import { EventEmitter } from 'node:events';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SESSION_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const READ_CHUNK_BYTES = 256 * 1024;
const FIRST_RECORD_LIMIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_READ_BYTES = 0;
const DEFAULT_TURN_START_SCAN_BYTES = 32 * 1024 * 1024;
const TURN_START_RECORD_LIMIT_BYTES = 256 * 1024;
const DEFAULT_MAX_MESSAGES = 0;
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_RUNNING_WINDOW_MS = 6 * 60 * 60 * 1000;
const MESSAGE_TEXT_LIMIT = 80000;
const DETAIL_TEXT_LIMIT = 8000;
const IMAGE_URL_LIMIT = 16 * 1024 * 1024;
const TOOL_FILE_CHANGE_LIMIT = 200;
const TOOL_FILE_PATH_LIMIT = 2048;
const APP_THREAD_SOURCES = new Set(['vscode', 'appServer', 'app_server']);
const TURN_TERMINAL_PROCESS_KINDS = new Set(['task_complete', 'task_error', 'turn_aborted', 'error']);

export class NativeSessionStore extends EventEmitter {
  constructor(codexHome, options = {}) {
    super();
    this.codexHome = path.resolve(codexHome);
    this.sessionsDir = path.join(this.codexHome, 'sessions');
    this.indexFile = path.join(this.codexHome, 'session_index.jsonl');
    this.globalStateFile = path.join(this.codexHome, '.codex-global-state.json');
    this.sideChatStateFile = path.resolve(
      options.sideChatStateFile || path.join(this.codexHome, 'codex-web-side-chat.json'),
    );
    this.deepSeekUsageFile = String(options.deepSeekUsageFile || '').trim();
    this.stateDbFile = path.resolve(options.stateDbFile || path.join(this.codexHome, 'state_5.sqlite'));
    this.goalsDbFile = path.resolve(options.goalsDbFile || path.join(this.codexHome, 'goals_1.sqlite'));
    this.maxReadBytes = nonNegativeNumber(options.maxReadBytes, DEFAULT_MAX_READ_BYTES);
    this.turnStartScanBytes = positiveNumber(
      options.turnStartScanBytes,
      Math.max(DEFAULT_TURN_START_SCAN_BYTES, this.maxReadBytes),
    );
    this.maxMessages = nonNegativeNumber(options.maxMessages, DEFAULT_MAX_MESSAGES);
    this.maxSessions = positiveNumber(options.maxSessions, DEFAULT_MAX_SESSIONS);
    this.pollIntervalMs = positiveNumber(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    this.runningWindowMs = positiveNumber(options.runningWindowMs, DEFAULT_RUNNING_WINDOW_MS);
    this.watchChanges = options.watchChanges !== false;
    this.entries = new Map();
    this.subagentEntries = new Map();
    this.subagentThreads = new Map();
    this.titles = new Map();
    this.details = new Map();
    this.threadGoals = new Map();
    this.clearedThreadGoalIds = new Set();
    this.goalsStamp = '';
    this.sessionMetadataCache = new Map();
    this.indexStamp = '';
    this.workspaceStateAvailable = false;
    this.projectlessThreadIds = new Set();
    this.projectThreadIds = new Set();
    this.sideChatThreadIds = new Set();
    this.sideChatSourceThreads = new Map();
    this.pinnedThreadIds = [];
    this.threadSettingsOverrides = new Map();
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
            && relative !== 'goals_1.sqlite'
            && relative !== 'goals_1.sqlite-wal'
            && relative !== 'goals_1.sqlite-shm'
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
    }, 40);
    this.refreshTimer.unref?.();
  }

  refresh() {
    this.refreshTitles();
    const goalChangedIds = this.refreshThreadGoals();
    const pinnedChangedIds = this.refreshWorkspaceState();
    this.refreshAppThreads();
    const nextEntries = scanSessionFiles(
      this.sessionsDir,
      this.titles,
      this.appThreads,
      (id) => this.workspaceKindForThread(id),
      this.sessionMetadataCache,
    );
    const nextSubagentEntries = scanSessionFiles(this.sessionsDir, this.titles, this.subagentThreads);
    const changedIds = [
      ...new Set([
        ...changedSessionIds(this.entries, nextEntries),
        ...changedSessionIds(this.subagentEntries, nextSubagentEntries),
        ...pinnedChangedIds,
        ...goalChangedIds,
      ]),
    ];
    this.entries = nextEntries;
    this.subagentEntries = nextSubagentEntries;
    pruneSessionMetadataCache(this.sessionMetadataCache, nextEntries);

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
    let state = null;
    try {
      state = JSON.parse(readFileSync(this.globalStateFile, 'utf8'));
    } catch {}

    const previousPinnedThreadIds = this.pinnedThreadIds;
    if (state && typeof state === 'object' && !Array.isArray(state)) {
      this.pinnedThreadIds = normalizePinnedThreadIds(state['pinned-thread-ids']);
    }
    const pinnedChangedIds = equalStringArrays(previousPinnedThreadIds, this.pinnedThreadIds)
      ? []
      : [...new Set([...previousPinnedThreadIds, ...this.pinnedThreadIds])];

    const hasProjectlessIds = state
      && typeof state === 'object'
      && !Array.isArray(state)
      && Object.prototype.hasOwnProperty.call(state, 'projectless-thread-ids');
    const value = hasProjectlessIds ? state['projectless-thread-ids'] : null;
    const globalIds = Array.isArray(value)
      ? value
      : value && typeof value === 'object'
        ? Object.keys(value)
        : [];
    const local = this.readLocalSideChatState();

    if (state) {
      const assignments = state['thread-project-assignments'];
      this.projectThreadIds = new Set((assignments && typeof assignments === 'object' && !Array.isArray(assignments)
        ? Object.keys(assignments)
        : [])
        .map((id) => String(id || '').trim().toLowerCase())
        .filter((id) => SESSION_ID_PATTERN.test(`${id}.jsonl`)));
    }
    const globalProjectlessIds = [...globalIds, ...local.legacyProjectlessIds]
      .map((id) => String(id || '').trim().toLowerCase())
      .filter((id) => SESSION_ID_PATTERN.test(`${id}.jsonl`) && !this.projectThreadIds.has(id));
    const localProjectlessIds = local.projectlessIds
      .map((id) => String(id || '').trim().toLowerCase())
      .filter((id) => SESSION_ID_PATTERN.test(`${id}.jsonl`));
    this.projectlessThreadIds = new Set([...globalProjectlessIds, ...localProjectlessIds]);
    this.workspaceStateAvailable = state
      ? Boolean(hasProjectlessIds || local.projectlessIds.length || globalProjectlessIds.length)
      : Boolean(local.projectlessIds.length || globalProjectlessIds.length || this.workspaceStateAvailable);
    this.refreshSideChatState(state);
    try {
      this.writeLocalSideChatState([...this.sideChatThreadIds], Object.fromEntries(this.sideChatSourceThreads), {
        projectlessIds: local.projectlessIds,
        legacyProjectlessIds: globalProjectlessIds,
        workspaceHints: {
          ...(state?.['thread-workspace-root-hints'] && typeof state['thread-workspace-root-hints'] === 'object'
            ? state['thread-workspace-root-hints']
            : {}),
          ...local.workspaceHints,
        },
      });
    } catch {}
    return pinnedChangedIds;
  }

  readLocalSideChatState() {
    try {
      const parsed = JSON.parse(readFileSync(this.sideChatStateFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ids: [], sources: {}, ignoredIds: [], projectlessIds: [], legacyProjectlessIds: [], workspaceHints: {} };
      }
      const raw = parsed['side-chat-thread-ids'];
      const ids = Array.isArray(raw)
        ? raw
        : raw && typeof raw === 'object'
          ? Object.keys(raw)
          : [];
      const sources = (parsed['side-chat-source-threads']
        && typeof parsed['side-chat-source-threads'] === 'object'
        && !Array.isArray(parsed['side-chat-source-threads']))
        ? parsed['side-chat-source-threads']
        : {};
      const ignoredIds = Array.isArray(parsed['ignored-side-chat-thread-ids'])
        ? parsed['ignored-side-chat-thread-ids']
        : [];
      const projectlessRaw = parsed['projectless-thread-ids'];
      const projectlessIds = Array.isArray(projectlessRaw)
        ? projectlessRaw
        : projectlessRaw && typeof projectlessRaw === 'object'
          ? Object.keys(projectlessRaw)
          : [];
      const legacyProjectlessRaw = parsed['legacy-projectless-thread-ids'];
      const legacyProjectlessIds = Array.isArray(legacyProjectlessRaw)
        ? legacyProjectlessRaw
        : legacyProjectlessRaw && typeof legacyProjectlessRaw === 'object'
          ? Object.keys(legacyProjectlessRaw)
          : [];
      const workspaceHints = (parsed['thread-workspace-root-hints']
        && typeof parsed['thread-workspace-root-hints'] === 'object'
        && !Array.isArray(parsed['thread-workspace-root-hints']))
        ? parsed['thread-workspace-root-hints']
        : {};
      return { ids, sources, ignoredIds, projectlessIds, legacyProjectlessIds, workspaceHints };
    } catch {
      return { ids: [], sources: {}, ignoredIds: [], projectlessIds: [], legacyProjectlessIds: [], workspaceHints: {} };
    }
  }

  writeLocalSideChatState(ids, sources, options = {}) {
    const current = this.readLocalSideChatState();
    const cleanIds = [...new Set((ids || [])
      .map((id) => String(id || '').trim().toLowerCase())
      .filter((id) => SESSION_ID_PATTERN.test(String(id) + '.jsonl')))];
    const cleanSources = {};
    for (const [id, source] of Object.entries(sources || {})) {
      const threadId = String(id || '').trim().toLowerCase();
      const sourceThreadId = String(source || '').trim().toLowerCase();
      if (!SESSION_ID_PATTERN.test(String(threadId) + '.jsonl')) continue;
      if (!cleanIds.includes(threadId)) continue;
      cleanSources[threadId] = SESSION_ID_PATTERN.test(String(sourceThreadId) + '.jsonl') ? sourceThreadId : '';
    }
    const projectlessIds = [...new Set((options.projectlessIds || current.projectlessIds || [])
      .map((id) => String(id || '').trim().toLowerCase())
      .filter((id) => SESSION_ID_PATTERN.test(String(id) + '.jsonl')))];
    const legacyProjectlessIds = [...new Set((options.legacyProjectlessIds || current.legacyProjectlessIds || [])
      .map((id) => String(id || '').trim().toLowerCase())
      .filter((id) => SESSION_ID_PATTERN.test(String(id) + '.jsonl') && !projectlessIds.includes(id)))];
    const workspaceHints = {};
    for (const [id, cwd] of Object.entries(options.workspaceHints || current.workspaceHints || {})) {
      const threadId = String(id || '').trim().toLowerCase();
      const value = String(cwd || '').trim();
      if ((projectlessIds.includes(threadId) || legacyProjectlessIds.includes(threadId)) && value) {
        workspaceHints[threadId] = value;
      }
    }
    const payload = {
      'side-chat-thread-ids': cleanIds,
      'side-chat-source-threads': cleanSources,
      'ignored-side-chat-thread-ids': [...new Set((options.ignoredIds || current.ignoredIds || [])
        .map((id) => String(id || '').trim().toLowerCase())
        .filter((id) => SESSION_ID_PATTERN.test(String(id) + '.jsonl') && !cleanIds.includes(id)))],
      'projectless-thread-ids': projectlessIds,
      'legacy-projectless-thread-ids': legacyProjectlessIds,
      'thread-workspace-root-hints': workspaceHints,
      updatedAt: Date.now(),
    };
    const temporary = this.sideChatStateFile + '.tmp-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    writeFileSync(temporary, JSON.stringify(payload) + String.fromCharCode(10), { mode: 0o600 });
    renameSync(temporary, this.sideChatStateFile);
    return payload;
  }

  refreshSideChatState(state = null) {
    let snapshot = state;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      try {
        snapshot = JSON.parse(readFileSync(this.globalStateFile, 'utf8'));
      } catch {
        snapshot = {};
      }
    }

    const globalRaw = snapshot?.['side-chat-thread-ids'];
    const globalIds = Array.isArray(globalRaw)
      ? globalRaw
      : globalRaw && typeof globalRaw === 'object'
        ? Object.keys(globalRaw)
        : [];
    const globalSources = (snapshot?.['side-chat-source-threads']
      && typeof snapshot['side-chat-source-threads'] === 'object'
      && !Array.isArray(snapshot['side-chat-source-threads']))
      ? snapshot['side-chat-source-threads']
      : {};

    const local = this.readLocalSideChatState();
    const ignoredIds = new Set(local.ignoredIds
      .map((id) => String(id || '').trim().toLowerCase())
      .filter(Boolean));
    const mergedIds = new Set();
    const mergedSources = new Map();

    for (const list of [globalIds, local.ids]) {
      for (const id of list || []) {
        const threadId = String(id || '').trim().toLowerCase();
        if (!SESSION_ID_PATTERN.test(String(threadId) + '.jsonl')) continue;
        if (ignoredIds.has(threadId)) continue;
        mergedIds.add(threadId);
      }
    }
    for (const sources of [globalSources, local.sources]) {
      for (const [id, source] of Object.entries(sources || {})) {
        const threadId = String(id || '').trim().toLowerCase();
        const sourceThreadId = String(source || '').trim().toLowerCase();
        if (!SESSION_ID_PATTERN.test(String(threadId) + '.jsonl')) continue;
        if (!mergedIds.has(threadId)) continue;
        if (!mergedSources.has(threadId) || sourceThreadId) {
          mergedSources.set(
            threadId,
            SESSION_ID_PATTERN.test(String(sourceThreadId) + '.jsonl') ? sourceThreadId : '',
          );
        }
      }
    }

    this.sideChatThreadIds = mergedIds;
    this.sideChatSourceThreads = mergedSources;

    // Keep a durable local copy even if Codex App rewrites global state.
    try {
      this.writeLocalSideChatState([...mergedIds], Object.fromEntries(mergedSources));
    } catch {}
  }

  listPinnedThreadIds() {
    return [...this.pinnedThreadIds];
  }

  workspaceKindForThread(id) {
    const threadId = String(id || '').trim().toLowerCase();
    if (!this.workspaceStateAvailable || !SESSION_ID_PATTERN.test(`${threadId}.jsonl`)) return '';
    if (this.projectlessThreadIds.has(threadId)) return 'projectless';
    return 'project';
  }

  markProjectlessThread(id, options = {}) {
    const threadId = String(id || '').trim().toLowerCase();
    if (!SESSION_ID_PATTERN.test(`${threadId}.jsonl`)) return false;
    const local = this.readLocalSideChatState();
    const ids = local.projectlessIds.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
    if (!ids.includes(threadId)) ids.push(threadId);
    const cwd = String(options.cwd || '').trim();
    const workspaceHints = { ...local.workspaceHints };
    if (cwd) workspaceHints[threadId] = cwd;
    this.writeLocalSideChatState(local.ids, local.sources, {
      projectlessIds: ids,
      legacyProjectlessIds: local.legacyProjectlessIds.filter((value) => (
        String(value || '').trim().toLowerCase() !== threadId
      )),
      workspaceHints,
    });
    this.projectlessThreadIds.add(threadId);
    this.projectThreadIds.delete(threadId);
    this.workspaceStateAvailable = true;
    this.scheduleRefresh();
    return true;
  }

  isSideChatThread(id) {
    const threadId = String(id || '').trim().toLowerCase();
    return Boolean(threadId) && this.sideChatThreadIds.has(threadId);
  }

  sideChatSourceThreadId(id) {
    const threadId = String(id || '').trim().toLowerCase();
    return this.sideChatSourceThreads.get(threadId) || '';
  }

  markSideChatThread(id, options = {}) {
    const threadId = String(id || '').trim().toLowerCase();
    if (!SESSION_ID_PATTERN.test(String(threadId) + '.jsonl')) return false;
    const local = this.readLocalSideChatState();
    const ids = local.ids.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
    if (!ids.includes(threadId)) ids.push(threadId);

    const sourceThreadId = String(options.sourceThreadId || '').trim().toLowerCase();
    const sources = { ...local.sources };
    if (sourceThreadId && SESSION_ID_PATTERN.test(String(sourceThreadId) + '.jsonl')) {
      sources[threadId] = sourceThreadId;
    } else if (!sources[threadId]) {
      sources[threadId] = '';
    }
    this.writeLocalSideChatState(ids, sources, {
      ignoredIds: local.ignoredIds.filter((value) => String(value || '').trim().toLowerCase() !== threadId),
    });

    this.sideChatThreadIds.add(threadId);
    this.sideChatSourceThreads.set(threadId, sources[threadId] || '');
    this.scheduleRefresh();
    return true;
  }

  unmarkSideChatThread(id) {
    const threadId = String(id || '').trim().toLowerCase();
    if (!SESSION_ID_PATTERN.test(String(threadId) + '.jsonl')) return false;
    const local = this.readLocalSideChatState();
    const ids = local.ids.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
    const nextIds = ids.filter((value) => value !== threadId);
    if (nextIds.length === ids.length && !this.sideChatThreadIds.has(threadId)) return false;
    const sources = { ...local.sources };
    if (sources[threadId] !== undefined) {
      delete sources[threadId];
    }
    this.writeLocalSideChatState(nextIds, sources, {
      ignoredIds: [...new Set([...local.ignoredIds, threadId])],
    });

    this.sideChatThreadIds.delete(threadId);
    this.sideChatSourceThreads.delete(threadId);
    this.scheduleRefresh();
    return true;
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
        if (Number(row.is_automation) === 1 && !this.pinnedThreadIds.includes(id)) continue;
        if (!rolloutPath) continue;
        const rawThreadSettings = {};
        if (Number(row.has_model_provider) === 1) rawThreadSettings.modelProvider = row.model_provider;
        if (Number(row.has_model) === 1) rawThreadSettings.model = row.model;
        if (Number(row.has_reasoning_effort) === 1) rawThreadSettings.reasoningEffort = row.reasoning_effort;
        const threadSettings = normalizeThreadSettings(rawThreadSettings);
        next.set(id, {
          rolloutPath: path.resolve(rolloutPath),
          cwd: String(row.cwd || '').trim(),
          workspaceKind: this.workspaceStateAvailable ? this.workspaceKindForThread(id) : '',
          title: cleanTitle(row.title),
          createdAtMs: timestampMs(row.created_at_ms),
          updatedAtMs: timestampMs(row.updated_at_ms),
          recencyAtMs: timestampMs(row.recency_at_ms),
          threadSettings,
          settingsUpdatedAtMs: Object.keys(threadSettings).length ? timestampMs(row.updated_at_ms) : 0,
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

  refreshThreadGoals() {
    let stamp = '';
    try {
      const stat = statSync(this.goalsDbFile);
      stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      stamp = '';
    }
    for (const suffix of ['-wal', '-shm']) {
      try {
        const stat = statSync(this.goalsDbFile + suffix);
        stamp += `|${suffix}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
      } catch {}
    }
    if (stamp && stamp === this.goalsStamp) return [];

    const previous = this.threadGoals;
    const next = new Map();
    try {
      if (existsSync(this.goalsDbFile)) {
        const db = new DatabaseSync(this.goalsDbFile, { readOnly: true, timeout: 500 });
        try {
          const rows = db.prepare(`
            SELECT thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms
            FROM thread_goals
          `).all();
          for (const row of rows) {
            const goal = normalizeThreadGoal(row, row.thread_id);
            if (goal) next.set(goal.threadId, goal);
          }
        } finally {
          try { db.close(); } catch {}
        }
      }
      this.goalsStamp = stamp || 'empty';
    } catch {
      if (previous.size) return [];
      this.goalsStamp = stamp || this.goalsStamp || 'error';
      return [];
    }

    this.threadGoals = next;
    const changed = [];
    const ids = new Set([...previous.keys(), ...next.keys()]);
    for (const id of ids) {
      if (!sameThreadGoal(previous.get(id), next.get(id))) changed.push(id);
    }
    for (const id of changed) {
      const cache = this.details.get(id);
      if (!cache) continue;
      const dbGoal = next.get(id) || null;
      if (dbGoal) this.clearedThreadGoalIds.delete(id);
      attachThreadGoal(
        cache,
        this.clearedThreadGoalIds.has(id) ? null : resolveThreadGoal(cache.goal, dbGoal),
      );
    }
    return changed;
  }

  applyThreadGoal(rawGoal, fallbackThreadId = '') {
    const goal = normalizeThreadGoal(rawGoal, fallbackThreadId);
    if (!goal) return false;

    const previous = this.threadGoals.get(goal.threadId) || null;
    this.threadGoals.set(goal.threadId, goal);
    this.clearedThreadGoalIds.delete(goal.threadId);
    const cacheChanged = attachThreadGoal(this.details.get(goal.threadId), goal);
    if (sameThreadGoal(previous, goal) && !cacheChanged) return false;

    this.version += 1;
    this.emit('change', { version: this.version, changedIds: [goal.threadId] });
    return true;
  }

  clearThreadGoal(id) {
    const threadId = String(id || '').trim().toLowerCase();
    if (!SESSION_ID_PATTERN.test(`${threadId}.jsonl`)) return false;

    const alreadyCleared = this.clearedThreadGoalIds.has(threadId);
    const hadGoal = this.threadGoals.delete(threadId);
    const cacheChanged = attachThreadGoal(this.details.get(threadId), null);
    this.clearedThreadGoalIds.add(threadId);
    if (alreadyCleared && !hadGoal && !cacheChanged) return false;

    this.version += 1;
    this.emit('change', { version: this.version, changedIds: [threadId] });
    return true;
  }

  applyThreadSettings(rawSettings, fallbackThreadId = '') {
    const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const threadId = String(source.threadId || source.thread_id || fallbackThreadId || '').trim().toLowerCase();
    if (!SESSION_ID_PATTERN.test(`${threadId}.jsonl`)) return null;

    const settings = normalizeThreadSettings(source.threadSettings || source.thread_settings || source);
    if (!Object.keys(settings).length) return null;

    const updatedAtMs = Date.now();
    const previous = this.threadSettingsOverrides.get(threadId) || {};
    const overlay = { ...previous, ...settings, updatedAtMs };
    this.threadSettingsOverrides.set(threadId, overlay);
    const cache = this.details.get(threadId);
    if (cache) {
      const merged = mergeThreadSettingsMetadata(cache.metadata, overlay, updatedAtMs);
      if (merged.changed) cache.metadata = merged.metadata;
    }

    this.version += 1;
    this.emit('change', { version: this.version, changedIds: [threadId] });
    return { ...overlay };
  }

  applyPersistedThreadSettings(cache, entry) {
    if (!cache || !entry) return false;
    const threadId = String(entry.id || '').trim().toLowerCase();
    const persisted = entry.threadSettings || {};
    const persistedUpdatedAtMs = Number(entry.settingsUpdatedAtMs) || 0;
    let overlay = this.threadSettingsOverrides.get(threadId) || null;

    if (overlay) {
      const overlayUpdatedAtMs = Number(overlay.updatedAtMs) || 0;
      const persistedMatchesOverlay = threadSettingsMatch(persisted, overlay);
      const persistedIsNewer = persistedUpdatedAtMs > overlayUpdatedAtMs;
      if (persistedMatchesOverlay || persistedIsNewer) {
        this.threadSettingsOverrides.delete(threadId);
        overlay = null;
      }
    }

    const settings = overlay || persisted;
    if (!Object.keys(settings).length) return false;
    const updatedAtMs = overlay ? Number(overlay.updatedAtMs) || 0 : persistedUpdatedAtMs;
    const merged = mergeThreadSettingsMetadata(cache.metadata, settings, updatedAtMs);
    if (merged.changed) cache.metadata = merged.metadata;
    return merged.changed;
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
        const summary = sessionSummary(entry, status);
        if (this.isSideChatThread(entry.id)) {
          summary.sideChat = true;
          summary.sideChatSourceThreadId = this.sideChatSourceThreadId(entry.id) || '';
        }
        return summary;
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

  accumulateDeepSeekUsage(cache, payload) {
    if (!this.deepSeekUsageFile) return;
    const model = String(cache?.metadata?.model || '').trim().toLowerCase();
    if (!model.startsWith('deepseek')) return;
    const usage = cache?.currentTurnTokenUsage;
    const total = Number(usage?.totalTokens);
    if (!Number.isFinite(total) || total <= 0) return;
    const turnKey = `${String(cache?.id || '')}:${String(payload?.turn_id || payload?.turnId || cache?.latestTurnId || '')}`;
    if (!turnKey || turnKey.endsWith(':')) return;
    try {
      const current = readDeepSeekUsageStatsFile(this.deepSeekUsageFile) || {};
      const counted = Array.isArray(current.countedTurns) ? current.countedTurns : [];
      if (counted.includes(turnKey)) return;
      const input = Math.max(0, Number(usage.inputTokens) || 0);
      const cached = Math.max(0, Number(usage.cachedInputTokens) || 0);
      const output = Math.max(0, Number(usage.outputTokens) || 0);
      const next = {
        totalTokens: (Number(current.totalTokens) || 0) + total,
        inputTokens: (Number(current.inputTokens) || 0) + input,
        outputTokens: (Number(current.outputTokens) || 0) + output,
        cachedInputTokens: (Number(current.cachedInputTokens) || 0) + cached,
        requests: (Number(current.requests) || 0) + 1,
        updatedAt: new Date().toISOString(),
        countedTurns: [...counted.slice(-999), turnKey],
      };
      writeFileSync(this.deepSeekUsageFile, JSON.stringify(next, null, 2));
    } catch {}
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

    readSessionUpdates(cache, entry, this.maxMessages, this);
    this.applyPersistedThreadSettings(cache, entry);
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
    const dbGoal = this.threadGoals.get(String(entry.id || '').trim().toLowerCase()) || null;
    if (dbGoal) this.clearedThreadGoalIds.delete(entry.id);
    attachThreadGoal(
      cache,
      this.clearedThreadGoalIds.has(entry.id) ? null : resolveThreadGoal(cache.goal, dbGoal),
    );
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
  const modelProviderColumn = columns.has('model_provider') ? 'model_provider' : 'NULL';
  const modelColumn = columns.has('model') ? 'model' : 'NULL';
  const reasoningEffortColumn = columns.has('reasoning_effort') ? 'reasoning_effort' : 'NULL';
  const automationThread = `(
    ${threadSource} = 'automation'
    OR (
      preview LIKE 'Automation:%'
      AND preview LIKE '%Automation ID:%'
      AND preview LIKE '%Automation memory:%'
    )
  )`;
  return db.prepare(`
    SELECT id, rollout_path, source, cwd, title, created_at_ms, updated_at_ms,
      ${recencyColumn} AS recency_at_ms,
      ${modelProviderColumn} AS model_provider,
      ${modelColumn} AS model,
      ${reasoningEffortColumn} AS reasoning_effort,
      ${columns.has('model_provider') ? 1 : 0} AS has_model_provider,
      ${columns.has('model') ? 1 : 0} AS has_model,
      ${columns.has('reasoning_effort') ? 1 : 0} AS has_reasoning_effort,
      CASE WHEN ${automationThread} THEN 1 ELSE 0 END AS is_automation
    FROM threads
    WHERE archived = 0
      AND preview <> ''
      AND cli_version <> ''
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

function readDeepSeekUsageStatsFile(file) {
  try {
    if (!file || !existsSync(file)) return null;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch {
    return null;
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

function scanSessionFiles(
  root,
  titles,
  appThreads = null,
  workspaceKindForThread = null,
  sessionMetadataCache = null,
) {
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
      if (appThread?.rolloutPath && !sameLocalPath(filePath, appThread.rolloutPath)) continue;

      try {
        const stat = statSync(filePath);
        const title = titles.get(id)?.title || appThread?.title || `Codex ${id.slice(0, 8)}`;
        const createdAtMs = appThread?.createdAtMs || stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs;
        const recencyMs = appThread?.recencyAtMs || appThread?.updatedAtMs || stat.mtimeMs;
        const sessionMetadata = sessionMetadataCache
          ? cachedSessionMetadata(sessionMetadataCache, id, filePath, stat.ino)
          : appThread?.cwd ? null : sessionMetadataFromFirstRecord(readFirstRecord(filePath));
        const entry = {
          id,
          title,
          cwd: appThread?.cwd || sessionMetadata?.cwd || '',
          originator: sessionMetadata?.originator || '',
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
          threadSettings: appThread?.threadSettings || {},
          settingsUpdatedAtMs: appThread?.settingsUpdatedAtMs || 0,
        };
        const previous = entries.get(id);
        if (!previous || entry.recencyMs > previous.recencyMs) entries.set(id, entry);
      } catch {}
    }
  }

  return entries;
}

function sameLocalPath(left, right) {
  const normalize = (value) => {
    let normalized = path.resolve(value);
    if (process.platform !== 'win32') return normalized;

    const extendedUncPrefix = '\\\\?\\UNC\\';
    const extendedPathPrefix = '\\\\?\\';
    if (normalized.toUpperCase().startsWith(extendedUncPrefix.toUpperCase())) {
      normalized = '\\\\' + normalized.slice(extendedUncPrefix.length);
    } else if (normalized.startsWith(extendedPathPrefix)) {
      normalized = normalized.slice(extendedPathPrefix.length);
    }
    return normalized.toLowerCase();
  };
  return normalize(left) === normalize(right);
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
  return `${entry.filePath}:${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.recencyMs}:${entry.title}:${entry.cwd}:${entry.originator || ''}:${entry.workspaceKind || ''}:${entry.parentThreadId || ''}:${entry.agentPath || ''}:${entry.settingsUpdatedAtMs || 0}:${JSON.stringify(entry.threadSettings || {})}`;
}

function sessionSummary(entry, status) {
  return {
    id: entry.id,
    source: 'codex',
    title: entry.title,
    cwd: entry.cwd || '',
    originator: entry.originator || '',
    workspaceKind: entry.workspaceKind || '',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    status,
    readOnly: false,
  };
}

function cachedSessionMetadata(cache, id, filePath, ino) {
  const previous = cache.get(id);
  if (previous?.filePath === filePath && previous.ino === ino) return previous.metadata;

  const metadata = sessionMetadataFromFirstRecord(readFirstRecord(filePath));
  if (metadata) cache.set(id, { filePath, ino, metadata });
  else cache.delete(id);
  return metadata;
}

function sessionMetadataFromFirstRecord(record) {
  if (record?.type !== 'session_meta' || !record.payload || typeof record.payload !== 'object') return null;
  return {
    cwd: String(record.payload.cwd || '').trim(),
    originator: String(record.payload.originator || '').trim(),
  };
}

function pruneSessionMetadataCache(cache, entries) {
  for (const [id, cached] of cache) {
    const entry = entries.get(id);
    if (!entry || entry.filePath !== cached.filePath || entry.ino !== cached.ino) cache.delete(id);
  }
}

function createDetailCache(entry, options) {
  const maxReadBytes = Number(options.maxReadBytes);
  const startOffset = Number.isFinite(maxReadBytes) && maxReadBytes > 0
    ? Math.max(0, entry.size - maxReadBytes)
    : 0;
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
    pendingGoalUpdates: new Map(),
    responseAnnotationsByTurn: new Map(),
    metadata: { workspaceKind: entry.workspaceKind || '' },
    goal: null,
    currentTurnId: '',
    previousTurnId: '',
    status: Date.now() - entry.mtimeMs <= options.runningWindowMs ? 'running' : 'done',
    latestTurnId: '',
    currentTurnStartedAt: '',
    currentTurnTokenUsage: null,
    currentTurnTokenUsageBaseline: null,
    currentTurnFallbackTokenUsage: null,
    latestTotalTokenUsage: null,
    contextUsedTokens: null,
    contextWindowTokens: null,
    turnStartScanComplete: startOffset === 0,
    displayUserMessagesInTurn: 0,
    pendingThreadRollbackTurnId: '',
    retryFallbackAssistant: null,
    lastTimestamp: '',
    subagentTurnIds: new Set(),
    contentMutated: false,
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

function readSessionUpdates(cache, entry, maxMessages, store) {
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
      cache.remainder = consumeJsonlBuffer(cache, data, maxMessages, store);
    }
    cache.offset = position;
    cache.size = entry.size;
    cache.mtimeMs = entry.mtimeMs;
    if (cache.contentMutated) {
      // One generation bump per read pass so merged content invalidates clients without thrashing.
      cache.generation += 1;
      cache.contentMutated = false;
    }
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

function consumeJsonlBuffer(cache, data, maxMessages, store) {
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
      applyNativeRecord(cache, JSON.parse(line.toString('utf8')), maxMessages, store);
    } catch {}
  }
  return start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
}

function applyNativeRecord(cache, record, maxMessages, store) {
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
    if (payload.type === 'task_complete') store?.accumulateDeepSeekUsage(cache, payload);
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
      const goalStatus = extractUpdateGoalStatus(name, input);
      if (goalStatus) {
        if (callId) cache.pendingGoalUpdates.set(callId, goalStatus);
        markThreadGoalStatusFromTool(cache, goalStatus, record);
      }
      break;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = String(payload.call_id || '');
      const name = cache.calls.get(callId) || 'tool';
      const expectedGoalStatus = cache.pendingGoalUpdates.get(callId) || '';
      if (expectedGoalStatus) {
        const outputGoal = extractThreadGoalFromToolOutput(payload.output);
        if (outputGoal) mergeThreadGoalFromToolOutput(cache, outputGoal, expectedGoalStatus, record);
        cache.pendingGoalUpdates.delete(callId);
      }
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
    const metadataId = String(payload.id || '').trim().toLowerCase();
    const cacheId = String(cache.id || '').trim().toLowerCase();
    if (metadataId && cacheId && metadataId !== cacheId) return;
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
      approvalsReviewer: payload.approvals_reviewer || cache.metadata.approvalsReviewer || '',
      sandboxPolicy: normalizeSandboxPolicy(payload.sandbox_policy) || cache.metadata.sandboxPolicy || '',
      timezone: payload.timezone || cache.metadata.timezone || '',
    };
  }
}

function applyEventRecord(cache, record, payload, maxMessages) {
  const turnId = String(payload.turn_id || payload.turnId || '');
  if (turnId) cache.latestTurnId = turnId;
  if (payload.type === 'task_started') {
    updateNativeTurnId(cache, turnId);
    cache.currentTurnTokenUsage = null;
    cache.currentTurnTokenUsageBaseline = tokenUsageBaseline(cache.latestTotalTokenUsage);
    cache.currentTurnFallbackTokenUsage = null;
    const contextWindowTokens = normalizeContextTokenCount(payload.model_context_window);
    if (contextWindowTokens !== null) cache.contextWindowTokens = contextWindowTokens;
  }
  switch (payload.type) {
    case 'thread_settings_applied': {
      const settings = payload.thread_settings;
      if (!settings || typeof settings !== 'object') break;
      const appliedAtMs = Date.parse(String(record.timestamp || ''));
      const merged = mergeThreadSettingsMetadata(
        cache.metadata,
        normalizeThreadSettings(settings),
        Number.isFinite(appliedAtMs) ? appliedAtMs : 0,
      );
      const next = merged.metadata;
      let changed = merged.changed;
      if (Object.hasOwn(settings, 'approval_policy')) {
        const approvalPolicy = String(settings.approval_policy || '').trim();
        if (approvalPolicy) {
          next.approvalPolicy = approvalPolicy;
          changed = true;
        }
      }
      if (Object.hasOwn(settings, 'approvals_reviewer')) {
        const approvalsReviewer = String(settings.approvals_reviewer || '').trim();
        if (approvalsReviewer) {
          next.approvalsReviewer = approvalsReviewer;
          changed = true;
        }
      }
      if (Object.hasOwn(settings, 'sandbox_policy')) {
        const sandboxPolicy = normalizeSandboxPolicy(settings.sandbox_policy);
        if (sandboxPolicy) {
          next.sandboxPolicy = sandboxPolicy;
          changed = true;
        }
      }
      if (!changed) break;
      cache.metadata = next;
      break;
    }
    case 'task_started':
      cache.status = 'running';
      if (!cache.currentTurnStartedAt) cache.currentTurnStartedAt = String(record.timestamp || '');
      cache.turnStartScanComplete = true;
      appendNativeMessage(cache, 'process', '任务开始', record, maxMessages, payload.type);
      break;
    case 'task_complete': {
      const errorMessage = nativeEventErrorMessage(payload.error);
      if (errorMessage) {
        cache.status = 'error';
        restoreRolledBackRetryAssistant(cache, maxMessages);
        appendNativeMessage(cache, 'process', errorMessage, record, maxMessages, 'task_error', {
          ...(cache.currentTurnTokenUsage ? { tokenUsage: { ...cache.currentTurnTokenUsage } } : {}),
        });
        break;
      }
      cache.status = 'done';
      restoreRolledBackRetryAssistant(cache, maxMessages);
      // Promote the latest unphased assistant bubble of this turn to final_answer so Web history
      // keeps intermediate progress separate from the permanent reply.
      promoteLatestAssistantFinalAnswer(cache);
      const duration = Number(payload.duration_ms);
      const content = Number.isFinite(duration) ? `任务完成，耗时 ${(duration / 1000).toFixed(1)}s` : '任务完成';
      appendNativeMessage(cache, 'process', content, record, maxMessages, payload.type, {
        ...(cache.currentTurnTokenUsage ? { tokenUsage: { ...cache.currentTurnTokenUsage } } : {}),
      });
      break;
    }
    case 'token_count': {
      updateCurrentTurnTokenUsage(
        cache,
        payload.info?.last_token_usage,
        payload.info?.total_token_usage,
      );
      const contextUsedTokens = normalizeContextUsedTokens(payload.info?.last_token_usage);
      if (contextUsedTokens !== null) cache.contextUsedTokens = contextUsedTokens;
      const contextWindowTokens = normalizeContextTokenCount(
        payload.info?.model_context_window ?? payload.model_context_window,
      );
      if (contextWindowTokens !== null) cache.contextWindowTokens = contextWindowTokens;
      break;
    }
    case 'turn_aborted':
      cache.status = 'interrupted';
      restoreRolledBackRetryAssistant(cache, maxMessages);
      appendNativeMessage(
        cache,
        'process',
        payload.message || nativeEventErrorMessage(payload.error, '任务已暂停'),
        record,
        maxMessages,
        payload.type,
      );
      break;
    case 'task_error':
    case 'error':
      cache.status = 'error';
      restoreRolledBackRetryAssistant(cache, maxMessages);
      appendNativeMessage(
        cache,
        'process',
        payload.message || nativeEventErrorMessage(payload.error, '任务中断'),
        record,
        maxMessages,
        payload.type,
      );
      break;
    case 'thread_rolled_back':
      cache.pendingThreadRollbackTurnId = cache.currentTurnId || cache.latestTurnId || '';
      break;
    case 'context_compacted':
      if (cache.messages.at(-1)?.kind !== 'context_compacted') {
        appendNativeMessage(cache, 'process', '上下文已自动压缩', record, maxMessages, payload.type);
      }
      break;
    case 'thread_goal_updated': {
      const goal = normalizeThreadGoal(payload.goal || payload, cache.id || payload.threadId || payload.thread_id);
      if (goal) {
        cache.goal = goal;
        cache.contentMutated = true;
      }
      break;
    }
    default:
      break;
  }
}

function nativeEventErrorMessage(error, fallback = '') {
  if (typeof error === 'string') return error.trim() || fallback;
  if (error && typeof error === 'object') {
    const direct = error.message ?? error.error ?? error.detail;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    try {
      const serialized = JSON.stringify(error, null, 2);
      if (serialized && serialized !== '{}') return serialized;
    } catch {}
  }
  return fallback;
}

function applyCompactedRecord(cache, record, maxMessages) {
  dropRawHandoffBeforeCompaction(cache, record);
  if (cache.messages.at(-1)?.kind !== 'context_compacted') {
    appendNativeMessage(cache, 'process', '上下文已自动压缩', record, maxMessages, 'context_compacted');
  }
  // A browser may have read the internal handoff summary before the compacted
  // record landed. Changing the generation forces its next poll to reset.
  cache.generation += 1;
}

function dropRawHandoffBeforeCompaction(cache, record) {
  const compactedAt = Date.parse(record.timestamp || '');
  // Scan recent tail so interleaved tools after a handoff still get cleaned up.
  for (let index = cache.messages.length - 1; index >= 0; index -= 1) {
    const message = cache.messages[index];
    const messageAt = Date.parse(message?.at || '');
    const followsHandoffQuickly = Number.isFinite(messageAt)
      && Number.isFinite(compactedAt)
      && compactedAt >= messageAt
      && compactedAt - messageAt <= 5000;
    const embeddedHandoff = compactedRecordContainsHandoff(record, message);
    if (!followsHandoffQuickly && !embeddedHandoff) {
      if (message?.role === 'tool' || message?.role === 'process') continue;
      break;
    }
    const linkedEmbeddedHandoff = embeddedHandoff && (followsHandoffQuickly || message.kind === 'message');
    if (
      message?.role === 'assistant'
      && (
        linkedEmbeddedHandoff
        || (message.kind === 'final_answer' && isHandoffSummaryText(message.content))
      )
    ) {
      // A compacted handoff may omit phase, so embedded summaries are not always final_answer.
      cache.messages.splice(index, 1);
      return;
    }
    if (message?.role === 'context' && message.kind === 'handoff_summary') return;
    if (message?.role === 'tool' || message?.role === 'process') continue;
    break;
  }
}

function compactedRecordContainsHandoff(record, message) {
  const content = String(message?.content || '').trim();
  const compactedMessage = String(record?.payload?.message || '');
  const envelope = 'Another language model started to solve this problem';
  if (content.length < 24 || !compactedMessage.startsWith(envelope)) return false;
  return compactedMessage.includes(content.slice(0, Math.min(240, content.length)));
}

function isHandoffSummaryText(text) {
  const normalized = String(text || '').replace(/\r\n/g,'\n').trim();
  if (!normalized) return false;
  const firstLine = normalized.split('\n', 1)[0].trim();
  const plain = firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\*{1,2}|\*{1,2}$/g, '')
    .replace(/^_+|_+$/g, '')
    .trim()
    .toLowerCase();
  if (
    plain === 'handoff'
    || plain === 'handoff summary'
    || plain === 'compacted handoff summary'
    || plain === 'context checkpoint'
    || plain.startsWith('handoff:')
    || plain.startsWith('handoff summary:')
    || plain.startsWith('compacted handoff')
    || plain.startsWith('context checkpoint:')
    || plain.startsWith('交接摘要')
    || /^\*\*handoff(?:\s+summary)?\*\*/i.test(firstLine)
    || /^\*\*compacted handoff(?:\s+summary)?\*\*/i.test(firstLine)
  ) return true;
  // Collab handoffs may omit a clean title but still ship the standard sections.
  const head = normalized.slice(0, 6000).toLowerCase();
  const structuredChineseHandoff = plain === '当前状态' && [
    '最新需求：',
    '当前源码仍是',
    '上一轮已完成并需保留',
    '## 下一步',
    '工作树有大量',
    '禁止清理或回滚',
  ].every((signal) => head.includes(signal));
  if (structuredChineseHandoff) return true;
  const hasGoal = head.includes('## goal') || head.includes('## 目标') || head.startsWith('goal\n') || head.startsWith('目标\n');
  const hasOps = head.includes('service / ops')
    || head.includes('immediate next steps')
    || head.includes('already done')
    || head.includes('key files')
    || head.includes('key decisions')
    || head.includes('what remains')
    || head.includes('critical references')
    || head.includes('next immediate')
    || head.includes('constraints')
    || head.includes('current status')
    || head.includes('key findings')
    || head.includes('important constraints')
    || head.includes('useful references')
    || head.includes('open decisions')
    || head.includes('likely design')
    || head.includes('investigation started');
  const structuredHandoffSections = [
    '## current state',
    '## findings',
    '## browser state',
    '## agents',
    '## next steps',
    '## 当前状态',
    '## 发现',
    '## 浏览器状态',
    '## 代理',
    '## 后续步骤',
  ].filter((section) => head.includes(section)).length;
  const hasActiveGoalMarker = head.includes('active goal:');
  return hasGoal && (hasOps || structuredHandoffSections >= 3 || (hasActiveGoalMarker && structuredHandoffSections >= 2));
}

function shouldHideHandoffMessage(message) {
  if (!message) return false;
  if (message.role === 'context' && message.kind === 'handoff_summary') return true;
  if (message.role === 'assistant' && isHandoffSummaryText(message.content)) return true;
  return false;
}
function applyMessageRecord(cache, record, payload, maxMessages) {
  if (!['user', 'assistant'].includes(payload.role)) return;
  const text = contentText(payload.content);
  const images = contentImages(payload.content);
  if (!text && !images.length) return;
  const turnId = String(
    payload.internal_chat_message_metadata_passthrough?.turn_id
    || payload.internal_chat_message_metadata_passthrough?.turnId
    || cache.currentTurnId
    || '',
  );
  if (payload.role === 'user') {
    const responseAnnotations = responseAnnotationsFromText(text);
    if (turnId && responseAnnotations.length) cache.responseAnnotationsByTurn.set(turnId, responseAnnotations);
  }
  const browserComments = payload.role === 'user' && isBrowserCommentsMessage(text);
  const browserCommentMeta = browserComments ? browserCommentsMetadata(text) : null;
  const contexts = payload.role === 'user' ? normalizeInjectedContexts(text) : [];
  if (text && !contexts.length && isInjectedWorkspaceInstructions(payload.role, text)) return;
  const displayText = payload.role === 'user' ? normalizeUserDisplayText(text) : text;
  let messageKind = payload.phase || 'message';
  if (payload.role === 'assistant' && !payload.phase && displayText) {
    // When the runtime omits phase, classify short intermediate chatter as commentary
    // so completed history can keep it under process while leaving the final bubble intact.
    messageKind = isProgressStyleText(displayText) ? 'commentary' : 'message';
  }
  if (payload.role === 'user' && !contexts.length && (displayText || images.length)) {
    if (cache.displayUserMessagesInTurn === 0) {
      if (turnId && turnId === cache.currentTurnId) {
        collapseRolledBackRetryTurn(cache, displayText, images.length > 0);
      } else {
        cache.pendingThreadRollbackTurnId = '';
        cache.retryFallbackAssistant = null;
      }
    }
    if (browserComments) {
      messageKind = 'steering_browser_comment';
    } else if (
      turnId
      && turnId === cache.currentTurnId
      && cache.displayUserMessagesInTurn > 0
      && !isAutomationHeartbeatMessage(displayText)
    ) {
      messageKind = 'steering_user';
    }
    cache.displayUserMessagesInTurn += 1;
  }
  if (contexts.length) {
    for (const context of contexts) {
      appendNativeMessage(cache, 'context', context.content, record, maxMessages, context.kind);
    }
  } else if (displayText && payload.role === 'assistant' && isHandoffSummaryText(displayText)) {
    // Internal agent handoff must not surface in the Web chat UI.
  } else if (displayText) {
    const responseAnnotations = payload.role === 'assistant' && /:codex-annotation\{index=/.test(displayText)
      ? cache.responseAnnotationsByTurn.get(turnId || cache.currentTurnId)
      : null;
    const messageMetadata = browserCommentMeta
      || (responseAnnotations?.length ? { responseAnnotations: responseAnnotations.map((item) => ({ ...item })) } : null);
    appendNativeMessage(cache, payload.role, displayText, record, maxMessages, messageKind, messageMetadata);
  }
  const imageKind = payload.role === 'user'
    ? ['steering_user', 'steering_browser_comment'].includes(messageKind) ? 'steering_input_image' : 'input_image'
    : 'output_image';
  for (const image of images) appendNativeMessage(cache, 'image', image, record, maxMessages, imageKind);
}

function collapseRolledBackRetryTurn(cache, displayText, hasImages) {
  const rolledBackTurnId = String(cache.pendingThreadRollbackTurnId || '');
  cache.pendingThreadRollbackTurnId = '';
  if (!rolledBackTurnId || hasImages || !isExplicitRetryRequest(displayText)) {
    cache.retryFallbackAssistant = null;
    return false;
  }

  const currentTurnId = String(cache.currentTurnId || '');
  if (!currentTurnId || currentTurnId === rolledBackTurnId) {
    cache.retryFallbackAssistant = null;
    return false;
  }

  const rolledBackMessages = cache.messages.filter((message) => message.turnId === rolledBackTurnId);
  const rolledBackUsers = rolledBackMessages.filter((message) => message.role === 'user');
  if (
    rolledBackUsers.length !== 1
    || !['', 'message'].includes(String(rolledBackUsers[0].kind || ''))
    || !isExplicitRetryRequest(rolledBackUsers[0].content)
    || rolledBackMessages.some((message) => message.role === 'image')
  ) {
    cache.retryFallbackAssistant = null;
    return false;
  }

  const previousTurnId = String(rolledBackUsers[0].previousTurnId || '');
  const fallback = latestRetryAssistantResult(rolledBackMessages) || cache.retryFallbackAssistant;
  cache.messages = cache.messages.filter((message) => message.turnId !== rolledBackTurnId);
  for (const message of cache.messages) {
    if (message.turnId === currentTurnId) message.previousTurnId = previousTurnId || undefined;
  }
  cache.previousTurnId = previousTurnId;
  cache.retryFallbackAssistant = fallback ? { ...fallback } : null;
  cache.contentMutated = true;
  return true;
}

function isExplicitRetryRequest(text) {
  return String(text || '').replace(/\s+/g, '') === '重试';
}

function latestRetryAssistantResult(messages) {
  const candidates = messages.filter((message) => (
    message.role === 'assistant'
    && !shouldHideHandoffMessage(message)
    && ['', 'message', 'final_answer'].includes(String(message.kind || ''))
  ));
  return [...candidates].reverse().find((message) => message.kind === 'final_answer')
    || [...candidates].reverse().find((message) => !isProgressStyleText(message.content))
    || null;
}

function restoreRolledBackRetryAssistant(cache, maxMessages) {
  const fallback = cache.retryFallbackAssistant;
  if (!fallback) return;
  cache.retryFallbackAssistant = null;
  const currentTurnId = String(cache.currentTurnId || '');
  if (!currentTurnId) return;
  const currentMessages = cache.messages.filter((message) => message.turnId === currentTurnId);
  if (currentMessages.some((message) => (
    message.role === 'assistant'
    && !shouldHideHandoffMessage(message)
    && canMergeAssistantKind(message.kind)
  ))) return;

  cache.messages.push({
    ...fallback,
    seq: cache.nextSequence++,
    kind: 'final_answer',
    turnId: currentTurnId,
    previousTurnId: cache.previousTurnId || undefined,
    retrySourceTurnId: fallback.retrySourceTurnId || fallback.turnId || undefined,
  });
  trimNativeMessages(cache, maxMessages);
}

function isBrowserCommentsMessage(text) {
  return String(text || '').replace(/\r\n/g, '\n').trimStart().startsWith('# Browser comments:');
}

function isAutomationHeartbeatMessage(text) {
  const value = String(text || '').trim();
  return value.startsWith('<heartbeat') && value.includes('</heartbeat>');
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

function responseAnnotationsFromText(text) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const match = /<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/i.exec(source);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => ({
      text: limitText(String(item?.text || '').trim(), DETAIL_TEXT_LIMIT),
      annotation: limitText(String(item?.annotation || '').trim(), DETAIL_TEXT_LIMIT),
    })).filter((item) => item.text || item.annotation);
  } catch {
    return [];
  }
}

function responseAnnotationRequestText(text) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!/^# Response annotations:\s*$/im.test(source)) return null;
  if (!/<response-annotations>[\s\S]*?<\/response-annotations>/i.test(source)) return null;
  const markers = [...source.matchAll(/^## My request(?: for Codex)?:\s*$/gim)];
  const marker = markers.at(-1);
  return marker?.index == null ? '' : source.slice(marker.index + marker[0].length);
}

function matchWorkspaceInstructionsPrefix(text) {
  const source = String(text || '').replace(/\r\n/g, '\n').trimStart();
  const match = /^# AGENTS\.md instructions(?: for ([^\n]+))?\s*\n+<INSTRUCTIONS>\n?[\s\S]*?<\/INSTRUCTIONS>/.exec(source);
  if (!match) return null;
  return {
    source: match[0],
    workspace: String(match[1] || '').trim(),
  };
}

function isInjectedWorkspaceInstructions(role, text) {
  if (role !== 'user') return false;
  const normalized = String(text || '').replace(/\r\n/g, '\n').trimStart();
  const workspace = matchWorkspaceInstructionsPrefix(normalized);
  const workspaceInstructions = Boolean(workspace && !normalized.slice(workspace.source.length).trim());
  const skillInstructions = normalized.startsWith('<skill>')
    && normalized.includes('<name>')
    && normalized.includes('</skill>');
  return workspaceInstructions || skillInstructions;
}

function normalizeInjectedContexts(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const exact = normalizeExactInjectedContext(normalized);
  if (exact) return [exact];

  return peelCompositeInjectedContexts(normalized);
}

function normalizeInjectedContext(text) {
  const contexts = normalizeInjectedContexts(text);
  return contexts[0] || null;
}

function normalizeExactInjectedContext(normalized) {
  const environment = normalized.match(/^<environment_context>\s*([\s\S]*?)\s*<\/environment_context>$/);
  if (environment) return formatEnvironmentContext(environment[1]);

  const browser = normalized.match(/^<in-app-browser-context\b[^>]*>\s*([\s\S]*?)\s*<\/in-app-browser-context>$/);
  if (browser) {
    const url = browser[1].match(/Current URL:\s*(\S+)/)?.[1] || '';
    return {
      kind: 'browser_context',
      content: url ? ('当前页面 ' + url) : '浏览器状态已同步',
    };
  }

  const internal = normalized.match(/^<codex_internal_context\b[^>]*>\s*([\s\S]*?)\s*<\/codex_internal_context>$/);
  if (internal) {
    const objective = firstContextTag(internal[1], 'objective');
    return {
      kind: 'goal_context',
      content: objective ? ('持续目标\n' + objective) : '内部任务状态已同步',
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

function formatEnvironmentContext(source) {
  const date = firstContextTag(source, 'current_date');
  const timezone = firstContextTag(source, 'timezone');
  const cwd = firstContextTag(source, 'cwd');
  const roots = contextTagValues(source, 'root');
  const permission = source.match(/<permission_profile\b[^>]*\btype="([^"]+)"/)?.[1] || '';
  const lines = [];
  if (date) lines.push('日期 ' + date);
  if (timezone) lines.push('时区 ' + timezone);
  if (cwd && !roots.includes(cwd)) lines.push('目录 ' + cwd);
  if (roots.length) {
    lines.push('工作区 ' + roots.length);
    for (const root of roots) lines.push('- ' + root);
  }
  if (permission) lines.push('权限 ' + permission);
  return { kind: 'environment_context', content: lines.join('\n') || '环境信息已同步' };
}

function peelCompositeInjectedContexts(normalized) {
  let remaining = normalized;
  const contexts = [];

  const workspace = takeWorkspaceInjectedPrefix(remaining);
  if (workspace) {
    contexts.push(workspace.context);
    remaining = workspace.remaining.trim();
  } else {
    const standaloneWorkspace = matchWorkspaceInstructionsPrefix(remaining);
    if (standaloneWorkspace) {
      remaining = remaining.slice(standaloneWorkspace.source.length).trim();
    }
  }

  const environment = remaining.match(/^<environment_context>\s*([\s\S]*?)\s*<\/environment_context>\s*$/);
  if (environment) {
    contexts.push(formatEnvironmentContext(environment[1]));
    remaining = '';
  }

  // Only fold when the entire user message is injected context.
  if (remaining) return [];
  return contexts;
}

function takeWorkspaceInjectedPrefix(normalized) {
  const taggedPlugins = normalized.match(/^<recommended_plugins>\s*([\s\S]*?)\s*<\/recommended_plugins>/);
  const plainPluginsPrefix = 'Here is a list of plugins that are available but not installed.';
  const hasPlainPlugins = normalized.startsWith(plainPluginsPrefix);
  if (!taggedPlugins && !hasPlainPlugins) return null;

  let afterPlugins = '';
  let pluginSource = '';
  if (taggedPlugins) {
    pluginSource = taggedPlugins[1];
    afterPlugins = normalized.slice(taggedPlugins[0].length).replace(/^\n+/, '').trimStart();
  } else {
    const agentsAt = normalized.search(/\n# AGENTS\.md instructions(?: for [^\n]+)?\s*\n/);
    const envAt = normalized.search(/\n<environment_context>/);
    let cut = normalized.length;
    if (agentsAt >= 0) cut = Math.min(cut, agentsAt);
    if (envAt >= 0) cut = Math.min(cut, envAt);
    pluginSource = normalized.slice(0, cut);
    afterPlugins = normalized.slice(cut).replace(/^\n+/, '').trimStart();
  }

  const workspaceMatch = matchWorkspaceInstructionsPrefix(afterPlugins);
  if (taggedPlugins && afterPlugins && !workspaceMatch && !afterPlugins.startsWith('<environment_context>')) {
    return null;
  }
  if (hasPlainPlugins && afterPlugins && !workspaceMatch && !afterPlugins.startsWith('<environment_context>')) {
    return null;
  }

  let remaining = afterPlugins;
  if (workspaceMatch) {
    remaining = afterPlugins.slice(workspaceMatch.source.length).replace(/^\n+/, '').trimStart();
  }

  if (remaining && !remaining.startsWith('<environment_context>')) return null;

  const pluginCount = (pluginSource.match(/^\s*-\s+[^\n]+$/gm) || []).length;
  const lines = [];
  if (pluginCount) lines.push('推荐插件 ' + pluginCount);
  else lines.push('推荐插件列表已同步');
  const workspace = String(workspaceMatch?.workspace || '').trim();
  if (workspace) lines.push('工作区规则 ' + workspace);
  return {
    context: {
      kind: 'workspace_context',
      content: lines.join('\n'),
    },
    remaining,
  };
}

function normalizeWorkspaceInjectedContext(normalized) {
  const taken = takeWorkspaceInjectedPrefix(normalized);
  if (!taken || taken.remaining) return null;
  return taken.context;
}

const TURN_TOKEN_USAGE_FIELDS = {
  inputTokens: 'input_tokens',
  cachedInputTokens: 'cached_input_tokens',
  outputTokens: 'output_tokens',
  reasoningOutputTokens: 'reasoning_output_tokens',
  totalTokens: 'total_tokens',
};

function normalizeTurnTokenUsageSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const usage = {};
  const fields = new Set();
  for (const [target, source] of Object.entries(TURN_TOKEN_USAGE_FIELDS)) {
    const numeric = Number(value[source] ?? value[target]);
    if (!Number.isFinite(numeric) || numeric < 0) continue;
    usage[target] = Math.round(numeric);
    fields.add(target);
  }
  if (!fields.size) return null;
  for (const target of Object.keys(TURN_TOKEN_USAGE_FIELDS)) usage[target] ??= 0;
  if (!fields.has('totalTokens')) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
    fields.add('totalTokens');
  }
  return { usage, fields };
}

function normalizeTurnTokenUsage(value) {
  return normalizeTurnTokenUsageSnapshot(value)?.usage || null;
}

function tokenUsageBaseline(snapshot) {
  if (!snapshot) return {};
  return Object.fromEntries([...snapshot.fields].map((field) => [field, snapshot.usage[field]]));
}

function updateCurrentTurnTokenUsage(cache, lastValue, totalValue) {
  const lastUsage = normalizeTurnTokenUsage(lastValue);
  const totalSnapshot = normalizeTurnTokenUsageSnapshot(totalValue);
  const previousSnapshot = cache.latestTotalTokenUsage;
  const previousTotal = Number(previousSnapshot?.usage?.totalTokens);
  const nextTotal = Number(totalSnapshot?.usage?.totalTokens);
  const cumulativeAdvanced = !totalSnapshot
    || !Number.isFinite(previousTotal)
    || (Number.isFinite(nextTotal) && nextTotal > previousTotal);

  if (lastUsage && cumulativeAdvanced) {
    cache.currentTurnFallbackTokenUsage = addTurnTokenUsage(cache.currentTurnFallbackTokenUsage, lastUsage);
  }

  if (!totalSnapshot) {
    if (lastUsage) cache.currentTurnTokenUsage = { ...cache.currentTurnFallbackTokenUsage };
    return;
  }

  const baseline = cache.currentTurnTokenUsageBaseline || {};
  for (const field of totalSnapshot.fields) {
    if (Number.isFinite(Number(baseline[field]))) continue;
    baseline[field] = Math.max(0, totalSnapshot.usage[field] - Number(lastUsage?.[field] || 0));
  }
  cache.currentTurnTokenUsageBaseline = baseline;

  const fallback = cache.currentTurnFallbackTokenUsage || {};
  cache.currentTurnTokenUsage = Object.fromEntries(Object.keys(TURN_TOKEN_USAGE_FIELDS).map((field) => {
    if (totalSnapshot.fields.has(field) && Number.isFinite(Number(baseline[field]))) {
      return [field, Math.max(0, totalSnapshot.usage[field] - Number(baseline[field]))];
    }
    return [field, Number(fallback[field] || 0)];
  }));
  cache.latestTotalTokenUsage = totalSnapshot;
}

function normalizeContextTokenCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric);
}

function normalizeContextUsedTokens(value) {
  if (!value || typeof value !== 'object') return null;
  const inputTokens = normalizeContextTokenCount(value.input_tokens ?? value.inputTokens);
  if (inputTokens !== null && inputTokens > 0) return inputTokens;
  const totalTokens = normalizeContextTokenCount(value.total_tokens ?? value.totalTokens);
  return totalTokens ?? inputTokens;
}

function addTurnTokenUsage(current, addition) {
  const fields = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
  return Object.fromEntries(fields.map((field) => [field, Number(current?.[field] || 0) + Number(addition?.[field] || 0)]));
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
  const responseAnnotationRequest = responseAnnotationRequestText(normalized);
  if (responseAnnotationRequest !== null) return cleanUserRequest(responseAnnotationRequest);
  const requestMarkers = [...normalized.matchAll(/^## My request(?: for Codex)?:\s*$/gm)];
  const requestMarker = requestMarkers.at(-1);
  const requestIndex = requestMarker?.index ?? -1;
  const requestStart = requestIndex === -1 ? -1 : requestIndex + requestMarker[0].length;
  // A design annotation has the same browser-comment envelope as a regular
  // comment, but only its changed declarations belong in the visible history.
  const standaloneAnnotation = browserAnnotationDisplayText(normalized);
  if (standaloneAnnotation && normalized.startsWith('Browser annotation:')) {
    return standaloneAnnotation;
  }
  if (!normalized.startsWith('# Browser comments:')) {
    return cleanUserRequest(requestIndex === -1 ? normalized : normalized.slice(requestStart));
  }

  const commentsBlock = requestIndex === -1 ? normalized : normalized.slice(0, requestIndex);
  const requestBlock = requestIndex === -1 ? '' : normalized.slice(requestStart);
  const parts = [];
  const pushPart = (value) => {
    const clean = String(value || '').trim();
    if (clean && !parts.includes(clean)) parts.push(clean);
  };

  const commentPattern = /^Comment:\s*\n([\s\S]*?)(?=\n(?:<in-app-browser-context\b|## (?:User )?Comment \d+\b|## Requested annotation \d+\b)|$(?![\s\S]))/gm;
  let match;
  while ((match = commentPattern.exec(commentsBlock))) pushPart(match[1]);

  const sectionPattern = /^## (?:User Comment|Comment|Requested annotation) \d+\s*$([\s\S]*?)(?=^## (?:User Comment|Comment|Requested annotation) \d+\s*$|^## My request(?: for Codex)?:\s*$|^<in-app-browser-context\b|$(?![\s\S]))/gm;
  while ((match = sectionPattern.exec(commentsBlock))) {
    const section = String(match[1] || '');
    const annotation = browserAnnotationDisplayText(section);
    if (annotation) {
      pushPart(annotation);
      continue;
    }
    const explicit = section.match(/^Comment:\s*\n([\s\S]*)$/m)?.[1]
      || section.match(/^Comment:\s*(.+)$/m)?.[1]
      || '';
    if (explicit.trim()) {
      pushPart(explicit);
      continue;
    }
    const cleanedSection = cleanUserRequest(section
      .replace(/^File:\s*[^\n]*$/gm, '')
      .replace(/^Node position:[^\n]*$/gm, '')
      .replace(/^Untrusted page evidence[^\n]*$/gm, '')
      .replace(/^Page URL:[^\n]*$/gm, '')
      .replace(/^Frame:[^\n]*$/gm, '')
      .replace(/^Target:[^\n]*$/gm, '')
      .replace(/^Target selector:[^\n]*$/gm, '')
      .replace(/^Target path:[^\n]*$/gm, '')
      .replace(/^Nearby text:[^\n]*$/gm, '')
      .replace(/^Area rectangle:[^\n]*$/gm, '')
      .replace(/^Saved marker screenshot:[^\n]*$/gm, '')
      .replace(/^Annotated screenshot:[^\n]*$/gm, '')
      .replace(/^Attached image:[^\n]*$/gm, '')
      .replace(/^Browser annotation:[\s\S]*?(?=^Comment:|$(?![\s\S]))/gm, ''));
    pushPart(cleanedSection);
  }

  const request = cleanUserRequest(requestBlock);
  if (request) {
    // Prefer the explicit user request when browser-comment scaffolding surrounds it.
    return request;
  }
  return parts.length ? parts.join('\n\n') : cleanUserRequest(normalized);
}

function browserAnnotationDisplayText(source) {
  const normalized = String(source || '').replace(/\r\n/g, '\n');
  const annotationStart = normalized.indexOf('Browser annotation:');
  if (annotationStart === -1) return '';

  const annotation = normalized.slice(annotationStart + 'Browser annotation:'.length);
  const requestedChanges = /^Requested changes:\s*$/m.exec(annotation);
  if (!requestedChanges || requestedChanges.index == null) return '';

  const afterChanges = annotation.slice(requestedChanges.index + requestedChanges[0].length);
  const boilerplateStart = afterChanges.search(/^(?:Apply each annotation|Treat the visible viewport|Do not copy temporary)/m);
  const changeLines = (boilerplateStart === -1 ? afterChanges : afterChanges.slice(0, boilerplateStart))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^-\s+\S/.test(line))
    .map((line) => line.replace(/\s+->\s+/g, ' → '));

  return changeLines.length ? `界面批注\n${changeLines.join('\n')}` : '界面批注';
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
  const hasInlineImage = role === 'tool' && /"image_url"\s*:/.test(String(content || ''));
  const limit = role === 'image' || hasInlineImage
    ? IMAGE_URL_LIMIT
    : role === 'user' || role === 'assistant'
      ? MESSAGE_TEXT_LIMIT
      : DETAIL_TEXT_LIMIT;
  const clean = limitText(String(content || '').trim(), limit);
  if (!clean) return;
  if (tryMergeAssistantMessage(cache, role, clean, record, kind, metadata)) return;
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
  trimNativeMessages(cache, maxMessages);
}

function isProtectedNativeMessage(message) {
  const role = message?.role;
  const kind = String(message?.kind || '');
  if (role === 'user' || role === 'assistant' || role === 'image') return true;
  // Terminal process records close a rendered turn. Losing one lets a later
  // user message attach to the previous turn's live panel during hydration.
  if (role === 'process' && TURN_TERMINAL_PROCESS_KINDS.has(kind)) return true;
  if (role === 'context' && ['handoff_summary', 'turn_aborted'].includes(kind)) return true;
  return false;
}

function isDroppableNativeMessage(message) {
  const role = message?.role;
  return !isProtectedNativeMessage(message) && (role === 'tool' || role === 'process' || role === 'thinking');
}

function trimNativeMessages(cache, maxMessages) {
  const limit = Number(maxMessages);
  if (!Number.isInteger(limit) || limit <= 0) return;
  if (!Array.isArray(cache.messages) || cache.messages.length <= limit) return;

  let messages = cache.messages;
  const overflow = messages.length - limit;
  const dropIndexes = [];
  for (let index = 0; index < messages.length && dropIndexes.length < overflow; index += 1) {
    if (isDroppableNativeMessage(messages[index])) dropIndexes.push(index);
  }
  if (dropIndexes.length) {
    const dropSet = new Set(dropIndexes);
    messages = messages.filter((_, index) => !dropSet.has(index));
    cache.messagesTruncated = true;
  }

  if (messages.length > limit) {
    const protectedMessages = messages.filter((message) => isProtectedNativeMessage(message));
    if (protectedMessages.length <= limit) {
      const room = limit - protectedMessages.length;
      const droppable = messages.filter((message) => !isProtectedNativeMessage(message));
      const keepDroppable = new Set(droppable.slice(-room));
      messages = messages.filter((message) => (
        isProtectedNativeMessage(message) || keepDroppable.has(message)
      ));
    } else {
      const keepProtected = new Set(protectedMessages.slice(-limit));
      messages = messages.filter((message) => keepProtected.has(message));
    }
    cache.messagesTruncated = true;
  }

  cache.messages = messages;
}

function selectRecentNativeMessages(visibleMessages, limit) {
  if (!limit || !Array.isArray(visibleMessages) || visibleMessages.length <= limit) {
    return visibleMessages;
  }

  const tail = visibleMessages.slice(-limit);
  const tailProtected = tail.filter((message) => isProtectedNativeMessage(message));
  const tailUsers = tailProtected.filter((message) => message.role === 'user').length;
  const tailAssistants = tailProtected.filter((message) => message.role === 'assistant').length;
  const tailDroppable = tail.length - tailProtected.length;
  const toolHeavy = tailDroppable >= Math.ceil(limit * 0.75);
  // Keep chronological tails for normal chats. Only rebalance when the window is
  // almost pure tool/process noise and would hide the actual conversation body.
  if ((tailUsers > 0 || tailAssistants > 0) && !toolHeavy) return tail;
  if (tailUsers > 0 && tailAssistants > 0) return tail;

  const keep = new Set(tail);
  const newestProtected = [];
  for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
    const message = visibleMessages[index];
    if (!isProtectedNativeMessage(message)) continue;
    newestProtected.push(message);
    if (newestProtected.length >= Math.min(limit, Math.max(6, Math.floor(limit / 2)))) break;
  }
  for (const message of newestProtected) {
    if (keep.has(message)) continue;
    const dropCandidate = [...keep].find((item) => isDroppableNativeMessage(item));
    if (!dropCandidate) break;
    keep.delete(dropCandidate);
    keep.add(message);
  }
  return visibleMessages.filter((message) => keep.has(message));
}

function tryMergeAssistantMessage(cache, role, clean, record, kind, metadata = null) {
  if (role !== 'assistant') return false;
  if (!canMergeAssistantKind(kind)) return false;
  if (metadata && typeof metadata === 'object' && Object.keys(metadata).length) return false;
  const previous = findMergeableAssistantMessage(cache, kind, clean);
  if (!previous) return false;
  if (previous.content === clean || previous.content.endsWith('\n\n' + clean) || previous.content.endsWith('\n' + clean)) {
    return true;
  }
  const before = previous.content;
  if (clean.startsWith(previous.content) && clean.length > previous.content.length) {
    previous.content = limitText(clean, MESSAGE_TEXT_LIMIT);
  } else {
    previous.content = limitText(previous.content + '\n\n' + clean, MESSAGE_TEXT_LIMIT);
  }
  // Progress stays progress; final_answer only merges with adjacent final_answer.
  if (kind === 'final_answer') previous.kind = 'final_answer';
  else if (previous.kind === 'message' || !previous.kind) previous.kind = kind || previous.kind || 'message';
  if (record?.timestamp) previous.at = record.timestamp;
  // Keep chronological order: note → tools → note → tools (App-style).
  // Do not relocate progress bubbles past interleaved tools/process items.
  if (previous.content !== before) cache.contentMutated = true;
  return true;
}

function findMergeableAssistantMessage(cache, kind = '', clean = '') {
  const turnId = cache.currentTurnId || '';
  const incomingFinal = kind === 'final_answer';
  // final_answer only merges with an immediately previous final_answer (no tools between).
  if (incomingFinal) {
    const previous = cache.messages.at(-1);
    if (!previous || previous.role !== 'assistant') return null;
    if ((previous.turnId || '') !== turnId) return null;
    if (previous.kind !== 'final_answer') return null;
    return previous;
  }
  // Keep long unphased summaries as their own bubble instead of folding into progress chatter.
  if (!isProgressStyleText(clean)) return null;
  // Only merge immediately consecutive progress notes.
  // Tools / process / user between notes start a new progress bubble so the
  // timeline stays note → tools → note → tools (matches Codex App).
  const previous = cache.messages.at(-1);
  if (!previous) return null;
  if ((previous.turnId || '') !== turnId) return null;
  if (previous.role !== 'assistant') return null;
  if (!canMergeProgressKind(previous.kind)) return null;
  if (!isProgressStyleText(previous.content)) return null;
  return previous;
}

function relocateNativeMessageToEnd(cache, message) {
  const index = cache.messages.indexOf(message);
  if (index < 0 || index === cache.messages.length - 1) return;
  cache.messages.splice(index, 1);
  cache.messages.push(message);
}

function promoteLatestAssistantFinalAnswer(cache) {
  const turnId = cache.currentTurnId || "";
  let lastAssistant = null;
  let lastSummary = null;
  for (let index = cache.messages.length - 1; index >= 0; index -= 1) {
    const message = cache.messages[index];
    if (!message) continue;
    if (turnId && (message.turnId || "") && (message.turnId || "") !== turnId) {
      if (message.role === "assistant" || message.role === "user" || (message.role === "process" && message.kind === "task_started")) break;
      continue;
    }
    if (message.role !== "assistant") continue;
    const kind = String(message.kind || "");
    if (kind === "final_answer") return;
    if (!lastAssistant) lastAssistant = message;
    if (!lastSummary && ["", "message", "commentary"].includes(kind) && !isProgressStyleText(message.content)) {
      lastSummary = message;
      break;
    }
    if (!["", "message", "commentary"].includes(kind)) break;
  }
  const target = lastSummary || lastAssistant;
  if (!target) return;
  if (String(target.kind || "") !== "final_answer") target.kind = "final_answer";
}

function canMergeAssistantKind(kind) {
  return ['', 'message', 'commentary', 'final_answer'].includes(String(kind || ''));
}

function canMergeProgressKind(kind) {
  return ['', 'message', 'commentary'].includes(String(kind || ''));
}

function isProgressStyleText(text) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) return false;
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
  if (source.length >= 500 || lines.length >= 6) return false;
  // Numbered/markdown section summaries are treated as final-style, not live progress.
  if (/^\d+\.\s+\S/.test(source) && lines.length >= 3) return false;
  if (/^#{1,6}\s+\S/.test(source)) return false;
  if (/^\*\*[^*]+\*\*\s*$/.test(lines[0] || '') && lines.length >= 3) return false;
  return true;
}

function updateNativeTurnId(cache, value) {
  const turnId = String(value || '').trim();
  if (!turnId) return;
  cache.latestTurnId = turnId;
  if (turnId === cache.currentTurnId) return;
  cache.previousTurnId = cache.currentTurnId || '';
  cache.currentTurnId = turnId;
  cache.currentTurnStartedAt = '';
  cache.currentTurnTokenUsage = null;
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
  const formatted = detail ? `${name}\n${detail}` : name;
  // Tool outputs can contain inline image data URLs. Keep those intact so the
  // tool-image endpoint can decode them after the original temporary file is gone.
  const limit = /"image_url"\s*:/.test(formatted) ? IMAGE_URL_LIMIT : DETAIL_TEXT_LIMIT;
  return limitText(formatted, limit);
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

function normalizeServiceTier(value) {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized === 'default') return null;
  if (normalized === 'priority') return 'priority';
  return undefined;
}

const THREAD_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function threadSettingsValue(source, keys) {
  for (const key of keys) {
    if (Object.hasOwn(source, key)) return { present: true, value: source[key] };
  }
  return { present: false, value: undefined };
}

function normalizeThreadSettings(rawSettings) {
  const source = rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)
    ? rawSettings
    : {};
  const settings = {};
  const normalizeText = (value) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
  };

  const model = threadSettingsValue(source, ['model']);
  if (model.present) settings.model = normalizeText(model.value);

  const modelProvider = threadSettingsValue(source, ['modelProvider', 'model_provider_id', 'model_provider']);
  if (modelProvider.present) settings.modelProvider = normalizeText(modelProvider.value);

  const effort = threadSettingsValue(source, ['effort', 'reasoningEffort', 'reasoning_effort']);
  if (effort.present) {
    const normalized = normalizeText(effort.value);
    if (normalized === null || THREAD_REASONING_EFFORTS.has(normalized)) settings.reasoningEffort = normalized;
  }

  const serviceTier = threadSettingsValue(source, ['serviceTier', 'service_tier']);
  if (serviceTier.present) {
    const normalized = normalizeServiceTier(serviceTier.value);
    if (normalized !== undefined) settings.serviceTier = normalized;
  }

  return settings;
}

function mergeThreadSettingsMetadata(metadata, settings, updatedAtMs = 0) {
  const next = { ...(metadata || {}) };
  let changed = false;
  for (const key of ['modelProvider', 'model', 'reasoningEffort', 'serviceTier']) {
    if (!Object.hasOwn(settings, key)) continue;
    if (!Object.hasOwn(next, key) || next[key] !== settings[key]) {
      next[key] = settings[key];
      changed = true;
    }
  }
  const timestamp = Number(updatedAtMs) || 0;
  if (timestamp > 0 && next.settingsUpdatedAtMs !== timestamp) {
    next.settingsUpdatedAtMs = timestamp;
    changed = true;
  }
  return { metadata: next, changed };
}

function threadSettingsMatch(persisted, overlay) {
  const fields = ['modelProvider', 'model', 'reasoningEffort', 'serviceTier']
    .filter((key) => Object.hasOwn(overlay || {}, key));
  return fields.length > 0 && fields.every((key) => (
    Object.hasOwn(persisted || {}, key) && persisted[key] === overlay[key]
  ));
}

const THREAD_GOAL_STATUSES = new Set([
  'active',
  'paused',
  'blocked',
  'usage_limited',
  'budget_limited',
  'complete',
]);

function normalizeThreadGoalStatus(value) {
  const raw = String(value || '').trim();
  const collapsed = raw.replace(/[_-]/g, '').toLowerCase();
  if (collapsed === 'usagelimited') return 'usage_limited';
  if (collapsed === 'budgetlimited') return 'budget_limited';
  return raw.toLowerCase();
}

function normalizeThreadGoal(raw, fallbackThreadId = '') {
  if (!raw || typeof raw !== 'object') return null;
  const threadId = String(raw.threadId || raw.thread_id || fallbackThreadId || '').trim().toLowerCase();
  const objective = String(raw.objective || '').trim();
  const status = normalizeThreadGoalStatus(raw.status);
  if (!threadId || !objective || !THREAD_GOAL_STATUSES.has(status)) return null;
  const createdAtRaw = raw.createdAtMs ?? raw.created_at_ms ?? raw.createdAt ?? raw.created_at;
  const updatedAtRaw = raw.updatedAtMs ?? raw.updated_at_ms ?? raw.updatedAt ?? raw.updated_at;
  const toMs = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return number < 1e12 ? Math.floor(number * 1000) : Math.floor(number);
  };
  const createdAtMs = toMs(createdAtRaw);
  const updatedAtMs = toMs(updatedAtRaw);
  const tokenBudgetRaw = raw.tokenBudget ?? raw.token_budget;
  const tokenBudgetNumber = tokenBudgetRaw == null || tokenBudgetRaw === ''
    ? null
    : Math.max(0, Math.floor(Number(tokenBudgetRaw) || 0));
  return {
    threadId,
    goalId: String(raw.goalId || raw.goal_id || '').trim() || null,
    objective,
    status,
    tokenBudget: Number.isFinite(tokenBudgetNumber) ? tokenBudgetNumber : null,
    tokensUsed: Math.max(0, Math.floor(Number(raw.tokensUsed ?? raw.tokens_used) || 0)),
    timeUsedSeconds: Math.max(0, Math.floor(Number(raw.timeUsedSeconds ?? raw.time_used_seconds) || 0)),
    createdAtMs: createdAtMs || 0,
    updatedAtMs: updatedAtMs || createdAtMs || 0,
  };
}

function sameThreadGoal(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.threadId === right.threadId
    && left.goalId === right.goalId
    && left.objective === right.objective
    && left.status === right.status
    && left.tokenBudget === right.tokenBudget
    && left.tokensUsed === right.tokensUsed
    && left.timeUsedSeconds === right.timeUsedSeconds
    && left.createdAtMs === right.createdAtMs
    && left.updatedAtMs === right.updatedAtMs;
}

function resolveThreadGoal(eventGoal, dbGoal) {
  if (!dbGoal) return eventGoal || null;
  if (!eventGoal) return dbGoal;
  const eventUpdated = Number(eventGoal.updatedAtMs) || 0;
  const dbUpdated = Number(dbGoal.updatedAtMs) || 0;
  return dbUpdated >= eventUpdated ? dbGoal : eventGoal;
}

function extractUpdateGoalStatus(name, input) {
  const toolName = String(name || '').trim().toLowerCase();
  let raw = input;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { raw = JSON.parse(trimmed); } catch {}
    }
  }

  if (toolName === 'update_goal') {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const status = String(raw.status || '').trim().toLowerCase();
      return THREAD_GOAL_STATUSES.has(status) && (status === 'complete' || status === 'blocked')
        ? status
        : null;
    }
    return null;
  }

  const text = typeof input === 'string'
    ? input
    : (raw && typeof raw === 'object' && !Array.isArray(raw)
      ? String(raw.cmd || raw.input || raw.code || raw.source || '')
      : '');
  const goalCall = text.match(/\btools\s*\.\s*update_goal\s*\(/i);
  if (!text || !goalCall) return null;

  // Prefer simple, robust extraction over brittle full-call regexes.
  const statusMatch = text.match(/\bstatus\s*:\s*["'](complete|blocked)["']/i)
    || text.match(/["']status["']\s*:\s*["'](complete|blocked)["']/i);
  if (!statusMatch) return null;
  // Require that update_goal appears before the status token to avoid false positives.
  const goalPos = goalCall.index == null ? -1 : goalCall.index;
  const statusPos = statusMatch.index == null ? -1 : statusMatch.index;
  if (goalPos < 0 || statusPos < goalPos) return null;
  return statusMatch[1].toLowerCase();
}

function parseGoalOutputJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}

  const tail = trimmed.slice(-200000);
  let attempts = 0;
  for (let index = tail.lastIndexOf('{'); index >= 0 && attempts < 32; index = tail.lastIndexOf('{', index - 1)) {
    attempts += 1;
    try { return JSON.parse(tail.slice(index)); } catch {}
  }
  return null;
}

function extractThreadGoalFromToolOutput(output) {
  const queue = [{ value: output, depth: 0 }];
  let inspected = 0;
  while (queue.length && inspected < 200) {
    const { value, depth } = queue.shift();
    inspected += 1;
    if (value == null || depth > 6) continue;
    if (typeof value === 'string') {
      const parsed = parseGoalOutputJson(value);
      if (parsed != null) queue.unshift({ value: parsed, depth: depth + 1 });
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) queue.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (typeof value !== 'object') continue;
    if (value.goal && typeof value.goal === 'object' && !Array.isArray(value.goal)) return value.goal;
    for (const key of ['text', 'output', 'content', 'structuredContent', 'structured_content', 'result']) {
      if (Object.hasOwn(value, key)) queue.push({ value: value[key], depth: depth + 1 });
    }
  }
  return null;
}

function mergeThreadGoalFromToolOutput(cache, rawGoal, expectedStatus, record) {
  if (!cache?.goal || !rawGoal || typeof rawGoal !== 'object') return false;
  const base = cache.goal;
  const recordStamp = Date.parse(String(record?.timestamp || ''));
  const merged = normalizeThreadGoal({
    threadId: rawGoal.threadId ?? rawGoal.thread_id ?? base.threadId ?? cache.id,
    goalId: rawGoal.goalId ?? rawGoal.goal_id ?? base.goalId,
    objective: rawGoal.objective ?? base.objective,
    status: rawGoal.status ?? expectedStatus,
    tokenBudget: rawGoal.tokenBudget ?? rawGoal.token_budget ?? base.tokenBudget,
    tokensUsed: rawGoal.tokensUsed ?? rawGoal.tokens_used ?? base.tokensUsed,
    timeUsedSeconds: rawGoal.timeUsedSeconds ?? rawGoal.time_used_seconds ?? base.timeUsedSeconds,
    createdAtMs: rawGoal.createdAtMs ?? rawGoal.created_at_ms ?? rawGoal.createdAt ?? rawGoal.created_at ?? base.createdAtMs,
    updatedAtMs: rawGoal.updatedAtMs ?? rawGoal.updated_at_ms ?? rawGoal.updatedAt ?? rawGoal.updated_at
      ?? base.updatedAtMs ?? (Number.isFinite(recordStamp) ? recordStamp : 0),
  }, base.threadId || cache.id);
  if (!merged || merged.status !== expectedStatus || merged.threadId !== String(cache.id || '').toLowerCase()) return false;
  if (base.goalId && merged.goalId && base.goalId !== merged.goalId) return false;
  return attachThreadGoal(cache, merged);
}

function markThreadGoalStatusFromTool(cache, status, record) {
  if (!cache || !THREAD_GOAL_STATUSES.has(status)) return false;
  if (!cache.goal || !cache.goal.objective) return false;
  // complete is terminal for the current objective; do not regress it.
  if (cache.goal.status === 'complete') return false;
  if (cache.goal.status === status) return false;

  const stamp = Date.parse(String(record?.timestamp || ''));
  const updatedAtMs = Number.isFinite(stamp) && stamp > 0
    ? Math.floor(stamp)
    : Date.now();

  cache.goal = {
    ...cache.goal,
    status,
    updatedAtMs: Math.max(Number(cache.goal.updatedAtMs) || 0, updatedAtMs),
  };
  cache.contentMutated = true;
  return true;
}

function attachThreadGoal(cache, goal) {
  if (!cache) return false;
  const next = goal ? { ...goal } : null;
  if (sameThreadGoal(cache.goal, next)) return false;
  cache.goal = next;
  cache.contentMutated = true;
  return true;
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
  const visibleMessages = availableMessages.filter((message) => !shouldHideHandoffMessage(message));
  const messages = limit && (!hasAfter || reset)
    ? selectRecentNativeMessages(visibleMessages, limit)
    : visibleMessages;

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
    hasEarlierMessages: messages.length < visibleMessages.length,
    generation: cache.generation,
    cursor: Math.max(0, cache.nextSequence - 1),
    reset,
    revision: `${entry.ino}:${entry.size}:${entry.mtimeMs}`,
    metadata: { ...cache.metadata, workspaceKind: entry.workspaceKind || '' },
    goal: cache.goal ? { ...cache.goal } : null,
    contextWindow: Number.isFinite(cache.contextUsedTokens) && cache.contextWindowTokens > 0
      ? {
          usedTokens: cache.contextUsedTokens,
          maxTokens: cache.contextWindowTokens,
        }
      : null,
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

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function timestampMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
