import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const AWESOME_GPT_IMAGE_REPOSITORY = 'freestylefly/awesome-gpt-image-2';
export const AWESOME_GPT_IMAGE_BUILTIN_REVISION = '60b6e1d3ddaf1c982426d6c8181827764c6b2012';

const REVISION_PATTERN = /^[0-9a-f]{40}$/i;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_MS = 5 * 60 * 1000;

export class ImagePromptLibrary {
  constructor({
    cacheDir,
    casesFile,
    stylesFile,
    builtInRevision = AWESOME_GPT_IMAGE_BUILTIN_REVISION,
    repository = AWESOME_GPT_IMAGE_REPOSITORY,
    fetchImpl = globalThis.fetch,
    githubToken = '',
    autoSync = true,
    intervalMs = DEFAULT_INTERVAL_MS,
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    now = () => new Date(),
    logger = console,
  }) {
    if (!cacheDir || !casesFile || !stylesFile) throw new Error('提示词库路径配置不完整');
    if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持 fetch');
    if (!REVISION_PATTERN.test(builtInRevision)) throw new Error('内置提示词库版本无效');

    this.cacheDir = path.resolve(cacheDir);
    this.revisionsDir = path.join(this.cacheDir, 'revisions');
    this.stateFile = path.join(this.cacheDir, 'state.json');
    this.casesFile = path.resolve(casesFile);
    this.stylesFile = path.resolve(stylesFile);
    this.builtInRevision = builtInRevision.toLowerCase();
    this.repository = repository;
    this.fetchImpl = fetchImpl;
    this.githubToken = String(githubToken || '').trim();
    this.autoSync = Boolean(autoSync);
    this.intervalMs = finitePositiveNumber(intervalMs, DEFAULT_INTERVAL_MS);
    this.requestTimeoutMs = finitePositiveNumber(requestTimeoutMs, DEFAULT_TIMEOUT_MS);
    this.now = now;
    this.logger = logger;
    this.timer = null;
    this.retryTimer = null;
    this.syncPromise = null;
    this.library = null;
    this.syncState = {
      revision: this.builtInRevision,
      source: 'bundled',
      checkedAt: null,
      updatedAt: null,
      status: 'ready',
      error: '',
    };

    this.loadInitialLibrary();
  }

  start() {
    if (!this.autoSync || this.timer) return;
    void this.sync({ reason: 'startup' }).catch((error) => {
      this.logger?.warn?.(`Image Prompt 自动更新失败: ${error.message}`);
      this.scheduleRetry();
    });
    this.timer = setInterval(() => {
      void this.sync({ reason: 'interval' }).catch((error) => {
        this.logger?.warn?.(`Image Prompt 自动更新失败: ${error.message}`);
        this.scheduleRetry();
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = null;
    this.retryTimer = null;
  }

  getLibrary() {
    return {
      ...this.library,
      sync: this.getStatus(),
    };
  }

  getStatus() {
    return {
      ...this.syncState,
      version: this.library.version,
      totalCases: this.library.totalCases,
      totalTemplates: this.library.totalTemplates,
      autoSync: this.autoSync,
      intervalMinutes: Math.round(this.intervalMs / 60_000),
    };
  }

  async sync({ reason = 'manual' } = {}) {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.performSync(reason).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  async performSync(reason) {
    const checkedAt = this.timestamp();
    this.syncState = {
      ...this.syncState,
      checkedAt,
      status: 'checking',
      error: '',
    };

    try {
      const revision = await this.fetchLatestRevision();
      if (revision === this.syncState.revision) {
        this.syncState = {
          ...this.syncState,
          checkedAt,
          status: 'ready',
          error: '',
        };
        this.persistState(reason);
        this.clearRetry();
        return this.getStatus();
      }

      const [caseData, styleData] = await Promise.all([
        this.fetchJson(this.rawUrl(revision, 'data/cases.json')),
        this.fetchJson(this.rawUrl(revision, 'data/style-library.json')),
      ]);
      const validated = validateLibraryData(caseData, styleData);
      this.writeRevision(revision, caseData, styleData);
      this.library = createLibraryPayload(validated, revision, this.repository);
      this.syncState = {
        revision,
        source: 'github',
        checkedAt,
        updatedAt: checkedAt,
        status: 'ready',
        error: '',
      };
      this.persistState(reason);
      this.clearRetry();
      return this.getStatus();
    } catch (error) {
      const message = cleanError(error);
      this.syncState = {
        ...this.syncState,
        checkedAt,
        status: 'error',
        error: message,
      };
      try {
        this.persistState(reason);
      } catch (stateError) {
        this.logger?.warn?.(`Image Prompt 更新状态保存失败: ${stateError.message}`);
      }
      throw new Error(message);
    }
  }

  scheduleRetry() {
    if (!this.autoSync || this.retryTimer) return;
    const delay = Math.min(this.intervalMs, DEFAULT_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.sync({ reason: 'retry' }).catch((error) => {
        this.logger?.warn?.(`Image Prompt 自动重试失败: ${error.message}`);
        this.scheduleRetry();
      });
    }, delay);
    this.retryTimer.unref?.();
  }

  clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  loadInitialLibrary() {
    const bundledData = validateLibraryData(
      readJsonFile(this.casesFile),
      readJsonFile(this.stylesFile),
    );
    this.library = createLibraryPayload(bundledData, this.builtInRevision, this.repository);

    if (!existsSync(this.stateFile)) return;
    try {
      const state = readJsonFile(this.stateFile);
      const revision = cleanRevision(state.revision);
      if (!revision) throw new Error('缓存版本无效');

      if (revision !== this.builtInRevision || existsSync(this.revisionDir(revision))) {
        const cachedData = this.readRevision(revision);
        this.library = createLibraryPayload(cachedData, revision, this.repository);
      }
      this.syncState = {
        revision,
        source: revision === this.builtInRevision && !existsSync(this.revisionDir(revision))
          ? 'bundled'
          : 'github',
        checkedAt: cleanTimestamp(state.checkedAt),
        updatedAt: cleanTimestamp(state.updatedAt),
        status: state.status === 'error' ? 'error' : 'ready',
        error: state.status === 'error' ? String(state.error || '').slice(0, 500) : '',
      };
    } catch (error) {
      this.syncState = {
        ...this.syncState,
        status: 'error',
        error: `缓存不可用，已使用内置版本: ${cleanError(error)}`,
      };
      this.logger?.warn?.(`Image Prompt 缓存载入失败: ${error.message}`);
    }
  }

  readRevision(revision) {
    const directory = this.revisionDir(revision);
    return validateLibraryData(
      readJsonFile(path.join(directory, 'cases.json')),
      readJsonFile(path.join(directory, 'style-library.json')),
    );
  }

  writeRevision(revision, caseData, styleData) {
    mkdirSync(this.revisionsDir, { recursive: true, mode: 0o700 });
    const target = this.revisionDir(revision);
    const temporary = path.join(
      this.revisionsDir,
      `.${revision}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`,
    );
    mkdirSync(temporary, { mode: 0o700 });
    try {
      writeJsonFile(path.join(temporary, 'cases.json'), caseData);
      writeJsonFile(path.join(temporary, 'style-library.json'), styleData);
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  persistState(reason) {
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    const state = {
      revision: this.syncState.revision,
      source: this.syncState.source,
      checkedAt: this.syncState.checkedAt,
      updatedAt: this.syncState.updatedAt,
      status: this.syncState.status,
      error: this.syncState.error,
      reason,
    };
    atomicWriteJson(this.stateFile, state);
  }

  revisionDir(revision) {
    return path.join(this.revisionsDir, revision);
  }

  async fetchLatestRevision() {
    const data = await this.fetchJson(
      `https://api.github.com/repos/${this.repository}/commits/main`,
      'application/vnd.github+json',
    );
    const revision = cleanRevision(data?.sha);
    if (!revision) throw new Error('GitHub 返回的版本号无效');
    return revision;
  }

  async fetchJson(url, accept = 'application/json') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    try {
      const headers = {
        Accept: accept,
        'User-Agent': 'codex-web-image-prompt-sync',
      };
      if (this.githubToken && new URL(url).origin === 'https://api.github.com') {
        headers.Authorization = `Bearer ${this.githubToken}`;
      }
      const response = await this.fetchImpl(url, { headers, signal: controller.signal });
      if (!response?.ok) throw new Error(`GitHub 请求失败 (${response?.status || 'unknown'})`);
      return await response.json();
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('GitHub 请求超时');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  rawUrl(revision, file) {
    return `https://raw.githubusercontent.com/${this.repository}/${revision}/${file}`;
  }

  timestamp() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return new Date().toISOString();
    return date.toISOString();
  }
}

function createLibraryPayload(data, revision, repository) {
  const { caseData, styleData, cases, templates } = data;
  return {
    version: `${revision}:${styleData.version || 1}:${cases.length}:${templates.length}`,
    revision,
    imageBaseUrl: `https://raw.githubusercontent.com/${repository}/${revision}/data`,
    totalCases: cases.length,
    totalTemplates: templates.length,
    categories: Array.isArray(styleData.categories) ? styleData.categories : [],
    styles: Array.isArray(styleData.styles) ? styleData.styles : [],
    scenes: Array.isArray(styleData.scenes) ? styleData.scenes : [],
    cases,
    templates,
    sources: [
      {
        name: 'awesome-gpt-image-2',
        url: `https://github.com/${repository}`,
        license: 'MIT',
        role: '提示词案例与工业模板',
      },
      {
        name: 'gpt_image_playground',
        url: 'https://github.com/CookSleep/gpt_image_playground',
        license: 'MIT',
        role: '完整生图工作台',
      },
    ],
    repository: caseData.repository || styleData.repository || `https://github.com/${repository}`,
  };
}

function validateLibraryData(caseData, styleData) {
  if (!caseData || typeof caseData !== 'object' || Array.isArray(caseData)) {
    throw new Error('案例数据格式无效');
  }
  if (!styleData || typeof styleData !== 'object' || Array.isArray(styleData)) {
    throw new Error('模板数据格式无效');
  }
  const cases = Array.isArray(caseData.cases) ? caseData.cases : [];
  const templates = Array.isArray(styleData.templates) ? styleData.templates : [];
  if (!cases.length || !templates.length) throw new Error('提示词数据为空');
  if (cases.some((item) => !item || typeof item !== 'object')) throw new Error('案例条目格式无效');
  if (templates.some((item) => !item || typeof item !== 'object')) throw new Error('模板条目格式无效');
  return { caseData, styleData, cases, templates };
}

function readJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJsonFile(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function atomicWriteJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeJsonFile(temporary, value);
  renameSync(temporary, file);
}

function cleanRevision(value) {
  const revision = String(value || '').trim().toLowerCase();
  return REVISION_PATTERN.test(revision) ? revision : '';
}

function cleanTimestamp(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cleanError(error) {
  const message = String(error?.message || error || '未知错误').replace(/[\r\n]+/g, ' ').trim();
  const cause = String(error?.cause?.code || error?.cause?.message || '').replace(/[\r\n]+/g, ' ').trim();
  return `${message}${cause && !message.includes(cause) ? ` (${cause})` : ''}`.slice(0, 500);
}

function finitePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
