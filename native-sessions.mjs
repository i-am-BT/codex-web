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
const DEFAULT_TURN_START_SCAN_BYTES = 32 * 1024 * 1024;
const TURN_START_RECORD_LIMIT_BYTES = 256 * 1024;
const DEFAULT_MAX_MESSAGES = 700;
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_RUNNING_WINDOW_MS = 60000;
const MESSAGE_TEXT_LIMIT = 80000;
const DETAIL_TEXT_LIMIT = 8000;
const IMAGE_URL_LIMIT = 16 * 1024 * 1024;
const TOOL_FILE_CHANGE_LIMIT = 200;
const TOOL_FILE_PATH_LIMIT = 2048;
const APP_THREAD_SOURCES = new Set(['vscode', 'appServer', 'app_server']);

export class NativeSessionStore extends EventEmitter {
  constructor(codexHome, options = {}) {
    super();
    this.codexHome = path.resolve(codexHome);
    this.sessionsDir = path.join(this.codexHome, 'sessions');
    this.indexFile = path.join(this.codexHome, 'session_index.jsonl');
    this.globalStateFile = path.join(this.codexHome, '.codex-global-state.json');
    this.stateDbFile = path.resolve(options.stateDbFile || path.join(this.codexHome, 'state_5.sqlite'));
    this.maxReadBytes = positiveNumber(options.maxReadBytes, DEFAULT_MAX_READ_BYTES);
    this.turnStartScanBytes = positiveNumber(
      options.turnStartScanBytes,
      Math.max(DEFAULT_TURN_START_SCAN_BYTES, this.maxReadBytes),
    );
    this.maxMessages = positiveNumber(options.maxMessages, DEFAULT_MAX_MESSAGES);
    this.maxSessions = positiveNumber(options.maxSessions, DEFAULT_MAX_SESSIONS);
    this.pollIntervalMs = positiveNumber(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.runningWindowMs = positiveNumber(options.runningWindowMs, DEFAULT_RUNNING_WINDOW_MS);
    this.watchChanges = options.watchChanges !== false;
    this.entries = new Map();
    this.subagentEntries = new Map();
    this.subagentThreads = new Map();
    this.titles = new Map();
    this.details = new Map();
    this.indexStamp = '';
    this.workspaceStateAvailable = false;
    this.projectlessThreadIds = new Set();
    this.projectThreadIds = new Set();
    this.pinnedThreadIds = [];
    this.appThreads = null;
    this.stateDb = null;
    this.stateDbIno = 0;
    this.stateThreadQuery = null;
    this.stateSubagentThreadQuery = null;
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
            && relative !== '.codex-global-state.json'
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
    const pinnedChangedIds = this.refreshWorkspaceState();
    this.refreshAppThreads();
    const nextEntries = scanSessionFiles(
      this.sessionsDir,
      this.titles,
      this.appThreads,
      (id) => this.workspaceKindForThread(id),
    );
    const nextSubagentEntries = scanSessionFiles(this.sessionsDir, this.titles, this.subagentThreads);
    const changedIds = [
      ...new Set([
        ...changedSessionIds(this.entries, nextEntries),
        ...changedSessionIds(this.subagentEntries, nextSubagentEntries),
        ...pinnedChangedIds,
      ]),
    ];
    this.entries = nextEntries;
    this.subagentEntries = nextSubagentEntries;

    for (const id of [...this.details.keys()]) {
      if (!this.entries.has(id) && !this.subagentEntries.has(id)) this.details.delete(id);
    }

    if (changedIds.length) {
      this.version += 1;
      this.emit('change', { version: this.version, changedIds });
    }
    return this.list();
  }

  refreshWorkspaceState() {
    let state;
    try {
      state = JSON.parse(readFileSync(this.globalStateFile, 'utf8'));
    } catch {
      // Codex Desktop replaces this file atomically. Keep the last valid
      // snapshot while it is temporarily missing or incomplete.
      return [];
    }

    const previousPinnedThreadIds = this.pinnedThreadIds;
    this.pinnedThreadIds = normalizePinnedThreadIds(state?.['pinned-thread-ids']);
    const pinnedChangedIds = equalStringArrays(previousPinnedThreadIds, this.pinnedThreadIds)
      ? []
      : [...new Set([...previousPinnedThreadIds, ...this.pinnedThreadIds])];

    const hasProjectlessIds = state
      && typeof state === 'object'
      && !Array.isArray(state)
      && Object.prototype.hasOwnProperty.call(state, 'projectless-thread-ids');
    if (!hasProjectlessIds) {
      this.projectlessThreadIds = new Set();
      this.projectThreadIds = new Set();
      this.workspaceStateAvailable = false;
      return pinnedChangedIds;
    }

    const value = state?.['projectless-thread-ids'];
    const ids = Array.isArray(value)
      ? value
      : value && typeof value === 'object'
        ? Object.keys(value)
        : null;
    if (!ids) return pinnedChangedIds;

    this.projectlessThreadIds = new Set(ids
      .map((id) => String(id || '').trim().toLowerCase())
      .filter((id) => SESSION_ID_PATTERN.test(`${id}.jsonl`)));
    const assignments = state?.['thread-project-assignments'];
    this.projectThreadIds = new Set((assignments && typeof assignments === 'object' && !Array.isArray(assignments)
      ? Object.keys(assignments)
      : [])
      .map((id) => String(id || '').trim().toLowerCase())
      .filter((id) => SESSION_ID_PATTERN.test(`${id}.jsonl`)));
    this.workspaceStateAvailable = true;
    return pinnedChangedIds;
  }

  listPinnedThreadIds() {
    return [...this.pinnedThreadIds];
  }

  workspaceKindForThread(id) {
    const threadId = String(id || '').trim().toLowerCase();
    if (!this.workspaceStateAvailable || !SESSION_ID_PATTERN.test(`${threadId}.jsonl`)) return '';
    if (this.projectThreadIds.has(threadId)) return 'project';
    return this.projectlessThreadIds.has(threadId) ? 'projectless' : 'project';
  }

  refreshAppThreads() {
    let stat;
    try {
      stat = statSync(this.stateDbFile);
    } catch {
      this.closeStateDb();
      this.appThreads = null;
      this.subagentThreads = new Map();
      return;
    }

    try {
      if (!this.stateDb || this.stateDbIno !== stat.ino) {
        this.closeStateDb();
        this.stateDb = new DatabaseSync(this.stateDbFile, { readOnly: true, timeout: 500 });
        this.stateDbIno = stat.ino;
        this.stateThreadQuery = prepareAppThreadQuery(this.stateDb);
        this.stateSubagentThreadQuery = prepareSubagentThreadQuery(this.stateDb);
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
          workspaceKind: this.workspaceStateAvailable ? this.workspaceKindForThread(id) : '',
          title: cleanTitle(row.title),
          createdAtMs: timestampMs(row.created_at_ms),
          updatedAtMs: timestampMs(row.updated_at_ms),
          recencyAtMs: timestampMs(row.recency_at_ms),
        });
      }
      this.appThreads = next;

      const nextSubagents = new Map();
      for (const row of this.stateSubagentThreadQuery?.all() || []) {
        const id = String(row.id || '').trim().toLowerCase();
        const rolloutPath = String(row.rollout_path || '').trim();
        const spawn = parseSubagentThreadSource(row.source);
        if (!SESSION_ID_PATTERN.test(`${id}.jsonl`) || !rolloutPath || !spawn) continue;
        nextSubagents.set(id, {
          rolloutPath: path.resolve(rolloutPath),
          cwd: String(row.cwd || '').trim(),
          title: cleanTitle(row.title) || agentPathLabel(spawn.agentPath),
          createdAtMs: timestampMs(row.created_at_ms),
          updatedAtMs: timestampMs(row.updated_at_ms),
          recencyAtMs: timestampMs(row.recency_at_ms),
          ...spawn,
        });
      }
      this.subagentThreads = nextSubagents;
    } catch {
      this.closeStateDb();
      if (this.appThreads === null) this.appThreads = new Map();
      this.subagentThreads = new Map();
    }
  }

  closeStateDb() {
    try {
      this.stateDb?.close();
    } catch {}
    this.stateDb = null;
    this.stateDbIno = 0;
    this.stateThreadQuery = null;
    this.stateSubagentThreadQuery = null;
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

  list(limit = this.maxSessions, { includeIds = [] } = {}) {
    const now = Date.now();
    const sortedEntries = [...this.entries.values()]
      .sort((left, right) => right.recencyMs - left.recencyMs);
    const selectedIds = new Set(sortedEntries
      .slice(0, positiveNumber(limit, this.maxSessions))
      .map((entry) => entry.id));
    for (const id of includeIds) {
      const cleanId = String(id || '').trim().toLowerCase();
      if (this.entries.has(cleanId)) selectedIds.add(cleanId);
    }
    return sortedEntries
      .filter((entry) => selectedIds.has(entry.id))
      .map((entry) => {
        let cached = this.details.get(entry.id);
        let cacheIsCurrent = cached
          && cached.filePath === entry.filePath
          && cached.size === entry.size;

        // A recent mtime only means the session changed, not that its turn is
        // still running. Parse changed recent sessions so a task_complete at
        // the end of the JSONL is reflected in the sidebar immediately.
        if (!cacheIsCurrent && now - entry.mtimeMs <= this.runningWindowMs) {
          this.get(entry.id);
          cached = this.details.get(entry.id);
          cacheIsCurrent = cached
            && cached.filePath === entry.filePath
            && cached.size === entry.size;
        }

        const status = cacheIsCurrent
          ? effectiveSessionStatus(cached.status, entry.mtimeMs, this.runningWindowMs, now)
          : now - entry.mtimeMs <= this.runningWindowMs
            ? 'running'
            : 'done';
        return sessionSummary(entry, status);
      });
  }

  get(id, options = {}) {
    return this.getConversationFromEntries(id, options, false);
  }

  getSubagent(parentId, agentRef, options = {}) {
    let entry = findSubagentEntry(this.subagentEntries, parentId, agentRef);
    if (!entry) {
      this.refresh();
      entry = findSubagentEntry(this.subagentEntries, parentId, agentRef);
    }
    if (!entry) return null;
    const conversation = this.getConversationFromEntries(entry.id, options, true);
    if (!conversation) return null;
    const cache = this.details.get(entry.id);
    const ownTurns = cache?.subagentTurnIds || new Set();
    const fallbackTurnId = conversation.latestTurnId;
    const messages = conversation.messages.filter((message) => (
      ownTurns.size ? ownTurns.has(message.turnId) : message.turnId === fallbackTurnId
    ));
    return {
      ...conversation,
      source: 'subagent',
      title: agentPathLabel(entry.agentPath),
      metadata: {
        ...conversation.metadata,
        parentThreadId: entry.parentThreadId,
        agentPath: entry.agentPath,
        agentNickname: entry.agentNickname,
        depth: entry.depth,
      },
      messages,
    };
  }

  getConversationFromEntries(id, options = {}, subagent = false) {
    const entries = () => (subagent ? this.subagentEntries : this.entries);
    let entry = entries().get(id);
    if (!entry) {
      this.refresh();
      entry = entries().get(id);
    }
    if (!entry) return null;

    try {
      const stat = statSync(entry.filePath);
      if (stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs || stat.ino !== entry.ino) {
        this.refresh();
        entry = entries().get(id);
      }
    } catch {
      this.refresh();
      entry = entries().get(id);
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
    if (cache.status === 'running' && cache.latestTurnId && !cache.currentTurnStartedAt && !cache.turnStartScanComplete) {
      cache.currentTurnStartedAt = findTurnStartedAtBeforeOffset(
        entry.filePath,
        cache.latestTurnId,
        cache.startOffset,
        entry.size,
        this.turnStartScanBytes,
      );
      cache.turnStartScanComplete = true;
    }
    return buildConversation(entry, cache, options, this.runningWindowMs);
  }

  getMessage(id, sequence, generation) {
    const conversation = this.get(id);
    if (!conversation) return null;
    if (Number.isInteger(generation) && generation !== conversation.generation) return null;
    const target = Number(sequence);
    if (!Number.isInteger(target) || target < 1) return null;
    const message = this.details.get(id)?.messages.find((item) => item.seq === target);
    return message ? { ...message } : null;
  }
}

function prepareAppThreadQuery(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((column) => String(column.name || '')));
  const requiredColumns = [
    'id',
    'rollout_path',
    'source',
    'cwd',
    'title',
    'archived',
    'preview',
    'cli_version',
    'created_at_ms',
    'updated_at_ms',
  ];
  const missingColumns = requiredColumns.filter((column) => !columns.has(column));
  if (missingColumns.length) throw new Error(`threads table is missing columns: ${missingColumns.join(', ')}`);

  const recencyColumn = columns.has('recency_at_ms') ? 'recency_at_ms' : 'updated_at_ms';
  const threadSource = columns.has('thread_source') ? "COALESCE(thread_source, '')" : "''";
  return db.prepare(`
    SELECT id, rollout_path, source, cwd, title, created_at_ms, updated_at_ms, ${recencyColumn} AS recency_at_ms
    FROM threads
    WHERE archived = 0
      AND preview <> ''
      AND cli_version <> ''
      AND NOT (
        ${threadSource} = 'automation'
        OR (
          preview LIKE 'Automation:%'
          AND preview LIKE '%Automation ID:%'
          AND preview LIKE '%Automation memory:%'
        )
      )
  `);
}

function prepareSubagentThreadQuery(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map((column) => String(column.name || '')));
  if (!columns.has('thread_source')) return null;
  const recencyColumn = columns.has('recency_at_ms') ? 'recency_at_ms' : 'updated_at_ms';
  return db.prepare(`
    SELECT id, rollout_path, source, cwd, title, created_at_ms, updated_at_ms, ${recencyColumn} AS recency_at_ms
    FROM threads
    WHERE archived = 0
      AND thread_source = 'subagent'
      AND rollout_path <> ''
  `);
}

function parseSubagentThreadSource(value) {
  try {
    const source = typeof value === 'string' ? JSON.parse(value) : value;
    const spawn = source?.subagent?.thread_spawn;
    const parentThreadId = String(spawn?.parent_thread_id || '').trim().toLowerCase();
    const agentPath = String(spawn?.agent_path || '').trim();
    if (!SESSION_ID_PATTERN.test(`${parentThreadId}.jsonl`) || !/^\/[A-Za-z0-9_.\/-]+$/.test(agentPath)) return null;
    return {
      parentThreadId,
      agentPath,
      agentNickname: String(spawn?.agent_nickname || '').trim(),
      depth: Number.isInteger(spawn?.depth) ? spawn.depth : Number(spawn?.depth) || 0,
    };
  } catch {
    return null;
  }
}

function agentPathLabel(value) {
  const name = String(value || '').split('/').filter(Boolean).at(-1) || 'agent';
  const clean = name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : 'Agent';
}

function findSubagentEntry(entries, parentId, agentRef) {
  const parent = String(parentId || '').trim().toLowerCase();
  const ref = String(agentRef || '').trim();
  if (!SESSION_ID_PATTERN.test(`${parent}.jsonl`) || !ref) return null;
  const leaf = ref.split('/').filter(Boolean).at(-1) || ref;
  return [...entries.values()]
    .filter((entry) => entry.parentThreadId === parent)
    .sort((left, right) => right.recencyMs - left.recencyMs)
    .find((entry) => (
      entry.id === ref.toLowerCase()
      || entry.agentPath === ref
      || entry.agentPath.split('/').filter(Boolean).at(-1) === leaf
    )) || null;
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

function scanSessionFiles(root, titles, appThreads = null, workspaceKindForThread = null) {
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
          workspaceKind: appThread?.workspaceKind || workspaceKindForThread?.(id) || '',
          filePath,
          size: stat.size,
          ino: stat.ino,
          mtimeMs: stat.mtimeMs,
          recencyMs,
          createdAt: new Date(createdAtMs).toISOString(),
          updatedAt: new Date(recencyMs).toISOString(),
          parentThreadId: appThread?.parentThreadId || '',
          agentPath: appThread?.agentPath || '',
          agentNickname: appThread?.agentNickname || '',
          depth: appThread?.depth || 0,
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
  return `${entry.filePath}:${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.recencyMs}:${entry.title}:${entry.cwd}:${entry.workspaceKind || ''}:${entry.parentThreadId || ''}:${entry.agentPath || ''}`;
}

function sessionSummary(entry, status) {
  return {
    id: entry.id,
    source: 'codex',
    title: entry.title,
    cwd: entry.cwd || '',
    workspaceKind: entry.workspaceKind || '',
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
    startOffset,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    remainder: Buffer.alloc(0),
    skipFirstPartial: startOffset > 0,
    messages: [],
    nextSequence: 1,
    messagesTruncated: startOffset > 0,
    calls: new Map(),
    metadata: { workspaceKind: entry.workspaceKind || '' },
    currentTurnId: '',
    previousTurnId: '',
    status: Date.now() - entry.mtimeMs <= options.runningWindowMs ? 'running' : 'done',
    latestTurnId: '',
    currentTurnStartedAt: '',
    turnStartScanComplete: startOffset === 0,
    displayUserMessagesInTurn: 0,
    lastTimestamp: '',
    subagentTurnIds: new Set(),
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

function findTurnStartedAtBeforeOffset(filePath, turnId, boundaryOffset, fileSize, maxScanBytes) {
  const targetTurnId = String(turnId || '');
  if (!targetTurnId || boundaryOffset <= 0) return '';
  const scanBudget = positiveNumber(maxScanBytes, DEFAULT_TURN_START_SCAN_BYTES);
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const scanEnd = Math.min(boundaryOffset, fileSize);
    const scanFloor = Math.max(0, scanEnd - scanBudget);

    const startedAtFromLine = (line) => {
      if (!line.length) return '';
      const source = line.toString('utf8').replace(/\r$/, '');
      if (!source.includes('"task_started"') || !source.includes(targetTurnId)) return '';
      try {
        const record = JSON.parse(source);
        const payload = record?.payload || {};
        const recordTurnId = String(payload.turn_id || payload.turnId || '');
        return record?.type === 'event_msg' && payload.type === 'task_started' && recordTurnId === targetTurnId
          ? String(record.timestamp || '')
          : '';
      } catch {
        return '';
      }
    };

    let position = scanEnd;
    let lineParts = [];
    let lineBytes = 0;
    let skipBoundaryLine = false;
    if (scanEnd < fileSize) {
      const forwardParts = [];
      let forwardBytes = 0;
      let forward = scanEnd;
      const forwardLimit = Math.min(fileSize, scanEnd + TURN_START_RECORD_LIMIT_BYTES);
      let foundNewline = false;
      while (forward < forwardLimit) {
        const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, forwardLimit - forward));
        const bytesRead = readSync(fd, chunk, 0, chunk.length, forward);
        if (!bytesRead) break;
        const body = chunk.subarray(0, bytesRead);
        const newline = body.indexOf(10);
        const part = newline === -1 ? body : body.subarray(0, newline);
        if (part.length) {
          forwardParts.push(Buffer.from(part));
          forwardBytes += part.length;
        }
        if (newline !== -1) {
          foundNewline = true;
          break;
        }
        forward += bytesRead;
      }
      if (foundNewline) {
        lineParts = forwardParts;
        lineBytes = forwardBytes;
      } else {
        skipBoundaryLine = true;
      }
    }

    const finishLine = (prefix) => {
      const total = prefix.length + lineBytes;
      let startedAt = '';
      if (!skipBoundaryLine && total > 0 && total <= TURN_START_RECORD_LIMIT_BYTES) {
        const line = lineParts.length ? Buffer.concat([prefix, ...lineParts], total) : prefix;
        startedAt = startedAtFromLine(line);
      }
      lineParts = [];
      lineBytes = 0;
      skipBoundaryLine = false;
      return startedAt;
    };

    while (position > scanFloor) {
      const start = Math.max(scanFloor, position - READ_CHUNK_BYTES);
      const chunk = Buffer.allocUnsafe(position - start);
      const bytesRead = readSync(fd, chunk, 0, chunk.length, start);
      if (!bytesRead) break;
      const body = chunk.subarray(0, bytesRead);
      let lineEnd = body.length;
      for (let index = body.length - 1; index >= 0; index -= 1) {
        if (body[index] !== 10) continue;
        const startedAt = finishLine(body.subarray(index + 1, lineEnd));
        if (startedAt) return startedAt;
        lineEnd = index;
      }
      if (lineEnd > 0) {
        const prefix = Buffer.from(body.subarray(0, lineEnd));
        lineParts.unshift(prefix);
        lineBytes += prefix.length;
        if (lineBytes > TURN_START_RECORD_LIMIT_BYTES) skipBoundaryLine = true;
      }
      position = start;
    }
    return scanFloor === 0 ? finishLine(Buffer.alloc(0)) : '';
  } catch {
    return '';
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
    if (record.type === 'turn_context') updateNativeTurnId(cache, record.payload?.turn_id);
    applyMetadataRecord(cache, record);
    return;
  }

  if (record.type === 'compacted') {
    applyCompactedRecord(cache, record, maxMessages);
    return;
  }

  if (record.type === 'inter_agent_communication_metadata') {
    if (record.payload?.trigger_turn && cache.currentTurnId) cache.subagentTurnIds.add(cache.currentTurnId);
    return;
  }

  const payload = record.payload || {};
  if (record.type === 'event_msg') {
    applyEventRecord(cache, record, payload, maxMessages);
    return;
  }
  if (record.type !== 'response_item') return;

  const responseTurnId = String(
    payload.internal_chat_message_metadata_passthrough?.turn_id
      || payload.internal_chat_message_metadata_passthrough?.turnId
      || '',
  );
  if (responseTurnId) updateNativeTurnId(cache, responseTurnId);

  switch (payload.type) {
    case 'message':
      applyMessageRecord(cache, record, payload, maxMessages);
      break;
    case 'reasoning': {
      const summary = reasoningSummaryText(payload);
      if (summary) appendNativeMessage(cache, 'process', summary, record, maxMessages, 'reasoning_summary');
      break;
    }
    case 'function_call':
    case 'custom_tool_call': {
      const name = String(payload.name || payload.type || 'tool');
      const callId = String(payload.call_id || payload.id || '');
      if (callId) cache.calls.set(callId, name);
      const input = payload.type === 'custom_tool_call' ? payload.input : payload.arguments;
      appendNativeMessage(
        cache,
        'tool',
        formatToolText(name, input),
        record,
        maxMessages,
        payload.type,
        toolMessageMetadata(name, input),
      );
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
    updateNativeTurnId(cache, payload.turn_id || payload.turnId);
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
  const turnId = String(payload.turn_id || payload.turnId || '');
  if (turnId) cache.latestTurnId = turnId;
  if (payload.type === 'task_started') updateNativeTurnId(cache, turnId);
  switch (payload.type) {
    case 'task_started':
      cache.status = 'running';
      if (!cache.currentTurnStartedAt) cache.currentTurnStartedAt = String(record.timestamp || '');
      cache.turnStartScanComplete = true;
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
      if (cache.messages.at(-1)?.kind !== 'context_compacted') {
        appendNativeMessage(cache, 'process', '上下文已自动压缩', record, maxMessages, payload.type);
      }
      break;
    default:
      break;
  }
}

function applyCompactedRecord(cache, record, maxMessages) {
  const previous = cache.messages.at(-1);
  const previousAt = Date.parse(previous?.at || '');
  const compactedAt = Date.parse(record.timestamp || '');
  const followsHandoffQuickly = Number.isFinite(previousAt)
    && Number.isFinite(compactedAt)
    && compactedAt >= previousAt
    && compactedAt - previousAt <= 5000;
  const embeddedHandoff = compactedRecordContainsHandoff(record, previous);
  if (previous?.role === 'assistant' && previous.kind === 'final_answer' && (followsHandoffQuickly || embeddedHandoff)) {
    cache.messages.pop();
  }
  if (cache.messages.at(-1)?.kind !== 'context_compacted') {
    appendNativeMessage(cache, 'process', '上下文已自动压缩', record, maxMessages, 'context_compacted');
  }
  // A browser may have read the internal handoff summary before the compacted
  // record landed. Changing the generation forces its next poll to reset.
  cache.generation += 1;
}

function compactedRecordContainsHandoff(record, message) {
  const content = String(message?.content || '').trim();
  const compactedMessage = String(record?.payload?.message || '');
  const envelope = 'Another language model started to solve this problem';
  if (content.length < 24 || !compactedMessage.startsWith(envelope)) return false;
  return compactedMessage.includes(content.slice(0, Math.min(240, content.length)));
}

function applyMessageRecord(cache, record, payload, maxMessages) {
  if (!['user', 'assistant'].includes(payload.role)) return;
  const text = contentText(payload.content);
  const images = contentImages(payload.content);
  if ((!text && !images.length) || (text && isInjectedWorkspaceInstructions(payload.role, text))) return;
  const browserComments = payload.role === 'user' && isBrowserCommentsMessage(text);
  const browserCommentMeta = browserComments ? browserCommentsMetadata(text) : null;
  const context = payload.role === 'user' ? normalizeInjectedContext(text) : null;
  const displayText = payload.role === 'user' ? normalizeUserDisplayText(text) : text;
  let messageKind = payload.phase || 'message';
  if (payload.role === 'user' && !context && (displayText || images.length)) {
    const turnId = String(payload.internal_chat_message_metadata_passthrough?.turn_id || '');
    if (turnId && turnId === cache.currentTurnId && cache.displayUserMessagesInTurn > 0) {
      messageKind = browserComments ? 'steering_browser_comment' : 'steering_user';
    }
    cache.displayUserMessagesInTurn += 1;
  }
  if (context) {
    appendNativeMessage(cache, 'context', context.content, record, maxMessages, context.kind);
  } else if (displayText) {
    appendNativeMessage(cache, payload.role, displayText, record, maxMessages, messageKind, browserCommentMeta);
  }
  const imageKind = payload.role === 'user'
    ? ['steering_user', 'steering_browser_comment'].includes(messageKind) ? 'steering_input_image' : 'input_image'
    : 'output_image';
  for (const image of images) appendNativeMessage(cache, 'image', image, record, maxMessages, imageKind);
}

function isBrowserCommentsMessage(text) {
  return String(text || '').replace(/\r\n/g, '\n').trimStart().startsWith('# Browser comments:');
}

function browserCommentsMetadata(text) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const headings = source.match(/^## (?:User )?Comment \d+\s*$/gm) || [];
  const target = source.match(/^Target:\s*"([^"]+)"\s*$/m)?.[1]
    || source.match(/^File:\s*browser:([^\n]+)$/m)?.[1]
    || '';
  return {
    annotationCount: Math.max(1, headings.length),
    browserTarget: target.trim().slice(0, 240),
  };
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
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/g, '')
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
  if (compact.startsWith('The next image was attached by the user as additional visual context')) return true;
  if (compact.startsWith('The selected region is outlined') && compact.includes('comment marker')) return true;
  return compact.startsWith('The element ') && compact.includes('marked by comment marker');
}

function appendNativeMessage(cache, role, content, record, maxMessages, kind, metadata = null) {
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
    turnId: cache.currentTurnId || undefined,
    previousTurnId: cache.previousTurnId || undefined,
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
  });
  if (cache.messages.length > maxMessages) {
    cache.messages.splice(0, cache.messages.length - maxMessages);
    cache.messagesTruncated = true;
  }
}

function updateNativeTurnId(cache, value) {
  const turnId = String(value || '').trim();
  if (!turnId) return;
  cache.latestTurnId = turnId;
  if (turnId === cache.currentTurnId) return;
  cache.previousTurnId = cache.currentTurnId || '';
  cache.currentTurnId = turnId;
  cache.currentTurnStartedAt = '';
  cache.turnStartScanComplete = false;
  cache.displayUserMessagesInTurn = 0;
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

function reasoningSummaryText(payload) {
  const summaries = Array.isArray(payload?.summary) ? payload.summary : [];
  const text = [...summaries]
    .reverse()
    .find((item) => item?.type === 'summary_text' && String(item.text || '').trim())?.text;
  return String(text || '')
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\*{1,3}\s*/, '')
    .replace(/\s*\*{1,3}$/, '')
    .trim();
}

function readDoubleQuotedJsString(source, start) {
  if (source[start] !== '"') return null;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' && !escaped) {
      try {
        const value = JSON.parse(source.slice(start, index + 1));
        return typeof value === 'string' ? { value, end: index + 1 } : null;
      } catch {
        return null;
      }
    }
    if (char === '\\') escaped = !escaped;
    else escaped = false;
  }
  return null;
}

function readRawJsTemplate(source, start) {
  if (source[start] !== '`') return null;
  let escaped = false;
  let value = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '`' && !escaped) return { value, end: index + 1 };
    if (char === '$' && source[index + 1] === '{' && !escaped) return null;
    value += char;
    if (char === '\\') escaped = !escaped;
    else escaped = false;
  }
  return null;
}

function patchAssignmentAt(source, start) {
  if (!source.startsWith('const', start)) return null;
  const before = source[start - 1] || '';
  const after = source[start + 5] || '';
  if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) return null;
  let cursor = start + 5;
  while (source[cursor] && source[cursor].charCodeAt(0) <= 32) cursor += 1;
  if (!source.startsWith('patch', cursor) || /[A-Za-z0-9_$]/.test(source[cursor + 5] || '')) return null;
  cursor += 5;
  while (source[cursor] && source[cursor].charCodeAt(0) <= 32) cursor += 1;
  if (source[cursor] !== '=') return null;
  cursor += 1;
  while (source[cursor] && source[cursor].charCodeAt(0) <= 32) cursor += 1;
  if (source[cursor] === '"') return readDoubleQuotedJsString(source, cursor);
  if (!source.startsWith('String.raw', cursor)) return null;
  cursor += 'String.raw'.length;
  while (source[cursor] && source[cursor].charCodeAt(0) <= 32) cursor += 1;
  return readRawJsTemplate(source, cursor);
}

function executablePatchCode(source) {
  const calls = [];
  const assignments = [];
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    const assignment = patchAssignmentAt(source, index);
    if (assignment) {
      assignments.push({ ...assignment, start: index });
      index = assignment.end - 1;
      continue;
    }
    if (!source.startsWith('tools.apply_patch', index)) continue;
    let cursor = index + 'tools.apply_patch'.length;
    while (source[cursor] && source[cursor].charCodeAt(0) <= 32) cursor += 1;
    if (source[cursor] === '(') calls.push(index);
  }
  return { calls, assignments };
}

function orchestratedPatchText(source) {
  const parsed = executablePatchCode(source);
  for (let index = parsed.calls.length - 1; index >= 0; index -= 1) {
    const call = parsed.calls[index];
    if (!/^tools\.apply_patch\s*\(\s*patch\s*\)/.test(source.slice(call))) continue;
    const assignment = [...parsed.assignments].reverse().find((item) => item.end <= call);
    if (assignment) return assignment.value;
  }
  return '';
}

function toolPatchText(name, value) {
  const toolName = String(name || '').split('.').at(-1);
  if (toolName === 'apply_patch') {
    if (typeof value === 'object' && value?.patch) return String(value.patch);
    const source = String(value || '');
    if (source.includes('*** Begin Patch')) return source;
    try {
      const parsed = JSON.parse(source);
      if (typeof parsed === 'string') return parsed;
      if (parsed && typeof parsed === 'object' && parsed.patch) return String(parsed.patch);
    } catch {}
    return '';
  }
  if (toolName !== 'exec') return '';
  return orchestratedPatchText(String(value || ''));
}

function patchFileChanges(patch) {
  const files = new Map();
  let current = null;
  for (const line of String(patch || '').split('\n')) {
    const prefixes = [
      ['*** Update File: ', '已编辑'],
      ['*** Add File: ', '已新增'],
      ['*** Delete File: ', '已删除'],
    ];
    const match = prefixes.find(([prefix]) => line.startsWith(prefix));
    if (match) {
      const filePath = line.slice(match[0].length).trim().replace(/^['"]+|['",;\)\]]+$/g, '');
      if (!filePath || filePath.length > TOOL_FILE_PATH_LIMIT) {
        current = null;
        continue;
      }
      if (!files.has(filePath) && files.size >= TOOL_FILE_CHANGE_LIMIT) {
        current = null;
        continue;
      }
      current = files.get(filePath) || { filePath, verb: match[1], added: 0, removed: 0 };
      if (current.verb !== match[1]) current.verb = '已编辑';
      files.set(filePath, current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+')) current.added += 1;
    else if (line.startsWith('-')) current.removed += 1;
  }
  return [...files.values()];
}

function toolMessageMetadata(name, value) {
  const fileChanges = patchFileChanges(toolPatchText(name, value));
  return fileChanges.length ? { fileChanges } : null;
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

function buildConversation(entry, cache, options, runningWindowMs) {
  const after = Number(options.after);
  const requestedGeneration = Number(options.generation);
  const requestedLimit = Number(options.limit);
  const hasAfter = Number.isInteger(after) && after >= 0;
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, cache.messages.length)
    : 0;
  const generationMatches = Number.isInteger(requestedGeneration) && requestedGeneration === cache.generation;
  const firstSequence = cache.messages[0]?.seq || cache.nextSequence;
  const reset = hasAfter && (!generationMatches || after < firstSequence - 1);
  const availableMessages = hasAfter && !reset
    ? cache.messages.filter((message) => message.seq > after)
    : cache.messages;
  const messages = limit && (!hasAfter || reset) ? availableMessages.slice(-limit) : availableMessages;

  return {
    id: entry.id,
    source: 'codex',
    title: entry.title,
    createdAt: cache.metadata.createdAt || entry.createdAt,
    updatedAt: cache.lastTimestamp || entry.updatedAt,
    status: effectiveSessionStatus(cache.status, entry.mtimeMs, runningWindowMs),
    latestTurnId: cache.latestTurnId,
    latestTurnStartedAt: cache.currentTurnStartedAt,
    readOnly: false,
    truncated: cache.messagesTruncated,
    hasEarlierMessages: messages.length < availableMessages.length,
    generation: cache.generation,
    cursor: Math.max(0, cache.nextSequence - 1),
    reset,
    revision: `${entry.ino}:${entry.size}:${entry.mtimeMs}`,
    metadata: { ...cache.metadata, workspaceKind: entry.workspaceKind || '' },
    messages: messages.map((message) => ({ ...message })),
  };
}

function effectiveSessionStatus(status, mtimeMs, runningWindowMs, now = Date.now()) {
  if (status !== 'running') return status;
  return now - mtimeMs <= runningWindowMs ? 'running' : 'interrupted';
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

function normalizePinnedThreadIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  const seen = new Set();
  for (const item of value) {
    const id = String(item || '').trim().toLowerCase();
    if (!SESSION_ID_PATTERN.test(`${id}.jsonl`) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function equalStringArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function timestampMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
