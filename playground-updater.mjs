import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const DEFAULT_REPOSITORY = 'https://github.com/CookSleep/gpt_image_playground.git';
const DEFAULT_RELEASE_API = 'https://api.github.com/repos/CookSleep/gpt_image_playground/releases/latest';
const STABLE_TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const LATEST_CACHE_MS = 10 * 60 * 1000;
const INTEGRATION_ASSET_VERSION = '20260730-1';

export class PlaygroundUpdater {
  constructor(options = {}) {
    this.runtimeDir = path.resolve(options.runtimeDir);
    this.vendorDir = path.resolve(options.vendorDir);
    this.patchDir = path.resolve(options.patchDir);
    this.repository = options.repository || DEFAULT_REPOSITORY;
    this.releaseApi = options.releaseApi || DEFAULT_RELEASE_API;
    this.fetchImpl = options.fetchImpl || fetch;
    this.runCommand = options.runCommand || runCommand;
    this.enabled = options.enabled !== false;
    this.currentDir = path.join(this.runtimeDir, 'current');
    this.previousDir = path.join(this.runtimeDir, 'previous');
    this.latestCache = null;
    this.startPromise = null;
    this.updatePromise = null;
    this.state = {
      status: 'idle',
      phase: '',
      error: '',
      message: '',
      updatedAt: null,
    };
  }

  async getStatus({ refresh = false } = {}) {
    const current = await this.readCurrentVersion();
    let latest = this.latestCache?.release || null;
    let checkError = '';

    if (
      this.enabled
      && !this.startPromise
      && !this.updatePromise
      && (refresh || !this.latestCache || Date.now() - this.latestCache.checkedAt > LATEST_CACHE_MS)
    ) {
      try {
        latest = await this.fetchLatestRelease({ force: refresh });
      } catch (error) {
        checkError = cleanError(error);
      }
    }

    return this.publicStatus(current, latest, checkError);
  }

  async startUpdate() {
    if (!this.enabled) throw statusError(403, '生图工作台在线更新已禁用');
    if (this.startPromise) return this.startPromise;
    if (this.updatePromise) return this.getStatus();

    const startPromise = this.prepareUpdate();
    this.startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  async prepareUpdate() {
    const current = await this.readCurrentVersion();
    const latest = await this.fetchLatestRelease({ force: true });
    if (compareVersions(latest.version, current.version) <= 0) {
      this.state = {
        status: 'success',
        phase: 'complete',
        error: '',
        message: '当前已是最新版本',
        updatedAt: new Date().toISOString(),
      };
      return this.publicStatus(current, latest);
    }

    this.state = {
      status: 'updating',
      phase: 'download',
      error: '',
      message: `正在更新到 ${latest.tag}`,
      updatedAt: null,
    };
    const updatePromise = this.performUpdate(current, latest)
      .then((installed) => {
        this.state = {
          status: 'success',
          phase: 'complete',
          error: '',
          message: `已更新到 ${installed.tag}`,
          updatedAt: installed.updatedAt,
        };
        return installed;
      })
      .catch((error) => {
        this.state = {
          status: 'error',
          phase: 'failed',
          error: cleanError(error),
          message: '更新失败，已继续使用原版本',
          updatedAt: new Date().toISOString(),
        };
        return null;
      })
      .finally(() => {
        if (this.updatePromise === updatePromise) this.updatePromise = null;
      });
    this.updatePromise = updatePromise;

    return this.publicStatus(current, latest);
  }

  async waitForIdle() {
    if (this.startPromise) await this.startPromise;
    if (this.updatePromise) await this.updatePromise;
    return this.getStatus();
  }

  async fetchLatestRelease({ force = false } = {}) {
    if (!force && this.latestCache && Date.now() - this.latestCache.checkedAt <= LATEST_CACHE_MS) {
      return this.latestCache.release;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchImpl(this.releaseApi, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'codex-web-playground-updater',
        },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`GitHub Release 检查失败：HTTP ${response.status}`);
      const payload = await response.json();
      const tag = String(payload?.tag_name || '').trim();
      const match = tag.match(STABLE_TAG_PATTERN);
      if (!match || payload?.draft || payload?.prerelease) throw new Error('GitHub 未返回有效的稳定版本');
      const release = { tag, version: `${match[1]}.${match[2]}.${match[3]}` };
      this.latestCache = { checkedAt: Date.now(), release };
      return release;
    } finally {
      clearTimeout(timer);
    }
  }

  async performUpdate(current, release) {
    await mkdir(this.runtimeDir, { recursive: true });
    const stageDir = await mkdtemp(path.join(this.runtimeDir, '.update-'));
    const sourceDir = path.join(stageDir, 'source');
    const candidateDir = path.join(stageDir, 'candidate');
    const buildEnv = safeBuildEnvironment();

    try {
      await this.runCommand('git', [
        'clone',
        '--quiet',
        '--depth', '1',
        '--branch', release.tag,
        '--config', 'advice.detachedHead=false',
        this.repository,
        sourceDir,
      ], { cwd: stageDir, env: buildEnv, timeout: 120_000 });

      const commitResult = await this.runCommand('git', ['rev-parse', 'HEAD'], {
        cwd: sourceDir,
        env: buildEnv,
        timeout: 15_000,
      });
      const commit = String(commitResult.stdout || '').trim();
      if (!COMMIT_PATTERN.test(commit)) throw new Error('无法确认上游版本提交');

      const patchFile = await this.resolvePatchFile(release.version);
      this.state.phase = 'patch';
      await this.runCommand('git', ['apply', '--check', patchFile], {
        cwd: sourceDir,
        env: buildEnv,
        timeout: 30_000,
      });
      await this.runCommand('git', ['apply', patchFile], {
        cwd: sourceDir,
        env: buildEnv,
        timeout: 30_000,
      });

      this.state.phase = 'install';
      await this.runCommand('npm', ['ci', '--no-audit', '--no-fund'], {
        cwd: sourceDir,
        env: buildEnv,
        timeout: 10 * 60_000,
      });

      this.state.phase = 'test';
      await this.runCommand('npm', ['test'], {
        cwd: sourceDir,
        env: buildEnv,
        timeout: 10 * 60_000,
      });

      this.state.phase = 'build';
      await this.runCommand('npm', ['run', 'build'], {
        cwd: sourceDir,
        env: { ...buildEnv, VITE_API_PROXY_AVAILABLE: 'true' },
        timeout: 10 * 60_000,
      });

      this.state.phase = 'verify';
      const installed = {
        tag: release.tag,
        version: release.version,
        commit,
        updatedAt: new Date().toISOString(),
      };
      await this.prepareCandidate(path.join(sourceDir, 'dist'), candidateDir, installed);
      await this.activateCandidate(candidateDir);
      this.latestCache = { checkedAt: Date.now(), release };
      return installed;
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  }

  async resolvePatchFile(targetVersion) {
    const candidate = path.join(this.patchDir, `codex-web-v${targetVersion}.patch`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      throw new Error(`缺少 v${targetVersion} 的 Codex Web 生图工作台兼容补丁`);
    }
  }

  async prepareCandidate(distDir, candidateDir, installed) {
    await access(path.join(distDir, 'index.html'));
    await cp(distDir, candidateDir, { recursive: true, force: false });
    for (const file of ['sw.js', 'codex-web-overrides.css', 'codex-web-integration.js']) {
      await cp(path.join(this.vendorDir, file), path.join(candidateDir, file));
    }

    const indexFile = path.join(candidateDir, 'index.html');
    const originalIndex = await readFile(indexFile, 'utf8');
    const index = injectIntegrationAssets(originalIndex);
    await writeFile(indexFile, index, 'utf8');
    await writeFile(
      path.join(candidateDir, 'codex-web-version.json'),
      `${JSON.stringify(installed, null, 2)}\n`,
      'utf8',
    );
    await validateCandidate(candidateDir, index);
  }

  async activateCandidate(candidateDir) {
    await assertScopedDirectory(this.runtimeDir, candidateDir);
    await assertScopedDirectory(this.runtimeDir, this.currentDir);
    await assertScopedDirectory(this.runtimeDir, this.previousDir);
    await rm(this.previousDir, { recursive: true, force: true });
    const hadCurrent = existsSync(this.currentDir);
    if (hadCurrent) await rename(this.currentDir, this.previousDir);
    try {
      await rename(candidateDir, this.currentDir);
    } catch (error) {
      if (hadCurrent && existsSync(this.previousDir) && !existsSync(this.currentDir)) {
        await rename(this.previousDir, this.currentDir);
      }
      throw error;
    }
  }

  async readCurrentVersion() {
    try {
      const payload = JSON.parse(await readFile(path.join(this.currentDir, 'codex-web-version.json'), 'utf8'));
      const version = normalizeVersion(payload.version || payload.tag);
      if (version) return { ...payload, version, tag: payload.tag || `v${version}`, source: 'runtime' };
    } catch {}

    if (!existsSync(this.currentDir)) {
      try {
        const payload = JSON.parse(await readFile(path.join(this.previousDir, 'codex-web-version.json'), 'utf8'));
        const version = normalizeVersion(payload.version || payload.tag);
        if (version) return { ...payload, version, tag: payload.tag || `v${version}`, source: 'runtime' };
      } catch {}
    }

    try {
      const notice = await readFile(path.join(path.dirname(this.vendorDir), 'NOTICE.md'), 'utf8');
      const version = normalizeVersion(notice.match(/^- Version:\s*`?([^`\s]+)`?/m)?.[1]);
      const commit = notice.match(/^- Commit:\s*`?([0-9a-f]{7,40})`?/mi)?.[1] || '';
      if (version) return { version, tag: `v${version}`, commit, source: 'builtin', updatedAt: null };
    } catch {}
    return { version: '0.0.0', tag: 'unknown', commit: '', source: 'builtin', updatedAt: null };
  }

  publicStatus(current, latest, checkError = '') {
    return {
      enabled: this.enabled,
      status: this.state.status,
      phase: this.state.phase,
      message: this.state.message,
      error: this.state.error || checkError,
      currentVersion: current.version,
      currentTag: current.tag,
      currentSource: current.source,
      latestVersion: latest?.version || null,
      latestTag: latest?.tag || null,
      updateAvailable: Boolean(latest && compareVersions(latest.version, current.version) > 0),
      updatedAt: this.state.updatedAt || current.updatedAt || null,
    };
  }
}

export function injectIntegrationAssets(index) {
  let next = String(index || '');
  if (!next.includes('codex-web-overrides.css')) {
    next = next.replace(
      '</head>',
      `    <link rel="stylesheet" href="./codex-web-overrides.css?v=${INTEGRATION_ASSET_VERSION}">\n  </head>`,
    );
  }
  if (!next.includes('codex-web-integration.js')) {
    next = next.replace(
      '</head>',
      `    <script src="./codex-web-integration.js?v=${INTEGRATION_ASSET_VERSION}" defer></script>\n  </head>`,
    );
  }
  return next;
}

export function compareVersions(left, right) {
  const a = normalizeVersion(left)?.split('.').map(Number) || [0, 0, 0];
  const b = normalizeVersion(right)?.split('.').map(Number) || [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

async function validateCandidate(candidateDir, index) {
  if (!index.includes('codex-web-overrides.css') || !index.includes('codex-web-integration.js')) {
    throw new Error('构建结果缺少 Codex Web 集成资源');
  }
  const references = [...index.matchAll(/(?:src|href)="\.\/([^"?#]+)[^\"]*"/g)].map((match) => match[1]);
  for (const reference of references) {
    const file = path.resolve(candidateDir, reference);
    if (!isWithin(candidateDir, file)) throw new Error('构建结果包含不安全的资源路径');
    await access(file);
  }
  const mainScript = index.match(/<script[^>]+src="\.\/(assets\/[^"?]+\.js)/)?.[1];
  if (!mainScript) throw new Error('构建结果缺少主脚本');
  const script = await readFile(path.join(candidateDir, mainScript), 'utf8');
  for (const marker of ['codex-web:playground-ready', 'codex-web:image-prompt-applied', '/api/playground-config']) {
    if (!script.includes(marker)) throw new Error(`构建结果缺少集成标记：${marker}`);
  }
  const serviceWorker = await readFile(path.join(candidateDir, 'sw.js'), 'utf8');
  if (!serviceWorker.includes('unregister')) throw new Error('安全 Service Worker 未保留');
}

async function runCommand(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      maxBuffer: 12 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error).trim().slice(-1600);
    throw new Error(`${command} 执行失败${detail ? `：${detail}` : ''}`);
  }
}

function safeBuildEnvironment() {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'ComSpec'];
  const env = { CI: '1', NODE_ENV: 'development', npm_config_audit: 'false', npm_config_fund: 'false' };
  for (const key of allowed) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function normalizeVersion(value) {
  const match = String(value || '').trim().match(STABLE_TAG_PATTERN);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : '';
}

async function assertScopedDirectory(root, target) {
  if (!isWithin(root, target) || path.resolve(root) === path.resolve(target)) {
    throw new Error('拒绝操作不安全的更新目录');
  }
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function cleanError(error) {
  return String(error?.message || error || '未知错误').replace(/[\r\n]+/g, ' ').trim().slice(0, 1200);
}

function statusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
