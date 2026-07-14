import { EventEmitter } from 'node:events';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  watch,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SESSION_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const READ_CHUNK_BYTES = 256 * 1024;
const FIRST_RECORD_LIMIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_READ_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_MESSAGES = 700;
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_RUNNING_WINDOW_MS = 60000;
const MESSAGE_TEXT_LIMIT = 80000;
const DETAIL_TEXT_LIMIT = 8000;
const IMAGE_URL_LIMIT = 16 * 1024 * 1024;
const APP_THREAD_SOURCES = new Set(['vscode', 'appServer', 'app_server']);
const APP_THREAD_QUERY = `
  SELECT id, rollout_path, source, cwd, title, created_at_ms, updated_at_ms, recency_at_ms
  FROM threads
  WHERE archived = 0
    AND preview <> ''
    AND cli_version <> ''
    AND NOT (
      COALESCE(thread_source, '') = 'automation'
      OR (
        preview LIKE 'Automation:%'
        AND preview LIKE '%Automation ID:%'
        AND preview LIKE '%Automation memory:%'
      )
    )
`;

export class NativeSessionStore extends EventEmitter {
  constructor(codexHome, options = {}) {
    super();
    this.codexHome = path.resolve(codexHome);
    this.sessionsDir = path.join(this.codexHome, 'sessions');
    this.indexFile = path.join(this.codexHome, 'session_index.jsonl');
    this.stateDbFile = path.resolve(options.stateDbFile || path.join(this.codexHome, 'state_5.sqlite'));
    this.maxReadBytes = positiveNumber(options.maxReadBytes, DEFAULT_MAX_READ_BYTES);
    this.maxMessages = positiveNumber(options.maxMessages, DEFAULT_MAX_MESSAGES);
    this.maxSessions = positiveNumber(options.maxSessions, DEFAULT_MAX_SESSIONS);
    this.pollIntervalMs = positiveNumber(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.runningWindowMs = positiveNumber(options.runningWindowMs, DEFAULT_RUNNING_WINDOW_MS);
    this.watchChanges = options.watchChanges !== false;
    this.entries = new Map();
    this.titles = new Map();
    this.details = new Map();
    this.indexStamp = '';
    this.appThreads = null;
    this.stateDb = null;
    this.stateDbIno = 0;
    this.stateThreadQuery = null;
    this.version = 0;
    this.cacheGeneration = 0;
    this.watcher = null;
    this.pollTimer = null;
    this.refreshTimer = null;
    this.refresh();
  }

  start() {
    if (this.pollTimer) return;

    if (this.watchChanges && existsSync(this.codexHome)) {
      try {
        this.watcher = watch(this.codexHome, { recursive: true }, (_eventType, filename) => {
          const relative = String(filename || '').replace(/\\/g, '/');
          if (
            relative
            && relative !== 'session_index.jsonl'
            && relative !== 'state_5.sqlite'
            && relative !== 'state_5.sqlite-wal'
            && relative !== 'state_5.sqlite-shm'
            && !relative.startsWith('sessions/')
          ) return;
          this.scheduleRefresh();
        });
        this.watcher.on('error', () => {
          this.watcher?.close();
          this.watcher = null;
        });
      } catch {
        this.watcher = null;
      }
    }

    this.pollTimer = setInterval(() => this.refresh(), this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.pollTimer = null;
    this.refreshTimer = null;
    this.closeStateDb();
  }

  scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, 140);
    this.refreshTimer.unref?.();
  }

  refresh() {
    this.refreshTitles();
    this.refreshAppThreads();
    const nextEntries = scanSessionFiles(this.sessionsDir, this.titles, this.appThreads);
    const changedIds = changedSessionIds(this.entries, nextEntries);
    this.entries = nextEntries;

    for (const id of [...this.details.keys()]) {
      if (!this.entries.has(id)) this.details.delete(id);
    }

    if (changedIds.length) {
      this.version += 1;
      this.emit('change', { version: this.version, changedIds });
    }
    return this.list();
  }

  refreshAppThreads() {
    let stat;
    try {
      stat = statSync(this.stateDbFile);
    } catch {
      this.closeStateDb();
      this.appThreads = null;
      return;
    }

    try {
      if (!this.stateDb || this.stateDbIno !== stat.ino) {
        this.closeStateDb();
        this.stateDb = new DatabaseSync(this.stateDbFile, { readOnly: true, timeout: 500 });
        this.stateDbIno = stat.ino;
        this.stateThreadQuery = this.stateDb.prepare(APP_THREAD_QUERY);
      }

      const next = new Map();
      for (const row of this.stateThreadQuery.all()) {
        const id = String(row.id || '').trim().toLowerCase();
        const source = String(row.source || '');
        const rolloutPath = String(row.rollout_path || '').trim();
        if (!SESSION_ID_PATTERN.test(`${id}.jsonl`) || !APP_THREAD_SOURCES.has(source)) continue;
        if (!rolloutPath) continue;
        next.set(id, {
          rolloutPath: path.resolve(rolloutPath),
          cwd: String(row.cwd || '').trim(),
          title: cleanTitle(row.title),
          createdAtMs: timestampMs(row.created_at_ms),
          updatedAtMs: timestampMs(row.updated_at_ms),
          recencyAtMs: timestampMs(row.recency_at_ms),
        });
      }
      this.appThreads = next;
    } catch {
      this.closeStateDb();
      if (this.appThreads === null) this.appThreads = new Map();
    }
  }

  closeStateDb() {
    try {
      this.stateDb?.close();
    } catch {}
    this.stateDb = null;
    this.stateDbIno = 0;
    this.stateThreadQuery = null;
  }

  refreshTitles() {
    let stamp = '';
    try {
      const stat = statSync(this.indexFile);
      stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {}
    if (stamp === this.indexStamp) return;
    this.indexStamp = stamp;
    this.titles = readSessionIndex(this.indexFile);
  }

  list(limit = this.maxSessions) {
    const now = Date.now();
    return [...this.entries.values()]
      .sort((left, right) => right.recencyMs - left.recencyMs)
      .slice(0, positiveNumber(limit, this.maxSessions))
      .map((entry) => {
        const cached = this.details.get(entry.id);
        const status = cached && cached.filePath === entry.filePath && cached.size === entry.size
          ? cached.status
          : now - entry.mtimeMs <= this.runningWindowMs
            ? 'running'
            : 'done';
        return sessionSummary(entry, status);
      });
  }

  get(id, options = {}) {
    let entry = this.entries.get(id);
    if (!entry) {
      this.refresh();
      entry = this.entries.get(id);
    }
    if (!entry) return null;

    try {
      const stat = statSync(entry.filePath);
      if (stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs || stat.ino !== entry.ino) {
        this.refresh();
        entry = this.entries.get(id);
      }
    } catch {
      this.refresh();
      entry = this.entries.get(id);
    }
    if (!entry) return null;

    let cache = this.details.get(id);
    if (!cache || cache.filePath !== entry.filePath || cache.ino !== entry.ino || entry.size < cache.offset) {
      cache = createDetailCache(entry, {
        generation: ++this.cacheGeneration,
        maxReadBytes: this.maxReadBytes,
        runningWindowMs: this.runningWindowMs,
      });
      this.details.set(id, cache);
    } else if (entry.size === cache.offset && entry.mtimeMs !== cache.mtimeMs) {
      cache = createDetailCache(entry, {
        generation: ++this.cacheGeneration,
        maxReadBytes: this.maxReadBytes,
        runningWindowMs: this.runningWindowMs,
      });
      this.details.set(id, cache);
    }

    readSessionUpdates(cache, entry, this.maxMessages);
    return buildConversation(entry, cache, options);
  }
}

export function readSessionIndex(file) {
  const titles = new Map();
  if (!existsSync(file)) return titles;

  let content = '';
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return titles;
  }

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      const id = String(item.id || '').trim();
      const title = cleanTitle(item.thread_name);
      const updatedAt = String(item.updated_at || '');
      if (!SESSION_ID_PATTERN.test(`${id}.jsonl`) || !title) continue;
      const previous = titles.get(id);
      if (!previous || updatedAt >= previous.updatedAt) titles.set(id, { title, updatedAt });
    } catch {}
  }
  return titles;
}

function scanSessionFiles(root, titles, appThreads = null) {
  const entries = new Map();
  if (!existsSync(root)) return entries;
  const pending = [root];

  while (pending.length) {
    const directory = pending.pop();
    let children = [];
    try {
      children = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const child of children) {
      const filePath = path.join(directory, child.name);
      if (child.isDirectory()) {
        pending.push(filePath);
        continue;
      }
      if (!child.isFile()) continue;
      const id = child.name.match(SESSION_ID_PATTERN)?.[1]?.toLowerCase();
      if (!id) continue;
      const appThread = appThreads?.get(id);
      if (appThreads && !appThread) continue;
      if (appThread?.rolloutPath && path.resolve(filePath) !== appThread.rolloutPath) continue;

      try {
        const stat = statSync(filePath);
        const title = titles.get(id)?.title || appThread?.title || `Codex ${id.slice(0, 8)}`;
        const createdAtMs = appThread?.createdAtMs || stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs;
        const recencyMs = appThread?.recencyAtMs || appThread?.updatedAtMs || stat.mtimeMs;
        const firstRecord = appThread?.cwd ? null : readFirstRecord(filePath);
        const entry = {
          id,
          title,
          cwd: appThread?.cwd || String(firstRecord?.payload?.cwd || '').trim(),
          filePath,
          size: stat.size,
          ino: stat.ino,
          mtimeMs: stat.mtimeMs,
          recencyMs,
          createdAt: new Date(createdAtMs).toISOString(),
          updatedAt: new Date(recencyMs).toISOString(),
        };
        const previous = entries.get(id);
        if (!previous || entry.recencyMs > previous.recencyMs) entries.set(id, entry);
      } catch {}
    }
  }

  return entries;
}

function changedSessionIds(previous, next) {
  const changed = new Set();
  for (const [id, entry] of next) {
    const before = previous.get(id);
    if (!before || entrySignature(before) !== entrySignature(entry)) changed.add(id);
  }
  for (const id of previous.keys()) {
    if (!next.has(id)) changed.add(id);
  }
  return [...changed];
}

function entrySignature(entry) {
  return `${entry.filePath}:${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.recencyMs}:${entry.title}:${entry.cwd}`;
}

function sessionSummary(entry, status) {
  return {
    id: entry.id,
    source: 'codex',
    title: entry.title,
    cwd: entry.cwd || '',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    status,
    readOnly: false,
  };
}

function createDetailCache(entry, options) {
  const startOffset = Math.max(0, entry.size - options.maxReadBytes);
  const cache = {
    id: entry.id,
    filePath: entry.filePath,
    ino: entry.ino,
    generation: options.generation,
    offset: startOffset,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    remainder: Buffer.alloc(0),
    skipFirstPartial: startOffset > 0,
    messages: [],
    nextSequence: 1,
    messagesTruncated: startOffset > 0,
    calls: new Map(),
    metadata: {},
    status: Date.now() - entry.mtimeMs <= options.runningWindowMs ? 'running' : 'done',
    lastTimestamp: '',
  };

  const firstRecord = readFirstRecord(entry.filePath);
  if (firstRecord) applyMetadataRecord(cache, firstRecord);
  return cache;
}

function readFirstRecord(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    let total = Buffer.alloc(0);
    let position = 0;
    while (total.length < FIRST_RECORD_LIMIT_BYTES) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, FIRST_RECORD_LIMIT_BYTES - total.length));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      total = Buffer.concat([total, chunk.subarray(0, bytesRead)]);
      const newline = total.indexOf(10);
      if (newline !== -1) {
        return JSON.parse(total.subarray(0, newline).toString('utf8').replace(/\r$/, ''));
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

function readSessionUpdates(cache, entry, maxMessages) {
  if (entry.size < cache.offset) return;
  if (entry.size === cache.offset) {
    cache.size = entry.size;
    cache.mtimeMs = entry.mtimeMs;
    return;
  }

  let fd;
  try {
    fd = openSync(entry.filePath, 'r');
    let position = cache.offset;
    while (position < entry.size) {
      const length = Math.min(READ_CHUNK_BYTES, entry.size - position);
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, chunk, 0, length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const data = cache.remainder.length
        ? Buffer.concat([cache.remainder, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      cache.remainder = consumeJsonlBuffer(cache, data, maxMessages);
    }
    cache.offset = position;
    cache.size = entry.size;
    cache.mtimeMs = entry.mtimeMs;
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function consumeJsonlBuffer(cache, data, maxMessages) {
  let start = 0;
  if (cache.skipFirstPartial) {
    const newline = data.indexOf(10);
    if (newline === -1) return Buffer.alloc(0);
    start = newline + 1;
    cache.skipFirstPartial = false;
  }

  while (start < data.length) {
    const newline = data.indexOf(10, start);
    if (newline === -1) break;
    let line = data.subarray(start, newline);
    if (line.length && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
    start = newline + 1;
    if (!line.length) continue;
    try {
      applyNativeRecord(cache, JSON.parse(line.toString('utf8')), maxMessages);
    } catch {}
  }
  return start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
}

function applyNativeRecord(cache, record, maxMessages) {
  if (!record || typeof record !== 'object') return;
  if (record.timestamp) cache.lastTimestamp = String(record.timestamp);

  if (record.type === 'session_meta' || record.type === 'turn_context') {
    applyMetadataRecord(cache, record);
    return;
  }

  const payload = record.payload || {};
  if (record.type === 'event_msg') {
    applyEventRecord(cache, record, payload, maxMessages);
    return;
  }
  if (record.type !== 'response_item') return;

  switch (payload.type) {
    case 'message':
      applyMessageRecord(cache, record, payload, maxMessages);
      break;
    case 'reasoning':
      appendNativeMessage(
        cache,
        'thinking',
        (payload.summary || []).map((item) => item?.text).filter(Boolean).join('\n'),
        record,
        maxMessages,
        'reasoning',
      );
      break;
    case 'function_call':
    case 'custom_tool_call': {
      const name = String(payload.name || payload.type || 'tool');
      const callId = String(payload.call_id || payload.id || '');
      if (callId) cache.calls.set(callId, name);
      const input = payload.type === 'custom_tool_call' ? payload.input : payload.arguments;
      appendNativeMessage(cache, 'tool', formatToolText(name, input), record, maxMessages, payload.type);
      break;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = String(payload.call_id || '');
      const name = cache.calls.get(callId) || 'tool';
      appendNativeMessage(cache, 'tool', formatToolText(`${name} output`, payload.output), record, maxMessages, payload.type);
      break;
    }
    case 'web_search_call':
      appendNativeMessage(cache, 'tool', formatWebSearch(payload.action), record, maxMessages, payload.type);
      break;
    case 'tool_search_call':
      appendNativeMessage(cache, 'tool', formatToolText('tool_search', payload.arguments), record, maxMessages, payload.type);
      break;
    case 'tool_search_output':
      appendNativeMessage(
        cache,
        'tool',
        `tool_search output\n${(payload.tools || []).map((tool) => tool?.name || tool?.id).filter(Boolean).join('\n')}`,
        record,
        maxMessages,
        payload.type,
      );
      break;
    default:
      break;
  }
}

function applyMetadataRecord(cache, record) {
  const payload = record?.payload || {};
  if (record?.type === 'session_meta') {
    cache.metadata = {
      ...cache.metadata,
      id: payload.id || cache.id,
      cwd: payload.cwd || cache.metadata.cwd || '',
      modelProvider: payload.model_provider || cache.metadata.modelProvider || '',
      originator: payload.originator || cache.metadata.originator || '',
      sessionSource: payload.source || cache.metadata.sessionSource || '',
      cliVersion: payload.cli_version || cache.metadata.cliVersion || '',
      createdAt: payload.timestamp || record.timestamp || cache.metadata.createdAt || '',
    };
  } else if (record?.type === 'turn_context') {
    cache.metadata = {
      ...cache.metadata,
      cwd: payload.cwd || cache.metadata.cwd || '',
      model: payload.model || cache.metadata.model || '',
      reasoningEffort: payload.effort || cache.metadata.reasoningEffort || '',
      approvalPolicy: payload.approval_policy || cache.metadata.approvalPolicy || '',
      sandboxPolicy: normalizeSandboxPolicy(payload.sandbox_policy) || cache.metadata.sandboxPolicy || '',
      timezone: payload.timezone || cache.metadata.timezone || '',
    };
  }
}

function applyEventRecord(cache, record, payload, maxMessages) {
  switch (payload.type) {
    case 'task_started':
      cache.status = 'running';
      appendNativeMessage(cache, 'process', '任务开始', record, maxMessages, payload.type);
      break;
    case 'task_complete': {
      cache.status = 'done';
      const duration = Number(payload.duration_ms);
      const content = Number.isFinite(duration) ? `任务完成，耗时 ${(duration / 1000).toFixed(1)}s` : '任务完成';
      appendNativeMessage(cache, 'process', content, record, maxMessages, payload.type);
      break;
    }
    case 'task_error':
    case 'turn_aborted':
    case 'error':
      cache.status = 'error';
      appendNativeMessage(cache, 'process', payload.message || payload.error || '任务中断', record, maxMessages, payload.type);
      break;
    case 'context_compacted':
      appendNativeMessage(cache, 'process', '上下文已压缩', record, maxMessages, payload.type);
      break;
    default:
      break;
  }
}

function applyMessageRecord(cache, record, payload, maxMessages) {
  if (!['user', 'assistant'].includes(payload.role)) return;
  const text = contentText(payload.content);
  const images = contentImages(payload.content);
  if ((!text && !images.length) || (text && isInjectedWorkspaceInstructions(payload.role, text))) return;
  const context = payload.role === 'user' ? normalizeInjectedContext(text) : null;
  if (context) {
    appendNativeMessage(cache, 'context', context.content, record, maxMessages, context.kind);
  } else if (text) {
    const displayText = payload.role === 'user' ? normalizeUserDisplayText(text) : text;
    appendNativeMessage(cache, payload.role, displayText, record, maxMessages, payload.phase || 'message');
  }
  const imageKind = payload.role === 'user' ? 'input_image' : 'output_image';
  for (const image of images) appendNativeMessage(cache, 'image', image, record, maxMessages, imageKind);
}

function isInjectedWorkspaceInstructions(role, text) {
  if (role !== 'user') return false;
  const normalized = String(text || '').replace(/\r\n/g, '\n').trimStart();
  const workspaceInstructions = normalized.startsWith('# AGENTS.md instructions for ')
    && normalized.includes('\n\n<INSTRUCTIONS>\n')
    && normalized.includes('\n</INSTRUCTIONS>');
  const skillInstructions = normalized.startsWith('<skill>')
    && normalized.includes('<name>')
    && normalized.includes('</skill>');
  return workspaceInstructions || skillInstructions;
}

function normalizeInjectedContext(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  const environment = normalized.match(/^<environment_context>\s*([\s\S]*?)\s*<\/environment_context>$/);
  if (environment) {
    const source = environment[1];
    const date = firstContextTag(source, 'current_date');
    const timezone = firstContextTag(source, 'timezone');
    const cwd = firstContextTag(source, 'cwd');
    const roots = contextTagValues(source, 'root');
    const permission = source.match(/<permission_profile\b[^>]*\btype="([^"]+)"/)?.[1] || '';
    const lines = [];
    if (date) lines.push(`日期 ${date}`);
    if (timezone) lines.push(`时区 ${timezone}`);
    if (cwd && !roots.includes(cwd)) lines.push(`目录 ${cwd}`);
    if (roots.length) {
      lines.push(`工作区 ${roots.length}`);
      for (const root of roots) lines.push(`- ${root}`);
    }
    if (permission) lines.push(`权限 ${permission}`);
    return { kind: 'environment_context', content: lines.join('\n') || '环境信息已同步' };
  }

  const browser = normalized.match(/^<in-app-browser-context\b[^>]*>\s*([\s\S]*?)\s*<\/in-app-browser-context>$/);
  if (browser) {
    const url = browser[1].match(/Current URL:\s*(\S+)/)?.[1] || '';
    return {
      kind: 'browser_context',
      content: url ? `当前页面 ${url}` : '浏览器状态已同步',
    };
  }

  const internal = normalized.match(/^<codex_internal_context\b[^>]*>\s*([\s\S]*?)\s*<\/codex_internal_context>$/);
  if (internal) {
    const objective = firstContextTag(internal[1], 'objective');
    return {
      kind: 'goal_context',
      content: objective ? `持续目标\n${objective}` : '内部任务状态已同步',
    };
  }

  if (/^<turn_aborted>[\s\S]*<\/turn_aborted>$/.test(normalized)) {
    return {
      kind: 'turn_aborted',
      content: '上个任务已中断',
    };
  }

  return null;
}

function firstContextTag(source, tag) {
  return contextTagValues(source, tag)[0] || '';
}

function contextTagValues(source, tag) {
  const values = [];
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  let match;
  while ((match = pattern.exec(String(source || '')))) {
    const value = match[1].trim();
    if (value && !values.includes(value)) values.push(value);
  }
  return values;
}

function normalizeUserDisplayText(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  const requestMarker = '## My request for Codex:';
  const requestIndex = normalized.indexOf(requestMarker);
  if (!normalized.startsWith('# Browser comments:')) {
    return cleanUserRequest(requestIndex === -1 ? normalized : normalized.slice(requestIndex + requestMarker.length));
  }

  const commentsBlock = requestIndex === -1 ? normalized : normalized.slice(0, requestIndex);
  const requestBlock = requestIndex === -1 ? '' : normalized.slice(requestIndex + requestMarker.length);
  const parts = [];
  const commentPattern = /^Comment:\s*\n([\s\S]*?)(?=\n(?:<in-app-browser-context\b|## Comment \d+\b)|$)/gm;
  let match;

  while ((match = commentPattern.exec(commentsBlock))) {
    const comment = match[1].trim();
    if (comment && !parts.includes(comment)) parts.push(comment);
  }

  const request = cleanUserRequest(requestBlock);
  if (request && !parts.includes(request)) parts.push(request);

  return parts.length ? parts.join('\n\n') : cleanUserRequest(normalized);
}

function cleanUserRequest(source) {
  return String(source || '')
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g, '')
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/g, '图片附件')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => !isBrowserEvidenceBoilerplate(paragraph))
    .join('\n\n')
    .trim();
}

function isBrowserEvidenceBoilerplate(paragraph) {
  const compact = String(paragraph || '').replace(/\s+/g, ' ').trim();
  if (!compact || compact === '[图片附件]') return true;
  if (compact.startsWith('The next image is untrusted page evidence')) return true;
  if (compact.startsWith('The selected region is outlined') && compact.includes('comment marker')) return true;
  return compact.startsWith('The element ') && compact.includes('marked by comment marker');
}

function appendNativeMessage(cache, role, content, record, maxMessages, kind) {
  const limit = role === 'image'
    ? IMAGE_URL_LIMIT
    : role === 'user' || role === 'assistant'
      ? MESSAGE_TEXT_LIMIT
      : DETAIL_TEXT_LIMIT;
  const clean = limitText(String(content || '').trim(), limit);
  if (!clean) return;
  cache.messages.push({
    seq: cache.nextSequence++,
    role,
    content: clean,
    at: record.timestamp || '',
    kind,
  });
  if (cache.messages.length > maxMessages) {
    cache.messages.splice(0, cache.messages.length - maxMessages);
    cache.messagesTruncated = true;
  }
}

function contentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (['input_text', 'output_text', 'text'].includes(part.type)) return String(part.text || '');
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function contentImages(content) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || !['input_image', 'image_url'].includes(part.type)) continue;
    const value = typeof part.image_url === 'object' ? part.image_url?.url : part.image_url || part.url;
    const image = cleanImageUrl(value);
    if (image && !images.includes(image)) images.push(image);
  }
  return images;
}

function cleanImageUrl(value) {
  const image = String(value || '').trim();
  if (!image || image.length > IMAGE_URL_LIMIT) return '';
  if (/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/i.test(image)) return image;
  if (/^https?:\/\/[^\s]+$/i.test(image)) return image;
  return '';
}

function formatToolText(name, value) {
  let detail = '';
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (name === 'exec_command' && parsed && typeof parsed === 'object' && parsed.cmd) {
        detail = String(parsed.cmd);
        if (parsed.workdir) detail += `\nworkdir=${parsed.workdir}`;
      } else {
        detail = JSON.stringify(parsed, null, 2);
      }
    } catch {
      detail = value;
    }
  } else if (value !== undefined && value !== null) {
    detail = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }
  return limitText(detail ? `${name}\n${detail}` : name, DETAIL_TEXT_LIMIT);
}

function formatWebSearch(action) {
  if (!action || typeof action !== 'object') return 'web_search';
  const query = action.query || (Array.isArray(action.queries) ? action.queries.join('\n') : '');
  const target = query || action.url || action.type || '';
  return limitText(target ? `web_search\n${target}` : 'web_search', DETAIL_TEXT_LIMIT);
}

function normalizeSandboxPolicy(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value.type || value.mode || '';
  return '';
}

function buildConversation(entry, cache, options) {
  const after = Number(options.after);
  const requestedGeneration = Number(options.generation);
  const hasAfter = Number.isInteger(after) && after >= 0;
  const generationMatches = Number.isInteger(requestedGeneration) && requestedGeneration === cache.generation;
  const firstSequence = cache.messages[0]?.seq || cache.nextSequence;
  const reset = hasAfter && (!generationMatches || after < firstSequence - 1);
  const messages = hasAfter && !reset ? cache.messages.filter((message) => message.seq > after) : cache.messages;

  return {
    id: entry.id,
    source: 'codex',
    title: entry.title,
    createdAt: cache.metadata.createdAt || entry.createdAt,
    updatedAt: cache.lastTimestamp || entry.updatedAt,
    status: cache.status,
    readOnly: false,
    truncated: cache.messagesTruncated,
    generation: cache.generation,
    cursor: Math.max(0, cache.nextSequence - 1),
    reset,
    revision: `${entry.ino}:${entry.size}:${entry.mtimeMs}`,
    metadata: { ...cache.metadata },
    messages: messages.map((message) => ({ ...message })),
  };
}

function cleanTitle(value) {
  return String(value || '')
    .trim()
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^\n)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function limitText(value, limit) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[内容过长，已截断 ${text.length - limit} 字符]`;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function timestampMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
