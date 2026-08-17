import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as createHttpRequest } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('legacy agent_message commentary mirrors are not rendered as a second reply', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const start = serverSource.indexOf('function extractProcessEvent');
  const end = serverSource.indexOf('\nfunction writeEvent', start);
  assert.ok(start >= 0 && end > start);
  const { extractProcessEvent, extractText } = new Function(
    `${serverSource.slice(start, end)}; return { extractProcessEvent, extractText };`,
  )();

  const commentary = {
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      phase: 'commentary',
      message: '同一段中间回复',
    },
  };
  assert.equal(extractProcessEvent(commentary), null);
  assert.equal(extractText(commentary), '');

  const final = {
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      phase: 'final_answer',
      message: '唯一正式回复',
    },
  };
  assert.equal(extractProcessEvent(final), null);
  assert.equal(extractText(final), '唯一正式回复');
});

test('app-server terminal errors broadcast full detail before closing the turn', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const start = serverSource.indexOf('function handleAppServerError');
  const end = serverSource.indexOf('\nfunction assertAppServerConfigChangeAllowed', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const detail = `unexpected status 405 Method Not Allowed: ${'x'.repeat(520)}, url: http://127.0.0.1:8090/v1/responses`;
  const handleAppServerError = new Function(
    'activeNativeTurns',
    'cleanNativeThreadId',
    'setNativeTurnState',
    'recordNativeTurnCompletion',
    'broadcastNativeRuntime',
    'console',
    `${serverSource.slice(start, end)}; return handleAppServerError;`,
  )(
    new Map([['thread-a', { turnId: 'turn-a', status: 'running' }]]),
    (value) => String(value || '').trim(),
    (...args) => calls.push({ type: 'state', args }),
    (...args) => calls.push({ type: 'complete', args }),
    (event) => calls.push({ type: 'runtime', event }),
    { warn() {} },
  );

  handleAppServerError({
    threadId: 'thread-a',
    turnId: 'turn-a',
    willRetry: false,
    error: { message: detail },
  });

  assert.equal(calls[0].type, 'runtime');
  assert.equal(calls[0].event.message, detail);
  assert.equal(calls[1].type, 'complete');
  assert.deepEqual(calls[1].args, ['thread-a', { id: 'turn-a', status: 'failed' }]);
});

test('Homepage stats expose current and concurrent running task names', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const helperStart = serverSource.indexOf('function homepageTaskName');
  const helperEnd = serverSource.indexOf('\nfunction requireConfigWrite', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.match(serverSource, /const taskStats = homepageRunningTaskStats\(nativeSessionList\)/);
  assert.match(serverSource, /currentTask: taskStats\.currentTask/);
  assert.match(serverSource, /runningTasks: taskStats\.runningTasks/);

  const buildStats = ({ turns = new Map(), process = null, conversations = [] } = {}) => new Function(
    'activeNativeTurns',
    'activeProcess',
    'activeConversationId',
    'conversations',
    `${serverSource.slice(helperStart, helperEnd)}; return homepageRunningTaskStats;`,
  )(turns, process, 'legacy-active', conversations);

  const sessions = [
    {
      id: 'older',
      title: 'Older task',
      status: 'running',
      updatedAt: '2026-08-03T00:00:00.000Z',
    },
    {
      id: 'newer',
      title: '  Current\n task  ',
      status: 'running',
      updatedAt: '2026-08-03T00:01:00.000Z',
    },
    { id: 'done', title: 'Finished task', status: 'done' },
  ];
  const turns = new Map([
    ['older', { startedAt: '2026-08-03T00:02:00.000Z' }],
    ['newer', { startedAt: '2026-08-03T00:03:00.000Z' }],
  ]);
  const nativeStats = buildStats({ turns })(sessions);
  assert.deepEqual(nativeStats, {
    running: 2,
    currentTask: 'Current task',
    runningTasks: [
      { name: 'Current task', status: '执行中', startedAt: '2026-08-03T00:03:00.000Z' },
      { name: 'Older task', status: '执行中', startedAt: '2026-08-03T00:02:00.000Z' },
    ],
  });

  const withLegacyStats = buildStats({
    turns,
    process: { pid: 123 },
    conversations: [{
      id: 'legacy-active',
      title: 'Legacy current task',
      updatedAt: '2026-08-03T00:04:00.000Z',
    }],
  })(sessions);
  assert.equal(withLegacyStats.running, 3);
  assert.equal(withLegacyStats.currentTask, 'Legacy current task');
  assert.equal(withLegacyStats.runningTasks[0].name, 'Legacy current task');

  assert.deepEqual(buildStats()([]), {
    running: 0,
    currentTask: '空闲',
    runningTasks: [],
  });
});



test('DeepSeek quota card hides balance funding breakdown and local totals', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const uiStyles = await readFile(path.join(ROOT, 'ui.css'), 'utf8');
  const branchStart = serverSource.indexOf("if(quota.provider==='deepseek')");
  const branchEnd = serverSource.indexOf("const unit=quota.unit", branchStart);
  assert.ok(branchStart >= 0 && branchEnd > branchStart);
  const branch = serverSource.slice(branchStart, branchEnd);
  assert.doesNotMatch(branch, /grantedBalance|toppedUpBalance|赠送|充值/);
  assert.doesNotMatch(branch, /累计 Token/);
  assert.doesNotMatch(branch, /累计请求/);
  assert.doesNotMatch(branch, /usageStats/);
  assert.match(branch, /inlineStatus:balanceStatus,showRemainingLabel:false/);
  assert.match(branch, /subQuotaMeta subQuotaMetaDeepSeek/);
  assert.doesNotMatch(branch, /appendSubQuotaMeta\(meta,'状态 /);
  assert.doesNotMatch(serverSource, /subQuotaInlineSeparator/);
  assert.doesNotMatch(serverSource, /deepSeekUsageCalibration|deepseek-usage-calibration|accumulateDeepSeekUsage/);
  assert.match(uiStyles, /\.subQuotaWindowHeadInline \.subQuotaInlineStatus\s*\{[^}]*margin-left:\s*auto/s);
  assert.match(uiStyles, /\.subQuotaMetaDeepSeek\s*\{[^}]*flex-wrap:\s*nowrap/s);
  assert.doesNotMatch(uiStyles, /\.deepSeekUsageCalibration/);
});

test('Codex App quota card omits provider status metadata', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const branchStart = serverSource.indexOf('if(isCodexApp){');
  const branchEnd = serverSource.indexOf('const isSub2Api=', branchStart);
  assert.ok(branchStart >= 0 && branchEnd > branchStart);
  const branch = serverSource.slice(branchStart, branchEnd);

  assert.match(branch, /if\(quota\.message\)appendSubQuotaMeta\(meta,quota\.message\)/);
  assert.doesNotMatch(branch, /appendSubQuotaMeta\(meta,'状态 /);
});

test('native queue turns ignore unscoped idle status and stale completions', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const notificationStart = serverSource.indexOf('function handleAppServerNotification');
  const notificationEnd = serverSource.indexOf('\nfunction nativeThreadGoalStatus', notificationStart);
  const completionStart = serverSource.indexOf('function recordNativeTurnCompletion');
  const completionEnd = serverSource.indexOf('\nfunction currentNativeTurnId', completionStart);
  assert.ok(notificationStart >= 0 && notificationEnd > notificationStart);
  assert.ok(completionStart >= 0 && completionEnd > completionStart);
  assert.doesNotMatch(serverSource.slice(notificationStart, notificationEnd), /thread\/status\/changed/);

  const activeNativeTurns = new Map([['thread-a', { turnId: 'turn-current', status: 'running' }]]);
  const updates = [];
  const timers = [];
  const dispatches = [];
  const api = new Function(
    'activeNativeTurns',
    'cleanNativeThreadId',
    'nativeTurnStatus',
    'setNativeTurnState',
    'clearPersistedTerminalNativeTurn',
    'releaseAppServerThreadAfterTurn',
    'scheduleServerPromptQueueDispatch',
    'setTimeout',
    `${serverSource.slice(completionStart, completionEnd)}; return { recordNativeTurnCompletion };`,
  )(
    activeNativeTurns,
    (value) => String(value || '').trim(),
    (value) => String(value || '').toLowerCase() === 'failed' ? 'error' : 'done',
    (threadId, state) => {
      updates.push({ threadId, state });
      activeNativeTurns.set(threadId, { ...activeNativeTurns.get(threadId), ...state });
    },
    () => false,
    () => Promise.resolve(false),
    (...args) => dispatches.push(args),
    (callback) => { timers.push(callback); return { unref() {} }; },
  );

  assert.equal(api.recordNativeTurnCompletion('thread-a', {}), false);
  assert.equal(api.recordNativeTurnCompletion('thread-a', { id: 'turn-stale', status: 'completed' }), false);
  assert.equal(activeNativeTurns.get('thread-a').status, 'running');
  assert.equal(updates.length, 0);
  assert.equal(api.recordNativeTurnCompletion('thread-a', { id: 'turn-current', status: 'completed' }), true);
  assert.deepEqual(updates, [{ threadId: 'thread-a', state: { turnId: 'turn-current', status: 'done' } }]);
  assert.deepEqual(dispatches, [['thread-a', 160]], 'a durable server worker takes over the next queued prompt');
  assert.equal(timers.length, 0, 'terminal state remains until the matching persisted turn record is observed');
});

test('a matching persisted terminal releases a running turn and schedules the Web queue', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const changeStart = serverSource.indexOf('function broadcastNativeSessionChange');
  const changeEnd = serverSource.indexOf('\nfunction broadcastNativeRuntime', changeStart);
  assert.ok(changeStart >= 0 && changeEnd > changeStart);

  const activeNativeTurns = new Map([['thread-a', { turnId: 'turn-current', status: 'running' }]]);
  const scheduled = [];
  const runtimeEvents = [];
  const api = new Function(
    'sessionEventClients',
    'writeNamedEvent',
    'cleanNativeThreadId',
    'serverPromptQueueHasDispatchableItem',
    'nativeSessions',
    'activeNativeTurns',
    'scheduleServerPromptQueueDispatch',
    'broadcastNativeRuntime',
    'releaseAppServerThreadAfterTurn',
    `${serverSource.slice(changeStart, changeEnd)}; return { handleNativeSessionChange };`,
  )(
    [],
    () => {},
    (value) => String(value || '').trim(),
    () => true,
    {
      get: () => ({
        status: 'done',
        latestTurnId: 'turn-current',
        messages: [{ turnId: 'turn-current', role: 'process', kind: 'task_complete' }],
      }),
    },
    activeNativeTurns,
    (...args) => scheduled.push(args),
    (event) => runtimeEvents.push(event),
    () => Promise.resolve(false),
  );

  api.handleNativeSessionChange({ changedIds: ['thread-a'] });

  assert.equal(activeNativeTurns.has('thread-a'), false, 'the persisted terminal must supersede a missing turn/completed notification');
  assert.deepEqual(scheduled, [['thread-a', 160]], 'the server queue worker resumes without a foreground browser');
  assert.deepEqual(runtimeEvents, [{ type: 'turn-cleared', threadId: 'thread-a', turnId: 'turn-current' }]);
});

test('a terminal record for another turn cannot release a running queue lock', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const changeStart = serverSource.indexOf('function broadcastNativeSessionChange');
  const changeEnd = serverSource.indexOf('\nfunction broadcastNativeRuntime', changeStart);
  assert.ok(changeStart >= 0 && changeEnd > changeStart);

  const activeNativeTurns = new Map([['thread-a', { turnId: 'turn-current', status: 'running' }]]);
  const scheduled = [];
  const runtimeEvents = [];
  const api = new Function(
    'sessionEventClients',
    'writeNamedEvent',
    'cleanNativeThreadId',
    'serverPromptQueueHasDispatchableItem',
    'nativeSessions',
    'activeNativeTurns',
    'scheduleServerPromptQueueDispatch',
    'broadcastNativeRuntime',
    `${serverSource.slice(changeStart, changeEnd)}; return { handleNativeSessionChange };`,
  )(
    [],
    () => {},
    (value) => String(value || '').trim(),
    () => true,
    {
      get: () => ({
        status: 'done',
        latestTurnId: 'turn-other',
        messages: [{ turnId: 'turn-other', role: 'process', kind: 'task_complete' }],
      }),
    },
    activeNativeTurns,
    (...args) => scheduled.push(args),
    (event) => runtimeEvents.push(event),
  );

  api.handleNativeSessionChange({ changedIds: ['thread-a'] });

  assert.equal(activeNativeTurns.get('thread-a')?.status, 'running');
  assert.deepEqual(scheduled, [], 'an unrelated terminal must not send the queued prompt early');
  assert.deepEqual(runtimeEvents, []);
});

test('native terminal overrides clear after their matching persisted record or a newer native turn', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const terminalStart = serverSource.indexOf('function nativeTurnHasPersistedTerminal');
  const terminalEnd = serverSource.indexOf('\nfunction broadcastNativeRuntime', terminalStart);
  assert.ok(terminalStart >= 0 && terminalEnd > terminalStart);

  const activeNativeTurns = new Map([
    ['thread-a', { turnId: 'turn-current', status: 'error' }],
    ['thread-b', { turnId: 'turn-current', status: 'interrupted' }],
    ['thread-c', { turnId: 'turn-current', status: 'error' }],
  ]);
  const cleared = [];
  const terminalApi = new Function(
    'activeNativeTurns',
    'cleanNativeThreadId',
    'nativeSessions',
    'broadcastNativeRuntime',
    'releaseAppServerThreadAfterTurn',
    `${serverSource.slice(terminalStart, terminalEnd)}; return { clearPersistedTerminalNativeTurns };`,
  )(
    activeNativeTurns,
    (value) => String(value || '').trim(),
    {
      get: (threadId) => threadId === 'thread-a'
        ? { messages: [{ turnId: 'turn-current', role: 'process', kind: 'task_error' }] }
        : threadId === 'thread-c'
          ? { status: 'running', latestTurnId: 'turn-next', messages: [] }
          : { messages: [{ turnId: 'turn-other', role: 'process', kind: 'turn_aborted' }] },
    },
    (event) => cleared.push(event),
    () => Promise.resolve(false),
  );

  terminalApi.clearPersistedTerminalNativeTurns({ changedIds: ['thread-a', 'thread-b', 'thread-c'] });
  assert.equal(activeNativeTurns.has('thread-a'), false);
  assert.equal(activeNativeTurns.has('thread-b'), true, 'a terminal record for another turn cannot clear the active override');
  assert.equal(activeNativeTurns.has('thread-c'), false, 'a newer raw running turn must take over a stale terminal override');
  assert.deepEqual(cleared, [
    { type: 'turn-cleared', threadId: 'thread-a', turnId: 'turn-current' },
    { type: 'turn-cleared', threadId: 'thread-c', turnId: 'turn-current' },
  ]);
});

test('terminal completion clears an already persisted terminal without another watcher change', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const terminalStart = serverSource.indexOf('function nativeTurnHasPersistedTerminal');
  const terminalEnd = serverSource.indexOf('\nfunction broadcastNativeRuntime', terminalStart);
  const completionStart = serverSource.indexOf('function recordNativeTurnCompletion');
  const completionEnd = serverSource.indexOf('\nfunction currentNativeTurnId', completionStart);
  assert.ok(terminalStart >= 0 && terminalEnd > terminalStart);
  assert.ok(completionStart >= 0 && completionEnd > completionStart);

  const activeNativeTurns = new Map([['thread-a', { turnId: 'turn-current', status: 'running' }]]);
  const events = [];
  const dispatches = [];
  const api = new Function(
    'activeNativeTurns',
    'cleanNativeThreadId',
    'nativeSessions',
    'broadcastNativeRuntime',
    'nativeTurnStatus',
    'setNativeTurnState',
    'scheduleServerPromptQueueDispatch',
    'releaseAppServerThreadAfterTurn',
    `${serverSource.slice(terminalStart, terminalEnd)}; ${serverSource.slice(completionStart, completionEnd)}; return { recordNativeTurnCompletion };`,
  )(
    activeNativeTurns,
    (value) => String(value || '').trim(),
    {
      get: () => ({
        status: 'done',
        latestTurnId: 'turn-current',
        messages: [{ turnId: 'turn-current', role: 'process', kind: 'task_complete' }],
      }),
    },
    (event) => events.push(event),
    (value) => String(value || '').toLowerCase() === 'failed' ? 'error' : 'done',
    (threadId, state) => activeNativeTurns.set(threadId, { ...activeNativeTurns.get(threadId), ...state }),
    (...args) => dispatches.push(args),
    () => Promise.resolve(false),
  );

  assert.equal(api.recordNativeTurnCompletion('thread-a', { id: 'turn-current', status: 'completed' }), true);
  assert.equal(activeNativeTurns.has('thread-a'), false, 'a prior watcher refresh must not leave a permanent override');
  assert.deepEqual(events, [{ type: 'turn-cleared', threadId: 'thread-a', turnId: 'turn-current' }]);
  assert.deepEqual(dispatches, [['thread-a', 160]]);
});

test('server-owned Web queues retry only while native state is settling', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const retryStart = serverSource.indexOf('const SERVER_PROMPT_QUEUE_SETTLING_RETRY_LIMIT');
  const retryEnd = serverSource.indexOf('\nfunction scheduleIdleServerPromptQueueDispatches', retryStart);
  const workerStart = serverSource.indexOf('async function dispatchNextServerQueuedPrompt');
  const workerEnd = serverSource.indexOf('\nfunction broadcastPromptQueueChange', workerStart);
  assert.ok(retryStart >= 0 && retryEnd > retryStart);
  assert.ok(workerStart >= 0 && workerEnd > workerStart);

  const timers = [];
  const cleared = [];
  const refreshes = [];
  const retries = new Map();
  const api = new Function(
    'serverPromptQueueDispatchTimers',
    'serverPromptQueueDispatchRetries',
    'cleanNativeThreadId',
    'getPromptQueueItems',
    'isAppSourcedQueueItem',
    'clearTimeout',
    'setTimeout',
    'nativeAppErrorStatus',
    'nativeSessions',
    'console',
    `${serverSource.slice(retryStart, retryEnd)}; return { isServerPromptQueueDispatchSettlingError, retryServerPromptQueueDispatchAfterSettling };`,
  )(
    new Map(),
    retries,
    (value) => String(value || '').trim(),
    () => [{ id: 'web-queue-item', source: 'web', autoDispatch: true }],
    () => false,
    (timer) => cleared.push(timer),
    (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    (error) => Number(error?.statusCode || 502),
    { scheduleRefresh: () => refreshes.push(true) },
    { warn: () => {} },
  );

  assert.equal(api.isServerPromptQueueDispatchSettlingError({ statusCode: 409 }), true);
  assert.equal(api.isServerPromptQueueDispatchSettlingError({ statusCode: 409 }, { startAttempted: true }), false);
  assert.equal(api.isServerPromptQueueDispatchSettlingError({ message: 'already running' }), false);
  assert.equal(api.isServerPromptQueueDispatchSettlingError({ statusCode: 502 }), false);
  assert.equal(api.retryServerPromptQueueDispatchAfterSettling('thread-a'), true);
  assert.equal(retries.get('thread-a'), 1);
  assert.equal(timers.at(-1).delay, 240);
  assert.equal(api.retryServerPromptQueueDispatchAfterSettling('thread-a'), true);
  assert.equal(retries.get('thread-a'), 2);
  assert.equal(timers.at(-1).delay, 480);
  assert.equal(cleared.length, 1, 'the latest retry owns the only queued timer');
  assert.equal(refreshes.length, 2);
  assert.equal(api.retryServerPromptQueueDispatchAfterSettling('thread-a'), true);
  assert.equal(api.retryServerPromptQueueDispatchAfterSettling('thread-a'), true);
  assert.equal(api.retryServerPromptQueueDispatchAfterSettling('thread-a'), false);
  assert.equal(retries.has('thread-a'), false, 'the bounded retry chain must stop without a later event');

  const workerSource = serverSource.slice(workerStart, workerEnd);
  assert.match(workerSource, /if \(serverPromptQueueDispatchingThreads\.has\(id\) \|\| nativeTurnReservations\.has\(id\)\) return false/);
  assert.match(workerSource, /if \(conversation\.status === 'running'\) \{\s*retryServerPromptQueueDispatchAfterSettling\(id, \{ quiet: true \}\);/);
  assert.match(workerSource, /retryAfterSettling = isServerPromptQueueDispatchSettlingError\(error, \{ startAttempted \}\)/);

  const queueItem = { id: 'web-queue-item', source: 'web', autoDispatch: true };
  const dispatching = new Set();
  const reservations = new Set();
  const activeTurns = new Map();
  const retryCalls = [];
  const resetCalls = [];
  const consumed = [];
  const released = [];
  let refreshed = 0;
  let conversation = { status: 'running', metadata: {} };
  let continueTurn = async () => ({ turnId: 'unexpected' });
  const dispatchApi = new Function(
    'cleanNativeThreadId',
    'serverPromptQueueDispatchingThreads',
    'nativeTurnReservations',
    'nativeSessions',
    'activeNativeTurns',
    'getPromptQueueItems',
    'isAppSourcedQueueItem',
    'resetServerPromptQueueDispatchRetries',
    'retryServerPromptQueueDispatchAfterSettling',
    'reservePromptQueueItem',
    'serverQueuedPromptToNativeTurn',
    'continueNativeTurn',
    'consumePromptQueueReservation',
    'releasePromptQueueReservation',
    'isServerPromptQueueDispatchSettlingError',
    'markServerPromptQueueItemUncertain',
    'console',
    `${workerSource}; return { dispatchNextServerQueuedPrompt };`,
  )(
    (value) => String(value || '').trim(),
    dispatching,
    reservations,
    { get: () => conversation, scheduleRefresh: () => { refreshed += 1; } },
    activeTurns,
    () => [queueItem],
    () => false,
    (threadId) => resetCalls.push(threadId),
    (threadId) => retryCalls.push(threadId),
    () => ({ item: queueItem }),
    (item) => item,
    (...args) => continueTurn(...args),
    (reservation) => consumed.push(reservation),
    (reservation) => released.push(reservation),
    (error, { startAttempted = false } = {}) => Number(error?.statusCode || 502) === 409 && !startAttempted,
    (threadId, item, error) => {
      queueItem.autoDispatch = false;
      queueItem.dispatchState = 'uncertain';
      queueItem.dispatchError = String(error?.message || 'unknown dispatch result');
    },
    { warn: () => {} },
  );

  assert.equal(await dispatchApi.dispatchNextServerQueuedPrompt('thread-a'), false);
  assert.deepEqual(retryCalls, ['thread-a'], 'a still-running snapshot is rechecked without starting a turn');
  assert.equal(consumed.length, 0);

  reservations.add('thread-a');
  assert.equal(await dispatchApi.dispatchNextServerQueuedPrompt('thread-a'), false);
  assert.deepEqual(retryCalls, ['thread-a'], 'an in-flight caller owns the result and must not be retried');
  reservations.delete('thread-a');

  conversation = { status: 'done', metadata: {} };
  continueTurn = async () => { throw { statusCode: 409 }; };
  assert.equal(await dispatchApi.dispatchNextServerQueuedPrompt('thread-a'), false);
  assert.deepEqual(retryCalls, ['thread-a'], 'a post-start 409 is not safe to replay automatically');
  assert.equal(consumed.length, 0);
  assert.deepEqual(
    { autoDispatch: queueItem.autoDispatch, dispatchState: queueItem.dispatchState },
    { autoDispatch: false, dispatchState: 'uncertain' },
    'a post-start conflict is preserved for explicit retry',
  );
  queueItem.autoDispatch = true;
  queueItem.dispatchState = '';

  continueTurn = async () => { throw { statusCode: 502 }; };
  assert.equal(await dispatchApi.dispatchNextServerQueuedPrompt('thread-a'), false);
  assert.deepEqual(retryCalls, ['thread-a'], 'an uncertain upstream failure is never automatically replayed');
  assert.deepEqual(
    { autoDispatch: queueItem.autoDispatch, dispatchState: queueItem.dispatchState },
    { autoDispatch: false, dispatchState: 'uncertain' },
    'an unknown post-start result remains visible for explicit retry instead of being replayed automatically',
  );

  continueTurn = async () => ({ turnId: 'turn-next' });
  assert.equal(await dispatchApi.dispatchNextServerQueuedPrompt('thread-a'), false, 'an uncertain item is never started by the background worker');
  queueItem.autoDispatch = true;
  queueItem.dispatchState = '';
  assert.equal(await dispatchApi.dispatchNextServerQueuedPrompt('thread-a'), true);
  assert.equal(consumed.length, 1);
  assert.equal(refreshed, 1);
  assert.ok(released.length >= 3);
});

test('native session terminal state clears a stale in-memory running turn', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const helperStart = serverSource.indexOf('function nativeActiveTurnFor');
  const helperEnd = serverSource.indexOf('\nfunction nativeSessionSummaries', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);

  const activeNativeTurns = new Map([
    ['thread-done', { turnId: 'turn-done', status: 'running' }],
    ['thread-new-turn', { turnId: 'turn-new', status: 'running' }],
    ['thread-running', { turnId: 'turn-running', status: 'running' }],
    ['thread-resumed', {
      turnId: 'turn-interrupted',
      status: 'interrupted',
      updatedAt: '2026-08-07T13:10:00.000Z',
    }],
    ['thread-stale-jsonl', {
      turnId: 'turn-interrupted',
      status: 'interrupted',
      updatedAt: '2026-08-07T13:20:00.000Z',
    }],

  ]);
  const api = new Function(
    'activeNativeTurns',
    'cleanNativeThreadId',
    `${serverSource.slice(helperStart, helperEnd)}; return { nativeActiveTurnFor };`,
  )(
    activeNativeTurns,
    (value) => String(value || '').trim(),
  );

  assert.equal(api.nativeActiveTurnFor('thread-done', {
    status: 'done',
    latestTurnId: 'turn-done',
  }), null);
  assert.equal(activeNativeTurns.has('thread-done'), false);

  const newTurn = api.nativeActiveTurnFor('thread-new-turn', {
    status: 'done',
    latestTurnId: 'turn-old',
  });
  assert.equal(newTurn.status, 'running');
  assert.equal(activeNativeTurns.has('thread-new-turn'), true);

  const stillRunning = api.nativeActiveTurnFor('thread-running', {
    status: 'running',
    latestTurnId: 'turn-running',
  });
  assert.equal(stillRunning.status, 'running');
  assert.equal(activeNativeTurns.has('thread-running'), true);

  assert.equal(api.nativeActiveTurnFor('thread-resumed', {
    status: 'running',
    latestTurnId: 'turn-resumed',
    latestTurnStartedAt: '2026-08-07T13:18:58.198Z',
  }), null);
  assert.equal(activeNativeTurns.has('thread-resumed'), false, 'a newer persisted turn must clear the old paused override');

  const stalePersistedRunning = api.nativeActiveTurnFor('thread-stale-jsonl', {
    status: 'running',
    latestTurnId: 'turn-older',
    latestTurnStartedAt: '2026-08-07T13:00:00.000Z',
  });
  assert.equal(stalePersistedRunning.status, 'interrupted');
  assert.equal(activeNativeTurns.has('thread-stale-jsonl'), true, 'an older JSONL running state must not undo a newer pause');
});

test('app-server latest turn status repairs stale JSONL running state after restart', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const helperStart = serverSource.indexOf('function appServerTurnStartedAt');
  const helperEnd = serverSource.indexOf('\nfunction requestDesktopThreadSnapshot', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);

  const activeNativeTurns = new Map();
  const updates = [];
  const dispatches = [];
  const requests = [];
  const api = new Function(
    'activeNativeTurns',
    'cleanNativeThreadId',
    'nativeTurnStatus',
    'setNativeTurnState',
    'scheduleServerPromptQueueDispatch',
    'nativeActiveTurnFor',
    'nativeTurnStatusSyncRequests',
    'nativeTurnStatusSyncTimes',
    'NATIVE_TURN_STATUS_SYNC_INTERVAL_MS',
    'NATIVE_TURN_STATUS_ACTIVITY_GRACE_MS',
    'appServerClient',
    'NATIVE_TURN_STATUS_SYNC_TIMEOUT_MS',
    'releaseAppServerThreadAfterTurn',
    `${serverSource.slice(helperStart, helperEnd)}; return {
      applyAppServerTurnStatus,
      reconcileNativeTurnStatusFromAppServer,
    };`,
  )(
    activeNativeTurns,
    (value) => String(value || '').trim(),
    (value) => {
      const status = String(value || '').toLowerCase();
      if (status === 'inprogress' || status === 'running') return 'running';
      if (status === 'failed' || status === 'error') return 'error';
      if (['interrupted', 'cancelled', 'canceled', 'aborted'].includes(status)) return 'interrupted';
      return 'done';
    },
    (threadId, state) => {
      updates.push({ threadId, state });
      activeNativeTurns.set(threadId, { ...state, updatedAt: '2026-08-07T14:00:00.000Z' });
    },
    (...args) => dispatches.push(args),
    (threadId) => activeNativeTurns.get(threadId) || null,
    new Map(),
    new Map(),
    1500,
    5 * 60 * 1000,
    {
      request: async (method, params, options) => {
        requests.push({ method, params, options });
        return {
          data: [{
            id: 'turn-paused',
            status: 'interrupted',
            startedAt: Date.parse('2026-08-07T09:34:46.000Z') / 1000,
          }],
        };
      },
    },
    4000,
    () => Promise.resolve(false),
  );

  assert.equal(await api.reconcileNativeTurnStatusFromAppServer('thread-paused', {
    status: 'running',
    latestTurnId: 'turn-paused',
    latestTurnStartedAt: '2026-08-07T09:34:46.000Z',
  }), true);
  assert.deepEqual(requests, [{
    method: 'thread/turns/list',
    params: {
      threadId: 'thread-paused',
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    },
    options: { timeoutMs: 4000 },
  }]);
  assert.deepEqual(updates, [{
    threadId: 'thread-paused',
    state: {
      turnId: 'turn-paused',
      status: 'interrupted',
      startedAt: '2026-08-07T09:34:46.000Z',
      transport: 'app-server-status',
    },
  }]);
  assert.deepEqual(dispatches, [['thread-paused', 160]]);

  const updateCountBeforeLiveTurn = updates.length;
  assert.equal(api.applyAppServerTurnStatus('thread-live', {
    id: 'turn-live',
    status: 'interrupted',
    startedAt: Date.parse('2026-08-07T14:00:00.000Z') / 1000,
  }, {
    status: 'running',
    latestTurnId: 'turn-live',
    latestTurnStartedAt: '2026-08-07T14:00:00.000Z',
    updatedAt: new Date().toISOString(),
  }), false, 'fresh JSONL activity must outrank a stale app-server terminal status');
  assert.equal(updates.length, updateCountBeforeLiveTurn);

  activeNativeTurns.set('thread-newer', {
    turnId: 'turn-newer',
    status: 'running',
    startedAt: '2026-08-07T10:00:00.000Z',
  });
  assert.equal(api.applyAppServerTurnStatus('thread-newer', {
    id: 'turn-older',
    status: 'interrupted',
    startedAt: Date.parse('2026-08-07T09:00:00.000Z') / 1000,
  }), false, 'an older persisted terminal state must not stop a newer live turn');
});

test('stale app-server unsubscribe cleanup cannot suppress a later reload on the same connection', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const helperStart = serverSource.indexOf('function isAppServerThreadAlreadyUnsubscribedError');
  const helperEnd = serverSource.indexOf('\nfunction releaseAppServerThreadAfterTurn', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);

  const connection = {};
  const appServerLoadedThreads = new Map([
    ['thread-a', { connection, turnId: '', loadedAt: 0 }],
  ]);
  const appServerUnsubscribeRequests = new Map();
  const requests = [];
  const appServerClient = {
    child: connection,
    initialized: false,
    requestWithConnection: async (method, params, options) => {
      requests.push({ method, params, options });
      return { result: {}, child: connection };
    },
  };
  const api = new Function(
    'cleanNativeThreadId',
    'appServerLoadedThreads',
    'appServerUnsubscribeRequests',
    'activeNativeTurns',
    'appServerClient',
    'APP_SERVER_THREAD_UNSUBSCRIBE_TIMEOUT_MS',
    'console',
    `${serverSource.slice(helperStart, helperEnd)}; return { unsubscribeAppServerThread };`,
  )(
    (value) => String(value || '').trim(),
    appServerLoadedThreads,
    appServerUnsubscribeRequests,
    new Map(),
    appServerClient,
    5000,
    { warn() {} },
  );

  assert.equal(await api.unsubscribeAppServerThread('thread-a'), true);
  assert.equal(appServerLoadedThreads.has('thread-a'), false);
  assert.equal(
    appServerUnsubscribeRequests.size,
    0,
    'an already-closed connection must not leave a resolved unsubscribe entry behind',
  );

  appServerClient.initialized = true;
  appServerLoadedThreads.set('thread-a', { connection, turnId: '', loadedAt: 1 });
  assert.equal(await api.unsubscribeAppServerThread('thread-a'), true);
  assert.deepEqual(requests, [{
    method: 'thread/unsubscribe',
    params: { threadId: 'thread-a' },
    options: { timeoutMs: 5000 },
  }]);
  assert.equal(appServerUnsubscribeRequests.size, 0);
});

test('Desktop snapshots and patches synchronize live and terminal turn state', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const handlerStart = serverSource.indexOf('function handleDesktopIpcBroadcast');
  const handlerEnd = serverSource.indexOf('\nfunction desktopPendingKey', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);

  const activeNativeTurns = new Map([
    ['thread-a', { turnId: 'turn-a', status: 'running', transport: 'desktop-ipc' }],
    ['thread-b', { turnId: 'turn-b', status: 'running', transport: 'desktop-ipc' }],
    ['thread-c', { turnId: 'turn-c', status: 'interrupted', transport: 'app-server-status' }],
  ]);
  const conversations = new Map([
    ['thread-a', { status: 'running', latestTurnId: 'turn-a' }],
    ['thread-b', { status: 'running', latestTurnId: 'turn-b' }],
    ['thread-c', { status: 'interrupted', latestTurnId: 'turn-c' }],
  ]);
  const updates = [];
  const dispatches = [];
  const requestedSnapshots = [];
  const api = new Function(
    'desktopThreadStates',
    'cleanNativeThreadId',
    'requestDesktopThreadSnapshot',
    'syncDesktopPendingRequests',
    'activeNativeTurns',
    'nativeSessions',
    'setNativeTurnState',
    'scheduleServerPromptQueueDispatch',
    `${serverSource.slice(handlerStart, handlerEnd)}; return { handleDesktopIpcBroadcast };`,
  )(
    new Map(),
    (value) => String(value || '').trim(),
    (...args) => requestedSnapshots.push(args),
    () => {},
    activeNativeTurns,
    { get: (threadId) => conversations.get(threadId) || null },
    (threadId, state) => {
      updates.push({ threadId, state });
      activeNativeTurns.set(threadId, { ...activeNativeTurns.get(threadId), ...state });
    },
    (...args) => dispatches.push(args),
  );

  api.handleDesktopIpcBroadcast({
    method: 'thread-stream-state-changed',
    sourceClientId: 'desktop-owner',
    params: {
      conversationId: 'thread-a',
      change: {
        type: 'snapshot',
        revision: 1,
        conversationState: {
          requests: [],
          turns: [{ id: 'turn-a', status: 'inProgress' }],
        },
      },
    },
  });
  api.handleDesktopIpcBroadcast({
    method: 'thread-stream-state-changed',
    sourceClientId: 'desktop-owner',
    params: {
      conversationId: 'thread-a',
      change: {
        type: 'patches',
        baseRevision: 1,
        revision: 2,
        patches: [{ op: 'replace', path: ['turns', 0, 'status'], value: 'interrupted' }],
      },
    },
  });
  api.handleDesktopIpcBroadcast({
    method: 'thread-stream-state-changed',
    sourceClientId: 'desktop-owner',
    params: {
      conversationId: 'thread-b',
      change: {
        type: 'snapshot',
        revision: 1,
        conversationState: {
          requests: [],
          turns: [{ id: 'turn-b', status: 'completed' }],
        },
      },
    },
  });
  api.handleDesktopIpcBroadcast({
    method: 'thread-stream-state-changed',
    sourceClientId: 'desktop-owner',
    params: {
      conversationId: 'thread-c',
      change: {
        type: 'snapshot',
        revision: 1,
        conversationState: {
          requests: [],
          turns: [{ id: 'turn-c', status: 'inProgress' }],
        },
      },
    },
  });

  assert.deepEqual(updates, [
    {
      threadId: 'thread-a',
      state: { turnId: 'turn-a', status: 'interrupted', transport: 'desktop-ipc' },
    },
    {
      threadId: 'thread-b',
      state: { turnId: 'turn-b', status: 'done', transport: 'desktop-ipc' },
    },
    {
      threadId: 'thread-c',
      state: { turnId: 'turn-c', status: 'running', transport: 'desktop-ipc' },
    },
  ]);
  assert.deepEqual(dispatches, [['thread-a', 160], ['thread-b', 160]]);

  api.handleDesktopIpcBroadcast({
    method: 'thread-stream-state-changed',
    sourceClientId: 'desktop-owner',
    params: {
      conversationId: 'thread-a',
      change: {
        type: 'patches',
        baseRevision: 2,
        revision: 3,
        patches: [{ op: 'replace', path: ['turnHistory', 'history', 'entitiesByKey'], value: {} }],
      },
    },
  });
  assert.deepEqual(requestedSnapshots, [['thread-a', { force: true }]]);
});

test('Desktop owner loss preserves running state until an authoritative status check completes', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const helperStart = serverSource.indexOf('function requestDesktopThreadSnapshot');
  const helperEnd = serverSource.indexOf('\nasync function respondToNativeRequest', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);

  const activeNativeTurns = new Map([
    ['desktop-turn', { turnId: 'desktop-turn-id', status: 'running', transport: 'desktop-ipc' }],
  ]);
  const conversations = new Map([
    ['desktop-turn', {
      status: 'running',
      latestTurnId: 'desktop-turn-id',
      metadata: { originator: 'Codex Desktop' },
    }],
  ]);
  const reconciliations = [];
  let refreshes = 0;
  const api = new Function(
    'desktopSnapshotRequests',
    'desktopSnapshotRequestTimes',
    'desktopIpcClient',
    'isCodexDesktopIpcUnavailableError',
    'cleanNativeThreadId',
    'activeNativeTurns',
    'nativeSessions',
    'reconcileNativeTurnStatusFromAppServer',
    `${serverSource.slice(helperStart, helperEnd)}; return { requestDesktopThreadSnapshot };`,
  )(
    new Map(),
    new Map(),
    {
      loadCompleteHistory: async () => {
        const error = new Error('no client');
        error.reason = 'no-client-found';
        throw error;
      },
    },
    (error) => error?.reason === 'no-client-found',
    (value) => String(value || '').trim(),
    activeNativeTurns,
    {
      get: (threadId) => conversations.get(threadId) || null,
      scheduleRefresh: () => { refreshes += 1; },
    },
    async (...args) => {
      reconciliations.push(args);
      return false;
    },
  );

  await api.requestDesktopThreadSnapshot('desktop-turn', { force: true });

  assert.equal(activeNativeTurns.get('desktop-turn')?.status, 'running');
  assert.equal(refreshes, 1);
  assert.deepEqual(reconciliations, [[
    'desktop-turn',
    conversations.get('desktop-turn'),
    { force: true },
  ]]);
});

test('invalid Desktop request patches force a snapshot without advancing state', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const helperStart = serverSource.indexOf('function normalizeDesktopRequests');
  const helperEnd = serverSource.indexOf('\nfunction syncDesktopTurnState', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const api = new Function(
    `${serverSource.slice(helperStart, helperEnd)}; return { applyDesktopStatePatches };`,
  )();
  const current = {
    requests: [{ id: 'approval-1', method: 'item/commandExecution/requestApproval' }],
    turns: [{ id: 'turn-1', status: 'inProgress' }],
  };

  assert.equal(api.applyDesktopStatePatches(current, [
    { op: 'remove', path: ['requests', 99] },
  ]), null);
  assert.equal(api.applyDesktopStatePatches(current, [
    { op: 'replace', path: ['requests', 0, 'missing'], value: true },
  ]), null);
  assert.equal(api.applyDesktopStatePatches(current, [
    { op: 'replace', path: ['unknown', 0], value: true },
  ]), null);
  assert.deepEqual(api.applyDesktopStatePatches(current, [
    { op: 'remove', path: ['requests', 0] },
  ]), {
    requests: [],
    turns: [{ id: 'turn-1', status: 'inProgress' }],
  });
});

test('review regressions keep usage, goals, and theme state authoritative', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');

  assert.doesNotMatch(serverSource, /trackDeepSeekBalanceSpend|DEEPSEEK_BALANCE_FILE/);
  assert.doesNotMatch(serverSource, /deepSeekStats|usageStats = deepSeekStats|deepseek-usage-calibration|accumulateDeepSeekUsage/);
  assert.equal(
    (serverSource.match(/app\.patch\('\/api\/native-sessions\/:id\/goal'/g) || []).length,
    1,
  );
  assert.equal(
    (serverSource.match(/app\.delete\('\/api\/native-sessions\/:id\/goal'/g) || []).length,
    1,
  );
  assert.match(
    serverSource,
    /app\.patch\('\/api\/native-sessions\/:id\/goal'[\s\S]*?broadcastNativeRuntime\(\{ type: 'goal', threadId, goal: result\?\.goal \|\| null \}\)/,
  );
  assert.match(
    serverSource,
    /function toggleTheme\(\)\{const next=appearance\.theme==='system'\?'light':appearance\.theme==='light'\?'dark':'system';/,
  );
  assert.match(serverSource, /黑暗模式；点击恢复跟随系统/);

});

test('native tool image output falls back to embedded data after its source file is gone', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const helperStart = serverSource.indexOf('function decodeNativeToolImageOutput');
  const helperEnd = serverSource.indexOf('\nasync function continueNativeTurn', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const api = new Function(
    'TOOL_IMAGE_MAX_BYTES',
    `${serverSource.slice(helperStart, helperEnd)}; return { decodeNativeToolImageOutput };`,
  )(25 * 1024 * 1024);
  const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const result = api.decodeNativeToolImageOutput({
    content: JSON.stringify({
      output: [{ type: 'input_image', image_url: `data:image/png;base64,${imageData}` }],
    }),
  });
  assert.equal(result.type, 'image/png');
  assert.deepEqual(result.data, Buffer.from(imageData, 'base64'));
});

test('playground refresh preserves browser streaming preferences and completed Agent images', async () => {
  const playgroundPage = await readFile(
    path.join(ROOT, 'vendor', 'gpt-image-playground', 'app', 'index.html'),
    'utf8',
  );
  const playgroundOverrides = await readFile(
    path.join(ROOT, 'vendor', 'gpt-image-playground', 'app', 'codex-web-overrides.css'),
    'utf8',
  );
  const playgroundIntegration = await readFile(
    path.join(ROOT, 'vendor', 'gpt-image-playground', 'app', 'codex-web-integration.js'),
    'utf8',
  );
  const playgroundAssetPath = playgroundPage.match(/src="\.\/(assets\/[^"\?]+\.js)/)?.[1];
  assert.ok(playgroundAssetPath);
  assert.match(playgroundPage, /href="\.\/codex-web-overrides\.css\?v=[^"]+"/);
  assert.match(playgroundPage, /src="\.\/codex-web-integration\.js\?v=[^"]+"/);
  assert.match(playgroundOverrides, /\[data-input-bar\]:has\(\[contenteditable="true"\]:focus\)/);
  assert.match(playgroundOverrides, /font-size:\s*16px/);
  assert.match(playgroundOverrides, /> \.collapse-section\s*\{[^}]*grid-template-rows:\s*0fr/s);
  assert.match(playgroundOverrides, /\.codexWebUpdateButton\s*\{/);
  assert.match(playgroundOverrides, /\.codexWebUpdateButton--desktop\s*\{[^}]*margin-left:\s*0/s);
  assert.match(playgroundOverrides, /\.codexWebUpdateButton--mobile\s*\{[^}]*display:\s*none/s);
  assert.match(
    playgroundOverrides,
    /@media \(max-width:\s*639px\)[\s\S]*\.codexWebUpdateButton--mobile\s*\{[^}]*display:\s*inline-flex/s,
  );
  assert.match(
    playgroundOverrides,
    /@media \(max-width:\s*639px\)[\s\S]*\.codexWebUpdateButton--desktop\s*\{[^}]*display:\s*none/s,
  );
  assert.match(playgroundIntegration, /\/api\/playground-update\/status/);
  assert.match(playgroundIntegration, /method:\s*'POST'/);
  assert.match(playgroundIntegration, /const actions\s*=\s*settings\?\.parentElement\?\.parentElement/);
  assert.match(playgroundIntegration, /actions\.prepend\(createButton\('desktop'\)\)/);
  assert.match(playgroundIntegration, /actions\.prepend\(createButton\('mobile'\)\)/);
  assert.doesNotMatch(playgroundIntegration, /const brandRow=/);
  assert.match(playgroundIntegration, /setInterval\(scheduleEnsureButtons, 1500\)/);
  assert.match(playgroundIntegration, /if \(reloadWhenIdleTimer\) return/);
  assert.match(playgroundIntegration, /setTimeout\(reloadWhenGenerationEnds, 900\)/);
  assert.match(playgroundIntegration, /if \(document\.querySelector\('button\[aria-label=/);
  assert.match(playgroundIntegration, /scheduleReloadWhenIdle\(\);\s*\n\s*return/);
  assert.match(playgroundIntegration, /window\.location\.reload\(\)/);
  assert.doesNotMatch(playgroundIntegration, /MutationObserver/);
  const playgroundAssetScript = await readFile(
    path.join(ROOT, 'vendor', 'gpt-image-playground', 'app', playgroundAssetPath),
    'utf8',
  );
  const playgroundPatchSource = await readFile(
    path.join(ROOT, 'vendor', 'gpt-image-playground', 'patches', 'codex-web.patch'),
    'utf8',
  );
  const playgroundV072PatchSource = await readFile(
    path.join(ROOT, 'vendor', 'gpt-image-playground', 'patches', 'codex-web-v0.7.2.patch'),
    'utf8',
  );
  const playgroundV073PatchSource = await readFile(
    path.join(ROOT, 'vendor', 'gpt-image-playground', 'patches', 'codex-web-v0.7.3.patch'),
    'utf8',
  );

  assert.match(playgroundPatchSource, /streamImages: typeof existing\?\.streamImages === 'boolean'/);
  assert.match(playgroundPatchSource, /streamPartialImages: typeof existing\?\.streamPartialImages === 'number'/);
  assert.match(playgroundPatchSource, /let agentConversationPersistPromise: Promise<void> \| null = null/);
  assert.match(playgroundPatchSource, /await updateTaskInStore\(taskId, \{/);
  assert.match(playgroundPatchSource, /await flushAgentConversationsToIndexedDB\(\)/);
  assert.match(playgroundPatchSource, /const suppressCompletedImageTimeout = isAssistant/);
  assert.match(playgroundPatchSource, /AGENT_POST_IMAGE_STREAM_TIMEOUT\.test\(message\)/);
  assert.match(playgroundPatchSource, /const completeWithSuccessfulImages =/);
  assert.match(playgroundPatchSource, /status: 'done',\s*\n\+\s*error: null/);
  assert.match(playgroundV072PatchSource, /imageProfile,\s*\n\+\s*params: imageParams/);
  assert.match(playgroundV072PatchSource, /normalizeParamsForSettings\(imageParams, imageRequestSettings/);
  assert.match(playgroundV073PatchSource, /normalizeParamsForSettings\(imageParams, imageRequestSettings/);
  assert.match(playgroundAssetScript, /streamImages:typeof\(w==null\?void 0:w\.streamImages\)=="boolean"\?w\.streamImages:I\.streamImages/);
  assert.match(playgroundAssetScript, /streamPartialImages:typeof\(w==null\?void 0:w\.streamPartialImages\)=="number"\?w\.streamPartialImages:I\.streamPartialImages/);
  assert.match(
    playgroundAssetScript,
    /R\.getState\(\)\.setDetailTaskId\(e\)\}\}finally\{for\(const k of a\.inputImageIds\)[A-Za-z_$][\w$]*\(k\)\}/,
  );
  assert.doesNotMatch(
    playgroundAssetScript,
    /R\.getState\(\)\.setDetailTaskId\(e\)\}\}\}finally\{for\(const k of a\.inputImageIds\)[A-Za-z_$][\w$]*\(k\)\}/,
  );
  await new Promise((resolve, reject) => {
    execFile('node', ['--check', path.join(ROOT, 'vendor', 'gpt-image-playground', 'app', playgroundAssetPath)], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve();
    });
  });
});

test('playground proxy maps an external host alias only to a matching loopback provider port', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const helperStart = serverSource.indexOf('function isPlaygroundProviderHostAlias');
  const helperEnd = serverSource.indexOf('\nfunction normalizePlaygroundProxyBaseUrl', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helperSource = serverSource.slice(helperStart, helperEnd);
  const { isPlaygroundProviderHostAlias } = new Function(
    `${helperSource}; return { isPlaygroundProviderHostAlias };`,
  )();
  const provider = { baseUrl: 'http://127.0.0.1:8090/v1' };

  assert.equal(isPlaygroundProviderHostAlias(
    { hostname: '203.0.113.10' },
    new URL('http://203.0.113.10:8090/v1/images/generations'),
    provider,
  ), true);
  assert.equal(isPlaygroundProviderHostAlias(
    { hostname: '203.0.113.10' },
    new URL('http://203.0.113.9:8090/v1/images/generations'),
    provider,
  ), false);
  assert.equal(isPlaygroundProviderHostAlias(
    { hostname: '203.0.113.10' },
    new URL('http://203.0.113.10:8091/v1/images/generations'),
    provider,
  ), false);
  assert.equal(isPlaygroundProviderHostAlias(
    { hostname: '203.0.113.10' },
    new URL('http://203.0.113.10:8090/v1/images/generations'),
    { baseUrl: 'http://192.0.2.1:8090/v1' },
  ), false);
});

test('provider config reload guard preserves running app-server turns', async () => {
  const serverSource = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const helperStart = serverSource.indexOf('function assertAppServerConfigChangeAllowed');
  const helperEnd = serverSource.indexOf('\nasync function restartAppServerForConfigChange', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helperSource = serverSource.slice(helperStart, helperEnd);
  const buildGuard = (turns) => new Function(
    'activeNativeTurns',
    `${helperSource}; return assertAppServerConfigChangeAllowed;`,
  )(new Map(turns));

  assert.doesNotThrow(buildGuard([]));
  assert.doesNotThrow(buildGuard([['desktop', { status: 'running', transport: 'desktop-ipc' }]]));
  assert.throws(
    buildGuard([['local', { status: 'running', transport: 'app-server' }]]),
    (error) => error.statusCode === 409 && /任务正在运行/.test(error.message),
  );
});

test('login, read-only config, CLI arguments, and session restart', { timeout: 30000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-test-'));
  const runtime = path.join(temporary, 'runtime');
  const codexHome = path.join(temporary, 'codex-home');
  const fakeCodex = path.join(temporary, 'fake-codex.mjs');
  const fakeDocker = path.join(temporary, 'fake-docker.mjs');
  const fakeDockerArgsFile = path.join(temporary, 'fake-docker-args.json');
  const traceFile = path.join(temporary, 'codex-trace.json');
  const appServerTraceFile = path.join(temporary, 'app-server-trace.jsonl');
  const appServerControlFile = path.join(temporary, 'app-server-control.json');
  const codexGlobalStateFile = path.join(codexHome, '.codex-global-state.json');
  const imagePromptFetchFixture = path.join(temporary, 'image-prompt-fetch-fixture.mjs');
  const webEnv = path.join(temporary, 'web.env');
  const toolImagePath = path.join(temporary, 'tool-preview.png');
  const svgImagePath = path.join(temporary, 'grok-preview.svg');
  const invalidSvgImagePath = path.join(temporary, 'not-really-svg.svg');
  let externalImageRoot = '';
  let externalImagePath = '';
  const nativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa729';
  const nativeFirstTurnId = '019f4f84-ea9f-73c2-b997-deba7b4aa780';
  const nativeSecondTurnId = '019f4f84-ea9f-73c2-b997-deba7b4aa781';
  const forkedNativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa797';
  const createdNativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa799';
  const archivedNativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa730';
  const automationNativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa731';
  const subagentNativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa732';
  const appQueueOwnershipThreadId = '019f4f84-ea9f-73c2-b997-deba7b4aa733';
  const appQueueNoIdThreadId = '019f4f84-ea9f-73c2-b997-deba7b4aa734';
  const appQueueDuplicateNoIdThreadId = '019f4f84-ea9f-73c2-b997-deba7b4aa735';
  const appQueueEditThreadId = '019f4f84-ea9f-73c2-b997-deba7b4aa736';
  const appQueueReorderThreadId = '019f4f84-ea9f-73c2-b997-deba7b4aa737';
  const appQueueInterruptedThreadId = '019f4f84-ea9f-73c2-b997-deba7b4aa738';
  const appOwnedQueueItemId = 'app-owned-queue-item';
  const interruptedQueuePauseReason = 'Interrupted before the steer was accepted.';
  const appQueueInlineImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const appOwnedQueueRawItem = {
    id: appOwnedQueueItemId,
    text: '',
    context: {
      addedFiles: [{
        label: 'added-context.mjs',
        path: path.join(temporary, 'added-context.mjs'),
        fsPath: path.join(temporary, 'added-context.mjs'),
      }],
      chatGptConversationContexts: [],
      prompt: '',
      ideContext: null,
      imageAttachments: [{
        id: 'app-queue-image',
        filename: 'tool-preview.png',
        src: `file://${toolImagePath}`,
        localPath: toolImagePath,
      }],
      imageCommentDrafts: [],
      appshotContexts: [],
      fileAttachments: [{
        label: 'queue-context.mjs',
        path: path.join(temporary, 'queue-context.mjs'),
        fsPath: path.join(temporary, 'queue-context.mjs'),
        startLine: 4,
        endLine: 8,
      }],
      pastedTextAttachments: [{
        characterCount: 21,
        preview: 'pasted queue context',
        file: {
          label: 'pasted-text.txt',
          path: path.join(temporary, 'pasted-text.txt'),
          fsPath: path.join(temporary, 'pasted-text.txt'),
        },
      }],
      inAppBrowserContext: {
        currentUrls: ['http://127.0.0.1:36354/rich-queue'],
        isOpen: true,
        openTabCount: 1,
      },
      commentAttachments: [{
        type: 'comment',
        content: [{ content_type: 'text', text: 'Codex App owns this queued prompt' }],
        position: { side: 'right', path: 'browser:Rich queue fixture', line: 1 },
        localBrowserContext: {
          pageUrl: 'http://127.0.0.1:36354/rich-queue',
          framePath: [],
          frameUrl: null,
          targetDescription: 'Rich queue fixture',
          targetSelector: 'section.promptQueue',
          targetPath: 'main > section',
          nearbyText: 'queue context nearby text',
        },
        localBrowserCommentMetadata: {
          kind: 'element',
          markerViewportPoint: { x: 320, y: 640 },
          viewportSize: { width: 1145, height: 954 },
        },
        localBrowserScreenshot: { dataUrl: appQueueInlineImage },
      }],
      responseTextAnnotations: [],
      selectedTextAttachments: [],
      mcpAppModelContextAttachments: [],
      workspaceRoots: [temporary],
    },
    cwd: temporary,
    createdAt: 1785204000000,
  };
  const appOwnedEditQueueRawItem = {
    ...appOwnedQueueRawItem,
    id: 'app-owned-edit-item',
    text: 'Original editable prompt',
    context: {
      ...appOwnedQueueRawItem.context,
      prompt: 'Original editable prompt',
    },
    createdAt: 1785204000100,
  };
  const appQueueReorderFirstRawItem = {
    ...appOwnedQueueRawItem,
    id: 'app-reorder-first',
    text: 'First Codex App follow-up',
    context: { ...appOwnedQueueRawItem.context, prompt: 'First Codex App follow-up' },
    createdAt: 1785204000200,
  };
  const appQueueReorderSecondRawItem = {
    ...appOwnedQueueRawItem,
    id: 'app-reorder-second',
    text: 'Second Codex App follow-up',
    context: { ...appOwnedQueueRawItem.context, prompt: 'Second Codex App follow-up' },
    createdAt: 1785204000300,
  };
  const appQueueInterruptedRawItem = {
    ...appOwnedQueueRawItem,
    id: 'app-interrupted-follow-up',
    text: 'Resume this exact Codex App follow-up',
    context: { ...appOwnedQueueRawItem.context, prompt: 'Resume this exact Codex App follow-up' },
    pausedReason: interruptedQueuePauseReason,
    createdAt: 1785204000400,
  };
  const appQueueFailedRawItem = {
    ...appOwnedQueueRawItem,
    id: 'app-failed-follow-up',
    text: 'Keep this unrelated failure paused',
    context: { ...appOwnedQueueRawItem.context, prompt: 'Keep this unrelated failure paused' },
    pausedReason: 'Run ended before the steer was accepted.',
    createdAt: 1785204000500,
  };
  let child;
  let desktopIpc;
  let providerServer;
  let customProviderServer;
  let providerBaseUrl = '';
  let customProviderBaseUrl = '';
  const providerRequests = [];

  try {
    const providerHandler = async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      providerRequests.push({
        method: req.method,
        url: req.url,
        host: req.headers.host || '',
        authorization: req.headers.authorization || '',
        managementKey: req.headers['x-management-key'] || '',
        contentType: req.headers['content-type'] || '',
        body,
      });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v0/management/auth-files') {
        if (req.headers['x-management-key'] === 'bad-sub-key') {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res.end(JSON.stringify({
          files: [{
            id: 'codex-plus.json',
            name: 'codex-plus.json',
            type: 'codex',
            email: 'plus@example.com',
            auth_index: 'auth-index-1',
            account_id: 'acct-1',
            disabled: false,
          }],
        }));
        return;
      }
      if (req.url === '/v0/management/api-call') {
        if (req.headers['x-management-key'] === 'bad-sub-key') {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res.end(JSON.stringify({
          status_code: 200,
          body: {
            plan_type: 'plus',
            email: 'plus@example.com',
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: {
                used_percent: 30,
                limit_window_seconds: 18000,
                reset_at: 1785141573,
              },
              secondary_window: {
                used_percent: 18,
                limit_window_seconds: 604800,
                reset_at: 1785741573,
              },
            },
            rate_limit_reset_credits: { available_count: 1 },
          },
        }));
        return;
      }
      if (req.url === '/v1/usage') {
        if (req.headers.authorization === 'Bearer bad-sub-key') {
          res.end(JSON.stringify({ isValid: false, status: 'invalid_key' }));
          return;
        }
        res.end(JSON.stringify({
          isValid: true,
          mode: 'unrestricted',
          planName: 'GPT-20x-300',
          unit: 'USD',
          remaining: 70,
          subscription: {
            weekly_limit_usd: 100,
            weekly_usage_usd: 30,
            monthly_limit_usd: 400,
            monthly_usage_usd: 50,
            expires_at: '2026-08-01T00:00:00Z',
          },
          rate_limits: [{
            window: '5h',
            limit: 50,
            used: 10,
            remaining: 40,
            reset_at: '2026-07-19T05:00:00Z',
          }],
          usage: { today: { requests: 4, actual_cost: 3 } },
        }));
        return;
      }
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }));
        return;
      }
      if (req.url?.startsWith('/v1/images/generations')) {
        if (body.includes('heartbeat smoke test')) {
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        if (body.includes('forceTruncatedJson')) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
          res.write('{"data":[{"b64_json":"abc"');
          setTimeout(() => res.destroy(), 10);
          return;
        }
        if (body.includes('forceEventStream')) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          });
          res.write('data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"' + Buffer.from('partial').toString('base64') + '"}\n\n');
          await new Promise((resolve) => setTimeout(resolve, 60));
          res.write('data: {"object":"image.generation.result","data":[{"b64_json":"' + Buffer.from('final').toString('base64') + '"}]}\n\n');
          res.end();
          return;
        }
        res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('proxy-image').toString('base64') }] }));
        return;
      }
      if (req.url?.startsWith('/v1/responses')) {
        if (body.includes('forceStreamFailure')) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
          res.write('{"id":"partial"');
          setTimeout(() => res.destroy(), 10);
          return;
        }
        res.end(JSON.stringify({ id: 'response-fixture', output: [] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    };
    providerServer = createHttpServer(providerHandler);
    await new Promise((resolve, reject) => {
      providerServer.once('error', reject);
      providerServer.listen(0, '127.0.0.1', resolve);
    });
    providerBaseUrl = `http://127.0.0.1:${providerServer.address().port}`;
    customProviderServer = createHttpServer(providerHandler);
    await new Promise((resolve, reject) => {
      customProviderServer.once('error', reject);
      customProviderServer.listen(0, '127.0.0.1', resolve);
    });
    customProviderBaseUrl = `http://127.0.0.1:${customProviderServer.address().port}`;
    await mkdir(runtime, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    externalImageRoot = await mkdtemp(path.join(tmpdir(), 'codex-web-image-root-'));
    externalImagePath = path.join(externalImageRoot, 'gallery-preview.png');
    await writeFile(appServerControlFile, '{}');
    await writeFile(
      toolImagePath,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    );
    await writeFile(svgImagePath, '<?xml version="1.0"?>\n<!-- Grok SVG -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg>');
    await writeFile(invalidSvgImagePath, '<html><body>not an SVG image</body></html>');
    await writeFile(externalImagePath, await readFile(toolImagePath));
    await writeFile(imagePromptFetchFixture, `
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = typeof input === 'string' ? input : String(input?.url || input || '');
  if (url.endsWith('/data/images/case520.jpg')) {
    const body = new Uint8Array(2048);
    body[0] = 0xff;
    body[1] = 0xd8;
    body[body.length - 2] = 0xff;
    body[body.length - 1] = 0xd9;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  }
  return originalFetch(input, options);
};
`);
    await writeFile(path.join(codexHome, 'config.toml'), `model_provider = "fake"
model = "test-model"
model_reasoning_effort = "max"

[model_providers.fake]
name = "Fake"
base_url = "${providerBaseUrl}/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "test-token"

[model_providers.switchtest]
name = "Switch Test"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "switch-test-token"
`);
    await writeFile(codexGlobalStateFile, JSON.stringify({
      'pinned-thread-ids': [nativeSessionId, archivedNativeSessionId],
      'projectless-thread-ids': [],
      'thread-project-assignments': {},
      'electron-persisted-atom-state': {
        'unread-thread-ids-by-host-v1': {
          local: [
            nativeSessionId,
            forkedNativeSessionId,
            createdNativeSessionId,
            archivedNativeSessionId,
            automationNativeSessionId,
            subagentNativeSessionId,
            appQueueOwnershipThreadId,
            appQueueNoIdThreadId,
            appQueueDuplicateNoIdThreadId,
            appQueueEditThreadId,
            appQueueReorderThreadId,
            appQueueInterruptedThreadId,
          ],
        },
      },
      'queued-follow-ups': {
        [appQueueOwnershipThreadId]: [appOwnedQueueRawItem],
        [appQueueEditThreadId]: [appOwnedEditQueueRawItem],
        [appQueueReorderThreadId]: [appQueueReorderFirstRawItem, appQueueReorderSecondRawItem],
        [appQueueInterruptedThreadId]: [appQueueInterruptedRawItem, appQueueFailedRawItem],
        [appQueueNoIdThreadId]: [
          {
            text: 'Legacy predecessor without an id',
            createdAt: 1785204000500,
          },
          {
            text: 'Legacy Codex App prompt without an id',
            createdAt: 1785204001000,
          },
        ],
        [appQueueDuplicateNoIdThreadId]: [
          {
            text: 'Duplicate legacy prompt without an id',
            createdAt: 1785204002000,
          },
          {
            text: 'Duplicate legacy prompt without an id',
            createdAt: 1785204002000,
          },
        ],
      },
    }));
    const nativeSessionDir = path.join(codexHome, 'sessions', '2026', '07', '11');
    await mkdir(nativeSessionDir, { recursive: true });
    await writeFile(path.join(codexHome, 'session_index.jsonl'), [
      JSON.stringify({
        id: nativeSessionId,
        thread_name: 'Codex App fixture',
        updated_at: '2026-07-11T04:52:32Z',
      }),
      JSON.stringify({
        id: automationNativeSessionId,
        thread_name: 'Automation fixture',
        updated_at: '2026-07-11T04:52:34Z',
      }),
      '',
    ].join('\n'));
    const nativeSessionFile = path.join(
      nativeSessionDir,
      `rollout-2026-07-11T12-52-18-${nativeSessionId}.jsonl`,
    );
    await writeFile(
      nativeSessionFile,
      [
        JSON.stringify({
          timestamp: '2026-07-11T04:52:31.928Z',
          type: 'session_meta',
          payload: {
            id: nativeSessionId,
            timestamp: '2026-07-11T04:52:31.928Z',
            cwd: temporary,
            model_provider: 'fake',
            originator: 'codex-chrome-extension-sidepanel',
            source: 'vscode',
            cli_version: 'test',
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:31.990Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: nativeFirstTurnId, model_context_window: 258400 },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:31.995Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'native earlier message' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:31.997Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'native assistant answer' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:31.997Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'false-tool-image-patch',
            input: 'const patch = "*** Begin Patch\\n*** Update File: /tmp/fake-ui.js\\n+tools.view_image({path:\\"/tmp/not-a-real-image.png\\"})\\n*** End Patch";\ntext(await tools.apply_patch(patch));',
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:31.998Z',
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: nativeFirstTurnId },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:31.999Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: nativeSecondTurnId },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:32.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'native fixture message' },
              { type: 'input_image', image_url: 'data:image/png;base64,c21va2U=' },
            ],
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:32.004Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'tool-image-preview',
            input: `const result = await tools.view_image({path:${JSON.stringify(toolImagePath)},detail:"original"});\nimage(result.image_url);`,
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:32.004Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 215308, output_tokens: 775, total_tokens: 216083 },
              total_token_usage: { total_tokens: 35835711 },
              model_context_window: 258400,
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:32.005Z',
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: nativeSecondTurnId },
        }),
        '',
      ].join('\n'),
    );
    const archivedNativeSessionFile = path.join(
      nativeSessionDir,
      `rollout-2026-07-11T12-52-19-${archivedNativeSessionId}.jsonl`,
    );
    const subagentNativeSessionFile = path.join(
      nativeSessionDir,
      `rollout-2026-07-11T12-52-21-${subagentNativeSessionId}.jsonl`,
    );
    await writeFile(
      subagentNativeSessionFile,
      [
        JSON.stringify({
          timestamp: '2026-07-11T04:52:35.000Z',
          type: 'session_meta',
          payload: {
            id: subagentNativeSessionId,
            cwd: temporary,
            source: { subagent: { thread_spawn: {
              parent_thread_id: nativeSessionId,
              depth: 1,
              agent_path: '/root/ui_trace',
              agent_nickname: 'Russell',
            } } },
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:35.001Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'subagent-turn' },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:35.002Z',
          type: 'inter_agent_communication_metadata',
          payload: { trigger_turn: true },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:35.003Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: '子代理正在检查界面' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:35.004Z',
          type: 'response_item',
          payload: { type: 'function_call', call_id: 'subagent-call', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:36.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: '子代理检查完成' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:36.001Z',
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: 'subagent-turn', duration_ms: 1000 },
        }),
        '',
      ].join('\n'),
    );
    await writeFile(
      archivedNativeSessionFile,
      `${JSON.stringify({
        timestamp: '2026-07-11T04:52:33.000Z',
        type: 'session_meta',
        payload: {
          id: archivedNativeSessionId,
          source: 'vscode',
          cli_version: 'test',
        },
      })}\n`,
    );
    const automationNativeSessionFile = path.join(
      nativeSessionDir,
      `rollout-2026-07-11T12-52-20-${automationNativeSessionId}.jsonl`,
    );
    await writeFile(
      automationNativeSessionFile,
      `${JSON.stringify({
        timestamp: '2026-07-11T04:52:34.000Z',
        type: 'session_meta',
        payload: {
          id: automationNativeSessionId,
          source: 'vscode',
          cli_version: 'test',
        },
      })}\n`,
    );
    const stateDb = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
    stateDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        source TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        preview TEXT NOT NULL DEFAULT '',
        cli_version TEXT NOT NULL DEFAULT '',
        thread_source TEXT,
        created_at_ms INTEGER,
        updated_at_ms INTEGER,
        recency_at_ms INTEGER
      )
    `);
    const insertThread = stateDb.prepare(`
      INSERT INTO threads (
        id, rollout_path, source, cwd, title, archived, preview, cli_version, thread_source,
        created_at_ms, updated_at_ms, recency_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertThread.run(
      nativeSessionId,
      nativeSessionFile,
      'vscode',
      temporary,
      'Codex App fixture',
      0,
      'native fixture message',
      'test',
      'user',
      1783745551928,
      1783745552000,
      1783745552000,
    );
    insertThread.run(
      archivedNativeSessionId,
      archivedNativeSessionFile,
      'vscode',
      temporary,
      'Archived fixture',
      1,
      'archived fixture message',
      'test',
      'user',
      1783745553000,
      1783745553000,
      1783745553000,
    );
    insertThread.run(
      automationNativeSessionId,
      automationNativeSessionFile,
      'vscode',
      temporary,
      'Automation fixture',
      0,
      'Automation: Fixture\nAutomation ID: fixture\nAutomation memory: $CODEX_HOME/automations/fixture/memory.md',
      'test',
      'user',
      1783745554000,
      1783745554000,
      1783745554000,
    );
    insertThread.run(
      subagentNativeSessionId,
      subagentNativeSessionFile,
      JSON.stringify({ subagent: { thread_spawn: {
        parent_thread_id: nativeSessionId,
        depth: 1,
        agent_path: '/root/ui_trace',
        agent_nickname: 'Russell',
      } } }),
      temporary,
      'UI trace',
      0,
      'subagent fixture',
      'test',
      'subagent',
      1783745555000,
      1783745556001,
      1783745556001,
    );
    stateDb.close();
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli test');
  process.exit(0);
}
if (args[0] === 'app-server') {
  appendFileSync(process.env.FAKE_APP_SERVER_TRACE, JSON.stringify({
    type: 'process_env',
    openaiBaseUrl: process.env.OPENAI_BASE_URL,
    openaiApiKey: process.env.OPENAI_API_KEY,
    sub2ApiKey: process.env.SUB2API_API_KEY,
  }) + '\\n');
  const createdThreadId = '${createdNativeSessionId}';
  const forkedThreadId = '${forkedNativeSessionId}';
  const fixtureThreadId = '${nativeSessionId}';
  const archivedThreadId = '${archivedNativeSessionId}';
  const archivedThreadIds = new Set([archivedThreadId]);
  try {
    for (const line of readFileSync(process.env.FAKE_APP_SERVER_TRACE, 'utf8').split('\\n')) {
      if (!line.trim()) continue;
      const previous = JSON.parse(line);
      const previousThreadId = String(previous.params?.threadId || '');
      if (['thread/unarchive', 'thread/delete'].includes(previous.method)) archivedThreadIds.delete(previousThreadId);
    }
  } catch {}
  const archiveListCounters = new Map();
  let threadGoal = null;
  let clientName = '';
  const archiveControl = () => {
    try {
      return JSON.parse(readFileSync(process.env.FAKE_APP_SERVER_CONTROL, 'utf8'));
    } catch {
      return {};
    }
  };
  const thread = (id) => ({
    id,
    sessionId: id,
    source: 'appServer',
    threadSource: 'user',
    cwd: process.env.HOME,
    cliVersion: 'test',
    createdAt: 1783745551,
    updatedAt: 1783745552,
    recencyAt: 1783745552,
    preview: 'native app-server fixture',
    name: null,
    modelProvider: 'fake',
    status: { type: 'idle' },
    turns: [],
    ephemeral: false
  });
  const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      appendFileSync(process.env.FAKE_APP_SERVER_TRACE, JSON.stringify(message) + '\\n');
      if (!Object.hasOwn(message, 'id') || !message.method) continue;
      if (message.method === 'initialize') {
        clientName = String(message.params?.clientInfo?.name || '');
        send({ id: message.id, result: { userAgent: 'fake' } });
      }
      else if (message.method === 'model/list') {
        send({
          id: message.id,
          result: {
            data: [
              {
                id: 'test-model',
                displayName: 'Test model',
                serviceTiers: [
                  { id: 'default', name: 'Standard' },
                  { id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }
                ]
              },
              {
                id: 'standard-only-model',
                displayName: 'Standard only',
                serviceTiers: [{ id: 'default', name: 'Standard' }]
              }
            ],
            nextCursor: null
          }
        });
      }
      else if (message.method === 'account/rateLimits/read') {
        if (clientName === 'codex-web' && archiveControl().failPrimaryQuota === true) {
          send({ id: message.id, error: { code: -32000, message: 'primary quota channel unavailable' } });
        } else {
          send({
            id: message.id,
            result: {
              rateLimits: {
                planType: 'plus',
                credits: {
                  hasCredits: true,
                  unlimited: false,
                  balance: '1705.9287250000'
                }
              }
            }
          });
        }
      }
      else if (message.method === 'thread/list') {
        const control = archiveControl();
        const raceToken = String(control.unarchiveAfterFirstListToken || '');
        const raceId = String(control.unarchiveAfterFirstListId || '');
        if (message.params.archived === true && raceToken && raceId) {
          const seen = archiveListCounters.get(raceToken) || 0;
          if (seen >= 1) archivedThreadIds.delete(raceId);
          archiveListCounters.set(raceToken, seen + 1);
        }
        const data = message.params.archived === true
          ? [...archivedThreadIds].map((id) => thread(id))
          : [];
        send({ id: message.id, result: { data, nextCursor: null, backwardsCursor: null } });
      }
      else if (message.method === 'thread/start') {
        const control = archiveControl();
        const threadId = String(control.threadStartId || createdThreadId);
        send({ id: message.id, result: { thread: thread(threadId) } });
      }
      else if (message.method === 'thread/fork') send({ id: message.id, result: { thread: thread(forkedThreadId) } });
      else if (message.method === 'thread/resume') send({ id: message.id, result: { thread: thread(message.params.threadId || fixtureThreadId) } });
      else if (message.method === 'thread/unsubscribe') send({ id: message.id, result: {} });
      else if (message.method === 'turn/start') {
        const turnId = '019f4f84-ea9f-73c2-b997-deba7b4aa798';
        const text = (message.params.input || []).find((item) => item.type === 'text')?.text || '';
        const control = archiveControl();
        if (String(control.failTurnStartText || '') && text.includes(String(control.failTurnStartText))) {
          send({ id: message.id, error: { code: -32000, message: 'controlled turn/start failure' } });
          continue;
        }
        const respond = () => {
          send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
          send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
          send({
            method: 'error',
            params: {
              error: { message: 'Reconnecting... 1/5' },
              willRetry: true,
              threadId: message.params.threadId,
              turnId
            }
          });
          const nonRetryErrorText = String(control.nonRetryErrorText || '');
          if (nonRetryErrorText && text.includes(nonRetryErrorText)) {
            const sendNonRetryError = (errorTurnId) => send({
              method: 'error',
              params: {
                error: { message: 'controlled non-retry turn error' },
                willRetry: false,
                threadId: message.params.threadId,
                turnId: errorTurnId,
              },
            });
            const wrongTurnId = String(control.nonRetryErrorWrongTurnId || '');
            if (wrongTurnId) sendNonRetryError(wrongTurnId);
            const delayMs = Number(control.nonRetryErrorDelayMs || 0);
            setTimeout(() => sendNonRetryError(turnId), Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0);
          }
          if (text.includes('needs approval')) {
            send({
              id: 'approval-1',
              method: 'item/commandExecution/requestApproval',
              params: {
                threadId: message.params.threadId,
                turnId,
                itemId: 'item-1',
                startedAtMs: Date.now(),
                command: 'printf test',
                cwd: process.env.HOME,
                reason: 'test approval'
              }
            });
          }
        };
        const delayMs = Number(control.turnStartDelayMs || 0);
        if (delayMs > 0) setTimeout(respond, delayMs);
        else respond();
      }
      else if (message.method === 'turn/steer') {
        send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
      }
      else if (message.method === 'thread/archive') {
        const control = archiveControl();
        if (String(control.failArchiveThreadId || '') === String(message.params.threadId || '')) {
          send({ id: message.id, error: { code: -32000, message: 'controlled thread/archive failure' } });
          continue;
        }
        archivedThreadIds.add(message.params.threadId);
        send({ id: message.id, result: {} });
      }
      else if (message.method === 'thread/unarchive') {
        archivedThreadIds.delete(message.params.threadId);
        send({ id: message.id, result: { thread: thread(message.params.threadId) } });
      }
      else if (message.method === 'thread/delete') {
        archivedThreadIds.delete(message.params.threadId);
        send({ id: message.id, result: {} });
      }
      else if (message.method === 'thread/goal/set') {
        const now = Math.floor(Date.now() / 1000);
        threadGoal = {
          threadId: message.params.threadId,
          objective: message.params.objective ?? threadGoal?.objective ?? 'Fixture goal',
          status: message.params.status ?? threadGoal?.status ?? 'active',
          tokenBudget: null,
          tokensUsed: threadGoal?.tokensUsed ?? 0,
          timeUsedSeconds: threadGoal?.timeUsedSeconds ?? 0,
          createdAt: threadGoal?.createdAt ?? now,
          updatedAt: now
        };
        send({ id: message.id, result: { goal: threadGoal } });
        send({ method: 'thread/goal/updated', params: { threadId: message.params.threadId, goal: threadGoal } });
      }
      else if (message.method === 'thread/goal/clear') {
        const cleared = Boolean(threadGoal);
        threadGoal = null;
        send({ id: message.id, result: { cleared } });
        send({ method: 'thread/goal/cleared', params: { threadId: message.params.threadId } });
      }
      else if (['thread/name/set', 'thread/settings/update', 'turn/interrupt'].includes(message.method)) {
        send({ id: message.id, result: {} });
      }
      else send({ id: message.id, error: { code: -32601, message: 'unsupported fake method' } });
    }
  });
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  writeFileSync(process.env.FAKE_CODEX_TRACE, JSON.stringify({
    args,
    input,
    home: process.env.HOME,
    codexHome: process.env.CODEX_HOME,
    sub2ApiKey: process.env.SUB2API_API_KEY
  }, null, 2));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'FAKE_OK' } }));
}
`);
    await chmod(fakeCodex, 0o755);
    await writeFile(fakeDocker, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(fakeDockerArgsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write([
  '2026-08-07T08:00:00.000000000Z Grok2API console fixture ready',
  '2026-08-07T08:00:01.000000000Z api_key=fixture-api-key-value',
  '2026-08-07T08:00:02.000000000Z cookie=fixture-session-cookie',
].join('\\n') + '\\n');
process.stderr.write('2026-08-07T08:00:03.000000000Z Authorization: Bearer fixture-bearer-token\\n');
`);
    await chmod(fakeDocker, 0o755);

    desktopIpc = await createDesktopIpcFixture(temporary);
    child = await startServer({
      temporary,
      runtime,
      codexHome,
      fakeCodex,
      traceFile,
      appServerTraceFile,
      appServerControlFile,
      fetchFixture: pathToFileURL(imagePromptFetchFixture).href,
      dockerBin: fakeDocker,
      desktopIpcEnabled: 'true',
      desktopIpcSocket: desktopIpc.socketPath,
      desktopIpcTimeoutMs: '5000',
      playgroundProxyAllowedOrigins: customProviderBaseUrl,
      localImageRoots: externalImageRoot,
      sub2ApiBaseUrl: providerBaseUrl,
      sub2ApiKey: 'test-sub-key',
    });
    let port = await waitForServer(child, runtime);
    const baseUrl = `http://127.0.0.1:${port}`;

    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const homepageDisabled = await fetch(`${baseUrl}/api/homepage/stats`);
    assert.equal(homepageDisabled.status, 503);

    const markedAsset = await fetch(`${baseUrl}/vendor/marked.js`);
    assert.equal(markedAsset.status, 200);
    assert.match(await markedAsset.text(), /marked v18/);

    const purifyAsset = await fetch(`${baseUrl}/vendor/purify.js`);
    assert.equal(purifyAsset.status, 200);
    assert.match(await purifyAsset.text(), /DOMPurify 3/);

    const uiAsset = await fetch(`${baseUrl}/ui.css`);
    assert.equal(uiAsset.status, 200);
    const uiStyles = await uiAsset.text();
    assert.match(uiStyles, /\.historyProjectHead\[aria-expanded="true"\]/);
    assert.match(uiStyles, /\.historyProjectItems\[hidden\]/);
    assert.match(uiStyles, /\.historyProjectMenu\s*\{/);
    assert.match(uiStyles, /\.historyProjectMenu\.openAbove/);
    assert.match(uiStyles, /\.historyProjectMenuAction\.danger/);
    assert.match(uiStyles, /body\[data-theme\] \.requestAction\s*\{[^}]*background:\s*var\(--surface-raised\);[^}]*color:\s*var\(--text\)/s);
    assert.match(uiStyles, /body\[data-theme\] \.requestAction\.danger\s*\{[^}]*background:\s*var\(--danger-soft\);[^}]*color:\s*var\(--danger\)/s);
    assert.match(uiStyles, /\.settingsDialog \.dreamSkinGenerator/);
    assert.match(uiStyles, /\.dreamSkinConceptList\s*\{/);
    assert.match(uiStyles, /\.dreamSkinConcept\.active\s*\{/);
    assert.match(uiStyles, /\.dreamSkinConceptThumb\s*\{/);
    assert.match(uiStyles, /\.dreamSkinConceptPreview\s*\{/);
    assert.match(uiStyles, /body\[data-chat-bg="custom"\] \.main\s*\{[^}]*background-image:\s*var\(--custom-chat-bg\)/s);
    assert.match(uiStyles, /body\[data-chat-bg="skin"\] \.app\s*\{[^}]*background-image:[^}]*var\(--custom-chat-bg\)[^}]*background-position:\s*var\(--skin-art-position\)/s);
    assert.match(uiStyles, /body\[data-chat-bg="skin"\] \.main\s*\{[^}]*var\(--skin-content-wash\)/s);
    assert.match(uiStyles, /body\[data-chat-bg\] \.chat\s*\{[^}]*background:\s*transparent/s);
    assert.match(uiStyles, /body\[data-chat-bg="skin"\] \.side,[^}]*body\[data-chat-bg="skin"\] \.top\s*\{[^}]*var\(--skin-surface-soft\)/s);
    assert.match(uiStyles, /body\[data-chat-bg="skin"\] \.miniPrimary,[^}]*body\[data-chat-bg="skin"\] \.send\s*\{[^}]*background:\s*var\(--primary\)/s);
    assert.match(uiStyles, /\.generatedBackgroundApply/);
    assert.doesNotMatch(uiStyles, /data-chat-bg="dream-skin"|portal-hero\.png/);
    assert.match(uiStyles, /@media \(hover: hover\) and \(pointer: fine\)\s*\{[^}]*body \.histRename,[^}]*opacity:\s*0;[\s\S]*body \.hist:hover \.histRename/s);
    assert.match(uiStyles, /body \.hist\.native\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto/s);
    assert.match(uiStyles, /body \.hist\.native\.running\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto/s);
    assert.match(uiStyles, /\.histRunning\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*2;[^}]*left:\s*-7px;[^}]*pointer-events:\s*none/s);
    assert.match(uiStyles, /\.histCompletionUnread\s*\{[^}]*position:\s*absolute;[^}]*left:\s*-18px;[^}]*width:\s*30px;[^}]*height:\s*34px;[^}]*pointer-events:\s*auto/s);
    assert.match(uiStyles, /\.histCompletionUnread::after\s*\{[^}]*width:\s*8px;[^}]*height:\s*8px;[^}]*background:\s*currentColor/s);
    assert.match(uiStyles, /\.historyProjectFolder\s*\{/);
    assert.match(uiStyles, /\.historyProjectPreview\.visible\s*\{/);
    assert.match(uiStyles, /\.historyProjectItems\s*\{[^}]*padding-left:\s*22px/s);
    assert.match(uiStyles, /\.memoryCitations\[open\]/);
    assert.match(uiStyles, /\.memoryCitationItem\[open\]/);
    assert.match(uiStyles, /\.subQuotaStatusRow\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between/s);
    assert.match(uiStyles, /\.subQuotaPrimarySource\s*\{[^}]*font-size:\s*12px;[^}]*font-weight:\s*700/s);
    assert.match(uiStyles, /\.subQuotaCreditsGrid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
    assert.match(uiStyles, /\.subQuotaCredits\s*\{[^}]*padding:\s*2px 12px 2px 0/s);
    assert.match(uiStyles, /\.subQuotaCredits \+ \.subQuotaCredits\s*\{[^}]*padding:\s*2px 0 2px 12px;[^}]*text-align:\s*right/s);
    assert.match(uiStyles, /\.subQuotaCredits > strong\s*\{[^}]*font-size:\s*12px/s);
    assert.match(uiStyles, /\.subQuotaCodexPreviewProgress\s*\{[^}]*display:\s*grid;[^}]*gap:\s*4px/s);
    assert.match(uiStyles, /\.subQuotaCodexPreviewProgressHead\s*\{[^}]*justify-content:\s*flex-end;[^}]*font-size:\s*10px/s);
    assert.match(uiStyles, /\.subQuotaCodexBalances\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
    assert.match(uiStyles, /\.subQuotaCodexBalance > strong\s*\{[^}]*font-size:\s*12px/s);
    assert.match(uiStyles, /\.subQuotaCodexProgress\s*\{[^}]*min-width:\s*120px;[^}]*flex:\s*1 1 180px/s);
    assert.match(uiStyles, /@media \(max-width: 460px\)[\s\S]*?\.grok2ApiConsoleDialog\s*\{[^}]*width:\s*100%;[^}]*max-height:\s*calc\(100dvh - 24px\)/s);
    assert.match(uiStyles, /\.composerModelToggle/);
    assert.match(uiStyles, /\.composerPermissionToggle/);
    assert.match(uiStyles, /\.composerProjectToggle/);
    assert.match(uiStyles, /\.composerProjectPanel/);
    assert.match(uiStyles, /\.composerProjectPicker:not\(\.hidden\) \+ \.box/);
    assert.match(uiStyles, /\.automationStatus:empty\s*\{[^}]*display:\s*none/s);
    assert.match(uiStyles, /\.promptQueueRow/);
    assert.match(uiStyles, /\.box\.runActive/);
    assert.match(uiStyles, /\.composerModelToggle\.running:not\(:disabled\)\s*\{[^}]*cursor:\s*pointer/s);
    assert.match(uiStyles, /\.composerModelToggle\.running \.composerModelState\s*\{[^}]*border-right-color:\s*transparent;[^}]*animation:\s*spin/s);
    assert.match(uiStyles, /\.composerModelPanel\s*\{[^}]*width:\s*min\(260px,[^}]*border-radius:\s*18px/s);
    assert.match(uiStyles, /\.composerModelMenuRow\s*\{[^}]*min-height:\s*44px;[^}]*grid-template-columns:/s);
    assert.match(uiStyles, /\.composerModelMenuRow\.active\s*\{[^}]*background:\s*var\(--surface-hover\)/s);
    assert.match(uiStyles, /\.composerModelSubmenu\s*\{[^}]*position:\s*static;[^}]*width:\s*auto;[^}]*max-height:[^}]*border:\s*0;[^}]*box-shadow:\s*none/s);
    assert.match(uiStyles, /\.composerModelPanel\[data-submenu\] \.composerModelMainMenu\s*\{[^}]*display:\s*none/s);
    assert.match(uiStyles, /body \.composer > \.box\s*\{[^}]*width:\s*min\(380px, calc\(100% - 20px\)\)/s);
    assert.match(uiStyles, /\.composerModelOption\[aria-selected="true"\]/);
    assert.match(uiStyles, /\.composerReasoningRange\s*\{[^}]*appearance:\s*none;[^}]*cursor:\s*pointer/s);
    assert.match(uiStyles, /\.composerReasoningRange::-webkit-slider-thumb\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*border:\s*0;[^}]*background:\s*#ffffff/s);
    assert.match(uiStyles, /\.composerReasoningRange:focus-visible\s*\{[^}]*box-shadow:\s*none/s);
    assert.match(uiStyles, /\.composerReasoningMarks\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--reasoning-step-count\), 1fr\)/s);
    assert.match(uiStyles, /body \.box\.runActive > \.send:not\(\.cancelButton\):disabled\s*\{[^}]*display:\s*none/s);
    assert.match(uiStyles, /body \.cancelButton \.lucide\s*\{[^}]*fill:\s*currentColor;[^}]*stroke:\s*none/s);
    assert.match(uiStyles, /\.msg\.user:hover \.msgActions/);
    assert.match(uiStyles, /\.msg\.user::after\s*\{[^}]*width:\s*min\(124px, 100%\);[^}]*height:\s*6px/s);
    assert.match(uiStyles, /\.msg\.user \.msgActions\s*\{[^}]*top:\s*calc\(100% - 1px\);[^}]*padding:\s*5px 0 0 8px/s);
    assert.match(uiStyles, /body \.msg\.user \.msgActions \.copyMsg,[^}]*body \.msg\.user \.msgActions \.rollbackMsg\s*\{[^}]*width:\s*30px;[^}]*height:\s*30px;[^}]*border:\s*0;[^}]*background:\s*transparent/s);
    assert.match(uiStyles, /body \.msg\.user \.msgActions \.lucide\s*\{[^}]*width:\s*15px;[^}]*height:\s*15px/s);
    assert.match(uiStyles, /body \.msg\.user \.messageTime\s*\{[^}]*font-size:\s*12px/s);
    assert.match(uiStyles, /\.msg\.user\.hasInputImage \.msgBody\s*\{[^}]*border-radius:\s*16px;[^}]*background:\s*color-mix\(in oklab, var\(--text\) 5%, transparent\);[^}]*padding:\s*8px 12px/s);
    assert.match(uiStyles, /\.completionTimeline > \.activityBatch \+ \.activityBatch/);
    assert.match(uiStyles, /body\[data-theme="dark"\] \.completionTimeline\s*\{[^}]*--text:\s*#ffffff;[^}]*--text-muted:\s*#acacac;[^}]*--text-subtle:\s*#7b7b7b/s);
    assert.match(uiStyles, /body \.msg\.process\.completionSummary\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%/s);
    assert.match(uiStyles, /\.completionTokenUsage\s*\{[^}]*font-family:\s*ui-monospace[^;]*;[^}]*font-variant-numeric:\s*tabular-nums/s);
    assert.match(uiStyles, /\.completionSummary\.collapsible:not\(\[open\]\) > \.completionContent\s*\{[^}]*display:\s*none/s);
    assert.match(uiStyles, /\.activityClusterText\s*\{[^}]*width:\s*100%;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/s);
    assert.match(uiStyles, /\.activityClusterSummary\s*\{[^}]*width:\s*100%;[^}]*grid-template-columns:\s*var\(--activity-icon-box\) minmax\(0, 1fr\) 14px/s);
    assert.match(uiStyles, /\.activityCluster\[open\] > summary \.activityClusterChevron/);
    assert.match(uiStyles, /\.activityCluster:not\(\[open\]\) > \.activityClusterItems\s*\{[^}]*display:\s*none/s);
    assert.match(uiStyles, /\.activityClusterItems::before\s*\{[^}]*width:\s*1px;[^}]*background:\s*var\(--activity-rail\)/s);
    assert.match(uiStyles, /\.activityCluster \.activityItemChevron\s*\{[^}]*opacity:\s*0/s);
    assert.match(uiStyles, /\.activityCluster \.activityItem\[data-current="true"\] > \.activityItemSummary \.activityItemChevron,[^}]*opacity:\s*1/s);
    assert.match(uiStyles, /\.activityCluster \.activityItem\[data-current="true"\] > \.activityItemSummary,[^}]*color:\s*var\(--text\)/s);
    assert.match(uiStyles, /body\[data-theme\] \.msg\.process\.reasoningStatus/);
    assert.match(uiStyles, /--reasoning-flow-muted:\s*#b0b0b1/);
    assert.match(uiStyles, /\.reasoningStatus\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/s);
    assert.match(uiStyles, /> \.msg\.process\.reasoningStatus\.streaming\s*\{[^}]*var\(--reasoning-flow-muted\)[^}]*var\(--reasoning-flow-strong\)/s);
    assert.match(uiStyles, /body \.msg\.user\.browserCommentSteering\s*,\s*body \.msg\.user\.hasInputImage\.browserCommentSteering\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*min\(280px, 88%\)/s);
    assert.match(uiStyles, /\.browserCommentSteering > \.browserCommentSource\s*\{[^}]*display:\s*block;[^}]*width:\s*fit-content;[^}]*border-radius:\s*16px;[^}]*background:\s*color-mix\(in oklab, var\(--text\) 5%, transparent\)/s);
    assert.match(uiStyles, /\.browserCommentSteering > \.browserCommentSource\s*\{[^}]*white-space:\s*normal/s);
    assert.match(uiStyles, /body \.chat > \.msg\.user\.browserCommentSteering > \.msgBody\.browserCommentSource,[^}]*width:\s*fit-content;[^}]*padding:\s*8px 12px;[^}]*white-space:\s*normal/s);
    assert.doesNotMatch(uiStyles, /\.browserCommentSteering \.msgActions\s*\{[^}]*display:\s*none/s);
    assert.match(uiStyles, /\.activityItem\.fileTarget \.activityTarget/);
    assert.match(uiStyles, /\.activityItem\[open\] > \.activityItemSummary \.activityItemChevron/);
    assert.match(uiStyles, /\.agentActivityItem\[open\] > \.agentActivityRow \.agentActivityChevron/);
    assert.match(uiStyles, /\.completionTimeline > \.msg\.agentActivityGroup\s*\{[^}]*display:\s*flex;[^}]*width:\s*100%;[^}]*flex-wrap:\s*wrap;[^}]*column-gap:\s*6px/s);
    assert.match(uiStyles, /\.agentActivityGroup > \.activityBatch\s*\{[^}]*display:\s*contents/s);
    assert.match(uiStyles, /\.agentActivityGroup \.agentActivityItem\[open\]\s*\{[^}]*flex:\s*1 0 100%/s);
    assert.match(uiStyles, /\.agentActivityGroup \.agentActivityItem > \.agentActivityRow \.agentActivityStatus,[^}]*\.agentActivityChevron\s*\{[^}]*display:\s*none/s);
    assert.match(uiStyles, /\.agentActivityLabel\s*\{[^}]*max-width:\s*150px/s);
    assert.match(uiStyles, /\.agentActivityGroupStatus\[data-trace-state="done"\],\s*\.agentActivityGroupStatus\[data-trace-state="updated"\]\s*\{[^}]*color:\s*var\(--text-muted\)/s);
    assert.match(uiStyles, /\.subagentTraceTimeline\s*\{/);
    assert.match(uiStyles, /\.subagentTraceMessage\.final\s*\{/);
    assert.match(uiStyles, /\.subagentTraceNotice\.loading::before/);
    assert.match(uiStyles, /\.activityImageGallery\s*\{/);
    assert.match(uiStyles, /\.activityImagePreview\s*\{[^}]*display:\s*grid;[^}]*border:\s*0;[^}]*background:\s*transparent/s);
    assert.match(uiStyles, /\.activityImagePreview\.loaded\s*\{[^}]*aspect-ratio:\s*auto/s);
    assert.match(uiStyles, /\.activityImagePreview img\s*\{[^}]*width:\s*100%;[^}]*object-fit:\s*contain/s);
    assert.match(uiStyles, /\.activityImagePreview\.loaded img\s*\{[^}]*height:\s*auto/s);
    assert.match(uiStyles, /\.liveProcessElapsed\s*\{[^}]*width:\s*100%;[^}]*height:\s*40px;[^}]*align-items:\s*center;[^}]*border-bottom:\s*1px solid var\(--border\);[^}]*font-size:\s*14px;[^}]*white-space:\s*nowrap/s);
    assert.match(uiStyles, /\.liveProcessElapsed \+ \.liveProcessTimeline\s*\{[^}]*margin-top:\s*10px/s);
    assert.match(uiStyles, /body\[data-theme="dark"\] \.liveProcessElapsed\s*\{[^}]*border-bottom-color:\s*#303030;[^}]*color:\s*#acacac/s);
    assert.match(uiStyles, /\.liveProcessTimeline\s*\{[^}]*width:\s*100%;[^}]*gap:\s*14px/s);
    assert.doesNotMatch(uiStyles, /\.turnPlanPanel|\.turnPlanList|\.turnPlanStep/);
    assert.match(uiStyles, /body \.liveProcessTimeline > \.progressCommentary\.streaming[^,]*,\s*body \.liveProcessTimeline > \.activityCluster\.streaming > summary \.activityClusterText\s*\{[^}]*var\(--primary\)[^}]*background-size:\s*220% 100%;[^}]*animation:\s*liveProcessFlow 4\.8s linear infinite/s);
    assert.match(uiStyles, /body\[data-theme\] \.liveProcessTimeline > \.msg\.process\.reasoningStatus\.streaming\s*\{[^}]*animation:\s*liveProcessFlow 4\.8s linear infinite/s);
    assert.match(uiStyles, /@keyframes liveProcessFlow/);
    assert.match(uiStyles, /\.completionTimeline > \.msg\.user\.steeringUser/);
    assert.match(uiStyles, /\.sideActions\s*\{[^}]*grid-template-columns:\s*minmax\(112px, 1fr\) repeat\(4, 36px\);[^}]*gap:\s*6px/s);
    assert.match(uiStyles, /\.sideActions \.miniPrimary\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*white-space:\s*nowrap/s);
    assert.match(uiStyles, /\.sideActions \.miniPrimary \.buttonLabel\s*\{[^}]*flex:\s*0 0 auto;[^}]*word-break:\s*keep-all/s);
    assert.match(uiStyles, /\.subQuotaPopover\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible/s);
    assert.match(uiStyles, /body \.side:has\(\.subQuotaPopover:not\(\.hidden\)\)\s*\{[^}]*overflow-y:\s*auto/s);
    assert.match(uiStyles, /\.subQuotaSettingsDialog\s*\{/);
    assert.match(uiStyles, /\.subQuotaError\s*\{[^}]*font-size:\s*11px;[^}]*line-height:\s*1\.4/s);
    assert.match(uiStyles, /@container sidebar \(max-width: 280px\)/);
    assert.match(uiStyles, /\.archiveView\s*\{[^}]*flex:\s*1 1 auto;[^}]*overflow:\s*auto/s);
    assert.match(uiStyles, /\.archiveTaskRestore,[^}]*\.archiveTaskDelete\s*\{/s);
    assert.match(uiStyles, /body\[data-theme\] \.archiveProjectFilter select\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%/s);
    assert.match(uiStyles, /\.turnResultArtifacts\s*\{[^}]*align-self:\s*center/s);
    assert.match(uiStyles, /\.editedFilesResult\s*\{[^}]*width:\s*min\(160px, 100%\);[^}]*border-radius:\s*999px/s);
    assert.match(uiStyles, /\.editedFilesResult:not\(\.live\):not\(\[open\]\)\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*100%/s);
    assert.match(uiStyles, /\.editedFilesResult:not\(\.live\):not\(\[open\]\) > \.turnResultHead\s*\{[^}]*display:\s*inline-flex;[^}]*width:\s*max-content;[^}]*flex-wrap:\s*nowrap/s);
    assert.match(uiStyles, /\.editedFilesResult\.withPlan\s*\{[^}]*width:\s*max-content/s);
    assert.match(uiStyles, /\.editedFilesResult\.withPlan > \.turnResultHead\s*\{[^}]*min-height:\s*36px;[^}]*gap:\s*7px;[^}]*padding-inline:\s*12px/s);
    assert.match(uiStyles, /\.turnPlanProgressRing\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;[^}]*flex:\s*0 0 12px;[^}]*conic-gradient\(var\(--info\) var\(--turn-plan-progress\)/s);
    assert.match(uiStyles, /\.turnPlanProgressRing::after\s*\{[^}]*inset:\s*2px/s);
    assert.match(uiStyles, /body \.composer > \.editedFilesResult\.live\s*\{[^}]*align-self:\s*center;[^}]*margin:\s*0 auto 8px/s);
    assert.match(uiStyles, /body \.composer > \.editedFilesResult\.live\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s);
    assert.match(uiStyles, /body \.composer > \.editedFilesResult\.live:not\(\[open\]\)\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*100%/s);
    assert.match(uiStyles, /\.turnResultHead > \.turnResultFileLabel\s*\{[^}]*flex:\s*0 0 auto;[^}]*overflow:\s*visible;[^}]*text-overflow:\s*clip/s);
    assert.match(uiStyles, /body \.composer:has\(> \.composerProjectPicker:not\(\.hidden\)\)\s*\{[^}]*width:\s*min\(var\(--composer-width\), calc\(100% - 34px\)\);[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*padding:\s*0;[^}]*box-shadow:\s*none/s);
    assert.match(uiStyles, /body \.composer:has\(> \.composerProjectPicker:not\(\.hidden\)\) > \.composerProjectPicker\s*\{[^}]*width:\s*calc\(100% - 29px\)/s);
    assert.match(uiStyles, /body \.composer:has\(> \.composerProjectPicker:not\(\.hidden\)\) > \.box\s*\{[^}]*width:\s*100%/s);
    assert.match(uiStyles, /body\[data-theme="light"\] \.composerProjectToggle\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*#f6f6f6;[^}]*box-shadow:\s*none/s);
    assert.match(uiStyles, /body \.box\s*\{[^}]*grid-template-rows:\s*minmax\(50px, auto\) 34px;[^}]*gap:\s*2px;[^}]*border-radius:\s*20px/s);
    assert.match(uiStyles, /body\[data-theme\] \.box textarea\s*\{[^}]*min-height:\s*50px;[^}]*max-height:\s*180px;[^}]*font-size:\s*14px/s);
    assert.match(uiStyles, /@media \(max-width: 820px\)\s*\{[\s\S]*?body\[data-theme\] \.box textarea\s*\{[^}]*font-size:\s*16px/s);
    assert.match(uiStyles, /body \.composer:has\(> \.composerProjectPicker\.hidden\) > \.box\s*\{[^}]*width:\s*min\(calc\(var\(--composer-width\) - 22px\), calc\(100% - 60px\)\);[^}]*border-radius:\s*15px;[^}]*padding:\s*6px 7px 5px/s);
    assert.match(uiStyles, /body \.composer:has\(> \.composerProjectPicker\.hidden\) > \.box\.runActive\s*\{[^}]*grid-template-columns:\s*32px max-content minmax\(0, 1fr\) max-content 30px/s);
    assert.match(uiStyles, /body\[data-theme="light"\] \.composer:has\(> \.composerProjectPicker\.hidden\) > \.box\s*\{[^}]*border-color:\s*#e1e3e6;[^}]*background:\s*#ffffff;[^}]*box-shadow:\s*none/s);
    assert.match(uiStyles, /body\[data-theme="dark"\] \.composer:has\(> \.composerProjectPicker\.hidden\) > \.box\s*\{[^}]*border-color:\s*#454545;[^}]*background:\s*var\(--surface\);[^}]*box-shadow:\s*none/s);
    assert.match(uiStyles, /\.turnResultStatus\s*\{[^}]*color:\s*var\(--success\)/s);
    assert.match(uiStyles, /\.turnResultStatus\s*\{[^}]*display:\s*inline-flex;[^}]*min-height:\s*22px;[^}]*border-radius:\s*999px;[^}]*background:\s*var\(--success-soft\)/s);
    assert.match(uiStyles, /\.turnResultStatus::before\s*\{[^}]*width:\s*5px;[^}]*border-radius:\s*50%;[^}]*background:\s*currentColor/s);
    assert.match(uiStyles, /\.editedFilesResult\[open\] > \.turnResultHead\s*\{[^}]*min-height:\s*44px;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto;[^}]*column-gap:\s*10px;[^}]*padding:\s*0 12px/s);
    assert.match(uiStyles, /\.editedFilesResult\.withPlan\[open\] > \.turnResultHead\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap/s);
    assert.doesNotMatch(uiStyles, /\.liveProcessTimeline > \.editedFilesResult\.live/);
    assert.match(uiStyles, /body\[data-theme="dark"\] \.editedFilesResult:not\(\[open\]\)\s*\{[^}]*border-color:\s*#383838;[^}]*background:\s*#272727/s);
    assert.match(uiStyles, /body\[data-theme="dark"\] \.editedFilesResult\.withPlan \.turnPlanProgressRing\s*\{[^}]*conic-gradient\(#339cff var\(--turn-plan-progress\), #2b3c4f 0\)/s);
    assert.match(uiStyles, /body\[data-theme="dark"\] \.editedFilesResult\.withPlan \.turnPlanProgressLabel,[^}]*\.turnResultFileLabel\s*\{[^}]*color:\s*#bbbbbb/s);
    assert.match(uiStyles, /\.turnResultStat\.added\s*\{[^}]*color:\s*var\(--success\)/s);
    assert.match(uiStyles, /\.turnResultStat\.removed\s*\{[^}]*color:\s*var\(--danger\)/s);
    assert.match(uiStyles, /\.webPreviewResult\s*\{/);
    assert.match(uiStyles, /body\[data-theme\] \.msg\.assistant\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%/s);
    assert.match(uiStyles, /\.msg\.assistant > \.msgBody > :not\(\.memoryCitations\)\s*\{[^}]*max-width:\s*min\(780px, 100%\)/s);
    assert.match(uiStyles, /\.msg\.assistant > \.msgActions\s*\{[^}]*width:\s*fit-content;[^}]*opacity:\s*0/s);
    assert.match(uiStyles, /\.messageAction::after\s*\{[^}]*content:\s*attr\(data-tooltip\)/s);
    assert.match(uiStyles, /\.markdownCodeBlock\s*\{[^}]*position:\s*relative;[^}]*max-width:\s*100%/s);
    assert.match(uiStyles, /\.markdownCodeCopy\s*\{[^}]*position:\s*absolute;[^}]*opacity:\s*0;[^}]*pointer-events:\s*none/s);
    assert.match(uiStyles, /@media \(hover: none\), \(pointer: coarse\)\s*\{[^}]*\.markdownCodeCopy\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto/s);
    assert.match(uiStyles, /\.msg\.assistant \.continueMsg\s*\{[^}]*background:\s*transparent/s);
    assert.match(uiStyles, /--conversation-width:\s*760px/);
    assert.match(uiStyles, /body \.chat > :is\([^}]*\.msg:not\(\.user\):not\(\.inputImage\)[^}]*\.liveProcessPanel[^}]*\)\s*\{[^}]*width:\s*min\(var\(--conversation-width\), 100%\);[^}]*align-self:\s*center/s);
    assert.match(uiStyles, /body \.chat > :is\(\.msg\.user, \.msg\.image\.inputImage\)\s*\{[^}]*margin-right:\s*max\(0px, calc\(\(100% - var\(--conversation-width\)\) \/ 2\)\)/s);
    assert.match(uiStyles, /body \.composer\s*\{[^}]*border-top:\s*0;[^}]*background:\s*transparent/s);
    assert.match(uiStyles, /body\[data-theme="light"\] \.composer\s*\{[^}]*background:\s*transparent/s);
    assert.match(uiStyles, /body\[data-theme="light"\] \.box,\s*body\[data-theme="light"\] \.box:focus-within\s*\{[^}]*background:\s*#ffffff/s);
    assert.match(uiStyles, /body \.composer > \.box,\s*body \.composer > \.box:focus-within\s*\{[^}]*background:\s*var\(--surface\);[^}]*box-shadow:\s*none/s);
    assert.match(uiStyles, /@media \(min-width: 821px\)[\s\S]*?body \.main\s*\{[^}]*position:\s*relative;[^}]*height:\s*100dvh/s);
    assert.match(uiStyles, /@media \(min-width: 821px\)[\s\S]*?body \.chat\s*\{[^}]*padding-bottom:\s*max\(132px, calc\(var\(--composer-overlay-height, 132px\) \+ 12px\)\);[^}]*scroll-padding-bottom:\s*max\(132px, calc\(var\(--composer-overlay-height, 132px\) \+ 12px\)\)/s);
    assert.match(uiStyles, /@media \(max-width: 820px\)[\s\S]*?body \.main\s*\{[^}]*--header-height:\s*64px/s);
    assert.match(uiStyles, /@media \(max-width: 820px\)[\s\S]*?body \.top\s*\{[^}]*min-height:\s*64px;[^}]*height:\s*auto;[^}]*padding:\s*calc\(env\(safe-area-inset-top, 0px\) \+ 12px\) 16px 12px;[^}]*gap:\s*14px/s);
    assert.match(uiStyles, /@media \(max-width: 820px\)[\s\S]*?body \.top \.title\s*\{[^}]*line-height:\s*1\.4/s);
    assert.match(uiStyles, /@media \(max-width: 820px\)[\s\S]*?body \.chat\s*\{[^}]*margin-top:\s*10px;[^}]*padding:\s*22px 16px 20px;[^}]*scroll-padding-top:\s*32px/s);
    assert.match(uiStyles, /@media \(max-width: 820px\)[\s\S]*?\.subQuotaCodexSummary\s*\{[^}]*align-items:\s*stretch;[^}]*flex-direction:\s*column;[^}]*padding-top:\s*10px/s);
    assert.match(uiStyles, /@media \(max-width: 820px\)[\s\S]*?\.subQuotaCodexBalances\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;[^}]*flex:\s*none/s);
    assert.match(uiStyles, /\.liveProcessPanel\s*\{[^}]*margin:\s*0 0 18px/s);
    assert.match(uiStyles, /@media \(min-width: 821px\)[\s\S]*?body \.composer\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*auto 0 0;[^}]*background:\s*transparent;[^}]*pointer-events:\s*none/s);
    assert.match(uiStyles, /body \.composer > \*\s*\{[^}]*pointer-events:\s*auto/s);
    assert.match(uiStyles, /--composer-width:\s*var\(--conversation-width\)/);
    assert.match(uiStyles, /body \.msg\.user\s*\{[^}]*max-width:\s*min\(var\(--conversation-width\), 77%\);[^}]*border-radius:\s*16px;[^}]*background:\s*color-mix\(in oklab, var\(--text\) 5%, transparent\);[^}]*color:\s*var\(--text\);[^}]*padding:\s*8px 12px/s);
    assert.match(uiStyles, /\.completionTimeline > \.msg\.user\.steeringUser\s*\{[^}]*max-width:\s*77%;[^}]*padding:\s*8px 10px 8px/s);
    assert.match(uiStyles, /\.composer > \*\s*\{[^}]*width:\s*min\(var\(--composer-width\), calc\(100% - 60px\)\)/s);
    assert.match(uiStyles, /body \.box\s*\{[^}]*grid-template-rows:\s*minmax\(50px, auto\) 34px;[^}]*border-radius:\s*20px/s);
    assert.match(uiStyles, /\.composerPermissionToggle\s*\{[^}]*display:\s*inline-flex/);
    assert.match(uiStyles, /\.memoryCitations\s*\{[^}]*width:\s*100%/s);
    assert.match(uiStyles, /\.imagePreview\s*\{/);
    assert.match(uiStyles, /\.userAttachmentStack\s*\{/);
    assert.match(uiStyles, /\.userAttachmentStack\.single\s*\{[^}]*width:\s*100px/s);
    assert.match(uiStyles, /\.browserCommentSteering \.userAttachmentStack\s*\{[^}]*width:\s*min\(220px, 100%\);[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
    assert.match(uiStyles, /\.userAttachment\s*\{[^}]*width:\s*100%;[^}]*aspect-ratio:\s*1 \/ 1/s);
    assert.match(uiStyles, /\.userAttachment img\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*max-height:\s*none;[^}]*object-fit:\s*cover/s);
    assert.match(uiStyles, /body \.msg\.user\.steeringUser\.browserCommentSteering \.userAttachmentStack\.single,[^}]*width:\s*100px;[^}]*max-width:\s*100%/s);
    assert.match(uiStyles, /\.steeringUser \.userAttachmentStack\.single,[^}]*\.steeringUser\.hasInputImage \.userAttachmentStack\.single\s*\{[^}]*width:\s*100px;[^}]*max-width:\s*100%/s);
    assert.match(uiStyles, /\.msg\.user\.hasInputImage \.msgBody:empty/);
    assert.match(uiStyles, /\.settingsDialog/);

    const imagePromptStylesResponse = await fetch(`${baseUrl}/image-prompt.css`);
    assert.equal(imagePromptStylesResponse.status, 200);
    const imagePromptStyles = await imagePromptStylesResponse.text();
    assert.match(imagePromptStyles, /\.workspaceNavButton\.active/);
    assert.match(imagePromptStyles, /\.top:has\(> \.workspaceNav\) > #modeLabel\s*\{[^}]*grid-column:\s*4;[^}]*width:\s*max-content;[^}]*justify-self:\s*end/s);
    assert.match(imagePromptStyles, /\.top:has\(> \.workspaceNav\) > \.topConversationContext\s*\{[^}]*position:\s*absolute;[^}]*left:\s*68px;[^}]*right:\s*calc\(50% \+ 110px\);[^}]*overflow:\s*hidden;[^}]*padding-left:\s*10px/s);
    assert.match(imagePromptStyles, /\.imagePromptGrid/);
    assert.match(imagePromptStyles, /\.imagePromptDetailDialog/);
    assert.match(imagePromptStyles, /\.imagePromptPreviewFrame\.imageLoading img/);
    assert.match(imagePromptStyles, /\.imagePromptPlaygroundFrame/);
    assert.match(imagePromptStyles, /\.imagePromptViewTab\.active/);
    assert.match(imagePromptStyles, /\.imagePromptSyncStatus\[data-status="error"\]/);
    assert.match(imagePromptStyles, /\.imagePromptSyncButton\.syncing \.lucide/);
    assert.match(imagePromptStyles, /grid-template-columns:\s*38px minmax\(0, 1fr\) minmax\(64px, min\(24vw, 124px\)\)/);
    assert.match(imagePromptStyles, /body \.top:has\(> \.workspaceNav\) > \.topConversationContext\s*\{[^}]*position:\s*absolute;[^}]*display:\s*block;[^}]*left:\s*calc\(50% \+ 104px\);[^}]*right:\s*12px;[^}]*padding-left:\s*0;[^}]*text-align:\s*right/s);
    assert.match(imagePromptStyles, /body \.top:has\(> \.workspaceNav\) > \.topConversationContext #status\s*\{[^}]*display:\s*none/s);
    assert.match(imagePromptStyles, /body \.main\.imagePromptMain > \.top > \.topConversationContext,\s*body #modeLabel\s*\{[^}]*display:\s*none/s);
    assert.match(imagePromptStyles, /@media \(max-width: 560px\)[\s\S]*?body \.top:has\(> \.workspaceNav\) > \.topConversationContext\s*\{[^}]*left:\s*calc\(50% \+ 82px\)/);

    const imagePromptScriptResponse = await fetch(`${baseUrl}/image-prompt.js`);
    assert.equal(imagePromptScriptResponse.status, 200);
    const imagePromptScript = await imagePromptScriptResponse.text();
    assert.doesNotThrow(() => new Function(imagePromptScript));
    assert.match(imagePromptScript, /function loadDetailImage/);
    assert.match(imagePromptScript, /function useSelectedPromptInPlayground/);
    assert.match(imagePromptScript, /function handlePlaygroundBridgeMessage/);
    assert.match(imagePromptScript, /function startPlaygroundReadyWatch/);
    assert.match(imagePromptScript, /function playgroundFrameHasUi/);
    assert.match(imagePromptScript, /加载较慢，仍在初始化生图工作台/);
    assert.doesNotMatch(imagePromptScript, /外网链路较慢/);
    assert.match(imagePromptScript, /codex-web:image-prompt/);
    assert.match(imagePromptScript, /在生图工作台使用/);
    assert.match(imagePromptScript, /transparent_output/);
    assert.doesNotMatch(imagePromptScript, /发送到 Codex App|function composeCodexImagePrompt/);
    assert.match(imagePromptScript, /function setImagePromptView/);
    assert.match(imagePromptScript, /function syncPromptLibrary/);
    assert.match(imagePromptScript, /window\.addEventListener\('codex-web:main-view'/);
    assert.match(imagePromptScript, /new CustomEvent\('codex-web:workspace-view'/);
    assert.match(imagePromptScript, /options\.focus === true/);
    assert.match(imagePromptScript, /function checkLibraryStatus/);
    assert.match(imagePromptScript, /data-src="\/playground\/(?:\?v=[^"]*)?"/);

    const unauthorized = await fetch(`${baseUrl}/api/config`);
    assert.equal(unauthorized.status, 401);
    const unauthorizedPlaygroundConfig = await fetch(`${baseUrl}/api/playground-config`);
    assert.equal(unauthorizedPlaygroundConfig.status, 401);
    const unauthorizedPlaygroundProxy = await fetch(
      `${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(providerBaseUrl)}`,
      { method: 'POST' },
    );
    assert.equal(unauthorizedPlaygroundProxy.status, 401);
    const unauthorizedImagePrompts = await fetch(`${baseUrl}/api/image-prompts`);
    assert.equal(unauthorizedImagePrompts.status, 401);
    const unauthorizedImagePromptStatus = await fetch(`${baseUrl}/api/image-prompts/status`);
    assert.equal(unauthorizedImagePromptStatus.status, 401);
    const unauthorizedImagePromptSync = await fetch(`${baseUrl}/api/image-prompts/sync`, { method: 'POST' });
    const unauthorizedImagePromptAsset = await fetch(`${baseUrl}/api/image-prompts/assets/images/case1.jpg`);
    assert.equal(unauthorizedImagePromptSync.status, 401);
    assert.equal(unauthorizedImagePromptAsset.status, 401);
    const unauthorizedDreamSkin = await fetch(`${baseUrl}/api/dream-skin/prompt`, { method: 'POST' });
    assert.equal(unauthorizedDreamSkin.status, 401);
    const unauthorizedArchivedTasks = await fetch(`${baseUrl}/api/native-archived-sessions`);
    assert.equal(unauthorizedArchivedTasks.status, 401);
    const unauthorizedAutomations = await fetch(`${baseUrl}/api/automations`);
    assert.equal(unauthorizedAutomations.status, 401);
    const unauthorizedSkills = await fetch(`${baseUrl}/api/skills`);
    assert.equal(unauthorizedSkills.status, 401);
    const unauthorizedSubQuotas = await fetch(`${baseUrl}/api/sub-quotas`);
    assert.equal(unauthorizedSubQuotas.status, 401);
    const unauthorizedSubQuotaConfig = await fetch(`${baseUrl}/api/sub-quota-config`);
    assert.equal(unauthorizedSubQuotaConfig.status, 401);
    const unauthorizedGrok2ApiConsole = await fetch(`${baseUrl}/api/sub-quotas/grok2api/console`);
    assert.equal(unauthorizedGrok2ApiConsole.status, 401);
    const unauthorizedGrok2ApiSync = await fetch(`${baseUrl}/api/sub-quotas/grok2api/sync`, { method: 'POST' });
    assert.equal(unauthorizedGrok2ApiSync.status, 401);
    const unauthorizedModelCapabilities = await fetch(`${baseUrl}/api/native-model-capabilities`);
    assert.equal(unauthorizedModelCapabilities.status, 401);
    const unauthorizedPlayground = await fetch(`${baseUrl}/playground/`);
    assert.equal(unauthorizedPlayground.status, 401);

    const initialLoginErrors = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const rejectedLogin = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: `wrong-password-${attempt}` }),
      });
      assert.equal(rejectedLogin.status, 401);
      initialLoginErrors.push((await rejectedLogin.json()).error);
    }
    assert.deepEqual([...new Set(initialLoginErrors)], ['密码错误']);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];
    const grok2ApiConsole = await fetch(`${baseUrl}/api/sub-quotas/grok2api/console?tail=999`, {
      headers: { Cookie: cookie },
    });
    assert.equal(grok2ApiConsole.status, 200);
    assert.match(grok2ApiConsole.headers.get('cache-control'), /private, no-store/);
    const grok2ApiConsolePayload = await grok2ApiConsole.json();
    assert.equal(grok2ApiConsolePayload.ok, true);
    assert.equal(grok2ApiConsolePayload.tail, 400);
    assert.match(grok2ApiConsolePayload.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(grok2ApiConsolePayload.output, /Grok2API console fixture ready/);
    assert.match(grok2ApiConsolePayload.output, /api_key=\[REDACTED\]/);
    assert.match(grok2ApiConsolePayload.output, /cookie=\[REDACTED\]/);
    assert.match(grok2ApiConsolePayload.output, /Authorization: \[REDACTED\]/);
    assert.doesNotMatch(grok2ApiConsolePayload.output, /fixture-api-key-value|fixture-session-cookie|fixture-bearer-token/);
    assert.deepEqual(JSON.parse(await readFile(fakeDockerArgsFile, 'utf8')), [
      'logs',
      '--timestamps',
      '--tail',
      '400',
      'grok2api',
    ]);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const rejectedLogin = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: `still-wrong-${attempt}` }),
      });
      assert.equal(rejectedLogin.status, 401, 'successful login must clear prior failures');
    }
    const rateLimitedLogin = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'still-wrong-final' }),
    });
    assert.equal(rateLimitedLogin.status, 429);
    assert.equal(rateLimitedLogin.headers.get('retry-after'), '1');
    assert.match((await rateLimitedLogin.json()).error, /登录尝试过于频繁/);
    const healthWhileLoginLimited = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthWhileLoginLimited.status, 200);
    assert.equal((await healthWhileLoginLimited.json()).ok, true);

    const skills = await fetch(`${baseUrl}/api/skills`, {
      headers: { Cookie: cookie },
    });
    assert.equal(skills.status, 200);
    const skillsPayload = await skills.json();
    assert.ok(Array.isArray(skillsPayload.skills));
    assert.equal(typeof skillsPayload.count, 'number');
    assert.doesNotMatch(JSON.stringify(skillsPayload), /\/Users\//);
    assert.doesNotMatch(JSON.stringify(skillsPayload), /CODEX_HOME/);

    const unauthorizedCompletionRead = await fetch(`${baseUrl}/api/history-completion-read`);
    assert.equal(unauthorizedCompletionRead.status, 401);
    const emptyCompletionRead = await fetch(`${baseUrl}/api/history-completion-read`, {
      headers: { Cookie: cookie },
    });
    assert.equal(emptyCompletionRead.status, 200);
    assert.deepEqual((await emptyCompletionRead.json()).read, {});
    const nativeSessionsForCompletionRead = await fetch(`${baseUrl}/api/native-sessions`, {
      headers: { Cookie: cookie },
    });
    const nativeSessionsForCompletionReadPayload = await nativeSessionsForCompletionRead.json();
    const nativeCompletionReadSession = nativeSessionsForCompletionReadPayload.sessions
      .find((session) => session.id === nativeSessionId);
    assert.ok(nativeCompletionReadSession);
    assert.equal(nativeCompletionReadSession.status, 'done');
    const nativeCompletionReadVersion = `${nativeCompletionReadSession.status}|${nativeCompletionReadSession.updatedAt}`;
    const appStateAfterRead = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    appStateAfterRead['electron-persisted-atom-state']['unread-thread-ids-by-host-v1'].local =
      appStateAfterRead['electron-persisted-atom-state']['unread-thread-ids-by-host-v1'].local
        .filter((id) => id !== nativeSessionId);
    await writeFile(codexGlobalStateFile, JSON.stringify(appStateAfterRead));
    const appReadCompletion = await fetch(`${baseUrl}/api/history-completion-read`, {
      headers: { Cookie: cookie },
    });
    assert.equal(appReadCompletion.status, 200);
    assert.equal(
      (await appReadCompletion.json()).read[`codex:${nativeSessionId}`],
      nativeCompletionReadVersion,
    );
    appStateAfterRead['electron-persisted-atom-state']['unread-thread-ids-by-host-v1'].local
      .push(nativeSessionId);
    await writeFile(codexGlobalStateFile, JSON.stringify(appStateAfterRead));
    const appUnreadCompletion = await fetch(`${baseUrl}/api/history-completion-read`, {
      headers: { Cookie: cookie },
    });
    assert.equal(
      (await appUnreadCompletion.json()).read[`codex:${nativeSessionId}`],
      nativeCompletionReadVersion,
      'Codex App unread state must not revive a Web-read completion',
    );
    const completionReadBeforeInvalidState = await fetch(`${baseUrl}/api/history-completion-read`, {
      headers: { Cookie: cookie },
    }).then((response) => response.json());
    await writeFile(codexGlobalStateFile, '{"electron-persisted-atom-state":');
    const invalidAppReadCompletion = await fetch(`${baseUrl}/api/history-completion-read`, {
      headers: { Cookie: cookie },
    });
    assert.deepEqual(
      (await invalidAppReadCompletion.json()).read,
      completionReadBeforeInvalidState.read,
      'a partially-written Codex App state must not clear completion dots',
    );
    await unlink(codexGlobalStateFile);
    const missingAppReadCompletion = await fetch(`${baseUrl}/api/history-completion-read`, {
      headers: { Cookie: cookie },
    });
    assert.deepEqual(
      (await missingAppReadCompletion.json()).read,
      completionReadBeforeInvalidState.read,
      'a missing Codex App state must not clear completion dots',
    );
    await writeFile(codexGlobalStateFile, JSON.stringify(appStateAfterRead));
    const savedCompletionRead = await fetch(`${baseUrl}/api/history-completion-read`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ read: { 'codex:019f4f84-ea9f-73c2-b997-deba7b4aa729': 'done|2026-08-05T00:00:00Z' } }),
    });
    assert.equal(savedCompletionRead.status, 200);
    const fetchedCompletionRead = await fetch(`${baseUrl}/api/history-completion-read`, {
      headers: { Cookie: cookie },
    });
    assert.deepEqual((await fetchedCompletionRead.json()).read, {
      'codex:019f4f84-ea9f-73c2-b997-deba7b4aa729': 'done|2026-08-05T00:00:00Z',
    });
    const newerCompletionRead = await fetch(`${baseUrl}/api/history-completion-read`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ read: { 'codex:019f4f84-ea9f-73c2-b997-deba7b4aa729': 'done|2026-08-05T01:00:00Z' } }),
    });
    assert.equal(newerCompletionRead.status, 200);
    assert.equal(
      (await newerCompletionRead.json()).read['codex:019f4f84-ea9f-73c2-b997-deba7b4aa729'],
      'done|2026-08-05T01:00:00Z',
    );
    const staleCompletionRead = await fetch(`${baseUrl}/api/history-completion-read`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ read: { 'codex:019f4f84-ea9f-73c2-b997-deba7b4aa729': 'done|2026-08-04T23:00:00Z' } }),
    });
    assert.equal(staleCompletionRead.status, 200);
    assert.equal(
      (await staleCompletionRead.json()).read['codex:019f4f84-ea9f-73c2-b997-deba7b4aa729'],
      'done|2026-08-05T01:00:00Z',
    );
    const invalidCompletionRead = await fetch(`${baseUrl}/api/history-completion-read`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ read: 'not-an-object' }),
    });
    assert.equal(invalidCompletionRead.status, 400);

    const unauthorizedGoalUpdate = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/goal`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective: 'Unauthorized goal' }),
    });
    assert.equal(unauthorizedGoalUpdate.status, 401);
    const updatedGoal = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/goal`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective: 'Verify the native goal controls' }),
    });
    assert.equal(updatedGoal.status, 200);
    assert.equal((await updatedGoal.json()).goal.objective, 'Verify the native goal controls');
    const pausedGoal = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/goal`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    });
    assert.equal(pausedGoal.status, 200);
    assert.equal((await pausedGoal.json()).goal.status, 'paused');
    const sessionWithPausedGoal = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal((await sessionWithPausedGoal.json()).conversation.goal.status, 'paused');
    const clearedGoal = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/goal`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(clearedGoal.status, 200);
    assert.equal((await clearedGoal.json()).cleared, true);
    const sessionWithoutGoal = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal((await sessionWithoutGoal.json()).conversation.goal, null);

    const subQuotaConfig = await fetch(`${baseUrl}/api/sub-quota-config`, {
      headers: { Cookie: cookie },
    });
    assert.equal(subQuotaConfig.status, 200);
    const subQuotaConfigPayload = await subQuotaConfig.json();
    assert.equal(subQuotaConfigPayload.baseUrl, providerBaseUrl);
    assert.equal(subQuotaConfigPayload.keyConfigured, true);
    assert.equal(subQuotaConfigPayload.provider, 'cpa-codex');
    assert.equal(subQuotaConfigPayload.providerLabel, 'CPA Codex');
    assert.equal(subQuotaConfigPayload.visibleCount, 5);
    assert.deepEqual(subQuotaConfigPayload.codexApp, {
      provider: 'codex-app',
      providerLabel: 'Codex App',
      builtin: true,
      configured: true,
      visible: true,
    });
    assert.ok(subQuotaConfigPayload.sources.every((source) => source.visible === true));
    assert.doesNotMatch(JSON.stringify(subQuotaConfigPayload), /test-sub-key/);

    await writeFile(appServerControlFile, JSON.stringify({ failPrimaryQuota: true }));
    const codexAppCredits = await fetch(`${baseUrl}/api/codex-app-credits?refresh=1`, {
      headers: { Cookie: cookie },
    });
    await writeFile(appServerControlFile, '{}');
    assert.equal(codexAppCredits.status, 200);
    assert.match(codexAppCredits.headers.get('cache-control'), /private, no-store/);
    const codexAppCreditsPayload = await codexAppCredits.json();
    assert.match(codexAppCreditsPayload.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
    const { fetchedAt: _codexAppCreditsFetchedAt, ...codexAppCreditsStable } = codexAppCreditsPayload;
    assert.deepEqual(codexAppCreditsStable, {
      provider: 'codex-app',
      providerLabel: 'Codex App',
      name: 'Codex App',
      mode: 'codex_app_credits',
      valid: true,
      available: true,
      planType: 'plus',
      planName: 'Plus',
      unit: 'credits',
      balance: 1705.928725,
      pointsBalance: 1705.928725,
      pointsLimit: 2500,
      usdBalance: 68.2,
      usdLimit: 100,
      remainingPercent: 68.2,
      usdPerCredit: 0.04,
      currency: 'USD',
      hasCredits: true,
      unlimited: false,
      status: 'active',
      visible: true,
    });
    const quotaTrace = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(quotaTrace.some((message) => (
      message.method === 'initialize'
      && message.params?.clientInfo?.name === 'codex-web-quota'
    )));

    assert.equal(subQuotaConfigPayload.deepSeekUsage, undefined);
    assert.doesNotMatch(JSON.stringify(subQuotaConfigPayload), /test-sub-key|deepSeekUsage/);

    const rejectedSubQuotaUrl = await fetch(`${baseUrl}/api/sub-quota-config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'file:///tmp/sub2api', apiKey: 'new-sub-key' }),
    });
    assert.equal(rejectedSubQuotaUrl.status, 400);
    assert.doesNotMatch(await readFile(webEnv, 'utf8').catch(() => ''), /SUB2API_BASE_URL/);

    const uncheckedSubQuotaKey = await fetch(`${baseUrl}/api/sub-quota-config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: customProviderBaseUrl, apiKey: 'bad-sub-key' }),
    });
    assert.equal(uncheckedSubQuotaKey.status, 200);
    const uncheckedSubQuotaPayload = await uncheckedSubQuotaKey.json();
    assert.equal(uncheckedSubQuotaPayload.saved, true);
    assert.match(String(uncheckedSubQuotaPayload.detectDetail || ''), /上游检测结果不会阻止保存/);
    assert.doesNotMatch(JSON.stringify(uncheckedSubQuotaPayload), /bad-sub-key/);
    const uncheckedPersistedConfig = await readFile(webEnv, 'utf8');
    assert.match(uncheckedPersistedConfig, /^SUB2API_API_KEY="bad-sub-key"$/m);
    assert.match(uncheckedPersistedConfig, new RegExp(customProviderBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const updatedSubQuotaKey = await fetch(`${baseUrl}/api/sub-quota-config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: `${customProviderBaseUrl}/`, apiKey: 'new-sub-key' }),
    });
    assert.equal(updatedSubQuotaKey.status, 200);
    const updatedSubQuotaPayload = await updatedSubQuotaKey.json();
    assert.equal(updatedSubQuotaPayload.baseUrl, customProviderBaseUrl);
    assert.equal(updatedSubQuotaPayload.provider, 'cpa-codex');
    assert.equal(updatedSubQuotaPayload.providerLabel, 'CPA Codex');
    assert.match(String(updatedSubQuotaPayload.detectDetail || ''), /上游检测结果不会阻止保存/);
    assert.doesNotMatch(JSON.stringify(updatedSubQuotaPayload), /new-sub-key/);
    let persistedSubQuotaConfig = await readFile(webEnv, 'utf8');
    assert.match(persistedSubQuotaConfig, new RegExp(`^SUB2API_BASE_URL=${JSON.stringify(customProviderBaseUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(persistedSubQuotaConfig, /^SUB2API_API_KEY="new-sub-key"$/m);
    assert.match(persistedSubQuotaConfig, /^SUB_QUOTA_PROVIDER="?cpa-codex"?$/m);
    assert.equal((await stat(webEnv)).mode & 0o777, 0o600);

    const updatedSubQuotaUrl = await fetch(`${baseUrl}/api/sub-quota-config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: `${providerBaseUrl}/v1/usage`, apiKey: '' }),
    });
    assert.equal(updatedSubQuotaUrl.status, 200);
    assert.equal((await updatedSubQuotaUrl.json()).baseUrl, providerBaseUrl);
    persistedSubQuotaConfig = await readFile(webEnv, 'utf8');
    assert.match(persistedSubQuotaConfig, new RegExp(`^SUB2API_BASE_URL=${JSON.stringify(providerBaseUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.match(persistedSubQuotaConfig, /^SUB2API_API_KEY="new-sub-key"$/m);

    const refreshedSubQuotaConfig = await fetch(`${baseUrl}/api/sub-quota-config`, {
      headers: { Cookie: cookie },
    });
    assert.equal(refreshedSubQuotaConfig.status, 200);
    const refreshedSubQuotaConfigPayload = await refreshedSubQuotaConfig.json();
    assert.equal(refreshedSubQuotaConfigPayload.baseUrl, providerBaseUrl);
    assert.equal(refreshedSubQuotaConfigPayload.keyConfigured, true);
    assert.doesNotMatch(JSON.stringify(refreshedSubQuotaConfigPayload), /new-sub-key/);

    const updatedSubQuotaVisibility = await fetch(`${baseUrl}/api/sub-quota-config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codexAppVisible: false,
        order: ['deepseek', 'cpa-codex', 'sub2api', 'grok2api'],
        sources: [
          { provider: 'cpa-codex', baseUrl: providerBaseUrl, apiKey: '', visible: false },
          { provider: 'sub2api', baseUrl: '', apiKey: '', visible: false },
          { provider: 'grok2api', baseUrl: '', apiKey: '', visible: true },
          { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: '', visible: true },
        ],
      }),
    });
    assert.equal(updatedSubQuotaVisibility.status, 200);
    const updatedSubQuotaVisibilityPayload = await updatedSubQuotaVisibility.json();
    assert.equal(updatedSubQuotaVisibilityPayload.visibleCount, 2);
    assert.equal(updatedSubQuotaVisibilityPayload.codexApp.visible, false);
    assert.deepEqual(
      updatedSubQuotaVisibilityPayload.sources.map((source) => [source.provider, source.visible]),
      [
        ['deepseek', true],
        ['cpa-codex', false],
        ['sub2api', false],
        ['grok2api', true],
      ],
    );
    persistedSubQuotaConfig = await readFile(webEnv, 'utf8');
    assert.match(persistedSubQuotaConfig, /^CODEX_APP_QUOTA_VISIBLE="false"$/m);
    assert.match(persistedSubQuotaConfig, /^CPA_QUOTA_VISIBLE="false"$/m);
    assert.match(persistedSubQuotaConfig, /^SUB2API_QUOTA_VISIBLE="false"$/m);
    assert.match(persistedSubQuotaConfig, /^GROK2API_QUOTA_VISIBLE="true"$/m);
    assert.match(persistedSubQuotaConfig, /^DEEPSEEK_QUOTA_VISIBLE="true"$/m);
    assert.match(persistedSubQuotaConfig, /^SUB_QUOTA_ORDER="deepseek,cpa-codex,sub2api,grok2api"$/m);

    const subQuotas = await fetch(`${baseUrl}/api/sub-quotas`, {
      headers: { Cookie: cookie },
    });
    assert.equal(subQuotas.status, 200);
    assert.match(subQuotas.headers.get('cache-control'), /private, no-store/);
    const subQuotaPayload = await subQuotas.json();
    assert.equal(subQuotaPayload.configured, true);
    assert.equal(subQuotaPayload.count, 1);
    assert.equal(subQuotaPayload.quotas[0].planName, 'Plus');
    assert.equal(subQuotaPayload.quotas[0].name, 'plus@example.com');
    assert.equal(subQuotaPayload.quotas[0].rateLimits[0].window, '5h');
    assert.equal(subQuotaPayload.quotas[0].rateLimits[0].remaining, 70);
    assert.equal(subQuotaPayload.quotas[0].rateLimits[0].resetAt, '2026-07-27T08:39:33.000Z');
    assert.equal(subQuotaPayload.quotas[0].rateLimits[1].window, '7d');
    assert.equal(subQuotaPayload.quotas[0].rateLimits[1].remaining, 82);
    assert.equal(subQuotaPayload.quotas[0].rateLimits[1].resetAt, '2026-08-03T07:19:33.000Z');
    assert.equal(subQuotaPayload.codexApp.balance, 1705.928725);
    assert.equal(subQuotaPayload.codexApp.planName, 'Plus');
    assert.equal(subQuotaPayload.codexApp.visible, false);
    assert.deepEqual(subQuotaPayload.visibility, {
      'codex-app': false,
      'cpa-codex': false,
      sub2api: false,
      grok2api: true,
      deepseek: true,
    });
    const managementRequests = providerRequests.filter((item) => String(item.url || '').startsWith('/v0/management/'));
    assert.ok(managementRequests.some((item) => item.url === '/v0/management/auth-files'));
    assert.ok(managementRequests.some((item) => item.url === '/v0/management/api-call'));
    assert.equal(managementRequests.at(-1).managementKey, 'new-sub-key');
    assert.equal(managementRequests.at(-1).host, new URL(providerBaseUrl).host);
    assert.doesNotMatch(JSON.stringify(subQuotaPayload), /test-sub-key/);
    const refreshedSubQuotas = await fetch(`${baseUrl}/api/sub-quotas?refresh=1`, {
      headers: { Cookie: cookie },
    });
    assert.equal(refreshedSubQuotas.status, 200);

    const emptyAutomations = await fetch(`${baseUrl}/api/automations`, {
      headers: { Cookie: cookie },
    });
    assert.equal(emptyAutomations.status, 200);
    assert.equal((await emptyAutomations.json()).count, 0);
    const heartbeatDirectory = path.join(codexHome, 'automations', 'fixture-heartbeat');
    await mkdir(heartbeatDirectory, { recursive: true });
    await writeFile(path.join(heartbeatDirectory, 'automation.toml'), `version = 1
id = "fixture-heartbeat"
kind = "heartbeat"
name = "Fixture heartbeat"
prompt = "Keep the fixture task moving."
status = "ACTIVE"
rrule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=30"
target_thread_id = "${nativeSessionId}"
created_at = 1784422800000
updated_at = 1784422800000
`);
    const createdAutomation = await fetch(`${baseUrl}/api/automations`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Daily project brief',
        prompt: 'Summarize the latest project work.',
        cwd: temporary,
        model: 'test-model',
        reasoningEffort: 'xhigh',
        notificationPolicy: 'always',
        status: 'PAUSED',
        schedule: { frequency: 'weekdays', time: '08:00' },
      }),
    });
    assert.equal(createdAutomation.status, 201);
    const createdAutomationPayload = await createdAutomation.json();
    assert.equal(createdAutomationPayload.automation.id, 'daily-project-brief');
    assert.equal(createdAutomationPayload.automation.scheduleLabel, '工作日 08:00');
    assert.equal(createdAutomationPayload.automation.model, 'test-model');
    assert.equal(createdAutomationPayload.automation.reasoningEffort, 'xhigh');
    assert.equal(createdAutomationPayload.automation.notificationPolicy, 'always');
    assert.equal(createdAutomationPayload.automation.status, 'PAUSED');
    const editedAutomation = await fetch(`${baseUrl}/api/automations/daily-project-brief`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Weekly project brief',
        prompt: 'Summarize the latest project work every Friday.',
        cwd: '',
        model: 'test-model',
        reasoningEffort: 'ultra',
        notificationPolicy: 'failed_runs_only',
        status: 'PAUSED',
        schedule: { frequency: 'weekly', day: 'FR', time: '09:30' },
      }),
    });
    assert.equal(editedAutomation.status, 200);
    const editedAutomationPayload = await editedAutomation.json();
    assert.equal(editedAutomationPayload.automation.id, 'daily-project-brief');
    assert.equal(editedAutomationPayload.automation.name, 'Weekly project brief');
    assert.equal(editedAutomationPayload.automation.scheduleLabel, '周五 09:30');
    assert.deepEqual(editedAutomationPayload.automation.cwds, []);
    assert.equal(editedAutomationPayload.automation.reasoningEffort, 'ultra');
    assert.equal(editedAutomationPayload.automation.notificationPolicy, 'failed_runs_only');
    const automationToml = await readFile(
      path.join(codexHome, 'automations', 'daily-project-brief', 'automation.toml'),
      'utf8',
    );
    assert.match(automationToml, /name = "Weekly project brief"/);
    assert.match(automationToml, /rrule = "FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=30"/);
    assert.match(automationToml, /cwds = \[\]/);
    assert.match(automationToml, /model = "test-model"/);
    assert.match(automationToml, /reasoning_effort = "ultra"/);
    assert.match(automationToml, /notification_policy = "failed_runs_only"/);
    assert.match(automationToml, /status = "PAUSED"/);
    assert.match(automationToml, /target = \{ type = "projectless" \}/);
    const activatedAutomation = await fetch(
      `${baseUrl}/api/automations/daily-project-brief/status`,
      {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ACTIVE' }),
      },
    );
    assert.equal(activatedAutomation.status, 200);
    assert.equal((await activatedAutomation.json()).automation.status, 'ACTIVE');

    const archivedTasks = await fetch(`${baseUrl}/api/native-archived-sessions`, {
      headers: { Cookie: cookie },
    });
    assert.equal(archivedTasks.status, 200);
    assert.match(archivedTasks.headers.get('cache-control'), /private, no-store/);
    const archivedTasksPayload = await archivedTasks.json();
    assert.equal(archivedTasksPayload.count, 1);
    assert.equal(archivedTasksPayload.sessions[0].id, archivedNativeSessionId);
    assert.equal(archivedTasksPayload.sessions[0].source, 'codex');
    assert.equal(archivedTasksPayload.sessions[0].cwd, temporary);

    const rejectedUnarchivedDelete = await fetch(
      `${baseUrl}/api/native-archived-sessions/${nativeSessionId}`,
      { method: 'DELETE', headers: { Cookie: cookie } },
    );
    assert.equal(rejectedUnarchivedDelete.status, 404);
    assert.match((await rejectedUnarchivedDelete.json()).error, /不在已归档列表/);

    const unarchivedTask = await fetch(
      `${baseUrl}/api/native-archived-sessions/${archivedNativeSessionId}/unarchive`,
      { method: 'POST', headers: { Cookie: cookie } },
    );
    assert.equal(unarchivedTask.status, 200);
    assert.equal((await unarchivedTask.json()).id, archivedNativeSessionId);
    assert.ok(desktopIpc.messages.some((message) => (
      message.type === 'broadcast'
      && message.method === 'thread-unarchived'
      && message.version === 1
      && message.params?.hostId === 'local'
      && message.params?.conversationId === archivedNativeSessionId
      && message.params?.cwd === temporary
    )));
    assert.ok(desktopIpc.messages.some((message) => (
      message.type === 'broadcast'
      && message.method === 'query-cache-invalidate'
      && message.version === 0
      && JSON.stringify(message.params?.queryKey) === JSON.stringify(['archived-threads'])
    )));

    const playgroundResponse = await fetch(`${baseUrl}/playground/`, {
      headers: { Cookie: cookie },
    });
    assert.equal(playgroundResponse.status, 200);
    assert.match(playgroundResponse.headers.get('cache-control'), /private, no-store/);
    const playgroundPage = await playgroundResponse.text();
    assert.match(playgroundPage, /<title>GPT Image Playground<\/title>/);
    assert.match(playgroundPage, /codex-web-overrides\.css/);
    assert.match(playgroundPage, /codex-web-integration\.js/);
    const playgroundAssetPath = playgroundPage.match(/src="\.\/(assets\/[^"\?]+\.js)/)?.[1];
    assert.ok(playgroundAssetPath);
    const playgroundAsset = await fetch(`${baseUrl}/playground/${playgroundAssetPath}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(playgroundAsset.status, 200);
    assert.match(playgroundAsset.headers.get('content-type'), /javascript/);
    assert.match(playgroundAsset.headers.get('cache-control'), /private, no-store/);
    const playgroundAssetScript = await playgroundAsset.text();
    assert.match(playgroundAssetScript, /codex-web:playground-ready/);
    assert.match(playgroundAssetScript, /codex-web:image-prompt-applied/);
    assert.match(playgroundAssetScript, /\/api\/playground-config/);
    assert.match(playgroundAssetScript, /codex-web-agent/);
    assert.match(playgroundAssetScript, /agentApiConfigMode/);
    assert.match(playgroundAssetScript, /allowedOrigins/);
    assert.match(playgroundAssetScript, /codex_upstream/);
    assert.match(playgroundAssetScript, /Agent 规划服务暂时不可用，已切换为直接生图/);
    assert.match(playgroundAssetScript, /上游 Agent 流式请求失败/);
    assert.match(playgroundAssetScript, /请求将通过 Codex Web 同源代理转发到此 URL/);
    assert.doesNotMatch(playgroundAssetScript, /此处设置被忽略/);
    const playgroundPatchSource = await readFile(
      path.join(ROOT, 'vendor', 'gpt-image-playground', 'patches', 'codex-web.patch'),
      'utf8',
    );
    assert.match(playgroundPatchSource, /const preserveExistingUpstream = allowedOrigins\.has\(existingOrigin\)/);
    assert.match(playgroundPatchSource, /baseUrl: preserveExistingUpstream \? existingBaseUrl : profile\.baseUrl/);
    assert.match(playgroundPatchSource, /responseError = getErrorMessageFromValue\(response\?\.error\)/);
    assert.match(playgroundPatchSource, /isDirectAgentImageFallbackPrompt/);
    assert.match(playgroundPatchSource, /modulePreload: \{ polyfill: false \}/);
    assert.match(playgroundAssetScript, /输入 @ 选择或上传参考图/);
    assert.match(playgroundAssetScript, /上传新的参考图/);
    const playgroundServiceWorker = await fetch(`${baseUrl}/playground/sw.js`, {
      headers: { Cookie: cookie },
    });
    assert.equal(playgroundServiceWorker.status, 200);
    assert.match(playgroundServiceWorker.headers.get('content-type'), /javascript/);
    assert.match(await playgroundServiceWorker.text(), /registration\.unregister/);
    const playgroundIntegrationResponse = await fetch(`${baseUrl}/playground/codex-web-integration.js`, {
      headers: { Cookie: cookie },
    });
    assert.equal(playgroundIntegrationResponse.status, 200);
    assert.match(await playgroundIntegrationResponse.text(), /\/api\/playground-update\/status/);

    const unauthorizedPlaygroundUpdateStatus = await fetch(`${baseUrl}/api/playground-update/status`);
    assert.equal(unauthorizedPlaygroundUpdateStatus.status, 401);
    const playgroundUpdateStatus = await fetch(`${baseUrl}/api/playground-update/status`, {
      headers: { Cookie: cookie },
    });
    assert.equal(playgroundUpdateStatus.status, 200);
    assert.equal((await playgroundUpdateStatus.json()).enabled, false);
    const disabledPlaygroundUpdate = await fetch(`${baseUrl}/api/playground-update`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(disabledPlaygroundUpdate.status, 403);

    const dreamSkinSkill = await fetch(`${baseUrl}/assets/dream-skin/SKILL.md`, {
      headers: { Cookie: cookie },
    });
    assert.equal(dreamSkinSkill.status, 200);
    assert.match(dreamSkinSkill.headers.get('content-type'), /markdown|text\/plain/);
    const dreamSkinSkillMarkdown = await dreamSkinSkill.text();
    assert.match(dreamSkinSkillMarkdown, /Required Workflow[\s\S]*imagegen/);
    assert.match(dreamSkinSkillMarkdown, /Theme Integration Contract[\s\S]*concept-themes\.json/);

    const dreamSkinConceptSource = await fetch(
      `${baseUrl}/assets/dream-skin/background-generation-prompts.md`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(dreamSkinConceptSource.status, 200);
    const dreamSkinConceptMarkdown = await dreamSkinConceptSource.text();
    assert.equal((dreamSkinConceptMarkdown.match(/^## skin-0[1-8]｜/gm) || []).length, 8);
    assert.match(dreamSkinConceptMarkdown, /skin-03｜红白未来城市主题/);
    assert.match(dreamSkinConceptMarkdown, /完整皮肤由本文件生成的纯背景与 `concept-themes\.json`/);

    const dreamSkinThemeSource = await fetch(
      `${baseUrl}/assets/dream-skin/concept-themes.json`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(dreamSkinThemeSource.status, 200);
    const dreamSkinThemePayload = await dreamSkinThemeSource.json();
    assert.equal(dreamSkinThemePayload.schemaVersion, 1);
    assert.equal(Object.keys(dreamSkinThemePayload.themes).length, 8);

    const dreamSkinConfigResponse = await fetch(`${baseUrl}/api/config`, {
      headers: { Cookie: cookie },
    });
    assert.equal(dreamSkinConfigResponse.status, 200);
    const dreamSkinConfig = await dreamSkinConfigResponse.json();
    assert.equal(dreamSkinConfig.appearance.theme, 'system');
    assert.equal(dreamSkinConfig.dreamSkinConcepts.length, 8);
    assert.deepEqual(
      dreamSkinConfig.dreamSkinConcepts.map((concept) => concept.id),
      [
        'skin-01',
        'skin-02',
        'skin-03',
        'skin-04',
        'skin-05',
        'skin-06',
        'skin-07',
        'skin-08',
      ],
    );
    assert.deepEqual(
      dreamSkinConfig.dreamSkinConcepts.map((concept) => concept.name),
      [
        '粉系玫瑰人物主题',
        '财神打工主题',
        '红白未来城市主题',
        '清透鼠尾草人物主题',
        '彩色灵感小宇宙主题',
        '蓝紫星夜人物主题',
        '青蓝虚拟歌姬主题',
        '舞台黑金人物主题',
      ],
    );
    assert.equal(dreamSkinConfig.dreamSkinConcepts.find((concept) => concept.id === 'skin-03').mode, 'no-person');
    assert.equal(dreamSkinConfig.dreamSkinConcepts.every((concept) => !('prompt' in concept)), true);
    assert.equal(dreamSkinConfig.dreamSkinConcepts.every((concept) => concept.theme?.colors?.light && concept.theme?.colors?.dark), true);
    assert.equal(dreamSkinConfig.dreamSkinConcepts.find((concept) => concept.id === 'skin-07').theme.colors.light.accent, '#0b7f91');
    assert.equal(dreamSkinConfig.dreamSkinConcepts.find((concept) => concept.id === 'skin-07').theme.art.focusX, 0.73);
    assert.deepEqual(
      dreamSkinConfig.dreamSkinConcepts.map((concept) => concept.wallpaper),
      [
        '/assets/dream-skin/wallpapers/skin-01.jpg',
        '/assets/dream-skin/wallpapers/skin-02.jpg',
        '/assets/dream-skin/wallpapers/skin-03.jpg',
        '/assets/dream-skin/wallpapers/skin-04.jpg',
        '/assets/dream-skin/wallpapers/skin-05.jpg',
        '/assets/dream-skin/wallpapers/skin-06.jpg',
        '/assets/dream-skin/wallpapers/skin-07.jpg',
        '/assets/dream-skin/wallpapers/skin-08.jpg',
      ],
    );

    const dreamSkinWallpaper = await fetch(
      `${baseUrl}/assets/dream-skin/wallpapers/skin-03.jpg`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(dreamSkinWallpaper.status, 200);
    assert.match(dreamSkinWallpaper.headers.get('content-type'), /image\/jpeg/);
    assert.ok((await dreamSkinWallpaper.arrayBuffer()).byteLength > 100_000);

    const retiredDreamSkinPresetAppearance = await fetch(`${baseUrl}/api/appearance`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatBackground: 'dream:preset-midnight-aurora',
        theme: 'dark',
      }),
    });
    assert.equal(retiredDreamSkinPresetAppearance.status, 200);
    const retiredDreamSkinPresetState = (await retiredDreamSkinPresetAppearance.json()).appearance;
    assert.equal(retiredDreamSkinPresetState.chatBackground, 'default');
    assert.equal(retiredDreamSkinPresetState.theme, 'dark');

    const systemThemeAppearance = await fetch(`${baseUrl}/api/appearance`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'system' }),
    });
    assert.equal(systemThemeAppearance.status, 200);
    assert.equal((await systemThemeAppearance.json()).appearance.theme, 'system');

    const appliedDreamSkinWallpaper = await fetch(`${baseUrl}/api/appearance`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatBackground: 'dream:skin-03' }),
    });
    assert.equal(appliedDreamSkinWallpaper.status, 200);
    assert.equal((await appliedDreamSkinWallpaper.json()).appearance.chatBackground, 'dream:skin-03');

    const generatedDreamSkinUpload = await fetch(`${baseUrl}/api/appearance/background`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Dream Skin generated.png',
        type: 'image/png',
        data: `data:image/png;base64,${Buffer.from('dream-skin-smoke').toString('base64')}`,
        themeId: 'skin-07',
      }),
    });
    assert.equal(generatedDreamSkinUpload.status, 200);
    const generatedDreamSkinState = await generatedDreamSkinUpload.json();
    assert.equal(generatedDreamSkinState.background.themeId, 'skin-07');
    assert.equal(
      generatedDreamSkinState.appearance.customBackgrounds.find(
        (background) => background.value === generatedDreamSkinState.background.value,
      ).themeId,
      'skin-07',
    );

    const persistedDreamSkinConfig = await fetch(`${baseUrl}/api/config`, {
      headers: { Cookie: cookie },
    });
    assert.equal(persistedDreamSkinConfig.status, 200);
    assert.equal(
      (await persistedDreamSkinConfig.json()).appearance.customBackgrounds.find(
        (background) => background.value === generatedDreamSkinState.background.value,
      ).themeId,
      'skin-07',
    );

    const dreamSkinAppearanceResponse = await fetch(`${baseUrl}/api/appearance`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatBackground: 'dream-skin' }),
    });
    assert.equal(dreamSkinAppearanceResponse.status, 200);
    assert.equal((await dreamSkinAppearanceResponse.json()).appearance.chatBackground, 'default');

    const dreamSkinPromptResponse = await fetch(`${baseUrl}/api/dream-skin/prompt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: '雨夜东京工作室，右侧霓虹窗景',
        conceptId: 'skin-03',
        referenceCount: 0,
      }),
    });
    assert.equal(dreamSkinPromptResponse.status, 200);
    const dreamSkinTask = await dreamSkinPromptResponse.json();
    assert.equal(dreamSkinTask.mode, 'no-person');
    assert.equal(dreamSkinTask.conceptId, 'skin-03');
    assert.equal(dreamSkinTask.skill, 'vendor/codex-dream-skin/SKILL.md');
    assert.match(dreamSkinTask.prompt, /完整读取并遵循项目内置技能/);
    assert.match(dreamSkinTask.prompt, /选用概念风格：skin-03 · 红白未来城市主题/);
    assert.match(dreamSkinTask.prompt, /完整 Dream Skin 的 artwork 层/);
    assert.match(dreamSkinTask.prompt, /严禁把侧栏、卡片、按钮、输入框或文字画进图片/);
    assert.match(dreamSkinTask.prompt, /A colossal translucent coral-red energy sphere rises above the horizon/);
    assert.match(dreamSkinTask.prompt, /必须实际调用 \$imagegen/);
    assert.match(dreamSkinTask.prompt, /必须使用 imagegen 的内置 image_gen 工具模式/);
    assert.match(dreamSkinTask.prompt, /禁止执行 scripts\/image_gen\.py/);
    assert.match(dreamSkinTask.prompt, /雨夜东京工作室/);
    assert.equal(dreamSkinTask.cwd, ROOT);

    const dreamSkinReferenceError = await fetch(`${baseUrl}/api/dream-skin/prompt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'reference', referenceCount: 0 }),
    });
    assert.equal(dreamSkinReferenceError.status, 400);

    const pageResponse = await fetch(baseUrl, { headers: { Cookie: cookie } });
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.equal(page.includes('\0'), false, 'rendered HTML must not contain NUL bytes');
    assert.match(page, /src="\/vendor\/marked\.js"/);
    assert.match(page, /src="\/vendor\/purify\.js"/);
    assert.match(page, /href="\/ui\.css\?v=mobile-composer-fullscreen-20260817d"/);
    assert.match(page, /href="\/image-prompt\.css\?v=top-context-padding-20260801b"/);
    assert.match(page, /src="\/image-prompt\.js\?v=image-prompt-main-20260803a"/);
    assert.match(page, /\['dream-skin','Dream Skin'\]/);
    assert.doesNotMatch(page, /\['plain','纯净'\]|\['paper','纸张'\]|\['grid','网格'\]/);
    assert.match(page, /function createDreamSkinGenerator/);
    assert.match(page, /function renderDreamSkinConcepts/);
    assert.match(page, /function renderDreamSkinConceptPreview/);
    assert.match(page, /function selectDreamSkinConcept/);
    assert.match(page, /saveAppearance\(\{chatBackground:'dream:'\+concept\.id\}\)/);
    assert.match(page, /data-theme-mode="system"/);
    assert.match(page, /window\.matchMedia\('\(prefers-color-scheme: dark\)'\)/);
    assert.match(page, /const systemThemeMedia=window\.matchMedia\('\(prefers-color-scheme: dark\)'\)/);
    assert.match(page, /function effectiveAppearanceTheme\(\)/);
    assert.match(page, /function handleSystemThemeChange\(\)\{if\(appearance\.theme==='system'\)applyAppearance\(\)\}/);
    assert.match(page, /systemThemeMedia\.addEventListener\('change',handleSystemThemeChange\)/);
    assert.match(page, /document\.body\.dataset\.themeMode=themeMode/);
    assert.match(page, /跟随系统；点击切换明亮模式/);
    assert.match(page, /黑暗模式；点击恢复跟随系统/);
    assert.match(page, /function applyDreamSkinTheme/);
    assert.match(page, /const bg=skin&&backgroundUrl\?'skin':backgroundUrl\?'custom':selected/);
    assert.match(page, /themeId:concept\?\.id\|\|''/);
    assert.match(page, /if\(findDreamSkinConcept\(appearance\.chatBackground\)\)openDreamSkinGenerator\(\)/);
    assert.match(page, /conceptId:dreamSkinSelectedConcept/);
    assert.match(page, /function generateDreamSkinBackground/);
    assert.match(page, /function applyGeneratedImageBackground/);
    assert.match(page, /generatedBackgroundApply/);
    assert.match(page, /function renderAssistantMarkdown/);
    assert.match(page, /function enhanceMarkdownCodeBlocks\(body\)/);
    assert.match(page, /if\(assistantArtifacts\)enhanceMarkdownCodeBlocks\(body\)/);
    assert.match(page, /copyText\(code\.textContent\|\|'',copy\)/);
    assert.match(page, /function toolActivityPresentations/);
    assert.match(page, /function planActivityPresentation/);
    assert.doesNotMatch(page, /function createTurnPlanElement|turnPlanPanel/);
    assert.match(page, /function upsertLiveTurnPlan/);
    assert.match(page, /presentation\.variant==='plan'/);
    assert.match(page, /if\(descriptor\.name==='exec'\)\{const command=toolDetailCommand\(descriptor\.detail\);if\(command\)return\[commandActivityPresentation\(command\)\];return\[\{verb:'Ran',target:shortActivityText\(descriptor\.detail,72\)\|\|'command'/);
    assert.doesNotMatch(page, /descriptor\.name\+\(descriptor\.detail/);
    assert.match(page, /activityBatch/);
    assert.match(page, /liveProcessPanel/);
    assert.match(page, /let turnProcessStartedAt = 0;[\s\S]*let turnProcessElapsedLabel = null;[\s\S]*let turnProcessElapsedTimer = null;[\s\S]*let turnProcessElapsedFrozen = false;[\s\S]*let turnProcessElapsedTurnId = '';/);
    assert.match(page, /turnProcessHeader=document\.createElement\('div'\)/);
    assert.match(page, /turnProcessHeader\.insertBefore\(turnProcessElapsedLabel,turnProcessTimeline\)/);
    assert.match(page, /function beginTurnProcessCollection\(startedAt='',showElapsed=false,turnId=''\)/);
    assert.match(page, /beginTurnProcessCollection\(options\.at,showElapsed,options\.turnId\)/);
    assert.match(page, /function clearTurnProcessHeader\(\)\{\s*clearTurnReasoningStatus\(\);\s*clearTurnProcessElapsed\(\);/);
    assert.match(page, /beginTurnProcessCollection\(activeStartedAt,true,activeNativeTurnId\)/);
    assert.match(page, /hydrating:true/);
    assert.match(page, /function turnProcessElapsedMatches\(turnId\)/);
    assert.match(page, /if\(terminalProcess&&!options\.hydrating&&turnProcessElapsedTurnId&&!turnProcessElapsedMatches\(options\.turnId\)\)return null/);
    assert.match(page, /if\(isCompletedNativeRuntimeTurn\(runtime\.turnId\)&&\['delta','item-completed','connection-error','turn'\]\.includes\(runtime\.type\)\)return/);
    assert.match(page, /\['delta','item-completed','connection-error','turn'\]\.includes\(runtime\.type\)\)return/);
    assert.match(page, /freezeTurnProcessElapsed\(options\.at,options\.turnId\)/);
    assert.match(page, /freezeTurnProcessElapsed\(runtime\.updatedAt,runtimeTurnId\)/);
    assert.match(page, /freezeTurnProcessElapsed\(conversation\.updatedAt,completingTurnId\)/);
    assert.match(page, /let nativeCancelPending = null;/);
    assert.match(page, /nativeCancelPending=\{threadId,turnId\};[\s\S]*?statusEl\.textContent='Codex App · 正在停止…';[\s\S]*?if\(!nativeCancelPendingMatches\(threadId,turnId\)\)return;[\s\S]*?setTimeout\(\(\)=>\{if\(nativeCancelPendingMatches\(threadId,turnId\)\)syncCurrentNativeConversation\(\)\},80\)/);
    assert.doesNotMatch(page, /async function cancelRun\(\)\{[\s\S]*?clearLiveTurnProgress\(\);[\s\S]*?async function send/);
    assert.match(page, /const cancelPending=conversation\.source==='codex'[\s\S]*?&& running[\s\S]*?nativeCancelPendingMatches\(conversation\.id,conversation\.activeTurnId\)/);
    assert.match(page, /const reportedActiveTurnId=String\(conversation\.activeTurnId\|\|''\);[\s\S]*?conversation\.status!=='running'\|\|reportedActiveTurnId!==nativeCancelPending\.turnId/);
    assert.match(page, /if\(cancelPending\)statusEl\.textContent='Codex App · 正在停止…';\s*else showNativeRunningTimestamp\(runtime\.updatedAt\)/);
    assert.match(page, /function createActivityCluster/);
    assert.match(page, /function createActivityCluster[\s\S]*?cluster\.open=false;/);
    assert.match(page, /currentActivityCluster\.dataset\.activityLive='true'/);
    assert.match(page, /cluster\.dataset\.activityLive==='true'/);
    assert.match(page, /function updateTurnReasoningStatus/);
    assert.match(page, /if\(!turnReasoningStatus\)\{[\s\S]*turnReasoningStatus\.textContent=clean;[\s\S]*turnProcessTimeline\.appendChild\(turnReasoningStatus\)/);
    assert.doesNotMatch(page, /pendingActivityClusterTitle/);
    assert.match(page, /function isImageViewActivityPresentation/);
    assert.match(page, /image_view_activity/);
    assert.match(page, /function nativeToolImageUrls/);
    assert.match(page, /function createActivityImageGallery/);
    assert.match(page, /function loadSubagentTrace/);
    assert.match(page, /function appendSubagentTraceMessage/);
    assert.match(page, /function markSubagentTraceFinal/);
    assert.match(page, /if\(kind==='reasoning_summary'\)return false/);
    assert.match(page, /\/api\/native-sessions\/'\+encodeURIComponent\(state\.parentThreadId\)\+'\/subagents/);
    assert.match(page, /if\(source==='codex'\)\{\s*if\(running\)row\.appendChild\(running\);[\s\S]*row\.appendChild\(badge\);\s*}\s*row\.appendChild\(open\);\s*if\(running&&source!=='codex'\)row\.appendChild\(running\)/s);
    assert.match(page, /galleryOnly:true/);
    assert.doesNotMatch(page, /base\+\(index\+1\)\+generation/);
    assert.match(page, /continueMsg messageAction/);
    assert.match(page, /className='completionTimeline liveProcessTimeline'/);
    assert.doesNotMatch(page, /function updateTurnProcessLatest/);
    assert.match(page, /function appendInputImageToUser/);
    assert.match(page, /latestUserElement/);
    assert.match(page, /addMsg\('image',attachment\.url,\{kind:'input_image'\}\)/);
    assert.match(page, /stack\.classList\.toggle\('single',stack\.children\.length===1\)/);
    assert.match(page, /function runningActivityVerb/);
    assert.match(page, /sessionEvents\.addEventListener\('open'/);
    assert.doesNotMatch(page, /NATIVE_INITIAL_MESSAGE_LIMIT/);
    assert.match(page, /const NATIVE_HISTORY_PAGE_SIZE = 60;/);
    assert.match(page, /const NATIVE_HISTORY_MANUAL_MAX_BATCHES = 1;/);
    assert.match(page, /const NATIVE_HISTORY_INITIAL_MAX_BATCHES = 24;/);
    assert.match(page, /const NATIVE_HISTORY_PAGE_MAX_REQUEST_BATCHES = 2;/);
    assert.match(page, /let nativeHistoryNextPageLimit = NATIVE_HISTORY_PAGE_SIZE;/);
    assert.match(page, /function nativeHistoryViewportFilled\(container\)/);
    assert.match(page, /function nativeHistoryPageGrowthGoal\(container,initialHeight,fillViewport\)/);
    assert.match(page, /function nativeHistoryNextBatchCount\(growth,growthTarget,loadedBatches,maxBatches\)/);
    assert.match(page, /function historyNodeHasLayout\(node\)/);
    assert.match(page, /const nativeHistoryQuery=currentConversationSource==='codex'\s*\? '\?images=external&history=page&latest=complete&limit='\+nativeHistoryPageLimit\s*:\s*'';/);
    assert.match(page, /const pagingQuery=options\.historyPaging===true\?'&paging=earlier':''/);
    assert.match(page, /fetch\('\/api\/native-sessions\/'\+encodeURIComponent\(syncId\)\+'\?images=external&history=page&latest=complete&limit='\+historyLimit\+pagingQuery\)/);
    assert.match(page, /async function loadEarlierNativeHistoryPage\(options=\{\}\)/);
    assert.match(page, /const hintedLimit=normalizeNativeHistoryPageLimit\(nativeHistoryNextPageLimit\)/);
    assert.match(page, /const requestedLimit=fillViewport\?adaptiveLimit:Math\.max\(adaptiveLimit,hintedLimit\)/);
    assert.match(page, /historyPaging:true/);
    assert.match(page, /await restoreHistoryScrollAnchor\(chat,options\.historyScrollAnchor\)/);
    assert.match(page, /loadEarlierNativeHistoryPage\(\{fillViewport:true\}\)/);
    assert.match(page, /fillInitialSideChatHistoryPage\(\)/);
    assert.match(page, /function scheduleDeferredNativeHistorySync\(threadId\)/);
    assert.match(page, /nativeHistoryDeferredSyncTimer=null;\s*nativeHistorySyncDeferred=false;\s*if\(currentConversationSource!=='codex'/);
    assert.match(page, /if\(deferNativeSyncForHistoryPage\(\)\)return/);
    assert.match(page, /if\(sameConversation&&syncDeferred\)scheduleDeferredNativeHistorySync\(id\)/);
    assert.match(page, /historyPageLimit:nativeHistoryPageLimit,\s*historyScrollAnchor,/);
    assert.match(page, /const url='\/api\/native-sessions\/'\+encodeURIComponent\(id\)\+'\?images=external&history=page&latest=complete&limit='\+nativeHistoryPageLimit\+'&after='\+nativeCursor\+'&generation='\+nativeGeneration;/);
    assert.doesNotMatch(page, /addNativeHistoryLoadButton|nativeHistoryLoadEarlier/);
    assert.doesNotMatch(page, /fastNativeLoad/);
    assert.doesNotMatch(page, /加载完整记录/);
    assert.match(page, /function scheduleNativeCompletionSync/);
    assert.match(page, /function reconcileNativeCompletion/);
    assert.match(page, /runtime\.type==='connection-error'/);
    assert.match(page, /上游连接中断，正在重连/);
    assert.match(page, /document\.addEventListener\('visibilitychange',handleNativeVisibilityChange\)/);
    assert.match(page, /window\.addEventListener\('pageshow',syncNativeAfterPageResume\)/);
    assert.doesNotMatch(page, /setTimeout\(\(\)=>\{if\(currentConversationSource==='codex'.*loadConversation\(completedId,'codex'\)/);
    assert.doesNotMatch(page, /turnProcessAutoFollow/);
    assert.match(page, /上下文已自动压缩/);
    assert.doesNotMatch(page, /function appendTurnThinking/);
    assert.match(page, /id="sidePanel"/);
    assert.match(page, /function syncMenuButton/);
    assert.match(page, /sideCollapsed/);
    assert.match(page, /function setHistoryProjectExpanded/);
    assert.match(page, /function showHistoryProjectPreview/);
    assert.match(page, /itemCount\+' 个对话串，'\+runningCount\+' 个已开启'/);
    assert.match(page, /codexWeb\.historyProjectsCollapsed/);
    assert.match(page, /codexWeb\.historyTasksCollapsed/);
    assert.match(page, /codexWeb\.historyProjectsHidden/);
    assert.match(page, /function createHistoryProjectMenu/);
    assert.match(page, /function archiveHistoryProject/);
    assert.match(page, /function toggleHistoryProjectHidden/);
    assert.match(page, /codexWeb\.historyProjectNames\.v1/);
    assert.match(page, /function renameHistoryProject/);
    assert.match(page, /'pencil','重命名项目'/);
    assert.match(page, /historyProjectName\(item\.cwd\)/);
    assert.match(page, /function historyRefreshBlocked\(\)\{return historyRefreshPointerId!==null\|\|activeHistoryProjectMenu\|\|historyProjectPreviewAnchor\|\|historyRenameActive/);
    assert.match(page, /async function refreshHistory\(\)\{\s*if\(historyRefreshBlocked\(\)\)\{historyRefreshPending=true;return\}[\s\S]*const data=await res\.json\(\);[\s\S]*if\(historyRefreshBlocked\(\)\)\{historyRefreshPending=true;return\}/);
    assert.match(page, /\/api\/native-projects\/archive/);
    assert.match(page, /function extractMemoryCitations/);
    assert.match(page, /function renderMemoryCitations/);
    assert.match(page, /group\.open=false/);
    assert.match(page, /function enhanceComposer/);
    assert.match(page, /function renderComposerProjectOptions/);
    assert.match(page, /function selectComposerProjectPath/);
    assert.match(page, /composerProjectToggle/);
    assert.match(page, /composerProjectPicker\.classList\.toggle\('hidden',hasConversation\)/);
    assert.match(page, /composerProjectPicker\.setAttribute\('aria-hidden',String\(hasConversation\)\)/);
    assert.match(page, /function enqueuePrompt/);
    assert.match(page, /function steerQueuedPrompt/);
    assert.match(page, /function showNativeSteerOptimistically/);
    assert.match(page, /kind:'steering_user'/);
    assert.match(page, /steering_browser_comment/);
    assert.doesNotMatch(page, /createBrowserCommentDetails/);
    assert.match(page, /id="archiveToggle"[^>]*>已归档任务<\/button><button id="automationToggle"[^>]*>自动化安排<\/button><\/div><button id="settingsToggle"/);
    assert.match(page, /function enhanceSubQuota/);
    assert.match(page, /subQuotaToggle\.id='subQuotaToggle'/);
    assert.match(page, /setIconLabel\(subQuotaToggle,'gauge','额度',false\)/);
    assert.match(page, /subQuotaToggle\.setAttribute\('aria-controls','subQuotaSettingsDialog'\)/);
    assert.match(page, /subQuotaPopover\.id='subQuotaPopover'/);
    assert.match(page, /subQuotaToggle\.addEventListener\('pointerenter'.*showSubQuotaPreview/);
    assert.match(page, /subQuotaToggle\.addEventListener\('pointerleave',scheduleSubQuotaPreviewHide\)/);
    assert.doesNotMatch(page, /subQuotaToggle\.addEventListener\('mouseenter'/);
    assert.doesNotMatch(page, /subQuotaToggle\.addEventListener\('mouseleave'/);
    assert.match(page, /subQuotaToggle\.addEventListener\('click',handleSubQuotaToggleClick\)/);
    assert.match(page, /function handleSubQuotaToggleClick\(event\)/);
    assert.match(page, /const coarse=isCoarsePointer\(\)\|\|event\.pointerType==='touch'/);
    assert.match(page, /手机端点一下显示额度，再点一下打开配置/);
    assert.match(page, /sourceName\.textContent=quota\.provider==='cpa-codex'\s*\? providerName/s);
    assert.doesNotMatch(page, /providerName\+\(quota\.name&&quota\.name!==providerName/);
    assert.match(page, /finiteSubQuotaNumber\(quota\.subscription\.monthly\?\.limit\)>0/);
    assert.match(page, /重置 '\+formatSubQuotaDateTime\(rateLimit\.resetAt\)/);
    assert.match(page, /if\(stale\)appendSubQuotaMeta\(meta,subQuotaStaleMetaText\(quota\)\)/);
    assert.match(page, /Console 可调用/);
    assert.match(page, /const fetchedAt=quotas\.find\(\(quota\)=>quota\?\.fetchedAt\)\?\.fetchedAt\|\|data\.fetchedAt/);
    assert.match(page, /subQuotaStatus\.textContent=subQuotaFetchedStatusText\(fetchedAt,hasStale\)/);
    assert.match(page, /if\(quota\.valid===false\)\{/);
    assert.doesNotMatch(page, /if\(quota\.valid===false&&!?stale\)/);
    assert.match(page, /subQuotaSettingsOverlay\.id='subQuotaSettingsOverlay'/);
    assert.match(page, /subQuotaSettingsDialog\.id='subQuotaSettingsDialog'/);
    assert.match(page, /titleText\.textContent='额度监控'/);
    assert.match(page, /createSubQuotaVisibilityToggle\('Codex App'\)/);
    assert.match(page, /fetch\('\/api\/codex-app-credits'/);
    assert.match(page, /codexPointsLabel\.textContent='剩余点数'/);
    assert.match(page, /codexUsdLabel\.textContent='剩余美元'/);
    assert.match(page, /codexProgress\.className='subQuotaCodexProgress hidden'/);
    assert.match(page, /const codexIdentity=createSourceIdentity\('codex-app','Codex App','','monitor'\)/);
    assert.match(page, /appendSubQuotaProgress\(progressWrap,remainingPercent\)/);
    assert.match(page, /\[remaining,availability\]\.filter\(Boolean\)\.join\(' · '\)/);
    assert.match(page, /subQuotaPrimarySource\.textContent=showCodexApp\?'Codex App':''/);
    assert.match(page, /source\.className='subQuotaSource'\+\(isCodexApp\?' subQuotaSourceCodex':''\)/);
    assert.match(page, /if\(!isCodexApp\)\{/);
    assert.doesNotMatch(page, /quota\.provider==='codex-app'\?'点数'/);
    assert.match(page, /progressWrap\.className='subQuotaCodexPreviewProgress'/);
    assert.match(page, /progressHead\.className='subQuotaCodexPreviewProgressHead'/);
    assert.match(page, /grok2ApiConsoleDialog\.id='grok2ApiConsoleDialog'/);
    assert.match(page, /fetch\('\/api\/sub-quotas\/grok2api\/console\?tail=160'/);
    assert.match(page, /setIconLabel\(syncBtn,'refresh-cw','额度同步'\)/);
    assert.match(page, /fetch\('\/api\/sub-quotas\/grok2api\/sync'/);
    assert.doesNotMatch(page, /setIconLabel\(consoleBtn,'terminal-square','控制台'\)/);
    assert.match(page, /function formatCodexAppUsdAmount\(value\)/);
    assert.match(page, /formatCodexAppUsdAmount\(dollars\)/);
    assert.match(page, /urlLabel\.textContent='上游 URL'/);
    assert.match(page, /baseUrlInput\.type='url'/);
    assert.doesNotMatch(page, /baseUrlInput\.required=true/);
    assert.match(page, /baseUrlInput\.autocomplete='url'/);
    assert.match(page, /subQuotaSettingsSourceList\.appendChild\(createSourceFields\('cpa-codex','CPA Codex'/);
    assert.match(page, /subQuotaSettingsSourceList\.appendChild\(createSourceFields\('sub2api','Sub2API'/);
    assert.match(page, /footer\.className='subQuotaSettingsFooter'/);
    assert.match(page, /subQuotaSettingsForm\.insertBefore\(inputs\.source,footer\)/);

    assert.match(page, /inputs\.baseUrlInput\.value=source\.baseUrl\|\|''/);
    assert.match(page, /source\.keyConfigured\?'Key 已配置，留空保留'/);
    assert.match(page, /正在保存额度配置…/);
    assert.match(page, /JSON\.stringify\(\{sources,order,codexAppVisible\}\)/);
    assert.match(page, /各来源独立保存，检测失败不影响配置/);
    assert.match(page, /function openSubQuotaSettings\(\)/);
    assert.match(page, /function closeSubQuotaSettings\(\)/);
    assert.match(page, /subQuotaSettingsClose\.addEventListener\('click',closeSubQuotaSettings\)/);
    assert.match(page, /event\.target===subQuotaSettingsOverlay\)closeSubQuotaSettings\(\)/);
    assert.match(page, /subQuotaSettingsOverlay[^;]*closeSubQuotaSettings\(\);return/);
    assert.doesNotMatch(page, /subQuotaToggle\.addEventListener\('click',\(\)=>openSettings/);
    assert.doesNotMatch(page, /settingsPanel\.appendChild\(subQuotaSection\)/);
    assert.match(page, /fetch\('\/api\/sub-quota-config'/);
    assert.match(page, /fetch\('\/api\/sub-quotas'/);
    assert.match(page, /!subQuotaToggle\?\.contains\(event\.target\)/);
    assert.match(page, /id="archiveView"[^>]*aria-labelledby="archiveViewTitle"/);
    assert.match(page, /id="automationView"[^>]*aria-labelledby="automationViewTitle"/);
    assert.match(page, /让 ChatGPT 安排任务、设置提醒或监测更新/);
    assert.match(page, /class="automationFormBody"/);
    assert.match(page, /id="automationName"[^>]*placeholder="已安排任务标题"/);
    assert.match(page, /id="automationPrompt"[^>]*placeholder="描述 ChatGPT 应该做什么"/);
    assert.match(page, /id="automationRunAt"[^>]*><option value="new-task">新任务/);
    assert.match(page, /id="automationCwd"[^>]*><option value="">无/);
    assert.match(page, /id="automationModel"[^>]*><option value="">默认模型/);
    assert.match(page, /id="automationReasoning"[^>]*>.*<option value="ultra">极高/s);
    assert.match(page, /id="automationFrequency"[^>]*>.*<option value="hourly">每隔数小时/s);
    assert.match(page, /id="automationDayField" class="automationSettingRow hidden"/);
    assert.match(page, /id="automationIntervalField" class="automationSettingRow hidden"/);
    assert.match(page, /class="automationTimeControl"[^>]*>.*id="automationTimeDisplay">9:00.*id="automationTime" type="time" value="09:00"/s);
    assert.match(page, /getElementById\('automationTime'\)\?\.addEventListener\('input',syncAutomationTimeDisplay\)/);
    assert.match(page, /id="automationNotification"[^>]*><option value="always">所有运行/);
    assert.match(page, /automationFrequency\?\.addEventListener\('change',syncAutomationScheduleFields\)/);
    assert.match(page, /classList\.toggle\('hidden',value==='hourly'\|\|value==='custom'\)/);
    assert.match(page, /classList\.toggle\('hidden',value!=='weekly'\)/);
    assert.match(page, /classList\.toggle\('hidden',value!=='hourly'\)/);
    assert.match(page, /notificationPolicy:document\.getElementById\('automationNotification'\)\?\.value\|\|'always'/);
    assert.match(page, /className='automationTabs'/);
    assert.match(page, /\{value:'',label:'全部'\}/);
    assert.match(page, /\{value:'ACTIVE',label:'已开启'\}/);
    assert.match(page, /\{value:'PAUSED',label:'已暂停'\}/);
    assert.match(page, /button\.setAttribute\('role','tab'\)/);
    assert.match(page, /toggle\.className='automationStateToggle '\+\(item\.status==='ACTIVE'\?'active':'paused'\)/);
    assert.match(page, /schedule\.textContent=scheduleLabel\+\(item\.status==='ACTIVE'&&item\.nextRunAt\?' · 下次运行 '/);
    assert.match(page, /button\.dataset\.accent=template\.accent/);
    assert.match(page, /icon:'file-search-2',accent:'green'/);
    assert.doesNotMatch(page, /add\.setAttribute\('data-lucide','plus'\)/);
    assert.match(page, /function createAutomationDetail/);
    assert.match(page, /automationEditingId/);
    assert.match(page, /submitLabel\.textContent=automationEditingId\?'保存更改':'创建自动化'/);
    assert.match(page, /automationFormMessage\.textContent=editing\?'正在保存更改\.\.\.':'正在创建\.\.\.'/);
    assert.match(page, /fetch\(endpoint,\{method:editing\?'PATCH':'POST'/);
    assert.match(page, /function automationEditorTemplateFromItem\(item\)/);
    assert.match(page, /parts\.FREQ==='HOURLY'\)frequency='hourly'/);
    assert.match(page, /new Set\(days\)\.size===7\)frequency='daily'/);
    assert.match(page, /days\.join\(','\)==='MO,TU,WE,TH,FR'\)frequency='weekdays'/);
    assert.match(page, /frequency=days\.length===1\?'weekly':'custom'/);
    assert.match(page, /rrule:frequency==='custom'\?automationForm\?\.dataset\.originalRrule/);
    assert.match(page, /preserveTarget:automationForm\?\.dataset\.preserveTarget==='true'/);
    assert.match(page, /fillAutomationSelect\(runAt,\[\{value:'existing-task',label:'现有任务'\}\]/);
    assert.match(page, /openAutomationEditor\(automationEditorTemplateFromItem\(item\)\)/);
    assert.match(page, /editButton\.className='automationDetailMenuAction'/);
    assert.match(page, /panel\.className='automationDetailPanel'/);
    assert.match(page, /className='automationDetailAction automationDetailMenuButton'/);
    assert.match(page, /automationDetailRepeat\(item\)/);
    assert.match(page, /automationDetailTime\(item\)/);
    assert.match(page, /selectedAutomationId=item\.id;renderAutomations\(\)/);
    assert.match(page, /loadConversation\(item\.targetThreadId,'codex'\)/);
    assert.match(page, /function openAutomationView/);
    assert.match(page, /function renderAutomations/);
    assert.match(page, /new CustomEvent\('codex-web:main-view'/);
    assert.match(page, /event\.detail\?\.view==='image-prompts'&&activeMainView!=='chat'/);
    assert.match(page, /let currentConversationTitle = '新任务'/);
    assert.match(page, /function renderTopConversationTitle\(\)/);
    assert.match(page, /function setCurrentConversationTitle\(value,fallback='新任务'\)/);
    assert.match(page, /function setMainView\(view\)\{[\s\S]*?renderTopConversationTitle\(\);\s*\}/);
    assert.match(page, /function setSideChatView\(view\)\{[\s\S]*?renderSideChatTabs\(\);\s*renderTopConversationTitle\(\)/);
    assert.match(page, /async function syncSideChatConversation\(options=\{\}\)\{[\s\S]*?if\(tab\)\{[\s\S]*?tab\.title=title;[\s\S]*?renderTopConversationTitle\(\)/);
    assert.match(page, /async function renameConversation\(id,title,source='codex'\)\{[\s\S]*?currentConversationId===id[\s\S]*?setCurrentConversationTitle\(clean\)/);
    assert.match(page, /function newChat\(\)\{[^\n]*setCurrentConversationTitle\('新任务'\)/);
    assert.match(page, /async function loadConversation\(id,source='web',options=\{\}\)\{[\s\S]*?setCurrentConversationTitle\(conversation\.title\|\|'Chat','Chat'\)/);
    assert.match(page, /async function forkNativeConversation\(messageSeq,\{continueAfter=false,trigger=null,sourceThreadId:requestedThreadId=''\}=\{\}\)\{[\s\S]*?const sourceThreadId=String\(requestedThreadId\|\|currentConversationId\|\|''\)[\s\S]*?loadConversation\(data\.threadId,'codex',\{conversation:data\.conversation,skipPromptQueueSync:true\}\)[\s\S]*?setCurrentConversationTitle\(data\.conversation\?\.title\|\|'新分支','新分支'\)/);
    assert.doesNotMatch(page, /forkNativeConversation[\s\S]{0,500}confirm\(/);
    assert.match(page, /input\.focus\(\);\s*refreshHistory\(\)\.catch\(\(\)=>\{\}\)/);
    assert.match(page, /currentConversationSource==='codex'&&!options\.skipPromptQueueSync\)await pullPromptQueueFromServer/);
    assert.match(page, /automationStatus\.textContent=automationNotice\|\|''/);
    assert.match(page, /function openArchivedView/);
    assert.match(page, /ask:\{sandbox:'workspace-write',approval:'on-request',label:'请求批准',icon:'hand'\}/);
    assert.match(page, /auto:\{sandbox:'workspace-write',approval:'on-request',label:'替我审批',icon:'shield-check'\}/);
    assert.match(page, /full:\{sandbox:'danger-full-access',approval:'never',label:'完全访问',icon:'shield-alert'\}/);
    assert.match(page, /createComposerPermissionOption\('custom','自定义 \(config\.toml\)','使用 config\.toml 中定义的权限','settings'\)/);
    assert.match(page, /options\.setAttribute\('role','radiogroup'\)/);
    assert.match(page, /option\.setAttribute\('role','radio'\)/);
    assert.match(page, /option\.setAttribute\('aria-checked',String\(selected\)\)/);
    assert.match(page, /option\.tabIndex=selected\?0:-1/);
    assert.match(page, /function composerPermissionPayload/);
    assert.match(page, /if\(mode==='custom'\)return\{permissionMode:'custom'\}/);
    assert.match(page, /input\.placeholder=[^;]*'向 Codex 提问'/);
    assert.match(page, /function renderArchivedTasks/);
    assert.match(page, /永久删除全部已归档任务/);
    assert.match(page, /function createTurnResultArtifacts/);
    assert.match(page, /function createEditedFilesResultCard/);
    assert.match(page, /function revealExpandedEditedFilesCard/);
    assert.match(page, /const delta=cardRect\.top-visibleTop;\s*if\(delta<=1\)return;\s*setNativeLiveReadingHistory\(true\)/);
    assert.match(page, /if\(!live\)card\.addEventListener\('toggle'/);
    assert.match(page, /status\.className='turnResultStatus';\s*status\.textContent='已完成'/);
    assert.match(page, /function createWebPreviewResultCard/);
    assert.match(page, /function refreshLiveEditedFilesResult/);
    assert.match(page, /createEditedFilesResultCard\(files,'',\{live:true,plan:liveTurnPlan\}\)/);
    assert.match(page, /if\(item\._subagentTrace\?\.autoTrack\)loadSubagentTrace/);
    assert.doesNotMatch(page, /currentActivityCluster\.dataset\.activityGroup!==group/);
    assert.match(page, /turnProcessTimeline\.insertBefore\(element,matched\.nextSibling\)/);
    assert.match(page, /function appendConversationElement\(element,role,options=\{\}\)/);
    assert.match(page, /appendConversationElement\(el,role,\{steering:steeringUser,hydrating:Boolean\(options\.hydrating\),turnId:options\.turnId,activeTurn:activeTurnMessage\}\)/);
    assert.doesNotMatch(page, /matched\.open=true/);
    assert.match(page, /if\(steeringUser\|\|browserCommentUser\)cleanSteeringMessageDuplicates\(el\)/);
    assert.match(page, /if\(steeringUser\)\{[\s\S]*?if\(!completedSteeringTimeline\)activateTurnProcessElement\(el\)/);
    assert.doesNotMatch(page, /pinSteeringMessageToBottom|pinOpenSteeringMessages|ensureSteeringPinObserver/);
    assert.doesNotMatch(page, /function resetTurnProcessCollection\(\)[\s\S]*?nativeOptimisticSteering\.clear\(\)[\s\S]*?function beginTurnProcessCollection/);
    assert.match(page, /function dispatchNextQueuedPrompt/);
    assert.match(page, /createTrailingSingleFlight\(syncCurrentNativeConversationOnce\)/);
    assert.match(page, /<option value="ultra">ultra<\/option>/);
    assert.match(page, /if\(!preserveProviderModel&&Object\.hasOwn\(metadata,'reasoningEffort'\)\)/);
    assert.match(page, /function rememberNativeComposerOverride\(\{pending=false,writeId=0\}=\{\}\)/);
    assert.match(page, /function syncNativeComposerSettings\(changes=\{\}\)/);
    assert.match(page, /provider\?\.addEventListener\('change',\(\)=>\{void requestComposerProviderChange\(provider\.value\)\}\)/);
    assert.match(page, /composerProviderSelect\.addEventListener\('change',\(\)=>\{void requestComposerProviderChange\(composerProviderSelect\.value\)\}\)/);
    assert.match(page, /async function changeComposerProvider\(nextProvider\)[\s\S]*?syncNativeComposerSettings\(\{provider:requestedProvider,model:model\.value\}\)/);
    assert.match(page, /const settingsReady=await syncNativeComposerSettings[\s\S]*?return settingsReady/);
    assert.match(page, /function requestComposerProviderChange\(nextProvider\)[\s\S]*?composerProviderChangePromise=pending\.catch\(\(\)=>false\)/);
    assert.match(page, /const providerReady=await waitForLatestComposerProviderChange\(\);\s*await waitForLatestComposerModelLoad\(\);\s*await nativeComposerSettingsQueue\.catch\(\(\)=>false\)/);
    assert.match(page, /const revision=\+\+modelLoadRevision[\s\S]*?revision!==modelLoadRevision/);
    assert.match(page, /modelListCache\.has\(requestedProvider\)/);
    assert.match(page, /composerModelSelect\.addEventListener\('change',\(\)=>\{\s*const previous=model\.value;[\s\S]*?composerModelSwitchConfirm\(previous,model\.value\)[\s\S]*?syncComposerChrome\(\)\}\)/);
    assert.match(page, /model\?\.addEventListener\('change',\(\)=>\{\s*if\(!composerModelSwitchConfirm\(composerModelValueBeforeChange,model\.value\)\)return;[\s\S]*?syncComposerChrome\(\)\}\)/);
    assert.match(page, /payload\.provider=String\(provider\.value\|\|''\)\.trim\(\)\|\|null/);
    assert.match(page, /reasoningEffort\?\.addEventListener\('change',\(\)=>\{void syncNativeComposerSettings\(\{reasoningEffort:reasoningEffort\.value\}\);syncComposerChrome\(\)\}\)/);
    assert.match(page, /nativeComposerOverride=\{threadId:currentConversationId,provider:[^}]*pending:Boolean\(pending\),writeId:Number\(writeId\)\|\|0\}/);
    assert.match(page, /function nativeComposerOverrideApplies\(threadId\)\{return Boolean\(nativeComposerOverride\?\.pending/);
    assert.match(page, /if\(!preserveProviderModel&&Object\.hasOwn\(metadata,'reasoningEffort'\)\)/);
    assert.match(page, /if\(!preserveProviderModel&&Object\.hasOwn\(metadata,'modelProvider'\)\)/);
    assert.match(page, /if\(!preserveProviderModel&&Object\.hasOwn\(metadata,'model'\)\)/);
    assert.match(page, /async function applyNativeConversationMetadata\(metadata/);
    assert.match(page, /if\(modelOptionsProvider!==modelProvider\|\|modelLoadInFlight\?\.provider===modelProvider\)await loadModels\(modelProvider,selectedModel\)/);
    assert.match(page, /selectComposerModel\(selectedModel\)/);
    assert.match(page, /function resetComposerProviderChange\(\)\{composerProviderChangePromise=Promise\.resolve\(true\)\}/);
    assert.match(page, /if\(conversationChanged\)\{clearNativeCancelPending\(\);resetComposerProviderChange\(\)\}/);
    assert.match(page, /clearNativeComposerOverride\(\);\s*syncComposerChrome\(\);\s*void syncCurrentNativeConversation\(\)/);
    assert.match(page, /setNativeComposerOverride\(existingId,requestedProvider,requestedModel,requestedReasoningEffort,requestedPermissionMode,requestedSandbox,requestedApproval,requestedServiceTier,\{pending:true\}\)/);
    assert.match(page, /setNativeComposerOverride\(data\.threadId,requestedProvider,requestedModel,requestedReasoningEffort,requestedPermissionMode,requestedSandbox,requestedApproval,requestedServiceTier,\{pending:true\}\)/);
    assert.match(page, /body:JSON\.stringify\(\{message,attachments,provider:requestedProvider,model:requestedModel/);
    assert.match(page, /if\(currentConversationSource==='codex'&&currentConversationId===threadId\)\{\s*setNativeComposerOverride\(threadId,item\.provider,item\.model,item\.reasoningEffort,item\.permissionMode,item\.sandbox,item\.approval,item\.serviceTier\);/);
    assert.match(page, /permissionMode:\s*composerPermissionMode/);
    assert.match(page, /\.\.\.composerPermissionPayload\(item\.permissionMode,item\.sandbox,item\.approval\)/);
    assert.match(page, /\.\.\.composerPermissionPayload\(\)/);
    assert.match(page, /for\(const control of \[provider,model,reasoningEffort\]\)control\.disabled=legacyLocked/);
    assert.match(page, /if\(webRunActive\)closeLockedComposerPopovers\(\{includePermission:legacyLocked,includeModel:legacyLocked\}\)/);
    assert.doesNotMatch(page, /if\(webRunActive\)closeComposerPopovers\(\)/);
    assert.match(page, /createComposerModelMenuRow\('model','模型'\)/);
    assert.match(page, /createComposerModelMenuRow\('reasoning','推理强度'\)/);
    assert.match(page, /createComposerModelMenuRow\('advanced','高级'\)/);
    assert.match(page, /function renderComposerReasoningSlider\(source,target=/);
    assert.match(page, /composerReasoningInline\.className='composerReasoningInline'/);
    assert.match(page, /range\.type='range';\s*range\.className='composerReasoningRange';\s*range\.min='0';\s*range\.max=String\(levels\.length-1\);\s*range\.step='1'/);
    assert.match(page, /range\.setAttribute\('aria-label','推理强度'\)/);
    assert.match(page, /range\.setAttribute\('aria-valuetext',label\)/);
    assert.match(page, /if\(kind==='reasoning'\)\{\s*renderComposerReasoningSlider\(source\);\s*return;/);
    assert.match(page, /range\.addEventListener\('input',\(\)=>\{[\s\S]*selectValue\(levels\[sliderIndex\]\.value\)/);
    assert.match(page, /source\.dispatchEvent\(new Event\('change',\{bubbles:true\}\)\)/);
    assert.match(page, /row\.button\.classList\.toggle\('active',kind===activeKind\)/);
    assert.match(page, /row\.button\.setAttribute\('aria-expanded',String\(kind===activeKind\)\)/);
    assert.match(page, /运行中修改将用于下一条消息/);
    assert.match(page, /const conversation=data\.conversation;\s*nativeHistoryNextPageLimit=normalizeNativeHistoryPageLimit\(Math\.max\([\s\S]*?Number\(conversation\.nextHistoryPageLimit\)\|\|0,[\s\S]*?\)\);\s*currentNativeRunStatus=String\(conversation\.status\|\|''\);\s*await applyNativeConversationMetadata\(conversation\.metadata\|\|\{\},\{preserveProviderModel:nativeComposerOverrideApplies\(id\)\}\);\s*if\(seq!==conversationLoadSeq\|\|currentConversationSource!=='codex'\|\|currentConversationId!==id\)return;\s*if\(deferNativeSyncForHistoryPage\(\)\)return;\s*syncComposerContextWindow\(conversation\.contextWindow\|\|null\)/);
    assert.match(page, /e\.isComposing\|\|e\.keyCode===229/);
    assert.match(page, /if\(!e\.repeat\)send\(\)/);
    assert.match(page, /function formatMessageTime/);
    assert.match(page, /function enhanceSettingsModal/);
    assert.match(page, /function openImagePreview/);
    assert.match(page, /在新任务中继续/);
    assert.match(page, /continueAfter:true/);
    assert.doesNotMatch(page, /查看原图/);
    assert.match(page, /\/api\/password/);
    assert.match(page, /codexWeb\.promptQueue\.v1/);
    assert.match(page, /inputImage/);
    assert.match(page, /boot\(true\)/);
    assert.match(page, /async function boot\(selectRecent=false\)/);
    const inlineScript = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).sort((a, b) => b.length - a.length)[0];
    assert.ok(inlineScript);
    const composerModelItemsHelper = inlineScript.match(/(function composerModelItems[\s\S]*?)(?=function selectComposerModel)/)?.[1];
    assert.ok(composerModelItemsHelper);
    const composerModelItems = new Function(`let nativeModelCatalogIds=[]; ${composerModelItemsHelper}; return composerModelItems;`)();
    assert.deepEqual(composerModelItems(['gpt-5.5', 'gpt-5.5', ''], 'retired-model'), ['gpt-5.5', 'retired-model']);
    assert.deepEqual(composerModelItems(['gpt-5.5', 'retired-model'], 'retired-model'), ['gpt-5.5', 'retired-model']);

    const providerChangeHelper = inlineScript.match(/(async function changeComposerProvider[\s\S]*?)(?=function requestComposerProviderChange)/)?.[1];
    assert.ok(providerChangeHelper);
    const buildProviderChange = (loadModels, syncNativeComposerSettings) => new Function(
      'provider',
      'model',
      'rememberNativeComposerOverride',
      'syncComposerChrome',
      'loadModels',
      'syncNativeComposerSettings',
      'clearNativeComposerOverride',
      'syncCurrentNativeConversation',
      `let currentConversationSource='codex';
       let currentConversationId='thread-a';
       let nativeComposerOverride={threadId:'thread-a',provider:'beta'};
       ${providerChangeHelper}
       return {
         changeComposerProvider,
         setConversation(source,id){currentConversationSource=source;currentConversationId=id;},
       };`,
    )(
      { value: 'alpha' },
      { value: 'beta-model' },
      () => {},
      () => {},
      loadModels,
      syncNativeComposerSettings,
      () => {},
      () => {},
    );
    let settingsWrites = 0;
    const rejectedProviderChange = buildProviderChange(
      async () => true,
      async () => { settingsWrites += 1; return false; },
    );
    assert.equal(await rejectedProviderChange.changeComposerProvider('beta'), false);
    assert.equal(settingsWrites, 1);

    let finishModelLoad;
    const movedProviderChange = buildProviderChange(
      () => new Promise((resolve) => { finishModelLoad = resolve; }),
      async () => { settingsWrites += 1; return true; },
    );
    const staleChange = movedProviderChange.changeComposerProvider('beta');
    movedProviderChange.setConversation('codex', 'thread-b');
    finishModelLoad(true);
    assert.equal(await staleChange, false);
    assert.equal(settingsWrites, 1);

    const newTaskProviderChange = buildProviderChange(async () => true, async () => {
      settingsWrites += 1;
      return false;
    });
    newTaskProviderChange.setConversation('codex', '');
    assert.equal(await newTaskProviderChange.changeComposerProvider('beta'), true);
    assert.equal(settingsWrites, 1);
    const completedRuntimeHelper = inlineScript.match(/(function isCompletedNativeRuntimeTurn[\s\S]*?)(?=function refreshPromptQueueOnResume)/)?.[1];
    assert.ok(completedRuntimeHelper);
    const isCompletedNativeRuntimeTurn = new Function(
      completedRuntimeHelper + '; return isCompletedNativeRuntimeTurn;',
    )();
    assert.equal(isCompletedNativeRuntimeTurn('turn-old', 'turn-old', ''), true);
    assert.equal(isCompletedNativeRuntimeTurn('turn-old', '', 'turn-old'), true);
    assert.equal(isCompletedNativeRuntimeTurn('turn-new', 'turn-old', 'turn-old'), false);
    assert.equal(isCompletedNativeRuntimeTurn('', 'turn-old', 'turn-old'), false);
    assert.doesNotMatch(inlineScript, /function\s+([A-Za-z_$][\w$]*)function\s+\1\b/);
    assert.doesNotThrow(() => new Function(inlineScript));
    const handoffDisplayHelper = inlineScript.match(/(function isHandoffSummaryText[\s\S]*?)(?=function isProgressStyleAssistantText)/)?.[1];
    assert.ok(handoffDisplayHelper);
    const isHandoffSummaryText = new Function(
      handoffDisplayHelper + '; return isHandoffSummaryText;',
    )();
    assert.equal(isHandoffSummaryText('Context checkpoint:\n\n**Current State**\n- Repo: /workspace'), true);
    assert.equal(isHandoffSummaryText([
      '## Goal',
      '',
      'Active goal: remove the visible scrollbar from the Codex Web sidebar while preserving scrolling.',
      '',
      '## Current State',
      '- Repo: /workspace/codex-web',
      '',
      '## Findings',
      '- Internal context is visible.',
    ].join('\n')), true);
    assert.equal(isHandoffSummaryText([
      '## Goal',
      'Ship the release.',
      '',
      '## Current State',
      'All checks passed.',
      '',
      '## Findings',
      'No blockers remain.',
    ].join('\n')), false);
    assert.equal(isHandoffSummaryText([
      '## 当前状态',
      '',
      '最新需求：目标状态条保留目标正文。',
      '当前源码仍是上一轮的极简版本。',
      '上一轮已完成并需保留：真实页面验证。',
      '',
      '## 下一步',
      '1. 补齐内部交接过滤。',
      '',
      '工作树有大量用户已有修改和备份文件，禁止清理或回滚。相关位置主要是 server.mjs。',
    ].join('\n')), true);
    assert.equal(isHandoffSummaryText([
      '## 当前状态',
      '',
      '最新需求：目标状态条已经修复，服务健康。',
      '',
      '## 下一步',
      '',
      '工作树有大量用户已有修改，因此没有清理或回滚；等待用户验收。',
    ].join('\n')), false);
    assert.equal(isHandoffSummaryText('已完成 Context checkpoint 显示修复。'), false);
    const markdownFileIconHelper = inlineScript.match(/(function markdownLocalFileIcon[\s\S]*?)(?=function decorateMarkdownLink)/)?.[1];
    assert.ok(markdownFileIconHelper);
    const markdownLocalFileIcon = new Function(
      markdownFileIconHelper + '; return markdownLocalFileIcon;',
    )();
    assert.equal(markdownLocalFileIcon('/Volumes/ikirito/docker/codex-web/server.mjs:11980'), 'file-code-2');
    assert.equal(markdownLocalFileIcon('/Volumes/ikirito/docker/codex-web/ui.css'), 'hash');
    assert.equal(markdownLocalFileIcon('/Users/ikirito/Documents/notes.md'), 'file-text');
    assert.equal(markdownLocalFileIcon('https://example.com/app.js'), '');
    assert.equal(markdownLocalFileIcon('/playground/index.html'), '');
    assert.match(inlineScript, /link\.prepend\(icon\)/);
    assert.match(uiStyles, /\.markdownBody a\.markdownFileLink\s*\{[^}]*display:\s*inline-flex;[^}]*gap:\s*3px/s);
    assert.match(uiStyles, /\.markdownFileLinkIcon\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px/s);
    const subQuotaProgressHelper = inlineScript.match(/(function subQuotaProgressPercent[\s\S]*?)(?=function appendSubQuotaWindow)/)?.[1];
    assert.ok(subQuotaProgressHelper);
    const subQuotaProgressPercent = new Function(
      subQuotaProgressHelper + '; return subQuotaProgressPercent;',
    )();
    assert.equal(subQuotaProgressPercent(74, 100, 26, '%'), 26);
    assert.equal(subQuotaProgressPercent(74, 100, null, '%'), 74);
    assert.equal(subQuotaProgressPercent(100, 100, null, '%'), 100);
    assert.equal(subQuotaProgressPercent(75, 100, 25, 'USD'), 25);
    assert.equal(subQuotaProgressPercent(null, 100, null, 'USD'), null);
    assert.equal(subQuotaProgressPercent(null, null, null, '%', true), 100);
    assert.match(inlineScript, /const displayUsed=options\.displayUsed===true\|\|windowData\.display==='used'/);
    assert.match(inlineScript, /formatSubQuotaAmount\(used,unit,fixedCurrency\)\+' \/ '\+formatSubQuotaAmount\(limit,unit,fixedCurrency\)/);
    assert.match(inlineScript, /const availabilityOnly=available&&used===null&&limit===null&&remaining===null/);
    assert.match(inlineScript, /subQuotaProgressPercent\(used,limit,displayUsed\?null:remaining,unit,availabilityOnly\)/);
    assert.match(inlineScript, /if\(availabilityOnly\)bar\.dataset\.level='available'/);
    assert.match(inlineScript, /\{displayUsed:true,showReset:true,fixedCurrency:true\}/);
    assert.match(inlineScript, /const rateLimitWindowOptions=quota\.provider==='cpa-codex'\s*\? \{displayUsed:true\}\s*: sub2ApiWindowOptions/);
    assert.match(inlineScript, /appendSubQuotaWindow\(source,label,rateLimit,rateLimit\.unit\|\|unit,rateLimitWindowOptions\)/);
    assert.match(inlineScript, /appendSubQuotaWindow\(source,subQuotaRateLimitLabel\(rateLimit\.window\),rateLimit,rateLimit\.unit\|\|unit,rateLimitWindowOptions\)/);
    assert.match(inlineScript, /bar\.dataset\.level=percent>=100\?'exhausted':percent>=80\?'warning':'normal'/);
    assert.match(inlineScript, /value.textContent='当前可用'/);
    assert.doesNotMatch(inlineScript, /用量未返回/);
    const firstFiveHourWindow = inlineScript.indexOf("if(String(rateLimit?.window||'').toLowerCase()!=='5h')continue;");
    const dailySubscriptionWindow = inlineScript.indexOf("appendSubQuotaWindow(source,'每日',daily,unit,sub2ApiWindowOptions)");
    assert.ok(firstFiveHourWindow >= 0);
    assert.ok(dailySubscriptionWindow > firstFiveHourWindow);
    assert.match(inlineScript, /const label=isSub2Api\?'5小时':subQuotaRateLimitLabel\(rateLimit\.window\)/);
    assert.match(inlineScript, /if\(isSub2ApiSubscription&&expiresAt\)appendSubQuotaExpiry\(source,expiresAt\)/);
    assert.match(uiStyles, /\.subQuotaProgressBar\[data-level="normal"\],\s*\.subQuotaProgressBar\[data-level="available"\]\s*\{[^}]*background:\s*#22c55e/s);
    assert.match(uiStyles, /\.subQuotaProgressBar\[data-level="warning"\]\s*\{[^}]*background:\s*#f97316/s);
    assert.match(uiStyles, /\.subQuotaProgressBar\[data-level="exhausted"\]\s*\{[^}]*background:\s*var\(--danger\)/s);
    const subQuotaCountdownHelper = inlineScript.match(/(function formatSubQuotaResetCountdown[\s\S]*?)(?=function refreshSubQuotaCountdowns)/)?.[1];
    assert.ok(subQuotaCountdownHelper);
    const formatSubQuotaResetCountdown = new Function(
      subQuotaCountdownHelper + '; return formatSubQuotaResetCountdown;',
    )();
    const originalDateNow = Date.now;
    Date.now = () => Date.parse('2026-07-30T15:18:00+08:00');
    try {
      assert.equal(formatSubQuotaResetCountdown('2026-07-30T19:00:00+08:00'), '3h 42m 后重置');
      assert.equal(formatSubQuotaResetCountdown('2026-08-05T00:00:00+08:00'), '5d 8h 后重置');
    } finally {
      Date.now = originalDateNow;
    }
    const subQuotaDateTimeHelper = inlineScript.match(/(function formatSubQuotaDateTime[\s\S]*?)(?=function formatSubQuotaTime)/)?.[1];
    assert.ok(subQuotaDateTimeHelper);
    const formatSubQuotaDateTime = new Function(
      subQuotaDateTimeHelper + '; return formatSubQuotaDateTime;',
    )();
    assert.equal(formatSubQuotaDateTime('2026-07-29T14:08:28'), '07/29 14:08');
    assert.equal(formatSubQuotaDateTime('invalid'), '');
    const subQuotaPreviewHelpers = inlineScript.match(/(function showSubQuotaPreview[\s\S]*?)(?=function cancelSubQuotaPreviewHide)/)?.[1];
    assert.ok(subQuotaPreviewHelpers);
    const previewClasses = new Set(['hidden']);
    const previewAttributes = new Map();
    const previewPopover = {
      classList: {
        contains: (name) => previewClasses.has(name),
        add: (name) => previewClasses.add(name),
        remove: (name) => previewClasses.delete(name),
      },
    };
    const previewToggle = {
      dataset: {},
      setAttribute: (name, value) => previewAttributes.set(name, String(value)),
    };
    let subQuotaLoads = 0;
    const subQuotaPreviewApi = new Function(
      'subQuotaPopover',
      'subQuotaToggle',
      'subQuotaSettingsOverlay',
      'cancelSubQuotaPreviewHide',
      'loadSubQuota',
      'startSubQuotaCountdowns',
      'stopSubQuotaCountdowns',
      subQuotaPreviewHelpers + '; return { showSubQuotaPreview, hideSubQuotaPreview };',
    )(
      previewPopover,
      previewToggle,
      null,
      () => {},
      async () => { subQuotaLoads += 1; },
      () => {},
      () => {},
    );
    subQuotaPreviewApi.showSubQuotaPreview();
    subQuotaPreviewApi.showSubQuotaPreview();
    assert.equal(subQuotaLoads, 1);
    assert.equal(previewClasses.has('hidden'), false);
    assert.equal(previewAttributes.get('aria-expanded'), 'true');
    assert.equal(previewToggle.dataset.previewOpen, '1');
    subQuotaPreviewApi.hideSubQuotaPreview();
    assert.equal(previewClasses.has('hidden'), true);
    assert.equal(previewAttributes.get('aria-expanded'), 'false');
    assert.equal(previewToggle.dataset.previewOpen, undefined);
    subQuotaPreviewApi.showSubQuotaPreview();
    assert.equal(subQuotaLoads, 2);
    const subQuotaStaleHelpers = inlineScript.match(/(function subQuotaStaleMetaText[\s\S]*?)(?=function renderSubQuotaError)/)?.[1];
    assert.ok(subQuotaStaleHelpers);
    const subQuotaStaleApi = new Function(
      'formatSubQuotaTime',
      subQuotaStaleHelpers + '; return { subQuotaStaleMetaText, subQuotaFetchedStatusText };',
    )((value) => value === 'stale-at' ? '10:02' : value === 'checked-at' ? '10:12' : '');
    assert.equal(
      subQuotaStaleApi.subQuotaStaleMetaText({ stale: true, fetchedAt: 'stale-at', warning: '请求超时' }),
      '刷新失败，显示 10:02 的上次数据 · 请求超时',
    );
    assert.equal(
      subQuotaStaleApi.subQuotaStaleMetaText({ stale: true, fetchedAt: 'stale-at', warning: '刷新失败：请求超时' }),
      '刷新失败，显示 10:02 的上次数据 · 请求超时',
    );
    assert.equal(subQuotaStaleApi.subQuotaStaleMetaText({ stale: true }), '刷新失败，显示上次数据');
    assert.equal(subQuotaStaleApi.subQuotaFetchedStatusText('checked-at', true), '检查于 10:12');
    assert.equal(subQuotaStaleApi.subQuotaFetchedStatusText('checked-at', false), '更新于 10:12');
    const singleFlightHelper = inlineScript.match(/(function createTrailingSingleFlight[\s\S]*?)(?=function readPromptQueues)/)?.[1];
    assert.ok(singleFlightHelper);
    const createTrailingSingleFlight = new Function(
      singleFlightHelper + '; return createTrailingSingleFlight;',
    )();
    let singleFlightRuns = 0;
    const singleFlightReleases = [];
    const runSingleFlight = createTrailingSingleFlight(async () => {
      singleFlightRuns += 1;
      await new Promise((resolve) => singleFlightReleases.push(resolve));
    });
    const firstSingleFlight = runSingleFlight();
    const joinedSingleFlight = runSingleFlight();
    assert.equal(firstSingleFlight, joinedSingleFlight);
    assert.equal(singleFlightRuns, 1);
    singleFlightReleases.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(singleFlightRuns, 2);
    singleFlightReleases.shift()();
    await firstSingleFlight;
    const composerLabelHelpers = inlineScript.match(/(function composerModelLabel[\s\S]*?)(?=function closeComposerPopovers)/)?.[1];
    assert.ok(composerLabelHelpers);
    const composerLabels = new Function(
      'reasoningEffort',
      composerLabelHelpers + '; return { composerModelLabel, composerEffortLabel, composerMaximumEffortValue };',
    )(null);
    assert.equal(composerLabels.composerModelLabel('gpt-5.6-sol'), '5.6 Sol');
    assert.equal(composerLabels.composerModelLabel('deepseek-v4-flash'), 'DeepSeek V4 Flash');
    assert.equal(composerLabels.composerModelLabel('grok-4.5'), 'Grok 4.5');
    assert.equal(composerLabels.composerEffortLabel('xhigh'), '极高');
    assert.equal(composerLabels.composerEffortLabel('ultra'), '超高');
    assert.equal(composerLabels.composerMaximumEffortValue({ options: [
      { value: '' },
      { value: 'xhigh' },
      { value: 'ultra' },
    ] }), 'ultra');
    assert.equal(composerLabels.composerMaximumEffortValue({ options: [
      { value: '' },
      { value: 'xhigh' },
      { value: 'ultra', disabled: true },
    ] }), 'xhigh');
    const elapsedTitleHelpers = inlineScript.match(/(function processedMessageTitle[\s\S]*?)(?=function clearTurnReasoningStatus)/)?.[1];
    assert.ok(elapsedTitleHelpers);
    const elapsedTitleApi = new Function(
      elapsedTitleHelpers + '; return { completionMessageTitle, turnTokenUsageLabel, liveProcessElapsedTitle, turnProcessStartTimestamp };',
    )();
    assert.equal(elapsedTitleApi.completionMessageTitle('任务完成，耗时 0.1s'), '已处理 1s');
    assert.equal(elapsedTitleApi.completionMessageTitle('任务完成，耗时 2159.6s'), '已处理 36m');
    assert.equal(elapsedTitleApi.completionMessageTitle('任务完成', 65), '已处理 1m 5s');
    assert.equal(elapsedTitleApi.turnTokenUsageLabel({ totalTokens: 12345 }), '本轮累计 12,345 tokens');
    assert.equal(elapsedTitleApi.turnTokenUsageLabel(null), '');
    assert.match(inlineScript, /const collapsible=role==='tool'\|\|role==='thinking'\|\|role==='context'/);
    assert.match(inlineScript, /function shouldCollapseUserMessage\(text\)/);
    assert.match(inlineScript, /const longUser=role==='user'&&!steeringUser&&shouldCollapseUserMessage\(text\)/);
    assert.match(inlineScript, /if\(longUser\)bindLongUserMessage\(el,body,options\.scrollContainer\|\|chat\)/);
    assert.match(inlineScript, /function automationHeartbeatDisplayText\(text\)/);
    assert.match(inlineScript, /const displayText=stripNativeUiProtocolLines\(automationHeartbeatDisplayText\(text\)\);\s*renderMessageMarkdown\(body,displayText,\{assistantArtifacts:true\}\)/);
    const heartbeatDisplayHelper = inlineScript.match(/(function automationHeartbeatDisplayText[\s\S]*?)(?=function automationInstructionDisplayText)/)?.[1];
    assert.ok(heartbeatDisplayHelper);
    class TestHeartbeatDOMParser {
      parseFromString(source) {
        const tags = ['automation_id', 'current_time_iso', 'instructions', 'decision', 'message'];
        const children = tags.flatMap((tag) => {
          const open = `<${tag}>`;
          const close = `</${tag}>`;
          const start = source.indexOf(open);
          const end = source.indexOf(close, start + open.length);
          return start >= 0 && end >= 0
            ? [{ tagName: tag, textContent: source.slice(start + open.length, end) }]
            : [];
        });
        return {
          querySelector: () => null,
          documentElement: { tagName: 'heartbeat', children },
        };
      }
    }
    const automationHeartbeatDisplayText = new Function(
      'DOMParser',
      heartbeatDisplayHelper + '; return automationHeartbeatDisplayText;',
    )(TestHeartbeatDOMParser);
    const notifyHeartbeat = '<heartbeat>\n  <automation_id>09-30-linux-do</automation_id>\n  <decision>NOTIFY</decision>\n  <message>今日阅读已完成。</message>\n</heartbeat>';
    const quietHeartbeat = notifyHeartbeat.replace('NOTIFY', 'DONT_NOTIFY').replace('今日阅读已完成。', '自动阅读仍在运行。');
    assert.equal(automationHeartbeatDisplayText('普通消息 09-30-linux-do'), '普通消息 09-30-linux-do');
    assert.equal(automationHeartbeatDisplayText(notifyHeartbeat), '今日阅读已完成。');
    assert.equal(automationHeartbeatDisplayText(quietHeartbeat), '自动阅读仍在运行。');
    assert.equal(automationHeartbeatDisplayText(`任务完成。\n\n${notifyHeartbeat}`), '任务完成。\n\n今日阅读已完成。');
    assert.equal(automationHeartbeatDisplayText(`任务完成。\n\n\`\`\`xml\n${notifyHeartbeat}\n\`\`\``), '任务完成。\n今日阅读已完成。');
    const duplicateHeartbeat = notifyHeartbeat.replace('今日阅读已完成。', '今日阅读已完成 100/100（当前 107）。');
    assert.equal(
      automationHeartbeatDisplayText(`今日阅读已完成 **100/100**（当前 **107**）。\n\n\`\`\`xml\n${duplicateHeartbeat}\n\`\`\``),
      '今日阅读已完成 100/100（当前 107）。',
    );
    const instructionDisplayHelper = inlineScript.match(/(function automationInstructionDisplayText[\s\S]*?)(?=function renderAssistantMarkdown)/)?.[1];
    assert.ok(instructionDisplayHelper);
    const automationInstructionDisplayText = new Function(
      'DOMParser',
      instructionDisplayHelper + '; return automationInstructionDisplayText;',
    )(TestHeartbeatDOMParser);
    const automationInstruction = '<heartbeat>\n  <automation_id>09-30-linux-do</automation_id>\n  <current_time_iso>2026-07-27T01:30:27.548Z</current_time_iso>\n  <instructions>每天执行完整任务。</instructions>\n</heartbeat>';
    assert.equal(automationInstructionDisplayText(automationInstruction), '每天执行完整任务。');
    assert.equal(automationInstructionDisplayText('普通用户消息 2026-07-27T01:30:27.548Z'), '普通用户消息 2026-07-27T01:30:27.548Z');
    assert.match(inlineScript, /renderMessageMarkdown\(body,automationInstructionDisplayText\(text\)\)/);
    const longUserHelpers = inlineScript.match(/(function shouldCollapseUserMessage[\s\S]*?)(?=function addMsg)/)?.[1];
    assert.ok(longUserHelpers);
    const shouldCollapseUserMessage = new Function(
      longUserHelpers + '; return shouldCollapseUserMessage;',
    )();
    assert.equal(shouldCollapseUserMessage('简短消息'), false);
    assert.equal(shouldCollapseUserMessage('x'.repeat(560)), true);
    assert.equal(shouldCollapseUserMessage(Array.from({ length: 10 }, (_, index) => `第 ${index + 1} 行 ${'内容'.repeat(14)}`).join('\n')), true);
    assert.match(uiStyles, /body \.msg\.user\s*\{[^}]*max-width:\s*min\(var\(--conversation-width\), 77%\);[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word/s);
    assert.match(uiStyles, /body \.msg\.user \> \.msgBody\s*\{[^}]*white-space:\s*pre-wrap/s);
    assert.match(uiStyles, /body \.msg\.user \.markdownBody p[^}]*overflow-wrap:\s*anywhere/s);
    assert.match(uiStyles, /body \.msg\.user\.longUserMessage:not\(\.expanded\) > \.msgBody\s*\{[^}]*max-height:\s*210px;[^}]*overflow:\s*hidden;[^}]*mask-image:\s*linear-gradient/s);
    assert.match(uiStyles, /\.longUserMessageToggle\s*\{[^}]*width:\s*100%;[^}]*border-top:\s*1px solid[^}]*font-size:\s*11\.5px/s);
    assert.equal(elapsedTitleApi.liveProcessElapsedTitle(100_000, 100_000), '已处理 0s');
    assert.equal(elapsedTitleApi.liveProcessElapsedTitle(100_000, 133_999), '已处理 33s');
    assert.equal(elapsedTitleApi.liveProcessElapsedTitle(100_000, 160_000), '已处理 1m');
    assert.equal(elapsedTitleApi.liveProcessElapsedTitle(100_000, 165_000), '已处理 1m 5s');
    assert.equal(elapsedTitleApi.turnProcessStartTimestamp('not-a-date', 100_000), 100_000);
    const elapsedLifecycleHelpers = inlineScript.match(/(function turnProcessElapsedMatches[\s\S]*?)(?=function clearTurnProcessHeader)/)?.[1];
    assert.ok(elapsedLifecycleHelpers);
    const elapsedHeader = {
      children: [],
      insertBefore(node, before) {
        node.remove?.();
        const index = this.children.indexOf(before);
        node.parentNode = this;
        this.children.splice(index >= 0 ? index : this.children.length, 0, node);
        return node;
      },
    };
    const elapsedTimeline = { parentNode: elapsedHeader };
    elapsedHeader.children.push(elapsedTimeline);
    const elapsedDocument = {
      createElement() {
        return {
          className: '',
          dataset: {},
          parentNode: null,
          textContent: '',
          remove() {
            if (!this.parentNode) return;
            const index = this.parentNode.children.indexOf(this);
            if (index >= 0) this.parentNode.children.splice(index, 1);
            this.parentNode = null;
          },
        };
      },
    };
    let elapsedTimerCallback = null;
    let nextElapsedTimer = 17;
    const clearedElapsedTimers = [];
    const elapsedLifecycleApi = new Function(
      'document',
      'setInterval',
      'clearInterval',
      'liveProcessElapsedTitle',
      'turnProcessStartTimestamp',
      'turnProcessHeader',
      'turnProcessTimeline',
      `
        let turnProcessStartedAt = 0;
        let turnProcessElapsedLabel = null;
        let turnProcessElapsedTimer = null;
        let turnProcessElapsedFrozen = false;
        let turnProcessElapsedTurnId = '';
        function ensureTurnProcessHeader() { return turnProcessHeader; }
        ${elapsedLifecycleHelpers}
        return {
          clear: clearTurnProcessElapsed,
          ensure: ensureTurnProcessElapsedRunning,
          freeze: freezeTurnProcessElapsed,
          resume: resumeTurnProcessElapsed,
          start: startTurnProcessElapsed,
          update: updateTurnProcessElapsed,
          state: () => ({ turnProcessStartedAt, turnProcessElapsedLabel, turnProcessElapsedTimer, turnProcessElapsedFrozen, turnProcessElapsedTurnId }),
        };
      `,
    )(
      elapsedDocument,
      (callback, delay) => {
        assert.equal(delay, 1000);
        elapsedTimerCallback = callback;
        return nextElapsedTimer++;
      },
      (timer) => clearedElapsedTimers.push(timer),
      elapsedTitleApi.liveProcessElapsedTitle,
      elapsedTitleApi.turnProcessStartTimestamp,
      elapsedHeader,
      elapsedTimeline,
    );
    const liveElapsed = elapsedLifecycleApi.start('', 100_000, 'turn-new');
    assert.equal(liveElapsed.className, 'liveProcessElapsed');
    assert.equal(liveElapsed.dataset.messageKind, 'live_elapsed');
    assert.equal(liveElapsed.textContent, '已处理 0s');
    assert.deepEqual(elapsedHeader.children, [liveElapsed, elapsedTimeline]);
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedTimer, 17);
    elapsedLifecycleApi.update(133_999);
    assert.equal(liveElapsed.textContent, '已处理 33s');
    elapsedLifecycleApi.freeze(133_999, 'turn-old');
    assert.deepEqual(clearedElapsedTimers, []);
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedTimer, 17);
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedFrozen, false);
    elapsedLifecycleApi.freeze(133_999, 'turn-new');
    assert.deepEqual(clearedElapsedTimers, [17]);
    assert.deepEqual(elapsedHeader.children, [liveElapsed, elapsedTimeline]);
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedTimer, null);
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedFrozen, true);
    elapsedTimerCallback();
    assert.equal(liveElapsed.textContent, '已处理 33s');
    assert.strictEqual(elapsedLifecycleApi.resume(165_000), liveElapsed);
    assert.equal(liveElapsed.textContent, '已处理 1m 5s');
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedTimer, 18);
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedFrozen, false);
    assert.strictEqual(elapsedLifecycleApi.ensure('ignored', 166_000, 'turn-new'), liveElapsed);
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedTimer, 18);
    elapsedLifecycleApi.clear();
    assert.deepEqual(clearedElapsedTimers, [17, 18]);
    assert.deepEqual(elapsedHeader.children, [elapsedTimeline]);
    assert.deepEqual(elapsedLifecycleApi.state(), {
      turnProcessStartedAt: 0,
      turnProcessElapsedLabel: null,
      turnProcessElapsedTimer: null,
      turnProcessElapsedFrozen: false,
      turnProcessElapsedTurnId: '',
    });
    const reasoningStatusHelpers = inlineScript.match(/(function clearTurnReasoningStatus[\s\S]*?)(?=function clearTurnProcessHeader)/)?.[1];
    assert.ok(reasoningStatusHelpers);
    const reasoningTimeline = {
      children: [],
      appendChild(node) {
        if (node.parentNode) {
          const currentIndex = node.parentNode.children.indexOf(node);
          if (currentIndex >= 0) node.parentNode.children.splice(currentIndex, 1);
        }
        node.parentNode = this;
        node.isConnected = true;
        this.children.push(node);
        return node;
      },
    };
    const reasoningDocument = {
      createElement() {
        return {
          className: '',
          dataset: {},
          isConnected: false,
          parentNode: null,
          remove() {
            if (!this.parentNode) return;
            const currentIndex = this.parentNode.children.indexOf(this);
            if (currentIndex >= 0) this.parentNode.children.splice(currentIndex, 1);
            this.parentNode = null;
            this.isConnected = false;
          },
        };
      },
    };
    const reasoningApi = new Function('document', 'turnProcessTimeline', `
      let turnReasoningStatus = null;
      let currentActivityCluster = null;
      function shortActivityText(value, max = 100) {
        const clean = String(value || '').replace(/\\s+/g, ' ').trim();
        return clean.length > max ? clean.slice(0, max - 3) + '...' : clean;
      }
      function ensureTurnProcessHeader() { return turnProcessTimeline; }
      function moveLiveEditedFilesResultToEnd() {}
      function clearActiveActivityReasoning() {}
      ${reasoningStatusHelpers}
      return {
        clear: clearTurnReasoningStatus,
        current: () => turnReasoningStatus,
        move: moveTurnReasoningStatusToEnd,
        shouldClear: shouldClearTurnReasoningStatus,
        shouldClearPending: shouldClearPendingActivityReasoning,
        update: updateTurnReasoningStatus,
      };
    `)(reasoningDocument, reasoningTimeline);
    const firstReasoning = reasoningApi.update('Opening browser skill for execution');
    const secondReasoning = reasoningApi.update('Refining chat view loading and display logic');
    assert.strictEqual(secondReasoning, firstReasoning);
    assert.equal(reasoningTimeline.children.length, 1);
    assert.equal(secondReasoning.textContent, 'Refining chat view loading and display logic');
    const laterTool = { isConnected: false, parentNode: null };
    reasoningTimeline.appendChild(laterTool);
    reasoningApi.move();
    assert.strictEqual(reasoningTimeline.children.at(-1), secondReasoning);
    assert.equal(reasoningApi.shouldClear('assistant', 'commentary'), true);
    assert.equal(reasoningApi.shouldClear('assistant', 'final_answer'), true);
    assert.equal(reasoningApi.shouldClear('process', 'turn_aborted'), true);
    assert.equal(reasoningApi.shouldClear('process', 'task_error'), true);
    assert.equal(reasoningApi.shouldClear('process', 'context_compacted'), false);
    assert.equal(reasoningApi.shouldClearPending('assistant', 'commentary'), false);
    assert.equal(reasoningApi.shouldClearPending('assistant', 'final_answer'), true);
    assert.equal(reasoningApi.shouldClearPending('user', 'steering_browser_comment', true), false);
    assert.equal(reasoningApi.shouldClearPending('user', 'message', false), true);
    reasoningApi.clear();
    assert.equal(reasoningTimeline.children.length, 1);
    assert.equal(reasoningApi.current(), null);
    const memoryHelper = inlineScript.match(/(function extractMemoryCitations[\s\S]*?)(?=function memoryCitationTitle)/)?.[1];
    assert.ok(memoryHelper);
    const parseMemoryCitations = new Function(memoryHelper + '; return extractMemoryCitations;')();
    assert.deepEqual(parseMemoryCitations([
      '完成。',
      '<oai-mem-citation>',
      '<citation_entries>',
      'MEMORY.md:18-26|note=[reused UI direction]',
      'rollout_summaries/2026-07-11T04-52-18-demo.md:19-37|note=[reused verification path]',
      '</citation_entries>',
      '<rollout_ids>',
      '019f4f84-ea9f-73c2-b997-deba7b4aa729',
      '</rollout_ids>',
      '</oai-mem-citation>',
    ].join('\n')), {
      markdown: '完成。',
      citations: [
        { file: 'MEMORY.md', start: 18, end: 26, note: 'reused UI direction' },
        {
          file: 'rollout_summaries/2026-07-11T04-52-18-demo.md',
          start: 19,
          end: 37,
          note: 'reused verification path',
        },
      ],
    });
    const inboxHelpers = inlineScript.match(/(function parseInboxItemDirective[\s\S]*?)(?=function extractCodeComments)/)?.[1];
    assert.ok(inboxHelpers);
    const inboxApi = new Function(
      inboxHelpers + '; return { parseInboxItemDirective, extractInboxItems };',
    )();
    assert.deepEqual(
      inboxApi.parseInboxItemDirective('::inbox-item{title="Linux.do \\"启动\\"重试已更新" summary="无响应时最多刷新重试三轮"}'),
      { title: 'Linux.do "启动"重试已更新', summary: '无响应时最多刷新重试三轮' },
    );
    assert.deepEqual(inboxApi.extractInboxItems([
      '已完成启动重试修复。',
      '',
      '::inbox-item{title="第一条" summary="摘要一"}',
      '::inbox-item{title="第二条"}',
    ].join('\n')), {
      markdown: '已完成启动重试修复。',
      items: [
        { title: '第一条', summary: '摘要一' },
        { title: '第二条', summary: '' },
      ],
    });
    assert.deepEqual(inboxApi.extractInboxItems('正文\n::inbox-item{title="缺少结束括号"'), {
      markdown: '正文\n::inbox-item{title="缺少结束括号"',
      items: [],
    });
    assert.match(inlineScript, /title\.textContent=item\.title/);
    assert.match(inlineScript, /summary\.textContent=item\.summary/);
    assert.match(uiStyles, /\.inboxItems\s*\{[^}]*width:\s*min\(520px, 100%\)/s);
    assert.match(uiStyles, /\.inboxItem\s*\{[^}]*grid-template-columns:\s*24px minmax\(0, 1fr\)[^}]*border-radius:\s*8px/s);
    const activityHelpers = inlineScript.match(/(function decodeEmbeddedToolString[\s\S]*?)(?=function toolMessageTitle)/)?.[1];
    assert.ok(activityHelpers);
    const activityApi = new Function(`${activityHelpers}; return { normalizeTurnPlanItems, toolActivityPresentations, activityClusterPresentation, activityClusterMatchesBrowserTarget, markCurrentActivityItem };`)();
    const parseToolActivity = activityApi.toolActivityPresentations;
    const semanticCluster = (activityGroup, streaming = false) => ({
      dataset: { activityGroup },
      querySelectorAll(selector) {
        if (selector === ':scope > .activityClusterItems > .activityBatch') {
          return streaming ? [{ classList: { contains: (name) => name === 'streaming' } }] : [];
        }
        return [];
      },
    });
    assert.deepEqual(activityApi.activityClusterPresentation(semanticCluster('loaded_tools')), {
      icon: 'wrench',
      text: '已加载工具',
    });
    assert.deepEqual(activityApi.activityClusterPresentation(semanticCluster('files_read')), {
      icon: 'book-open',
      text: '已读取文件',
    });
    const clusterItem = ({ verb, currentVerb = verb, target = '', icon = 'wrench', classes = [] }) => ({
      classList: { contains: (name) => classes.includes(name) },
      querySelector(selector) {
        if (selector === '.activityVerb') return { dataset: { completedVerb: verb }, textContent: currentVerb };
        if (selector === '.activityTarget') return { textContent: target };
        if (selector === '.activityItemIcon [data-lucide]') {
          return { getAttribute: (name) => name === 'data-lucide' ? icon : null };
        }
        return null;
      },
    });
    const clusterBatch = (activityGroup, items, streaming = false) => ({
      dataset: { activityGroup },
      classList: { contains: (name) => name === 'streaming' && streaming },
      querySelectorAll: (selector) => selector === '.activityItem' ? items : [],
    });
    const activityCluster = (batches, reasoning = [], rawReasoning = null) => ({
      dataset: {
        activityGroup: 'tools',
        activityReasoning: rawReasoning ?? JSON.stringify(reasoning),
      },
      querySelectorAll(selector) {
        if (selector === ':scope > .activityClusterItems > .activityBatch') return batches;
        if (selector === '.activityItem') return batches.flatMap((batch) => batch.querySelectorAll('.activityItem'));
        return [];
      },
    });
    const commandItem = () => clusterItem({
      verb: 'Ran',
      currentVerb: 'Ran',
      target: 'command',
      icon: 'square-terminal',
    });
    assert.deepEqual(activityApi.activityClusterPresentation(activityCluster([
      clusterBatch('commands', [commandItem()]),
      clusterBatch('commands', [commandItem()]),
      clusterBatch('commands', [commandItem()]),
    ])), {
      icon: 'square-terminal',
      text: '运行了多个命令',
    });
    assert.deepEqual(activityApi.activityClusterPresentation(activityCluster([
      clusterBatch('commands', [commandItem()]),
      clusterBatch('commands', [commandItem()]),
    ], ['Planning first step', 'Planning latest step'])), {
      icon: 'square-terminal',
      text: 'Planning latest step',
    });
    assert.deepEqual(activityApi.activityClusterPresentation(activityCluster([
      clusterBatch('commands', [commandItem()]),
      clusterBatch('commands', [commandItem()]),
    ], ['   '])), {
      icon: 'square-terminal',
      text: '运行了多个命令',
    });
    assert.deepEqual(activityApi.activityClusterPresentation(activityCluster([
      clusterBatch('commands', [commandItem()]),
      clusterBatch('commands', [commandItem()]),
    ], [], '{broken')), {
      icon: 'square-terminal',
      text: '运行了多个命令',
    });
    const currentItems = [{ dataset: { current: 'true' } }, { dataset: {} }];
    assert.strictEqual(activityApi.markCurrentActivityItem({
      querySelectorAll: (selector) => selector === '.activityItem' ? currentItems : [],
    }), currentItems[1]);
    assert.equal(currentItems[0].dataset.current, undefined);
    assert.equal(currentItems[1].dataset.current, 'true');
    assert.deepEqual(activityApi.activityClusterPresentation(activityCluster([
      clusterBatch('loaded_tools', [clusterItem({
        verb: '读取',
        currentVerb: '读取',
        target: 'Browser 技能',
        icon: 'wrench',
        classes: ['skillTarget'],
      })]),
      clusterBatch('commands', [commandItem(), commandItem()]),
    ])), {
      icon: 'wrench',
      text: '已加载工具并运行了多个命令',
    });
    assert.deepEqual(activityApi.activityClusterPresentation(activityCluster([
      clusterBatch('files_read', [clusterItem({
        verb: '已读取',
        currentVerb: '正在读取',
        target: '2026-07-11T04-52-18-ZaKl-codex_web',
        icon: 'book-open',
        classes: ['memoryTarget'],
      })], true),
    ])), {
      icon: 'book-open',
      text: '正在读取 2026-07-11T04-52-18-ZaKl-codex_web',
    });
    const skillClusterAfterCommentary = {
      dataset: { activityReasoning: JSON.stringify(['Opening browser skill for execution']) },
    };
    assert.equal(
      activityApi.activityClusterMatchesBrowserTarget(skillClusterAfterCommentary, 'Opening browser skill for execution'),
      true,
    );
    assert.equal(
      activityApi.activityClusterMatchesBrowserTarget({
        dataset: { activityReasoning: JSON.stringify(['Older planning title', 'Latest planning title']) },
      }, 'Older planning title'),
      true,
    );
    const skillCall = [
      'exec',
      'const result = await tools.exec_command({"cmd":"cat /tmp/plugins/browser/skills/control-in-app-browser/SKILL.md"});',
    ].join('\n');
    assert.deepEqual(parseToolActivity(skillCall), [{
      verb: '读取',
      target: 'Control In App Browser 技能',
      icon: 'wrench',
      targetType: 'skill',
      activityGroup: 'loaded_tools',
      expandable: false,
    }]);
    assert.deepEqual(parseToolActivity("exec_command\nsed -n '1,40p' server.mjs\nworkdir=/workspace"), [{
      verb: 'Ran',
      target: "sed -n '1,40p' server.mjs",
      icon: 'square-terminal',
      targetType: '',
      expandable: true,
      shell: true,
      command: "sed -n '1,40p' server.mjs",
    }]);
    assert.deepEqual(parseToolActivity('exec\nconst result = await tools.exec_command({cmd:"sed -n \'1,40p\' server.mjs", workdir:"/workspace"});'), [{
      verb: 'Ran',
      target: "sed -n '1,40p' server.mjs",
      icon: 'square-terminal',
      targetType: '',
      expandable: true,
      shell: true,
      command: "sed -n '1,40p' server.mjs",
    }]);
    assert.deepEqual(parseToolActivity('exec_command\nrg -n "menuBtn|toggleMenu" server.mjs ui.css'), [{
      verb: '已在',
      target: 'server.mjs',
      suffix: '中搜索“menuBtn|toggleMenu”',
      icon: 'search',
      targetType: 'file',
      expandable: false,
    }]);
    assert.deepEqual(parseToolActivity('spawn_agent\n{\n  "task_name": "ui_trace",\n  "fork_turns": "all"\n}'), [{
      variant: 'agent',
      agentKey: 'ui_trace',
      label: 'Ui trace',
      agentAction: 'spawn',
      status: '已开始工作',
      icon: 'flower-2',
      expandable: true,
    }]);
    assert.deepEqual(parseToolActivity('followup_task\n{\n  "target": "agent_group_final_review",\n  "message": "复核当前改动"\n}'), [{
      variant: 'agent',
      agentKey: 'agent_group_final_review',
      label: 'Agent group final review',
      agentAction: 'followup',
      status: '已更新',
      icon: 'flower-2',
      expandable: true,
    }]);
    assert.deepEqual(parseToolActivity([
      '调用工具: update_plan',
      'call_id=call-plan-1',
      '{"explanation":"同步当前进度","plan":[{"step":"拆解参考图并对照当前实页 DOM、状态与样式","status":"completed"},{"step":"实现连续工具聚合、最新运行项、Agent 自动完成与紧凑文件 pill","status":"in_progress"},{"step":"补充状态/DOM/CSS 回归测试并运行完整检查","status":"pending"}]}',
    ].join('\n')), [{
      variant: 'plan',
      explanation: '同步当前进度',
      plan: [
        { step: '拆解参考图并对照当前实页 DOM、状态与样式', status: 'completed' },
        { step: '实现连续工具聚合、最新运行项、Agent 自动完成与紧凑文件 pill', status: 'in_progress' },
        { step: '补充状态/DOM/CSS 回归测试并运行完整检查', status: 'pending' },
      ],
    }]);
    assert.deepEqual(parseToolActivity([
      'exec',
      'const result = await tools.update_plan({',
      '  explanation: "同步当前进度",',
      '  plan: [',
      '    { step: "拆解参考图并对照当前实页 DOM、状态与样式", status: "completed" },',
      '    { step: "实现连续工具聚合、最新运行项、Agent 自动完成与紧凑文件 pill", status: "in_progress" },',
      '    { step: "补充状态/DOM/CSS 回归测试并运行完整检查", status: "pending" }',
      '  ]',
      '});',
      'text(result);',
    ].join('\n')), [{
      variant: 'plan',
      explanation: '同步当前进度',
      plan: [
        { step: '拆解参考图并对照当前实页 DOM、状态与样式', status: 'completed' },
        { step: '实现连续工具聚合、最新运行项、Agent 自动完成与紧凑文件 pill', status: 'in_progress' },
        { step: '补充状态/DOM/CSS 回归测试并运行完整检查', status: 'pending' },
      ],
    }]);
    assert.deepEqual(parseToolActivity([
      'exec_command',
      'nl -ba /tmp/example-codex-home/.codex/memories/rollout_summaries/2026-07-11T04-52-18-ZaKl-codex_web.md',
    ].join('\n')), [{
      verb: '已读取',
      target: '2026-07-11T04-52-18-ZaKl-codex_web',
      icon: 'book-open',
      targetType: 'memory',
      expandable: false,
    }]);
    assert.deepEqual(parseToolActivity('调用工具: spawn_agent\ncall_id=call-1\n{"task_name":"ui_trace"}'), [{
      variant: 'agent',
      agentKey: 'ui_trace',
      label: 'Ui trace',
      agentAction: 'spawn',
      status: '已开始工作',
      icon: 'flower-2',
      expandable: true,
    }]);
    const orchestratedCall = [
      'exec',
      'const calls = await Promise.all([',
      '  tools.view_image({path:"/tmp/reference.png"}),',
      '  tools.exec_command({cmd:"sed -n \'1,40p\' server.mjs"}),',
      '  tools.exec_command({cmd:"rg -n \\"composer\\" ui.css"}),',
      ']);',
    ].join('\n');
    assert.deepEqual(parseToolActivity(orchestratedCall), [
      { verb: '已查看', target: '1 张图像', icon: 'images' },
      { verb: '已在', target: 'ui.css', suffix: '中搜索“composer”', icon: 'search', targetType: 'file', expandable: false },
      { verb: 'Ran', target: "sed -n '1,40p' server.mjs", icon: 'square-terminal', targetType: '', expandable: true, shell: true, command: "sed -n '1,40p' server.mjs" },
    ]);
    const archiveProtocolCall = [
      'exec',
      'const results = await Promise.all([',
      ...[
        "rg -n -C 6 'archive|archived|归档|unarchive' server.mjs native-sessions.mjs desktop-ipc-client.mjs",
        "sed -n '430,670p' desktop-ipc-client.mjs",
        "sed -n '4300,4660p' server.mjs",
        "sed -n '2500,2825p' server.mjs",
        "rg -n -i 'thread.*archive|archive.*thread|conversation.*archive|archived' /Applications/Codex.app/Contents/Resources | head",
      ].map((command) => '  tools.exec_command({cmd:'+JSON.stringify(command)+'}),'),
      ']);',
    ].join('\n');
    const archiveProtocolActivity = parseToolActivity(archiveProtocolCall);
    assert.deepEqual(archiveProtocolActivity.slice(0, 4), [
      {
        verb: '已在',
        target: 'server.mjs',
        suffix: '中搜索“archive|archived|归档|unarchive”',
        icon: 'search',
        targetType: 'file',
        expandable: false,
      },
      { verb: 'Ran', target: "sed -n '430,670p' desktop-ipc-client.mjs", icon: 'square-terminal', targetType: '', expandable: true, shell: true, command: "sed -n '430,670p' desktop-ipc-client.mjs" },
      { verb: 'Ran', target: "sed -n '4300,4660p' server.mjs", icon: 'square-terminal', targetType: '', expandable: true, shell: true, command: "sed -n '4300,4660p' server.mjs" },
      { verb: 'Ran', target: "sed -n '2500,2825p' server.mjs", icon: 'square-terminal', targetType: '', expandable: true, shell: true, command: "sed -n '2500,2825p' server.mjs" },
    ]);
    assert.equal(archiveProtocolActivity[4].verb, 'Ran');
    assert.equal(archiveProtocolActivity[4].icon, 'square-terminal');
    assert.equal(archiveProtocolActivity[4].expandable, true);
    assert.match(archiveProtocolActivity[4].target, /^rg -n -i/);
    const patchCall = 'exec\nconst patch = "*** Begin Patch\\n*** Update File: /workspace/server.mjs\\n-old\\n---literal-minus\\n+new\\n+++literal-plus\\n*** Update File: /workspace/ui.css\\n+added\\n*** End Patch";\ntext(await tools.apply_patch(patch));';
    assert.deepEqual(parseToolActivity(patchCall), [
      {
        verb: '已编辑',
        icon: 'pencil',
        target: 'server.mjs',
        filePath: '/workspace/server.mjs',
        added: 2,
        removed: 2,
        meta: '+2 -2',
      },
      {
        verb: '已编辑',
        icon: 'pencil',
        target: 'ui.css',
        filePath: '/workspace/ui.css',
        added: 1,
        removed: 0,
        meta: '+1 -0',
      },
    ]);
    const falseImagePatchCall = 'exec\nconst patch = "*** Begin Patch\\n*** Update File: /workspace/fake-ui.js\\n+tools.view_image({path:\\"/tmp/not-a-real-image.png\\"})\\n*** End Patch";\ntext(await tools.apply_patch(patch));';
    assert.deepEqual(parseToolActivity(falseImagePatchCall), [
      {
        verb: '已编辑',
        icon: 'pencil',
        target: 'fake-ui.js',
        filePath: '/workspace/fake-ui.js',
        added: 1,
        removed: 0,
        meta: '+1 -0',
      },
    ]);

    const editedFilesHelper = inlineScript.match(
      /(function editedFilesFromTurnArtifacts[\s\S]*?)(?=function browserPreviewFromTurnArtifacts)/,
    )?.[1];
    assert.ok(editedFilesHelper);
    const editedFilesFromTurnArtifacts = new Function(
      editedFilesHelper + '; return editedFilesFromTurnArtifacts;',
    )();
    const editedItem = {
      dataset: { filePath: '/workspace/server.mjs' },
      querySelector(selector) {
        if (selector === '.activityVerb') return { dataset: { completedVerb: '已编辑' } };
        if (selector === '.activityTarget') return { textContent: 'server.mjs' };
        if (selector === '.activityMeta') return { textContent: '+12 -3' };
        return null;
      },
    };
    assert.deepEqual(editedFilesFromTurnArtifacts([{
      matches: () => false,
      querySelectorAll: () => [editedItem],
    }]), [{ name: '/workspace/server.mjs', verb: '已编辑', added: 12, removed: 3 }]);
    const sameBasenameItem = {
      dataset: { filePath: '/workspace/test/server.mjs' },
      querySelector(selector) {
        if (selector === '.activityVerb') return { dataset: { completedVerb: '已编辑' } };
        if (selector === '.activityTarget') return { textContent: 'server.mjs' };
        if (selector === '.activityMeta') return { textContent: '+4 -1' };
        return null;
      },
    };
    assert.deepEqual(editedFilesFromTurnArtifacts([{
      matches: () => false,
      querySelectorAll: () => [editedItem, sameBasenameItem],
    }]), [
      { name: '/workspace/server.mjs', verb: '已编辑', added: 12, removed: 3 },
      { name: '/workspace/test/server.mjs', verb: '已编辑', added: 4, removed: 1 },
    ]);

    const browserPreviewHelper = inlineScript.match(
      /(function browserPreviewFromTurnArtifacts[\s\S]*?)(?=function createResultCardButton)/,
    )?.[1];
    assert.ok(browserPreviewHelper);
    const browserPreviewFromTurnArtifacts = new Function(
      browserPreviewHelper + '; return browserPreviewFromTurnArtifacts;',
    )();
    assert.deepEqual(browserPreviewFromTurnArtifacts([{
      dataset: {
        messageText: [
          'mcp__node_repl__js',
          'await tab.goto("http://127.0.0.1:36354/demo")',
          'await tab.playwright.domSnapshot()',
          'const docs = "https://example.com/unrelated"',
        ].join('\n'),
      },
      querySelectorAll: () => [],
    }]), {
      url: 'http://127.0.0.1:36354/demo',
      label: '127.0.0.1:36354/demo',
    });
    assert.equal(browserPreviewFromTurnArtifacts([{
      dataset: {
        messageText: 'mcp__node_repl__js\nawait browser.documentation()\nconst docs = "https://example.com/docs"',
      },
      querySelectorAll: () => [],
    }]), null);

    class FixtureElement {
      constructor(tagName) {
        this.tagName = String(tagName).toUpperCase();
        this.children = [];
        this.dataset = {};
        this.attributes = new Map();
        this.className = '';
        this.open = false;
      }

      appendChild(child) {
        if (child.parentNode) {
          const previousIndex = child.parentNode.children.indexOf(child);
          if (previousIndex >= 0) child.parentNode.children.splice(previousIndex, 1);
        }
        this.children.push(child);
        child.parentNode = this;
        return child;
      }

      insertBefore(child, before) {
        if (child.parentNode) {
          const previousIndex = child.parentNode.children.indexOf(child);
          if (previousIndex >= 0) child.parentNode.children.splice(previousIndex, 1);
        }
        const index = this.children.indexOf(before);
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
        child.parentNode = this;
        return child;
      }

      get classList() {
        const element = this;
        const values = () => new Set(String(element.className || '').split(/\s+/).filter(Boolean));
        const write = (items) => { element.className = [...items].join(' '); };
        return {
          contains(name) { return values().has(name); },
          add(name) { const items = values(); items.add(name); write(items); },
          remove(name) { const items = values(); items.delete(name); write(items); },
          toggle(name, force) {
            const items = values();
            const enabled = force === undefined ? !items.has(name) : Boolean(force);
            if (enabled) items.add(name); else items.delete(name);
            write(items);
            return enabled;
          },
        };
      }

      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      }

      addEventListener() {}
    }
    const activityDomHelpers = inlineScript.match(
      /(function createActivityImageGallery[\s\S]*?)(?=const SUBAGENT_TRACE_POLL_MS)/,
    )?.[1];
    assert.ok(activityDomHelpers);
    const activityDomApi = new Function(
      'document',
      'openImagePreview',
      'refreshIcons',
      'setIconLabel',
      `let pendingAgentActivityBatches = []; ${activityDomHelpers}; return { createToolActivityItem, createActivityBatch, createAgentActivityGroup, appendAgentActivityBatch, updateAgentActivityGroupStatus, isAgentActivityOutput, queueAgentActivityBatch, takePendingAgentActivityBatch };`,
    )(
      { createElement: (tagName) => new FixtureElement(tagName) },
      () => {},
      () => {},
      () => {},
    );
    const { createToolActivityItem } = activityDomApi;
    const imageActivity = createToolActivityItem({
      verb: '已查看',
      target: '1 张图像',
      icon: 'image',
      expandable: true,
      galleryOnly: true,
      imageUrls: ['/api/native-sessions/thread/tool-images/7/1'],
    }, 'exec\nreal image call');
    const activityNodes = (node) => [node, ...node.children.flatMap(activityNodes)];
    const turnPlanProgressHelper = inlineScript.match(
      /(function turnPlanProgress[\s\S]*?)(?=function upsertLiveTurnPlan)/,
    )?.[1];
    assert.ok(turnPlanProgressHelper);
    const turnPlanDomApi = new Function(
      'normalizeTurnPlanItems',
      turnPlanProgressHelper + '; return { turnPlanProgress };',
    )(
      activityApi.normalizeTurnPlanItems,
    );
    const referencePlan = [
      { step: '拆解参考图并对照当前实页 DOM、状态与样式', status: 'completed' },
      { step: '实现连续工具聚合、最新运行项、Agent 自动完成与紧凑文件 pill', status: 'in_progress' },
      { step: '补充状态/DOM/CSS 回归测试并运行完整检查', status: 'pending' },
      { step: '重启本地服务并在桌面、375px、345px 深浅主题验收', status: 'pending' },
      { step: '提交、推送到 PR #12 并等待 CI', status: 'pending' },
    ];
    assert.deepEqual(turnPlanDomApi.turnPlanProgress(referencePlan), {
      items: referencePlan,
      total: 5,
      current: 2,
      completed: 1,
      percent: 40,
    });
    const upsertLiveTurnPlanHelper = inlineScript.match(
      /(function upsertLiveTurnPlan[\s\S]*?)(?=function appendTurnTool)/,
    )?.[1];
    assert.ok(upsertLiveTurnPlanHelper);
    const planTransparencyApi = new Function('normalizeTurnPlanItems', `
      const toolCluster = { kind: 'tool-cluster' };
      const agentGroup = { kind: 'agent-group' };
      const livePill = { kind: 'live-pill' };
      let currentActivityCluster = toolCluster;
      let currentAgentActivityGroup = agentGroup;
      let pendingActivityReasoning = ['kept reasoning'];
      let liveTurnPlan = [];
      let ensureCalls = 0;
      let refreshCalls = 0;
      let moveCalls = 0;
      function ensureTurnProcessHeader() { ensureCalls += 1; }
      function refreshLiveEditedFilesResult() { refreshCalls += 1; return livePill; }
      function moveLiveEditedFilesResultToEnd() { moveCalls += 1; }
      ${upsertLiveTurnPlanHelper}
      return {
        run: upsertLiveTurnPlan,
        state: () => ({
          currentActivityCluster,
          currentAgentActivityGroup,
          pendingActivityReasoning,
          liveTurnPlan,
          ensureCalls,
          refreshCalls,
          moveCalls,
          toolCluster,
          agentGroup,
          livePill,
        }),
      };
    `)(activityApi.normalizeTurnPlanItems);
    assert.strictEqual(planTransparencyApi.run(referencePlan), planTransparencyApi.state().livePill);
    const transparentPlanState = planTransparencyApi.state();
    assert.strictEqual(transparentPlanState.currentActivityCluster, transparentPlanState.toolCluster);
    assert.strictEqual(transparentPlanState.currentAgentActivityGroup, transparentPlanState.agentGroup);
    assert.deepEqual(transparentPlanState.pendingActivityReasoning, ['kept reasoning']);
    assert.deepEqual(transparentPlanState.liveTurnPlan, referencePlan);
    assert.equal(transparentPlanState.ensureCalls, 1);
    assert.equal(transparentPlanState.refreshCalls, 1);
    assert.equal(transparentPlanState.moveCalls, 1);
    const renderedActivityNodes = activityNodes(imageActivity);
    assert.equal(imageActivity.tagName, 'DETAILS');
    assert.equal(imageActivity.open, false);
    assert.equal(renderedActivityNodes.filter((node) => node.className.includes('activityImageGallery')).length, 1);
    assert.equal(renderedActivityNodes.filter((node) => node.className === 'activityRaw').length, 0);
    assert.equal(renderedActivityNodes.filter((node) => node.className === 'activityItemChevron').length, 1);
    assert.equal(renderedActivityNodes.find((node) => node.tagName === 'IMG').src, '/api/native-sessions/thread/tool-images/7/1');

    const agentActivity = createToolActivityItem({
      variant: 'agent',
      agentKey: 'ui_trace',
      label: 'Ui trace',
      status: '已开始工作',
      icon: 'flower-2',
      expandable: true,
    }, 'spawn_agent\n{"task_name":"ui_trace"}', true, { parentThreadId: nativeSessionId });
    const agentActivityNodes = activityNodes(agentActivity);
    assert.equal(agentActivity.tagName, 'DETAILS');
    assert.equal(agentActivity.open, false);
    assert.equal(agentActivity.className, 'activityItem agentActivityItem');
    assert.equal(agentActivity.dataset.agentKey, 'ui_trace');
    assert.equal(agentActivity.dataset.parentThreadId, nativeSessionId);
    assert.equal(agentActivityNodes.find((node) => node.className === 'agentActivityLabel').textContent, 'Ui trace');
    assert.equal(agentActivityNodes.find((node) => node.className === 'agentActivityStatus').textContent, '正在启动');
    assert.equal(agentActivityNodes.find((node) => node.className === 'agentActivityIcon').children[0].attributes.get('data-lucide'), 'flower-2');
    assert.equal(agentActivityNodes.filter((node) => node.className.includes('subagentTraceTimeline')).length, 1);
    assert.equal(agentActivityNodes.filter((node) => node.className.includes('agentActivityChevron')).length, 1);

    const agentPresentation = (agentKey, label) => ({
      variant: 'agent',
      agentKey,
      label,
      status: '已开始工作',
      icon: 'flower-2',
      expandable: true,
    });
    const firstAgentBatch = activityDomApi.createActivityBatch(
      [agentPresentation('final_diff_review', 'Final diff review')],
      'spawn_agent\n{"task_name":"final_diff_review"}',
      'agent_activity',
      true,
      { parentThreadId: nativeSessionId },
    );
    const secondAgentBatch = activityDomApi.createActivityBatch(
      [agentPresentation('final_ui_review', 'Final ui review')],
      'spawn_agent\n{"task_name":"final_ui_review"}',
      'agent_activity',
      true,
      { parentThreadId: nativeSessionId },
    );
    const agentGroup = activityDomApi.createAgentActivityGroup();
    activityDomApi.appendAgentActivityBatch(agentGroup, firstAgentBatch);
    activityDomApi.appendAgentActivityBatch(agentGroup, secondAgentBatch);
    assert.equal(agentGroup.className, 'msg agentActivityGroup streaming');
    assert.deepEqual(agentGroup.children, [firstAgentBatch, secondAgentBatch, agentGroup._agentActivityStatus]);
    assert.equal(agentGroup._agentActivityItems.length, 2);
    assert.equal(agentGroup._agentActivityStatus.textContent, '正在启动');
    assert.equal(agentGroup._agentActivityStatus.attributes.get('role'), 'status');
    assert.equal(activityDomApi.isAgentActivityOutput('spawn_agent output\n{"task_name":"/root/final_diff_review"}'), true);
    assert.equal(activityDomApi.isAgentActivityOutput('followup_task output\n{"target":"/root/final_diff_review"}'), true);
    assert.equal(activityDomApi.isAgentActivityOutput('exec output\n[]'), false);
    activityDomApi.queueAgentActivityBatch(firstAgentBatch);
    activityDomApi.queueAgentActivityBatch(secondAgentBatch);
    assert.strictEqual(activityDomApi.takePendingAgentActivityBatch(), firstAgentBatch);
    firstAgentBatch.classList.remove('streaming');
    assert.strictEqual(activityDomApi.takePendingAgentActivityBatch(), secondAgentBatch);
    for (const item of agentGroup._agentActivityItems) item.dataset.traceState = 'ready';
    firstAgentBatch.classList.remove('streaming');
    secondAgentBatch.classList.remove('streaming');
    activityDomApi.updateAgentActivityGroupStatus(agentGroup);
    assert.equal(agentGroup.className, 'msg agentActivityGroup');
    assert.equal(agentGroup._agentActivityStatus.textContent, '已开始工作');

    const editedFilesCardHelper = inlineScript.match(
      /(function createEditedFilesResultCard[\s\S]*?)(?=function moveLiveEditedFilesResultToEnd)/,
    )?.[1];
    assert.ok(editedFilesCardHelper);
    const createEditedFilesResultCard = new Function(
      'document',
      'createResultCardButton',
      'prepareUndoEditedFiles',
      'reviewTurnArtifacts',
      'turnPlanProgress',
      editedFilesCardHelper + '; return createEditedFilesResultCard;',
    )(
      { createElement: (tagName) => new FixtureElement(tagName) },
      () => new FixtureElement('button'),
      () => {},
      () => {},
      turnPlanDomApi.turnPlanProgress,
    );
    const compactEditedFiles = createEditedFilesResultCard([
      { name: '/workspace/ui.css', verb: '已编辑', added: 1, removed: 1 },
      { name: '/workspace/server.mjs', verb: '已编辑', added: 1, removed: 1 },
    ], '', { live: true });
    const compactEditedNodes = activityNodes(compactEditedFiles);
    assert.equal(compactEditedFiles.tagName, 'DETAILS');
    assert.equal(compactEditedFiles.className, 'turnResultCard editedFilesResult live');
    assert.equal(compactEditedFiles.attributes.get('aria-label'), '2 个文件已更改');
    assert.equal(compactEditedFiles.children[0].tagName, 'SUMMARY');
    assert.equal(compactEditedNodes.find((node) => node.tagName === 'STRONG').textContent, '2 个文件已更改');
    assert.equal(compactEditedNodes.find((node) => node.className === 'turnResultStat added').textContent, '+2');
    assert.equal(compactEditedNodes.find((node) => node.className === 'turnResultStat removed').textContent, '-2');
    assert.equal(compactEditedNodes.some((node) => node.className === 'turnResultStatus'), false);
    assert.equal(compactEditedNodes.some((node) => node.className === 'turnResultActions'), false);
    const completedEditedFiles = createEditedFilesResultCard([
      { name: '/workspace/ui.css', verb: '已编辑', added: 2, removed: 1 },
    ], '', { live: false });
    const completedEditedNodes = activityNodes(completedEditedFiles);
    assert.equal(completedEditedFiles.className, 'turnResultCard editedFilesResult');
    assert.equal(completedEditedNodes.find((node) => node.className === 'turnResultStatus').textContent, '已完成');
    const planProgressCard = createEditedFilesResultCard([
      { name: '/workspace/ui.css', verb: '已编辑', added: 370, removed: 92 },
      { name: '/workspace/server.mjs', verb: '已编辑', added: 0, removed: 0 },
      { name: '/workspace/test/server-smoke.test.mjs', verb: '已编辑', added: 0, removed: 0 },
    ], '', { live: true, plan: referencePlan });
    const planProgressNodes = activityNodes(planProgressCard);
    assert.equal(planProgressCard.className, 'turnResultCard editedFilesResult live withPlan');
    assert.equal(planProgressCard.attributes.get('aria-label'), '第 2 / 5 步，3 个文件已更改');
    assert.equal(planProgressNodes.find((node) => node.className === 'turnPlanProgressLabel').textContent, '第 2 / 5 步');
    assert.equal(planProgressNodes.find((node) => node.className === 'turnPlanProgressRing').attributes.get('style'), '--turn-plan-progress:40%');
    assert.equal(planProgressNodes.find((node) => node.className === 'turnResultFileLabel').textContent, '3 个文件已更改');
    assert.equal(planProgressNodes.find((node) => node.className === 'turnResultStat added').textContent, '+370');
    assert.equal(planProgressNodes.find((node) => node.className === 'turnResultStat removed').textContent, '-92');
    const planOnlyProgressCard = createEditedFilesResultCard([], '', { live: true, plan: referencePlan });
    assert.equal(planOnlyProgressCard.tagName, 'DIV');
    assert.equal(planOnlyProgressCard.className, 'turnResultCard editedFilesResult live withPlan planOnly');
    assert.equal(planOnlyProgressCard.children.length, 1);
    assert.equal(planOnlyProgressCard.children[0].tabIndex, 0);
    const planTooltip = planOnlyProgressCard.children[0].children.find((node) => node.className === 'turnPlanTooltip');
    assert.ok(planTooltip);
    assert.equal(planTooltip.attributes.has('role'), false);
    assert.deepEqual(planTooltip.children.map((node) => node.children.find((child) => child.className === 'turnPlanTooltipText')?.textContent), referencePlan.map((item) => item.step));

    const revealEditedFilesHelper = inlineScript.match(
      /(function revealExpandedEditedFilesCard[\s\S]*?)(?=function createEditedFilesResultCard)/,
    )?.[1];
    assert.ok(revealEditedFilesHelper);
    const revealScrollCalls = [];
    const revealFollowStates = [];
    const revealExpandedEditedFilesCard = new Function(
      'chat',
      'setNativeLiveReadingHistory',
      revealEditedFilesHelper + '; return revealExpandedEditedFilesCard;',
    )(
      {
        scrollTop: 400,
        getBoundingClientRect: () => ({ top: 100 }),
        scrollTo: (options) => revealScrollCalls.push(options),
      },
      (value) => revealFollowStates.push(value),
    );
    const expandedEditedCard = {
      open: true,
      isConnected: true,
      getBoundingClientRect: () => ({ top: 520 }),
    };
    revealExpandedEditedFilesCard(expandedEditedCard);
    assert.deepEqual(revealFollowStates, [true]);
    assert.deepEqual(revealScrollCalls, [{ top: 808, behavior: 'smooth' }]);
    expandedEditedCard.open = false;
    revealExpandedEditedFilesCard(expandedEditedCard);
    assert.equal(revealScrollCalls.length, 1);

    const liveResultHelpers = inlineScript.match(
      /(function moveLiveEditedFilesResultToEnd[\s\S]*?)(?=function createWebPreviewResultCard)/,
    )?.[1];
    assert.ok(liveResultHelpers);
    const detachLiveNode = (node) => {
      if (!node.parentNode) return;
      const previousIndex = node.parentNode.children.indexOf(node);
      if (previousIndex >= 0) node.parentNode.children.splice(previousIndex, 1);
    };
    const liveTimeline = {
      children: [],
      appendChild(node) {
        detachLiveNode(node);
        node.parentNode = this;
        node.isConnected = true;
        this.children.push(node);
        return node;
      },
      replaceChild(next, previous) {
        const index = this.children.indexOf(previous);
        assert.notEqual(index, -1);
        previous.parentNode = null;
        previous.isConnected = false;
        next.parentNode = this;
        next.isConnected = true;
        this.children.splice(index, 1, next);
        return previous;
      },
    };
    const livePromptQueuePanel = { kind: 'prompt-queue', parentNode: null, isConnected: true };
    const liveAttachmentTray = { kind: 'attachment-tray', parentNode: null, isConnected: true };
    const liveDropZone = { kind: 'drop-zone', parentNode: null, isConnected: true, children: [] };
    let liveComposerInsertCalls = 0;
    const liveComposer = {
      // Match enhanceComposer(): queue, attachment tray, then input capsule.
      children: [livePromptQueuePanel, liveAttachmentTray, liveDropZone],
      insertBefore(node, reference) {
        liveComposerInsertCalls += 1;
        assert.strictEqual(reference, livePromptQueuePanel);
        detachLiveNode(node);
        const index = this.children.indexOf(reference);
        assert.notEqual(index, -1);
        node.parentNode = this;
        node.isConnected = true;
        this.children.splice(index, 0, node);
        return node;
      },
      replaceChild(next, previous) {
        const index = this.children.indexOf(previous);
        assert.notEqual(index, -1);
        previous.parentNode = null;
        previous.isConnected = false;
        next.parentNode = this;
        next.isConnected = true;
        this.children.splice(index, 1, next);
        return previous;
      },
    };
    livePromptQueuePanel.parentNode = liveComposer;
    liveAttachmentTray.parentNode = liveComposer;
    liveDropZone.parentNode = liveComposer;
    const toolArtifact = { kind: 'tool-artifact' };
    const liveElements = [toolArtifact];
    const createdLiveCards = [];
    const makeLiveCard = (files, turnId, options) => {
      const card = {
        files,
        turnId,
        options,
        parentNode: null,
        isConnected: false,
        get nextSibling() {
          if (!this.parentNode) return null;
          const index = this.parentNode.children.indexOf(this);
          return this.parentNode.children[index + 1] || null;
        },
        remove() {
          if (!this.parentNode) return;
          const index = this.parentNode.children.indexOf(this);
          if (index >= 0) this.parentNode.children.splice(index, 1);
          this.parentNode = null;
          this.isConnected = false;
        },
      };
      createdLiveCards.push(card);
      return card;
    };
    const liveResultApi = new Function(
      'turnProcessTimeline',
      'turnProcessElements',
      'editedFilesFromTurnArtifacts',
      'createEditedFilesResultCard',
      'refreshIcons',
      'initialPlan',
      'composer',
      'dropZone',
      'promptQueuePanel',
      'attachmentTray',
      `
        let liveEditedFilesResult = null;
        let liveTurnPlan = initialPlan;
        ${liveResultHelpers}
        return {
          refresh: refreshLiveEditedFilesResult,
          state: () => ({ liveEditedFilesResult, liveTurnPlan, turnProcessElements }),
        };
      `,
    )(
      liveTimeline,
      liveElements,
      (elements) => {
        assert.strictEqual(elements, liveElements);
        return [{ name: '/workspace/server.mjs', verb: '已编辑', added: 2, removed: 1 }];
      },
      makeLiveCard,
      () => {},
      referencePlan,
      liveComposer,
      liveDropZone,
      livePromptQueuePanel,
      liveAttachmentTray,
    );
    const firstLivePill = liveResultApi.refresh();
    const secondLivePill = liveResultApi.refresh();
    assert.notStrictEqual(firstLivePill, secondLivePill);
    assert.deepEqual(liveTimeline.children, []);
    assert.deepEqual(liveComposer.children, [secondLivePill, livePromptQueuePanel, liveAttachmentTray, liveDropZone]);
    assert.strictEqual(secondLivePill.parentNode, liveComposer);
    assert.strictEqual(secondLivePill.nextSibling, livePromptQueuePanel);
    assert.ok(liveComposer.children.indexOf(secondLivePill) < liveComposer.children.indexOf(livePromptQueuePanel));
    assert.ok(liveComposer.children.indexOf(livePromptQueuePanel) < liveComposer.children.indexOf(liveAttachmentTray));
    assert.ok(liveComposer.children.indexOf(liveAttachmentTray) < liveComposer.children.indexOf(liveDropZone));
    assert.strictEqual(livePromptQueuePanel.parentNode, liveComposer);
    assert.equal(liveComposerInsertCalls, 1);
    assert.deepEqual(liveResultApi.state().turnProcessElements, [toolArtifact]);
    assert.equal(liveResultApi.state().turnProcessElements.includes(secondLivePill), false);
    assert.equal(createdLiveCards.length, 2);
    assert.deepEqual(createdLiveCards.at(-1).options, { live: true, plan: referencePlan });
    assert.match(inlineScript, /const anchor=promptQueuePanel\?\.parentNode===composer\?promptQueuePanel:dropZone/);
    assert.match(inlineScript, /composer\.insertBefore\(liveEditedFilesResult,anchor\)/);
    assert.match(inlineScript, /card\.addEventListener\('toggle',[\s\S]*?revealExpandedEditedFilesCard\(card\)/);
    assert.match(inlineScript, /if\(files\.length\)container\.appendChild\(createEditedFilesResultCard\(files,turnId\)\)/);

    const searchActivity = createToolActivityItem({
      verb: '已在',
      target: 'server.mjs',
      suffix: '中搜索“archive”',
      icon: 'search',
      targetType: 'file',
      expandable: false,
    }, 'exec\nsearch archive');
    const searchActivityNodes = activityNodes(searchActivity);
    assert.equal(searchActivity.className, 'activityItem static fileTarget');
    assert.equal(searchActivityNodes.find((node) => node.className === 'activityTarget').textContent, 'server.mjs');
    assert.equal(searchActivityNodes.find((node) => node.className === 'activitySuffix').textContent, '中搜索“archive”');

    const configResponse = await fetch(`${baseUrl}/api/config`, { headers: { Cookie: cookie } });
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json();
    assert.equal(config.defaults.model, 'test-model');
    assert.equal(config.defaults.reasoningEffort, 'max');
    assert.equal(config.defaults.serviceTier, null);
    assert.equal(config.capabilities.manageProviders, false);
    assert.equal(config.appearance.chatBackground, 'default');
    assert.deepEqual(config.pinnedThreadIds, [nativeSessionId, archivedNativeSessionId]);

    const modelCapabilitiesResponse = await fetch(`${baseUrl}/api/native-model-capabilities`, {
      headers: { Cookie: cookie },
    });
    assert.equal(modelCapabilitiesResponse.status, 200);
    assert.match(modelCapabilitiesResponse.headers.get('cache-control'), /no-store/);
    const modelCapabilities = await modelCapabilitiesResponse.json();
    assert.equal(modelCapabilities.ok, true);
    assert.equal(modelCapabilities.models.length, 2);
    assert.equal(modelCapabilities.models.every((entry) => typeof entry.displayName === 'string' && entry.displayName), true);
    assert.equal(modelCapabilities.models.find((entry) => entry.id === 'test-model')?.displayName, 'Test model');
    assert.equal(
      modelCapabilities.models
        .find((entry) => entry.id === 'test-model')
        ?.serviceTiers.some((tier) => tier.id === 'priority'),
      true,
    );
    assert.equal(
      modelCapabilities.models
        .find((entry) => entry.id === 'standard-only-model')
        ?.serviceTiers.some((tier) => tier.id === 'priority'),
      false,
    );

    const playgroundConfigResponse = await fetch(`${baseUrl}/api/playground-config`, {
      headers: { Cookie: cookie },
    });
    assert.equal(playgroundConfigResponse.status, 200);
    assert.match(playgroundConfigResponse.headers.get('cache-control'), /private, no-store/);
    const playgroundConfig = await playgroundConfigResponse.json();
    assert.doesNotMatch(JSON.stringify(playgroundConfig), /test-token/);
    assert.deepEqual(playgroundConfig, {
      profile: {
        id: 'codex-web-default',
        name: 'Codex Image · Fake',
        provider: 'openai',
        baseUrl: `${providerBaseUrl}/v1`,
        model: 'gpt-image-2',
        timeout: 660,
        apiMode: 'images',
        codexCli: true,
        apiProxy: true,
        streamImages: true,
        streamPartialImages: 3,
      },
      profiles: [
        {
          id: 'codex-web-default',
          name: 'Codex Image · Fake',
          provider: 'openai',
          baseUrl: `${providerBaseUrl}/v1`,
          model: 'gpt-image-2',
          timeout: 660,
          apiMode: 'images',
          codexCli: true,
          apiProxy: true,
          streamImages: true,
          streamPartialImages: 3,
        },
        {
          id: 'codex-web-agent',
          name: 'Codex Agent · Fake',
          provider: 'openai',
          baseUrl: `${providerBaseUrl}/v1`,
          model: 'test-model',
          timeout: 660,
          apiMode: 'responses',
          codexCli: false,
          apiProxy: true,
          streamImages: true,
          streamPartialImages: 3,
        },
      ],
      allowedOrigins: [providerBaseUrl, customProviderBaseUrl],
      agentApiConfigMode: 'hybrid',
      agentTextProfileId: 'codex-web-agent',
      agentImageProfileId: 'codex-web-default',
    });
    const uploadedHtmlResponse = await fetch(`${baseUrl}/api/uploads/file`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'active-content.html',
        type: 'text/html',
        data: `data:text/html;base64,${Buffer.from('<script>document.body.dataset.executed="true"</script>').toString('base64')}`,
      }),
    });
    assert.equal(uploadedHtmlResponse.status, 200);
    const uploadedHtml = (await uploadedHtmlResponse.json()).attachment;
    const downloadedHtmlResponse = await fetch(`${baseUrl}${uploadedHtml.url}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(downloadedHtmlResponse.status, 200);
    assert.match(downloadedHtmlResponse.headers.get('content-disposition') || '', /^attachment;/);
    assert.equal(downloadedHtmlResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.match(downloadedHtmlResponse.headers.get('cache-control') || '', /private, no-store/);
    assert.match(await downloadedHtmlResponse.text(), /document\.body\.dataset\.executed/);

    // Regression: a declared image/png upload with an HTML filename must not be stored
    // with a .html extension in IMAGE_DIR, which is served without a forced-download
    // header and would let the script execute same-origin on load.
    const spoofedImageUpload = await fetch(`${baseUrl}/api/uploads/image`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'evil.html',
        type: 'image/png',
        data: `data:image/png;base64,${Buffer.from('<script>document.body.dataset.executed="true"</script>').toString('base64')}`,
      }),
    });
    const spoofedImageUploadPayload = await spoofedImageUpload.json();
    assert.equal(spoofedImageUpload.status, 200, JSON.stringify(spoofedImageUploadPayload));
    assert.match(spoofedImageUploadPayload.image.url, /\.png$/);
    const spoofedImageDownload = await fetch(`${baseUrl}${spoofedImageUploadPayload.image.url}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(spoofedImageDownload.status, 200);
    assert.equal(spoofedImageDownload.headers.get('x-content-type-options'), 'nosniff');
    assert.doesNotMatch(spoofedImageDownload.headers.get('content-type') || '', /html/);

    const malformedUpload = await fetch(`${baseUrl}/api/uploads/file`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'invalid.txt',
        type: 'text/plain',
        data: 'data:text/plain;base64,AAAA=AAA',
      }),
    });
    assert.equal(malformedUpload.status, 400);
    assert.match((await malformedUpload.json()).error, /上传内容格式无效/);

    const oversizedImageUpload = await fetch(`${baseUrl}/api/uploads/image`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'too-large.png',
        type: 'image/png',
        data: `data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')}`,
      }),
    });
    const oversizedImageUploadPayload = await oversizedImageUpload.json();
    assert.equal(oversizedImageUpload.status, 413, JSON.stringify(oversizedImageUploadPayload));
    assert.match(oversizedImageUploadPayload.error, /图片不能超过 10MB/);

    const oversizedUploadRequest = await fetch(`${baseUrl}/api/uploads/file`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'request-too-large.txt',
        type: 'text/plain',
        data: 'A'.repeat(36 * 1024 * 1024),
      }),
    });
    assert.equal(oversizedUploadRequest.status, 413);
    assert.match(oversizedUploadRequest.headers.get('cache-control') || '', /no-store/);
    assert.match((await oversizedUploadRequest.json()).error, /请求内容过大/);

    const blockedPlaygroundOrigin = await fetch(
      `${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent('http://127.0.0.1:1')}`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    assert.equal(blockedPlaygroundOrigin.status, 403);
    const providerPort = new URL(providerBaseUrl).port;
    const externalProviderAlias = `http://203.0.113.10:${providerPort}/v1`;
    const requestExternalProviderAlias = (upstream, body) => new Promise((resolve, reject) => {
      const target = new URL(
        `${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(upstream)}`,
      );
      const request = createHttpRequest({
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          Cookie: cookie,
          Host: '203.0.113.10:36354',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { responseBody += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: responseBody }));
      });
      request.on('error', reject);
      request.end(body);
    });
    const aliasedPlaygroundOrigin = await requestExternalProviderAlias(
      externalProviderAlias,
      JSON.stringify({ model: 'gpt-image-2', prompt: 'external host alias smoke test' }),
    );
    assert.equal(aliasedPlaygroundOrigin.status, 200);
    assert.equal(providerRequests.at(-1).host, new URL(providerBaseUrl).host);
    const blockedDifferentHostAlias = await requestExternalProviderAlias(
      `http://203.0.113.9:${providerPort}/v1`,
      '{}',
    );
    assert.equal(blockedDifferentHostAlias.status, 403);
    const blockedDifferentPortAlias = await requestExternalProviderAlias(
      'http://203.0.113.10:1/v1',
      '{}',
    );
    assert.equal(blockedDifferentPortAlias.status, 403);
    const blockedPlaygroundPath = await fetch(
      `${baseUrl}/api-proxy/models?codex_upstream=${encodeURIComponent(providerBaseUrl)}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(blockedPlaygroundPath.status, 403);
    const playgroundProxyPayload = { model: 'gpt-image-2', prompt: 'proxy smoke test' };
    const playgroundProxyResponse = await fetch(
      `${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(providerBaseUrl)}`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Authorization: 'Bearer browser-playground-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(playgroundProxyPayload),
      },
    );
    assert.equal(playgroundProxyResponse.status, 200);
    assert.equal((await playgroundProxyResponse.json()).data.length, 1);
    assert.equal(providerRequests.at(-1).url, '/v1/images/generations');
    assert.equal(providerRequests.at(-1).authorization, 'Bearer test-token');
    assert.equal(providerRequests.at(-1).contentType, 'application/json');
    assert.deepEqual(JSON.parse(providerRequests.at(-1).body), playgroundProxyPayload);
    const heartbeatStatuses = [];
    const heartbeatResult = await new Promise((resolve, reject) => {
      const target = new URL(
        `${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(providerBaseUrl)}`,
      );
      const body = JSON.stringify({ model: 'gpt-image-2', prompt: 'heartbeat smoke test' });
      const request = createHttpRequest({
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { responseBody += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: responseBody }));
      });
      request.on('information', (information) => heartbeatStatuses.push(information.statusCode));
      request.on('error', reject);
      request.end(body);
    });
    assert.equal(heartbeatResult.status, 200);
    assert.equal(JSON.parse(heartbeatResult.body).data.length, 1);
    assert.ok(heartbeatStatuses.includes(102));
    const playgroundProxyFallback = await fetch(
      `${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(`${providerBaseUrl}/v1`)}`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(playgroundProxyPayload),
      },
    );
    assert.equal(playgroundProxyFallback.status, 200);
    assert.equal(providerRequests.at(-1).authorization, 'Bearer test-token');
    const allowedCustomOrigin = await fetch(
      `${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(customProviderBaseUrl)}`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Authorization: 'Bearer custom-site-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(playgroundProxyPayload),
      },
    );
    assert.equal(allowedCustomOrigin.status, 200);
    assert.equal(providerRequests.at(-1).authorization, '');
    const bufferedProxyFailure = await fetch(
      `${baseUrl}/api-proxy/responses?codex_upstream=${encodeURIComponent(customProviderBaseUrl)}`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceStreamFailure: true }),
      },
    );
    assert.equal(bufferedProxyFailure.status, 502);
    assert.match((await bufferedProxyFailure.json()).error, /Playground proxy (request failed|received truncated or invalid JSON)/);
    const truncatedJsonProxy = await fetch(
      `${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(providerBaseUrl)}`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'forceTruncatedJson' }),
      },
    );
    assert.equal(truncatedJsonProxy.status, 502);
    assert.match((await truncatedJsonProxy.json()).error, /truncated or invalid JSON|Playground proxy request failed/);
    const eventStreamProxy = await fetch(
      `${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(providerBaseUrl)}`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'forceEventStream', stream: true }),
      },
    );
    assert.equal(eventStreamProxy.status, 200);
    assert.match(eventStreamProxy.headers.get('content-type') || '', /text\/event-stream/);
    const eventStreamBody = await eventStreamProxy.text();
    assert.match(eventStreamBody, /image\.generation\.result|partial_image/);
    assert.ok(config.conversations.some((conversation) => (
      conversation.id === nativeSessionId
      && conversation.source === 'codex'
      && conversation.title === 'Codex App fixture'
      && conversation.cwd === temporary
      && conversation.originator === 'codex-chrome-extension-sidepanel'
      && conversation.automation?.id === 'fixture-heartbeat'
      && conversation.automation?.kind === 'heartbeat'
      && conversation.automation?.name === 'Fixture heartbeat'
      && conversation.automation?.scheduleLabel === '每天 09:30'
    )));
    assert.equal(config.conversations.some((conversation) => conversation.id === archivedNativeSessionId), false);
    assert.equal(config.conversations.some((conversation) => conversation.id === automationNativeSessionId), false);

    const imagePromptsResponse = await fetch(`${baseUrl}/api/image-prompts`, {
      headers: { Cookie: cookie },
    });
    assert.equal(imagePromptsResponse.status, 200);
    assert.match(imagePromptsResponse.headers.get('cache-control'), /private, no-store/);
    const imagePrompts = await imagePromptsResponse.json();
    assert.equal(imagePrompts.totalCases, 517);
    assert.equal(imagePrompts.totalTemplates, 22);
    assert.equal(imagePrompts.cases.length, 517);
    assert.equal(imagePrompts.templates.length, 22);
    assert.equal(imagePrompts.imageBaseUrl, '/api/image-prompts/assets');
    assert.match(imagePrompts.imageUpstreamBaseUrl, /awesome-gpt-image-2\/60b6e1d3/);
    assert.equal(imagePrompts.revision, '60b6e1d3ddaf1c982426d6c8181827764c6b2012');
    assert.equal(imagePrompts.sync.source, 'bundled');
    assert.equal(imagePrompts.sync.status, 'ready');
    assert.equal(imagePrompts.sync.autoSync, false);
    assert.ok(imagePrompts.sources.some((source) => source.name === 'gpt_image_playground'));
    assert.ok(imagePrompts.cases.some((item) => item.id === 520 && item.prompt));

    const rejectedImagePromptAsset = await fetch(`${baseUrl}/api/image-prompts/assets/secret.txt`, {
      headers: { Cookie: cookie },
    });
    assert.equal(rejectedImagePromptAsset.status, 400);

    const imagePromptAssetResponse = await fetch(`${baseUrl}/api/image-prompts/assets/images/case520.jpg`, {
      headers: { Cookie: cookie },
    });
    assert.equal(imagePromptAssetResponse.status, 200);
    assert.match(imagePromptAssetResponse.headers.get('content-type') || '', /image\//);
    assert.match(imagePromptAssetResponse.headers.get('cache-control') || '', /private/);
    assert.ok((await imagePromptAssetResponse.arrayBuffer()).byteLength > 1000);

    const imagePromptStatusResponse = await fetch(`${baseUrl}/api/image-prompts/status`, {
      headers: { Cookie: cookie },
    });
    assert.equal(imagePromptStatusResponse.status, 200);
    assert.match(imagePromptStatusResponse.headers.get('cache-control'), /private, no-store/);
    const imagePromptStatus = await imagePromptStatusResponse.json();
    assert.equal(imagePromptStatus.version, imagePrompts.version);
    assert.equal(imagePromptStatus.totalCases, 517);

    const nativeSessions = await fetch(`${baseUrl}/api/native-sessions`, {
      headers: { Cookie: cookie },
    });
    assert.equal(nativeSessions.status, 200);
    const nativeSessionsPayload = await nativeSessions.json();
    assert.deepEqual(nativeSessionsPayload.sessions.map((session) => session.id), [nativeSessionId]);
    assert.equal(nativeSessionsPayload.sessions[0].cwd, temporary);

    const nativeSession = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(nativeSession.status, 200);
    const nativeConversation = (await nativeSession.json()).conversation;
    assert.equal(nativeConversation.source, 'codex');
    assert.equal(nativeConversation.readOnly, false);
    assert.deepEqual(nativeConversation.contextWindow, { usedTokens: 215308, maxTokens: 258400 });
    assert.ok(nativeConversation.messages.some((message) => (
      message.role === 'user' && message.content === 'native fixture message'
    )));

    const unauthorizedSubagent = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}/subagents?agent=ui_trace`,
    );
    assert.equal(unauthorizedSubagent.status, 401);
    const subagentResponse = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}/subagents?agent=ui_trace&limit=100`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(subagentResponse.status, 200);
    const subagentConversation = (await subagentResponse.json()).subagent;
    assert.equal(subagentConversation.id, subagentNativeSessionId);
    assert.equal(subagentConversation.source, 'subagent');
    assert.equal(subagentConversation.status, 'done');
    assert.equal(subagentConversation.metadata.parentThreadId, nativeSessionId);
    assert.equal(subagentConversation.metadata.agentPath, '/root/ui_trace');
    assert.ok(subagentConversation.messages.some((message) => message.content === '子代理正在检查界面'));
    assert.ok(subagentConversation.messages.some((message) => message.content.includes('exec_command')));
    assert.ok(subagentConversation.messages.some((message) => message.content === '子代理检查完成'));
    const incrementalSubagentResponse = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}/subagents?agent=%2Froot%2Fui_trace&after=${subagentConversation.cursor}&generation=${subagentConversation.generation}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(incrementalSubagentResponse.status, 200);
    const incrementalSubagent = (await incrementalSubagentResponse.json()).subagent;
    assert.equal(incrementalSubagent.reset, false);
    assert.deepEqual(incrementalSubagent.messages, []);
    const missingSubagent = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}/subagents?agent=missing_agent`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(missingSubagent.status, 404);
    const nativeTargetMessage = nativeConversation.messages.find((message) => (
      message.role === 'user' && message.content === 'native fixture message'
    ));
    const nativeFirstMessage = nativeConversation.messages.find((message) => (
      message.role === 'user' && message.content === 'native earlier message'
    ));
    const nativeAssistantMessage = nativeConversation.messages.find((message) => (
      message.role === 'assistant' && message.content === 'native assistant answer'
    ));
    assert.equal(nativeFirstMessage.turnId, nativeFirstTurnId);
    assert.equal(nativeFirstMessage.previousTurnId, undefined);
    assert.equal(nativeAssistantMessage.turnId, nativeFirstTurnId);
    assert.equal(nativeTargetMessage.turnId, nativeSecondTurnId);
    assert.equal(nativeTargetMessage.previousTurnId, nativeFirstTurnId);
    assert.ok(nativeConversation.messages.some((message) => (
      message.role === 'image'
      && message.kind === 'input_image'
      && message.content === 'data:image/png;base64,c21va2U='
    )));
    const nativeToolImageMessage = nativeConversation.messages.find((message) => (
      message.role === 'tool' && message.content.includes(toolImagePath)
    ));
    assert.ok(nativeToolImageMessage);
    const toolImageUrl = `/api/native-sessions/${nativeSessionId}/tool-images/${nativeToolImageMessage.seq}/1`;
    const unauthorizedToolImage = await fetch(`${baseUrl}${toolImageUrl}`);
    assert.equal(unauthorizedToolImage.status, 401);
    const toolImage = await fetch(`${baseUrl}${toolImageUrl}`, { headers: { Cookie: cookie } });
    assert.equal(toolImage.status, 200);
    assert.equal(toolImage.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await toolImage.arrayBuffer()), await readFile(toolImagePath));

    // /api/local-image accepts a client-supplied path directly. It must still serve
    // images that live inside the session cwd...
    const inCwdLocalImage = await fetch(
      `${baseUrl}/api/local-image?${new URLSearchParams({ path: toolImagePath, cwd: temporary })}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(inCwdLocalImage.status, 200);
    assert.equal(inCwdLocalImage.headers.get('content-type'), 'image/png');
    const configuredRootLocalImage = await fetch(
      `${baseUrl}/api/local-image?${new URLSearchParams({ path: externalImagePath, cwd: temporary })}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(configuredRootLocalImage.status, 200);
    assert.equal(configuredRootLocalImage.headers.get('content-type'), 'image/png');
    const svgLocalImage = await fetch(
      `${baseUrl}/api/local-image?${new URLSearchParams({ path: svgImagePath, cwd: temporary })}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(svgLocalImage.status, 200);
    assert.equal(svgLocalImage.headers.get('content-type'), 'image/svg+xml');
    assert.equal(svgLocalImage.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(
      svgLocalImage.headers.get('content-security-policy'),
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    );
    assert.match(await svgLocalImage.text(), /<svg\b/);
    const invalidSvgLocalImage = await fetch(
      `${baseUrl}/api/local-image?${new URLSearchParams({ path: invalidSvgImagePath, cwd: temporary })}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(invalidSvgLocalImage.status, 404);
    // ...but must reject an absolute path outside both the session cwd and the OS temp
    // dir, or any authenticated user could read arbitrary image files on the host that
    // have nothing to do with the current Codex session.
    const outOfScopeImagePath = path.join(ROOT, `.local-image-security-probe-${process.pid}.png`);
    await writeFile(
      outOfScopeImagePath,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    );
    try {
      const outOfScopeLocalImage = await fetch(
        `${baseUrl}/api/local-image?${new URLSearchParams({ path: outOfScopeImagePath, cwd: temporary })}`,
        { headers: { Cookie: cookie } },
      );
      assert.equal(outOfScopeLocalImage.status, 404);
    } finally {
      await rm(outOfScopeImagePath, { force: true });
    }

    const falseToolImageMessage = nativeConversation.messages.find((message) => (
      message.role === 'tool' && message.content.includes('not-a-real-image.png')
    ));
    assert.ok(falseToolImageMessage);
    const falseToolImage = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}/tool-images/${falseToolImageMessage.seq}/1`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(falseToolImage.status, 404);

    const limitedNativeSession = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}?limit=3`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(limitedNativeSession.status, 200);
    const limitedNativeConversation = (await limitedNativeSession.json()).conversation;
    assert.equal(limitedNativeConversation.messages.length, 3);
    assert.equal(limitedNativeConversation.hasEarlierMessages, true);
    const externalizedImage = limitedNativeConversation.messages.find((message) => message.role === 'image');
    assert.match(externalizedImage.content, new RegExp(
      `^/api/native-sessions/${nativeSessionId}/images/${externalizedImage.seq}\\?generation=\\d+$`,
    ));

    const historyPageNativeSession = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}?limit=3&history=page`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(historyPageNativeSession.status, 200);
    const historyPageNativeConversation = (await historyPageNativeSession.json()).conversation;
    assert.deepEqual(
      historyPageNativeConversation.messages.map((message) => message.seq),
      nativeConversation.messages.slice(-3).map((message) => message.seq),
    );
    assert.equal(historyPageNativeConversation.hasEarlierMessages, true);
    assert.equal(historyPageNativeConversation.historyPageLimit, 3);
    assert.ok(historyPageNativeConversation.nextHistoryPageLimit > 3);

    const externalizedNativeSession = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}?images=external`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(externalizedNativeSession.status, 200);
    const externalizedNativeConversation = (await externalizedNativeSession.json()).conversation;
    assert.equal(externalizedNativeConversation.messages.length, nativeConversation.messages.length);
    assert.match(
      externalizedNativeConversation.messages.find((message) => message.role === 'image').content,
      new RegExp(`^/api/native-sessions/${nativeSessionId}/images/\\d+\\?generation=\\d+$`),
    );

    const appServerTraceBeforeFirstFork = await readAppServerTrace(appServerTraceFile);
    const nativeImage = await fetch(`${baseUrl}${externalizedImage.content}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(nativeImage.status, 200);
    assert.equal(nativeImage.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await nativeImage.arrayBuffer()).toString(), 'smoke');

    const restartedFromFirst = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/fork`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageSeq: nativeFirstMessage.seq,
        provider: 'fake',
        model: 'test-model',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'untrusted',
      }),
    });
    assert.equal(restartedFromFirst.status, 201);
    const restartedFromFirstPayload = await restartedFromFirst.json();
    assert.equal(restartedFromFirstPayload.threadId, createdNativeSessionId);
    assert.equal(restartedFromFirstPayload.forkedThroughTurnId, '');
    assert.equal(restartedFromFirstPayload.draft, 'native earlier message');
    const firstForkCleanup = await waitForAppServerTrace(
      appServerTraceFile,
      (messages) => messages.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === createdNativeSessionId
      )).length > appServerTraceBeforeFirstFork.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === createdNativeSessionId
      )).length,
      'thread/start fork did not release its Web app-server subscription',
    );
    assert.equal(
      firstForkCleanup.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === createdNativeSessionId
      )).length,
      appServerTraceBeforeFirstFork.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === createdNativeSessionId
      )).length + 1,
    );

    const appServerTraceBeforeFork = await readAppServerTrace(appServerTraceFile);
    const forked = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/fork`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageSeq: nativeTargetMessage.seq,
        provider: 'fake',
        model: 'test-model',
        serviceTier: 'priority',
        cwd: temporary,
        sandbox: 'workspace-write',
        approval: 'on-request',
      }),
    });
    assert.equal(forked.status, 201);
    const forkedPayload = await forked.json();
    assert.equal(forkedPayload.threadId, forkedNativeSessionId);
    assert.equal(forkedPayload.sourceThreadId, nativeSessionId);
    assert.equal(forkedPayload.forkedThroughTurnId, nativeFirstTurnId);
    assert.equal(forkedPayload.draft, 'native fixture message');
    assert.equal(forkedPayload.conversation.status, 'done');
    const forkCleanup = await waitForAppServerTrace(
      appServerTraceFile,
      (messages) => messages.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === forkedNativeSessionId
      )).length > appServerTraceBeforeFork.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === forkedNativeSessionId
      )).length,
      'thread/fork did not release its Web app-server subscription',
    );
    assert.equal(
      forkCleanup.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === forkedNativeSessionId
      )).length,
      appServerTraceBeforeFork.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === forkedNativeSessionId
      )).length + 1,
    );

    const appServerTraceBeforeAssistantFork = await readAppServerTrace(appServerTraceFile);
    const continuedFromAssistant = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/fork`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageSeq: nativeAssistantMessage.seq,
        provider: 'fake',
        model: 'test-model',
        cwd: temporary,
        sandbox: 'workspace-write',
        approval: 'on-request',
      }),
    });
    assert.equal(continuedFromAssistant.status, 201);
    const continuedFromAssistantPayload = await continuedFromAssistant.json();
    assert.equal(continuedFromAssistantPayload.threadId, forkedNativeSessionId);
    assert.equal(continuedFromAssistantPayload.forkedThroughTurnId, nativeFirstTurnId);
    assert.equal(continuedFromAssistantPayload.draft, '');
    const assistantForkCleanup = await waitForAppServerTrace(
      appServerTraceFile,
      (messages) => messages.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === forkedNativeSessionId
      )).length > appServerTraceBeforeAssistantFork.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === forkedNativeSessionId
      )).length,
      'second thread/fork did not release its Web app-server subscription',
    );
    assert.equal(
      assistantForkCleanup.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === forkedNativeSessionId
      )).length,
      appServerTraceBeforeAssistantFork.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === forkedNativeSessionId
      )).length + 1,
    );

    const archivedNativeSession = await fetch(`${baseUrl}/api/native-sessions/${archivedNativeSessionId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(archivedNativeSession.status, 404);

    const automationNativeSession = await fetch(`${baseUrl}/api/native-sessions/${automationNativeSessionId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(automationNativeSession.status, 404);

    const traceBeforeDesktopContinuation = await readAppServerTrace(appServerTraceFile);
    const desktopUnsubscribeCountBefore = traceBeforeDesktopContinuation.filter((message) => (
      message.method === 'thread/unsubscribe'
      && message.params?.threadId === nativeSessionId
    )).length;
    const desktopContinued = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'sync through desktop owner',
        provider: 'fake',
        model: 'test-model',
        reasoningEffort: 'ultra',
        serviceTier: 'priority',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'on-request',
      }),
    });
    assert.equal(desktopContinued.status, 202);
    const desktopContinuedPayload = await desktopContinued.json();
    assert.equal(desktopContinuedPayload.turnId, 'desktop-turn-1');
    const activeDesktopSession = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(activeDesktopSession.status, 200);
    const activeDesktopConversation = (await activeDesktopSession.json()).conversation;
    assert.equal(activeDesktopConversation.activeTurnId, desktopContinuedPayload.turnId);
    assert.match(activeDesktopConversation.activeTurnStartedAt, /^\d{4}-\d{2}-\d{2}T/);
    const traceAfterDesktopContinuation = await readAppServerTrace(appServerTraceFile);
    assert.equal(
      traceAfterDesktopContinuation.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === nativeSessionId
      )).length,
      desktopUnsubscribeCountBefore,
      'Desktop-owned continuation must not be released through Web app-server',
    );

    const desktopSteered = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/steer`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'steer through desktop owner',
        turnId: desktopContinuedPayload.turnId,
      }),
    });
    assert.equal(desktopSteered.status, 202);
    assert.equal((await desktopSteered.json()).turnId, desktopContinuedPayload.turnId);

    const desktopInterrupted = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: desktopContinuedPayload.turnId }),
    });
    assert.equal(desktopInterrupted.status, 200);

    desktopIpc.startTurnMode = 'echo-only';
    desktopIpc.onStartTurn = async (message) => {
      const text = message.params.turnStartParams.input.find((item) => item.type === 'text')?.text || '';
      assert.equal(text, 'recover from native echo');
      const records = [
        {
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'desktop-echo-turn' },
        },
        {
          timestamp: new Date().toISOString(),
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
          },
        },
      ];
      await appendFile(nativeSessionFile, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    };
    const echoStartedAt = Date.now();
    const echoedContinuation = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'recover from native echo',
        provider: 'fake',
        model: 'test-model',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'on-request',
      }),
    });
    const echoedContinuationPayload = await echoedContinuation.json();
    const echoedSessionContent = await readFile(nativeSessionFile, 'utf8');
    assert.equal(desktopIpc.lastError, null);
    assert.match(echoedSessionContent, /recover from native echo/);
    assert.equal(echoedContinuation.status, 202, JSON.stringify(echoedContinuationPayload));
    assert.ok(Date.now() - echoStartedAt < 3000);
    assert.equal(echoedContinuationPayload.turnId, 'desktop-echo-turn');

    const interruptCountBeforeStaleRequest = desktopIpc.messages.filter(
      (message) => message.method === 'thread-follower-interrupt-turn',
    ).length;
    const staleInterrupt = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: desktopContinuedPayload.turnId }),
    });
    assert.equal(staleInterrupt.status, 409);
    assert.match((await staleInterrupt.json()).error, /任务已过期/);
    assert.equal(
      desktopIpc.messages.filter((message) => message.method === 'thread-follower-interrupt-turn').length,
      interruptCountBeforeStaleRequest,
    );
    const missingTurnInterrupt = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(missingTurnInterrupt.status, 409);
    assert.match((await missingTurnInterrupt.json()).error, /状态已变化/);
    assert.equal(
      desktopIpc.messages.filter((message) => message.method === 'thread-follower-interrupt-turn').length,
      interruptCountBeforeStaleRequest,
    );

    desktopIpc.broadcast({
      type: 'broadcast',
      method: 'thread-stream-state-changed',
      version: 11,
      sourceClientId: 'desktop-owner',
      params: {
        conversationId: nativeSessionId,
        change: {
          type: 'snapshot',
          revision: 1,
          conversationState: {
            requests: [],
          },
        },
      },
    });
    desktopIpc.broadcast({
      type: 'broadcast',
      method: 'thread-stream-state-changed',
      version: 11,
      sourceClientId: 'desktop-owner',
      params: {
        conversationId: nativeSessionId,
        change: {
          type: 'patches',
          baseRevision: 1,
          revision: 2,
          patches: [{
            op: 'add',
            path: ['requests', 0],
            value: {
              id: 'desktop-approval-1',
              method: 'item/commandExecution/requestApproval',
              params: {
                threadId: nativeSessionId,
                turnId: echoedContinuationPayload.turnId,
                command: 'printf desktop',
                cwd: temporary,
                reason: 'desktop approval test',
              },
            },
          }],
        },
      },
    });
    const desktopApproval = await waitForPendingRequest(baseUrl, cookie);
    assert.equal(desktopApproval.method, 'item/commandExecution/requestApproval');
    assert.equal(desktopApproval.threadId, nativeSessionId);
    const desktopApproved = await fetch(`${baseUrl}/api/native-requests/${encodeURIComponent(desktopApproval.id)}/respond`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'accept' }),
    });
    assert.equal(desktopApproved.status, 200);
    const desktopApprovalMessage = desktopIpc.messages.find(
      (message) => message.method === 'thread-follower-command-approval-decision',
    );
    assert.equal(desktopApprovalMessage.version, 1);
    assert.equal(desktopApprovalMessage.targetClientId, 'desktop-owner');
    assert.deepEqual(desktopApprovalMessage.params, {
      conversationId: nativeSessionId,
      requestId: 'desktop-approval-1',
      decision: 'accept',
    });

    const appInterruptsBeforeDesktopTimeout = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((message) => message.method === 'turn/interrupt');
    const desktopInterruptMessageCount = desktopIpc.messages.filter(
      (message) => message.method === 'thread-follower-interrupt-turn',
    ).length;
    desktopIpc.interruptMode = 'timeout';
    const timeoutInterruptStartedAt = Date.now();
    let timeoutInterrupted;
    try {
      timeoutInterrupted = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/interrupt`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId: echoedContinuationPayload.turnId }),
      });
    } finally {
      desktopIpc.interruptMode = 'respond';
    }
    const timeoutInterruptedPayload = await timeoutInterrupted.json();
    assert.equal(timeoutInterrupted.status, 200, timeoutInterruptedPayload.error);
    assert.equal(timeoutInterruptedPayload.turnId, echoedContinuationPayload.turnId);
    assert.ok(
      Date.now() - timeoutInterruptStartedAt < 2500,
      'desktop interrupt timeout did not fall back promptly',
    );
    const timeoutDesktopInterrupts = desktopIpc.messages
      .filter((message) => message.method === 'thread-follower-interrupt-turn')
      .slice(desktopInterruptMessageCount);
    assert.equal(timeoutDesktopInterrupts.length, 1);
    assert.equal(timeoutDesktopInterrupts[0].targetClientId, 'desktop-owner');
    assert.equal(timeoutDesktopInterrupts[0].timeoutMs, 1000);
    const appInterruptsAfterDesktopTimeout = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((message) => message.method === 'turn/interrupt');
    assert.equal(appInterruptsAfterDesktopTimeout.length, appInterruptsBeforeDesktopTimeout.length + 1);
    assert.deepEqual(appInterruptsAfterDesktopTimeout.at(-1).params, {
      threadId: nativeSessionId,
      turnId: echoedContinuationPayload.turnId,
    });

    desktopIpc.broadcast({
      type: 'broadcast',
      method: 'thread-stream-state-changed',
      version: 11,
      sourceClientId: 'desktop-owner',
      params: {
        conversationId: nativeSessionId,
        change: {
          type: 'patches',
          baseRevision: 2,
          revision: 3,
          patches: [{
            op: 'add',
            path: ['requests', 0],
            value: {
              id: 'desktop-approval-removed',
              method: 'item/fileChange/requestApproval',
              params: {
                threadId: nativeSessionId,
                turnId: echoedContinuationPayload.turnId,
                reason: 'desktop removal test',
              },
            },
          }],
        },
      },
    });
    const removedDesktopApproval = await waitForPendingRequest(baseUrl, cookie);
    assert.equal(removedDesktopApproval.method, 'item/fileChange/requestApproval');
    desktopIpc.broadcast({
      type: 'broadcast',
      method: 'thread-stream-state-changed',
      version: 11,
      sourceClientId: 'desktop-owner',
      params: {
        conversationId: nativeSessionId,
        change: {
          type: 'patches',
          baseRevision: 3,
          revision: 4,
          patches: [{ op: 'remove', path: ['requests', 0] }],
        },
      },
    });
    await waitForPendingRequestGone(baseUrl, cookie, removedDesktopApproval.id);

    desktopIpc.broadcast({
      type: 'broadcast',
      method: 'thread-stream-state-changed',
      version: 11,
      sourceClientId: 'desktop-owner',
      params: {
        conversationId: nativeSessionId,
        change: {
          type: 'patches',
          baseRevision: 4,
          revision: 5,
          patches: [{
            op: 'add',
            path: ['requests', 0],
            value: {
              id: 'desktop-approval-reconnect',
              method: 'item/commandExecution/requestApproval',
              params: {
                threadId: nativeSessionId,
                turnId: echoedContinuationPayload.turnId,
                command: 'printf reconnect',
                cwd: temporary,
                reason: 'desktop reconnect test',
              },
            },
          }],
        },
      },
    });
    const reconnectApproval = await waitForPendingRequestState(
      baseUrl,
      cookie,
      (request) => request.id.includes('desktop-approval-reconnect'),
      'desktop reconnect approval did not arrive',
    );
    const reconnectSnapshot = {
      type: 'broadcast',
      method: 'thread-stream-state-changed',
      version: 11,
      sourceClientId: 'desktop-owner',
      params: {
        conversationId: nativeSessionId,
        change: {
          type: 'snapshot',
          revision: 6,
          conversationState: {
            requests: [{
              id: 'desktop-approval-reconnect',
              method: 'item/commandExecution/requestApproval',
              params: {
                threadId: nativeSessionId,
                turnId: echoedContinuationPayload.turnId,
                command: 'printf reconnect',
                cwd: temporary,
                reason: 'desktop reconnect test',
              },
            }],
          },
        },
      },
    };
    desktopIpc.historySnapshots.set(nativeSessionId, reconnectSnapshot);
    const initializeCountBeforeReconnect = desktopIpc.initializeCount;
    desktopIpc.disconnectClients();
    const disconnectedApproval = await waitForPendingRequestState(
      baseUrl,
      cookie,
      (request) => request.id === reconnectApproval.id && Boolean(request.connectionError),
      'desktop pending approval was cleared during disconnect',
    );
    assert.match(disconnectedApproval.connectionError, /关闭|断开|reset/i);
    await waitForDesktopInitializeCount(desktopIpc, initializeCountBeforeReconnect + 1);
    const reconciledApproval = await waitForPendingRequestState(
      baseUrl,
      cookie,
      (request) => request.id === reconnectApproval.id && !request.connectionError,
      'desktop pending approval was not reconciled after reconnect',
    );
    assert.equal(reconciledApproval.threadId, nativeSessionId);
    assert.ok(desktopIpc.messages.some((message) => (
      message.method === 'thread-follower-load-complete-history'
      && message.params?.conversationId === nativeSessionId
    )));
    const resolvedReconnectApproval = await fetch(
      `${baseUrl}/api/native-requests/${encodeURIComponent(reconnectApproval.id)}/respond`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'decline' }),
      },
    );
    assert.equal(resolvedReconnectApproval.status, 200);
    await waitForPendingRequestGone(baseUrl, cookie, reconnectApproval.id);

    desktopIpc.startTurnMode = 'respond';
    desktopIpc.onStartTurn = null;
    const echoedInterrupted = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: echoedContinuationPayload.turnId }),
    });
    assert.equal(echoedInterrupted.status, 200);

    const desktopStart = desktopIpc.messages.find((message) => message.method === 'thread-follower-start-turn');
    assert.equal(desktopStart.params.conversationId, nativeSessionId);
    assert.deepEqual(desktopStart.params.turnStartParams.input, [{
      type: 'text',
      text: 'sync through desktop owner',
      text_elements: [],
    }]);
    assert.equal(desktopStart.params.turnStartParams.effort, 'ultra');
    assert.equal(desktopStart.params.turnStartParams.model, 'test-model');
    assert.equal(desktopStart.params.turnStartParams.serviceTier, 'priority');
    assert.equal(desktopStart.params.turnStartParams.sandboxPolicy.type, 'readOnly');
    const standardDesktopStart = desktopIpc.messages.find((message) => (
      message.method === 'thread-follower-start-turn'
      && message.params.turnStartParams.input.some((item) => item.text === 'recover from native echo')
    ));
    assert.equal(standardDesktopStart.params.turnStartParams.serviceTier, null);
    const desktopSteer = desktopIpc.messages.find((message) => message.method === 'thread-follower-steer-turn');
    assert.equal(desktopSteer.params.conversationId, nativeSessionId);
    assert.deepEqual(desktopSteer.params.input, [{
      type: 'text',
      text: 'steer through desktop owner',
      text_elements: [],
    }]);
    assert.match(desktopSteer.params.clientUserMessageId, /^[a-f0-9]{32}$/);
    assert.match(desktopSteer.params.restoreMessage.id, /^[a-f0-9]{32}$/);
    assert.notEqual(desktopSteer.params.restoreMessage.id, desktopSteer.params.clientUserMessageId);
    assert.equal(desktopSteer.params.restoreMessage.text, 'steer through desktop owner');
    assert.equal(desktopSteer.params.restoreMessage.cwd, temporary);
    assert.deepEqual(desktopSteer.params.restoreMessage.context.prompt, 'steer through desktop owner');
    assert.deepEqual(desktopSteer.params.restoreMessage.context.workspaceRoots, [temporary]);
    assert.deepEqual(desktopSteer.params.restoreMessage.context.commentAttachments, []);
    assert.equal(desktopSteer.params.serviceTier, null);
    assert.deepEqual(desktopSteer.params.attachments, []);
    assert.ok(desktopIpc.messages.some((message) => message.method === 'thread-follower-interrupt-turn'));
    desktopIpc.ownerAvailable = false;

    await writeFile(appServerControlFile, JSON.stringify({ turnStartDelayMs: 120 }));
    const concurrentTurnPayload = {
      message: 'concurrent reservation test',
      provider: 'fake',
      model: 'test-model',
      cwd: temporary,
      sandbox: 'read-only',
      approval: 'on-request',
    };
    const firstConcurrentTurn = fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(concurrentTurnPayload),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondConcurrentTurn = fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(concurrentTurnPayload),
    });
    const concurrentTurnResponses = await Promise.all([firstConcurrentTurn, secondConcurrentTurn]);
    assert.deepEqual(concurrentTurnResponses.map((response) => response.status).sort(), [202, 409]);
    const acceptedConcurrentResponse = concurrentTurnResponses.find((response) => response.status === 202);
    const acceptedConcurrentPayload = await acceptedConcurrentResponse.json();
    const rejectedConcurrentResponse = concurrentTurnResponses.find((response) => response.status === 409);
    assert.match((await rejectedConcurrentResponse.json()).error, /已有任务|正在运行/);
    const interruptedConcurrentTurn = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: acceptedConcurrentPayload.turnId }),
    });
    assert.equal(interruptedConcurrentTurn.status, 200);
    await writeFile(appServerControlFile, '{}');

    const nonRetryErrorThreadId = '019f4f84-ea9f-73c2-b997-deba7b4aa742';
    const wrongNonRetryErrorTurnId = '019f4f84-ea9f-73c2-b997-deba7b4aa743';
    const nonRetryErrorMessage = 'controlled terminal retry exhaustion';
    await writeFile(appServerControlFile, JSON.stringify({
      threadStartId: nonRetryErrorThreadId,
      nonRetryErrorText: nonRetryErrorMessage,
      nonRetryErrorWrongTurnId: wrongNonRetryErrorTurnId,
      nonRetryErrorDelayMs: 280,
    }));
    const nonRetryStarted = await fetch(`${baseUrl}/api/native-sessions`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: nonRetryErrorMessage,
        provider: 'fake',
        model: 'test-model',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'on-request',
      }),
    });
    assert.equal(nonRetryStarted.status, 202);
    const nonRetryStartedPayload = await nonRetryStarted.json();
    assert.equal(nonRetryStartedPayload.threadId, nonRetryErrorThreadId);

    await new Promise((resolve) => setTimeout(resolve, 80));
    const wrongTurnStillLocked = await fetch(`${baseUrl}/api/native-sessions/${nonRetryErrorThreadId}/turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'must remain blocked after a different turn error',
        provider: 'fake',
        model: 'test-model',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'on-request',
      }),
    });
    assert.equal(wrongTurnStillLocked.status, 409);

    await new Promise((resolve) => setTimeout(resolve, 280));
    const resumedAfterMatchingError = await fetch(`${baseUrl}/api/native-sessions/${nonRetryErrorThreadId}/turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'resume after matching terminal error',
        provider: 'fake',
        model: 'test-model',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'on-request',
      }),
    });
    assert.equal(resumedAfterMatchingError.status, 202);
    const resumedAfterMatchingErrorPayload = await resumedAfterMatchingError.json();
    const cleanupResumedTurn = await fetch(`${baseUrl}/api/native-sessions/${nonRetryErrorThreadId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: resumedAfterMatchingErrorPayload.turnId }),
    });
    assert.equal(cleanupResumedTurn.status, 200);
    await writeFile(appServerControlFile, '{}');

    const appOwnedQueue = await fetch(`${baseUrl}/api/prompt-queues/${appQueueOwnershipThreadId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(appOwnedQueue.status, 200);
    const appOwnedQueuePayload = await appOwnedQueue.json();
    assert.equal(appOwnedQueuePayload.items.length, 1);
    assert.equal(appOwnedQueuePayload.items[0].id, appOwnedQueueItemId);
    assert.equal(appOwnedQueuePayload.items[0].source, 'codex-app');
    assert.deepEqual(appOwnedQueuePayload.items[0].attachments, [
      { kind: 'image', name: 'tool-preview.png', type: '', size: 0, url: '', filePath: toolImagePath },
      { kind: 'file', name: 'added-context.mjs', type: '', size: 0, url: '', filePath: path.join(temporary, 'added-context.mjs') },
      { kind: 'file', name: 'queue-context.mjs', type: '', size: 0, url: '', filePath: path.join(temporary, 'queue-context.mjs') },
    ]);

    // Ordering App-owned messages is an App-backed mutation, unlike the
    // preceding concurrent-start failure path which deliberately has no owner.
    desktopIpc.ownerAvailable = true;
    const interruptedAppQueue = await fetch(`${baseUrl}/api/prompt-queues/${appQueueInterruptedThreadId}`, {
      headers: { Cookie: cookie },
    });
    const interruptedAppQueuePayload = await interruptedAppQueue.json();
    assert.equal(interruptedAppQueue.status, 200, interruptedAppQueuePayload.error);
    assert.deepEqual(
      interruptedAppQueuePayload.items.map((item) => [item.id, item.pauseState]),
      [
        [appQueueInterruptedRawItem.id, 'interrupted'],
        [appQueueFailedRawItem.id, ''],
      ],
    );
    const appQueueResumeTraceBefore = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((message) => ['turn/start', 'turn/steer', 'thread/start'].includes(message.method)).length;
    const desktopMessagesBeforeQueueResume = desktopIpc.messages.length;
    const resumedAppQueue = await fetch(
      `${baseUrl}/api/prompt-queues/${appQueueInterruptedThreadId}/resume-interrupted`,
      { method: 'POST', headers: { Cookie: cookie } },
    );
    const resumedAppQueuePayload = await resumedAppQueue.json();
    assert.equal(resumedAppQueue.status, 200, resumedAppQueuePayload.error);
    assert.equal(resumedAppQueuePayload.resumed, 1);
    assert.deepEqual(
      resumedAppQueuePayload.items.map((item) => [item.id, item.pauseState]),
      [
        [appQueueInterruptedRawItem.id, ''],
        [appQueueFailedRawItem.id, ''],
      ],
    );
    const stateAfterAppQueueResume = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    assert.equal(
      Object.hasOwn(stateAfterAppQueueResume['queued-follow-ups'][appQueueInterruptedThreadId][0], 'pausedReason'),
      false,
    );
    assert.equal(
      stateAfterAppQueueResume['queued-follow-ups'][appQueueInterruptedThreadId][1].pausedReason,
      appQueueFailedRawItem.pausedReason,
    );
    assert.deepEqual(
      desktopIpc.messages.slice(desktopMessagesBeforeQueueResume)
        .filter((message) => (
          /queued-follow-?ups/.test(message.method || '')
          || ['thread-follower-start-turn', 'thread-follower-steer-turn'].includes(message.method)
        ))
        .map((message) => message.method),
      ['thread-queued-followups-changed'],
    );
    const appQueueResumeTraceAfter = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((message) => ['turn/start', 'turn/steer', 'thread/start'].includes(message.method)).length;
    assert.equal(appQueueResumeTraceAfter, appQueueResumeTraceBefore);
    const repeatedAppQueueResume = await fetch(
      `${baseUrl}/api/prompt-queues/${appQueueInterruptedThreadId}/resume-interrupted`,
      { method: 'POST', headers: { Cookie: cookie } },
    );
    assert.equal(repeatedAppQueueResume.status, 409);
    assert.match((await repeatedAppQueueResume.json()).error, /已恢复或不存在/);

    const appQueueBeforeOrder = await fetch(`${baseUrl}/api/prompt-queues/${appQueueReorderThreadId}`, {
      headers: { Cookie: cookie },
    });
    const appQueueBeforeOrderPayload = await appQueueBeforeOrder.json();
    assert.equal(appQueueBeforeOrder.status, 200);
    assert.deepEqual(
      appQueueBeforeOrderPayload.items.map((item) => item.id),
      ['app-reorder-first', 'app-reorder-second'],
    );
    const desktopMessagesBeforeOrder = desktopIpc.messages.length;
    const reorderedAppQueue = await fetch(`${baseUrl}/api/prompt-queues/${appQueueReorderThreadId}/order`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: appQueueBeforeOrderPayload.revision,
        itemIds: ['app-reorder-second', 'app-reorder-first'],
      }),
    });
    const reorderedAppQueuePayload = await reorderedAppQueue.json();
    assert.equal(reorderedAppQueue.status, 200, reorderedAppQueuePayload.error);
    assert.deepEqual(
      reorderedAppQueuePayload.items.map((item) => item.id),
      ['app-reorder-second', 'app-reorder-first'],
    );
    const reorderedAppState = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    assert.deepEqual(
      reorderedAppState['queued-follow-ups'][appQueueReorderThreadId],
      [appQueueReorderSecondRawItem, appQueueReorderFirstRawItem],
      'reordering must update the real Codex App queue without changing raw item content',
    );
    assert.ok(desktopIpc.messages.slice(desktopMessagesBeforeOrder).some((message) => (
      message.method === 'thread-queued-followups-changed'
      && message.params?.conversationId === appQueueReorderThreadId
      && message.params?.messages?.map((item) => item.id).join(',') === 'app-reorder-second,app-reorder-first'
    )));
    const staleOrderAttempt = await fetch(`${baseUrl}/api/prompt-queues/${appQueueReorderThreadId}/order`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: appQueueBeforeOrderPayload.revision, itemIds: ['app-reorder-first'] }),
    });
    assert.equal(staleOrderAttempt.status, 409);
    const staleOrderPayload = await staleOrderAttempt.json();
    assert.deepEqual(staleOrderPayload.items.map((item) => item.id), ['app-reorder-second', 'app-reorder-first']);
    const partialOrder = await fetch(`${baseUrl}/api/prompt-queues/${appQueueReorderThreadId}/order`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: reorderedAppQueuePayload.revision,
        itemIds: ['app-reorder-first', 'unknown-item-id'],
      }),
    });
    const partialOrderPayload = await partialOrder.json();
    assert.equal(partialOrder.status, 200, partialOrderPayload.error);
    assert.deepEqual(
      partialOrderPayload.items.map((item) => item.id),
      ['app-reorder-first', 'app-reorder-second'],
      'unknown or omitted ids must not delete the remaining App follow-up',
    );
    const partialOrderState = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    assert.deepEqual(
      partialOrderState['queued-follow-ups'][appQueueReorderThreadId],
      [appQueueReorderFirstRawItem, appQueueReorderSecondRawItem],
    );

    const appQueueWithoutIdFirst = await fetch(`${baseUrl}/api/prompt-queues/${appQueueNoIdThreadId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(appQueueWithoutIdFirst.status, 200);
    const appQueueWithoutIdFirstPayload = await appQueueWithoutIdFirst.json();
    assert.equal(appQueueWithoutIdFirstPayload.items.length, 2);
    const stableNoIdItem = appQueueWithoutIdFirstPayload.items.find((item) => (
      item.message === 'Legacy Codex App prompt without an id'
    ));
    assert.match(stableNoIdItem?.id || '', /^codex-app-[0-9a-f]{24}$/);
    assert.equal(stableNoIdItem?.source, 'codex-app');
    const appQueueWithoutIdSecond = await fetch(`${baseUrl}/api/prompt-queues/${appQueueNoIdThreadId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(appQueueWithoutIdSecond.status, 200);
    const appQueueWithoutIdSecondPayload = await appQueueWithoutIdSecond.json();
    assert.deepEqual(appQueueWithoutIdSecondPayload.items, appQueueWithoutIdFirstPayload.items);

    const appStateAfterPredecessorRemoval = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    appStateAfterPredecessorRemoval['queued-follow-ups'][appQueueNoIdThreadId] = [{
      text: 'Legacy Codex App prompt without an id',
      createdAt: 1785204001000,
    }];
    await writeFile(codexGlobalStateFile, JSON.stringify(appStateAfterPredecessorRemoval));
    const appQueueAfterPredecessorRemoval = await fetch(`${baseUrl}/api/prompt-queues/${appQueueNoIdThreadId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(appQueueAfterPredecessorRemoval.status, 200);
    const appQueueAfterPredecessorRemovalPayload = await appQueueAfterPredecessorRemoval.json();
    assert.equal(appQueueAfterPredecessorRemovalPayload.items.length, 1);
    assert.equal(appQueueAfterPredecessorRemovalPayload.items[0].id, stableNoIdItem.id);

    const appStateAfterPredecessorInsert = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    appStateAfterPredecessorInsert['queued-follow-ups'][appQueueNoIdThreadId] = [
      {
        text: 'New predecessor without an id',
        createdAt: 1785204000750,
      },
      {
        text: 'Legacy Codex App prompt without an id',
        createdAt: 1785204001000,
      },
    ];
    await writeFile(codexGlobalStateFile, JSON.stringify(appStateAfterPredecessorInsert));
    const appQueueAfterPredecessorInsert = await fetch(`${baseUrl}/api/prompt-queues/${appQueueNoIdThreadId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(appQueueAfterPredecessorInsert.status, 200);
    const appQueueAfterPredecessorInsertPayload = await appQueueAfterPredecessorInsert.json();
    assert.equal(appQueueAfterPredecessorInsertPayload.items.length, 2);
    assert.equal(
      appQueueAfterPredecessorInsertPayload.items.find((item) => (
        item.message === 'Legacy Codex App prompt without an id'
      ))?.id,
      stableNoIdItem.id,
    );

    const duplicateNoIdQueueFirst = await fetch(
      `${baseUrl}/api/prompt-queues/${appQueueDuplicateNoIdThreadId}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(duplicateNoIdQueueFirst.status, 200);
    const duplicateNoIdQueueFirstPayload = await duplicateNoIdQueueFirst.json();
    assert.equal(duplicateNoIdQueueFirstPayload.items.length, 2);
    assert.equal(new Set(duplicateNoIdQueueFirstPayload.items.map((item) => item.id)).size, 2);

    const appStateAfterDuplicateRemoval = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    appStateAfterDuplicateRemoval['queued-follow-ups'][appQueueDuplicateNoIdThreadId] = [{
      text: 'Duplicate legacy prompt without an id',
      createdAt: 1785204002000,
    }];
    await writeFile(codexGlobalStateFile, JSON.stringify(appStateAfterDuplicateRemoval));
    const duplicateNoIdQueueAfterRemoval = await fetch(
      `${baseUrl}/api/prompt-queues/${appQueueDuplicateNoIdThreadId}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(duplicateNoIdQueueAfterRemoval.status, 200);
    assert.equal((await duplicateNoIdQueueAfterRemoval.json()).items.length, 1);

    const appStateAfterDuplicateRestore = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    appStateAfterDuplicateRestore['queued-follow-ups'][appQueueDuplicateNoIdThreadId] = [
      {
        text: 'Duplicate legacy prompt without an id',
        createdAt: 1785204002000,
      },
      {
        text: 'Duplicate legacy prompt without an id',
        createdAt: 1785204002000,
      },
    ];
    await writeFile(codexGlobalStateFile, JSON.stringify(appStateAfterDuplicateRestore));
    const duplicateNoIdQueueAfterRestore = await fetch(
      `${baseUrl}/api/prompt-queues/${appQueueDuplicateNoIdThreadId}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(duplicateNoIdQueueAfterRestore.status, 200);
    const duplicateNoIdQueueAfterRestorePayload = await duplicateNoIdQueueAfterRestore.json();
    assert.equal(duplicateNoIdQueueAfterRestorePayload.items.length, 2);
    assert.deepEqual(
      duplicateNoIdQueueAfterRestorePayload.items.map((item) => item.id),
      duplicateNoIdQueueFirstPayload.items.map((item) => item.id),
    );

    const attemptedAppQueueOverwrite = await fetch(`${baseUrl}/api/prompt-queues/${appQueueOwnershipThreadId}`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: appOwnedQueuePayload.revision, items: [] }),
    });
    assert.equal(attemptedAppQueueOverwrite.status, 200);
    const appQueueAfterOverwrite = await attemptedAppQueueOverwrite.json();
    assert.deepEqual(appQueueAfterOverwrite.items.map((item) => item.id), [appOwnedQueueItemId]);

    const attemptedAppQueueSourceSpoof = await fetch(`${baseUrl}/api/prompt-queues/${appQueueOwnershipThreadId}`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: appQueueAfterOverwrite.revision,
        items: [{
          id: appOwnedQueueItemId,
          message: 'Web attempted to take ownership',
          provider: 'fake',
          model: 'test-model',
          source: 'web',
        }],
      }),
    });
    assert.equal(attemptedAppQueueSourceSpoof.status, 200);
    const appQueueAfterSourceSpoof = await attemptedAppQueueSourceSpoof.json();
    assert.equal(appQueueAfterSourceSpoof.items.length, 1);
    assert.equal(appQueueAfterSourceSpoof.items[0].id, appOwnedQueueItemId);
    assert.equal(appQueueAfterSourceSpoof.items[0].source, 'codex-app');
    assert.equal(appQueueAfterSourceSpoof.items[0].message, 'Codex App owns this queued prompt');

    const appQueueTraceBefore = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((message) => ['turn/start', 'turn/steer', 'thread/start'].includes(message.method)).length;
    const attemptedAppQueueTurn = await fetch(`${baseUrl}/api/native-sessions/${appQueueOwnershipThreadId}/turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...concurrentTurnPayload,
        message: 'Codex App owns this queued prompt',
        queueItemId: appOwnedQueueItemId,
      }),
    });
    assert.equal(attemptedAppQueueTurn.status, 409);
    assert.match((await attemptedAppQueueTurn.json()).error, /Codex App 管理/);
    const appQueueTraceAfter = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((message) => ['turn/start', 'turn/steer', 'thread/start'].includes(message.method)).length;
    assert.equal(appQueueTraceAfter, appQueueTraceBefore);

    desktopIpc.ownerAvailable = true;
    const editedAppQueueMessage = 'Edited in Web without losing App context';
    const editedAppQueue = await fetch(
      `${baseUrl}/api/prompt-queues/${appQueueEditThreadId}/items/${appOwnedEditQueueRawItem.id}`,
      {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: editedAppQueueMessage }),
      },
    );
    const editedAppQueuePayload = await editedAppQueue.json();
    assert.equal(editedAppQueue.status, 200, editedAppQueuePayload.error);
    assert.equal(editedAppQueuePayload.updated.message, editedAppQueueMessage);
    assert.equal(editedAppQueuePayload.updated.source, 'codex-app');
    const stateAfterAppQueueEdit = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    assert.deepEqual(
      stateAfterAppQueueEdit['queued-follow-ups'][appQueueEditThreadId],
      [{
        ...appOwnedEditQueueRawItem,
        text: editedAppQueueMessage,
        context: {
          ...appOwnedEditQueueRawItem.context,
          prompt: editedAppQueueMessage,
        },
      }],
    );
    assert.deepEqual(
      stateAfterAppQueueEdit['queued-follow-ups'][appQueueOwnershipThreadId],
      [appOwnedQueueRawItem],
    );

    desktopIpc.ignoreNextQueuedFollowUpsBroadcast = true;
    desktopIpc.failNextQueuedFollowUpsSet = true;
    const failedAppQueueDelete = await fetch(
      `${baseUrl}/api/prompt-queues/${appQueueOwnershipThreadId}/items/${appOwnedQueueItemId}`,
      { method: 'DELETE', headers: { Cookie: cookie } },
    );
    assert.equal(failedAppQueueDelete.status, 502);
    assert.match((await failedAppQueueDelete.json()).error, /controlled-queued-follow-ups-failure/);
    const stateAfterFailedAppQueueDelete = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    assert.deepEqual(
      stateAfterFailedAppQueueDelete['queued-follow-ups'][appQueueOwnershipThreadId],
      [appOwnedQueueRawItem],
    );
    const queueAfterFailedAppQueueDelete = await fetch(
      `${baseUrl}/api/prompt-queues/${appQueueOwnershipThreadId}`,
      { headers: { Cookie: cookie } },
    );
    assert.deepEqual(
      (await queueAfterFailedAppQueueDelete.json()).items.map((item) => item.id),
      [appOwnedQueueItemId],
    );

    desktopIpc.ignoreNextQueuedFollowUpsBroadcast = true;
    desktopIpc.failAfterWriteNextQueuedFollowUpsSet = true;
    const desktopMessagesBeforeFailedAfterWriteDelete = desktopIpc.messages.length;
    const failedAfterWriteAppQueueDelete = await fetch(
      `${baseUrl}/api/prompt-queues/${appQueueOwnershipThreadId}/items/${appOwnedQueueItemId}`,
      { method: 'DELETE', headers: { Cookie: cookie } },
    );
    assert.equal(failedAfterWriteAppQueueDelete.status, 200);
    const failedAfterWriteDeletePayload = await failedAfterWriteAppQueueDelete.json();
    assert.deepEqual(failedAfterWriteDeletePayload.items, []);
    const stateAfterFailedAfterWriteDelete = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    assert.equal(stateAfterFailedAfterWriteDelete['queued-follow-ups'][appQueueOwnershipThreadId], undefined);
    assert.deepEqual(
      desktopIpc.messages.slice(desktopMessagesBeforeFailedAfterWriteDelete)
        .filter((message) => message.method === 'thread-follower-set-queued-follow-ups-state')
        .map((message) => message.method),
      ['thread-follower-set-queued-follow-ups-state'],
    );

    const stateBeforeAppQueueSteer = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    stateBeforeAppQueueSteer['queued-follow-ups'][appQueueOwnershipThreadId] = [appOwnedQueueRawItem];
    await writeFile(codexGlobalStateFile, JSON.stringify(stateBeforeAppQueueSteer));
    const reloadedAppQueueBeforeSteer = await fetch(
      `${baseUrl}/api/prompt-queues/${appQueueOwnershipThreadId}`,
      { headers: { Cookie: cookie } },
    );
    assert.deepEqual((await reloadedAppQueueBeforeSteer.json()).items.map((item) => item.id), [appOwnedQueueItemId]);

    const desktopMessagesBeforeAppQueueSteer = desktopIpc.messages.length;
    const appQueueSteer = await fetch(`${baseUrl}/api/native-sessions/${appQueueOwnershipThreadId}/steer`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'stale browser copy must not win',
        turnId: 'app-owned-running-turn',
        queueItemId: appOwnedQueueItemId,
      }),
    });
    const appQueueSteerPayload = await appQueueSteer.json();
    assert.equal(appQueueSteer.status, 202, appQueueSteerPayload.error);
    assert.deepEqual(appQueueSteerPayload.queue.items, []);
    const stateAfterAppQueueSteer = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    assert.equal(stateAfterAppQueueSteer['queued-follow-ups'][appQueueOwnershipThreadId], undefined);
    const appQueueSteerDesktopMessages = desktopIpc.messages.slice(desktopMessagesBeforeAppQueueSteer);
    assert.deepEqual(
      appQueueSteerDesktopMessages
        .filter((message) => /queued-follow-?ups/.test(message.method || '') || message.method === 'thread-follower-steer-turn')
        .map((message) => message.method),
      ['thread-queued-followups-changed', 'thread-follower-steer-turn'],
    );
    const appQueueSteerDesktop = appQueueSteerDesktopMessages.find((message) => (
      message.method === 'thread-follower-steer-turn'
    ));
    const appQueueSteerText = appQueueSteerDesktop?.params?.input?.[0]?.text || '';
    assert.match(appQueueSteerText, /# Files mentioned by the user:/);
    assert.match(appQueueSteerText, /queue-context\.mjs/);
    assert.match(appQueueSteerText, /# Browser comments:/);
    assert.match(appQueueSteerText, /Codex App owns this queued prompt/);
    assert.match(appQueueSteerText, /Page URL: http:\/\/127\.0\.0\.1:36354\/rich-queue/);
    assert.match(appQueueSteerText, /<in-app-browser-context source="ambient-ui-state">/);
    assert.match(appQueueSteerText, /## My request for Codex:/);
    assert.deepEqual(
      appQueueSteerDesktop.params.input.slice(1).map(({ type }) => type),
      ['localImage', 'text', 'image'],
    );
    assert.equal(appQueueSteerDesktop.params.input[1].path, toolImagePath);
    assert.equal(appQueueSteerDesktop.params.input[3].url, appQueueInlineImage);
    assert.deepEqual(appQueueSteerDesktop.params.restoreMessage, appOwnedQueueRawItem);
    assert.deepEqual(
      appQueueSteerDesktop.params.attachments.map((attachment) => attachment.path),
      [
        path.join(temporary, 'queue-context.mjs'),
        path.join(temporary, 'pasted-text.txt'),
        path.join(temporary, 'added-context.mjs'),
        toolImagePath,
      ],
    );

    const appOwnedSideChatRawItem = {
      ...appOwnedQueueRawItem,
      id: 'app-owned-side-chat-item',
      text: 'Side chat owns this queued prompt',
      context: { ...appOwnedQueueRawItem.context, prompt: 'Side chat owns this queued prompt' },
    };
    const stateBeforeAppQueueSideChat = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    stateBeforeAppQueueSideChat['queued-follow-ups'][appQueueOwnershipThreadId] = [appOwnedSideChatRawItem];
    await writeFile(codexGlobalStateFile, JSON.stringify(stateBeforeAppQueueSideChat));
    const reloadedAppQueueBeforeSideChat = await fetch(`${baseUrl}/api/prompt-queues/${appQueueOwnershipThreadId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal((await reloadedAppQueueBeforeSideChat.json()).items.length, 1);
    const appQueueSideChat = await fetch(`${baseUrl}/api/native-sessions`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...concurrentTurnPayload,
        message: 'Side chat owns this queued prompt',
        sideChat: true,
        sourceThreadId: appQueueOwnershipThreadId,
        queueItemId: appOwnedSideChatRawItem.id,
      }),
    });
    const appQueueSideChatPayload = await appQueueSideChat.json();
    assert.equal(appQueueSideChat.status, 202, appQueueSideChatPayload.error);
    assert.ok(String(appQueueSideChatPayload.threadId || '').trim());
    const queueAfterAppQueueSideChat = await fetch(`${baseUrl}/api/prompt-queues/${appQueueOwnershipThreadId}`, {
      headers: { Cookie: cookie },
    });
    assert.deepEqual((await queueAfterAppQueueSideChat.json()).items, []);
    const appQueueTraceBeforeRemoval = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((message) => ['turn/start', 'turn/steer', 'thread/start'].includes(message.method)).length;

    const timeoutSteerText = 'Desktop write then timeout must reconcile exactly once';
    const timeoutSteerRawItem = {
      id: 'app-owned-steer-timeout-item',
      text: timeoutSteerText,
      context: {
        prompt: timeoutSteerText,
        workspaceRoots: [temporary],
      },
      cwd: temporary,
      createdAt: 1785204000200,
    };
    const stateBeforeTimeoutSteer = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    stateBeforeTimeoutSteer['queued-follow-ups'][nativeSessionId] = [timeoutSteerRawItem];
    await writeFile(codexGlobalStateFile, JSON.stringify(stateBeforeTimeoutSteer));
    const timeoutSteerQueue = await fetch(`${baseUrl}/api/prompt-queues/${nativeSessionId}`, {
      headers: { Cookie: cookie },
    });
    const timeoutSteerQueuePayload = await timeoutSteerQueue.json();
    assert.equal(timeoutSteerQueue.status, 200, timeoutSteerQueuePayload.error);
    assert.deepEqual(timeoutSteerQueuePayload.items.map((item) => item.id), [timeoutSteerRawItem.id]);

    desktopIpc.steerMode = 'echo-only';
    desktopIpc.onSteer = async (message) => {
      const text = message.params.input.find((item) => item.type === 'text')?.text || '';
      assert.match(text, new RegExp(timeoutSteerText));
      assert.equal(message.params.restoreMessage.id, timeoutSteerRawItem.id);
      assert.equal(message.params.restoreMessage.text, timeoutSteerRawItem.text);
      assert.equal(message.params.restoreMessage.context.prompt, timeoutSteerText);
      assert.deepEqual(message.params.restoreMessage.context.workspaceRoots, [temporary]);
      await appendFile(nativeSessionFile, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      })}\n`);
    };
    const desktopMessagesBeforeTimeoutSteer = desktopIpc.messages.length;
    const timeoutSteerStartedAt = Date.now();
    let timeoutSteer;
    try {
      timeoutSteer = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/steer`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'stale browser copy must not win after timeout',
          turnId: echoedContinuationPayload.turnId,
          queueItemId: timeoutSteerRawItem.id,
        }),
      });
    } finally {
      desktopIpc.steerMode = 'respond';
      desktopIpc.onSteer = null;
    }
    const timeoutSteerPayload = await timeoutSteer.json();
    assert.equal(timeoutSteer.status, 202, timeoutSteerPayload.error);
    assert.equal(timeoutSteerPayload.turnId, echoedContinuationPayload.turnId);
    assert.deepEqual(timeoutSteerPayload.queue.items, []);
    assert.ok(Date.now() - timeoutSteerStartedAt < 3000, 'native steer echo did not win before the 5s IPC timeout');
    assert.equal(desktopIpc.lastError, null);
    const stateAfterTimeoutSteer = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    assert.equal(stateAfterTimeoutSteer['queued-follow-ups'][nativeSessionId], undefined);
    const timeoutSteerDesktopMessages = desktopIpc.messages.slice(desktopMessagesBeforeTimeoutSteer)
      .filter((message) => /queued-follow-?ups/.test(message.method || '') || message.method === 'thread-follower-steer-turn');
    assert.deepEqual(
      timeoutSteerDesktopMessages.map((message) => message.method),
      ['thread-queued-followups-changed', 'thread-follower-steer-turn'],
    );
    const timeoutSteerRequests = timeoutSteerDesktopMessages.filter((message) => (
      message.method === 'thread-follower-steer-turn'
    ));
    assert.equal(timeoutSteerRequests.length, 1);
    assert.match(timeoutSteerRequests[0].params.clientUserMessageId, /^[a-f0-9]{32}$/);
    assert.equal((await readFile(nativeSessionFile, 'utf8')).split(timeoutSteerText).length - 1, 1);
    const interruptedTimeoutSteer = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: timeoutSteerPayload.turnId }),
    });
    assert.equal(interruptedTimeoutSteer.status, 200);

    const stateBeforeFailedAppQueueSteer = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    stateBeforeFailedAppQueueSteer['queued-follow-ups'][appQueueOwnershipThreadId] = [appOwnedQueueRawItem];
    await writeFile(codexGlobalStateFile, JSON.stringify(stateBeforeFailedAppQueueSteer));
    const restoredAppQueue = await fetch(`${baseUrl}/api/prompt-queues/${appQueueOwnershipThreadId}`, {
      headers: { Cookie: cookie },
    });
    assert.deepEqual((await restoredAppQueue.json()).items.map((item) => item.id), [appOwnedQueueItemId]);

    desktopIpc.failNextSteer = true;
    const desktopMessagesBeforeFailedSteer = desktopIpc.messages.length;
    const failedAppQueueSteer = await fetch(`${baseUrl}/api/native-sessions/${appQueueOwnershipThreadId}/steer`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Codex App owns this queued prompt',
        turnId: 'app-owned-running-turn',
        queueItemId: appOwnedQueueItemId,
      }),
    });
    assert.equal(failedAppQueueSteer.status, 502);
    assert.match((await failedAppQueueSteer.json()).error, /controlled-steer-failure/);
    const stateAfterFailedAppQueueSteer = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    assert.deepEqual(stateAfterFailedAppQueueSteer['queued-follow-ups'][appQueueOwnershipThreadId], [appOwnedQueueRawItem]);
    assert.deepEqual(
      desktopIpc.messages.slice(desktopMessagesBeforeFailedSteer)
        .filter((message) => /queued-follow-?ups/.test(message.method || '') || message.method === 'thread-follower-steer-turn')
        .map((message) => message.method),
      [
        'thread-queued-followups-changed',
        'thread-follower-steer-turn',
        'thread-queued-followups-changed',
      ],
    );

    const appQueueDelete = await fetch(
      `${baseUrl}/api/prompt-queues/${appQueueOwnershipThreadId}/items/${appOwnedQueueItemId}`,
      { method: 'DELETE', headers: { Cookie: cookie } },
    );
    assert.equal(appQueueDelete.status, 200);
    const appQueueDeletePayload = await appQueueDelete.json();
    assert.equal(appQueueDeletePayload.consumed.source, 'codex-app');
    assert.deepEqual(appQueueDeletePayload.items, []);
    const stateAfterAppQueueDelete = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    assert.equal(stateAfterAppQueueDelete['queued-follow-ups'][appQueueOwnershipThreadId], undefined);
    desktopIpc.ownerAvailable = false;

    const codexGlobalState = JSON.parse(await readFile(codexGlobalStateFile, 'utf8'));
    delete codexGlobalState['queued-follow-ups'];
    await writeFile(codexGlobalStateFile, JSON.stringify(codexGlobalState));
    const appQueueAfterAppRemoval = await fetch(`${baseUrl}/api/prompt-queues/${appQueueOwnershipThreadId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(appQueueAfterAppRemoval.status, 200);
    assert.deepEqual((await appQueueAfterAppRemoval.json()).items, []);
    const appQueueWithoutIdAfterAppRemoval = await fetch(`${baseUrl}/api/prompt-queues/${appQueueNoIdThreadId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(appQueueWithoutIdAfterAppRemoval.status, 200);
    assert.deepEqual((await appQueueWithoutIdAfterAppRemoval.json()).items, []);
    const duplicateNoIdQueueAfterAppRemoval = await fetch(
      `${baseUrl}/api/prompt-queues/${appQueueDuplicateNoIdThreadId}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(duplicateNoIdQueueAfterAppRemoval.status, 200);
    assert.deepEqual((await duplicateNoIdQueueAfterAppRemoval.json()).items, []);
    const appQueueTraceAfterRemoval = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((message) => ['turn/start', 'turn/steer', 'thread/start'].includes(message.method)).length;
    assert.equal(appQueueTraceAfterRemoval, appQueueTraceBeforeRemoval);

    const backgroundBeaconThreadId = '019f4f84-ea9f-73c2-b997-deba7b4aa739';
    const backgroundBeaconFirst = {
      id: 'background-beacon-first',
      message: 'persist while the phone is backgrounded',
      createdAt: '2026-08-03T01:00:00.000Z',
      source: 'web',
    };
    const backgroundBeaconSecond = {
      id: 'background-beacon-second',
      message: 'keep the server order intact',
      createdAt: '2026-08-03T01:00:01.000Z',
      source: 'web',
    };
    const appendBackgroundBeacon = (item) => fetch(
      `${baseUrl}/api/prompt-queues/${backgroundBeaconThreadId}/append-beacon`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ item }),
      },
    );
    assert.equal((await appendBackgroundBeacon(backgroundBeaconFirst)).status, 204);
    assert.equal((await appendBackgroundBeacon(backgroundBeaconSecond)).status, 204);
    assert.equal((await appendBackgroundBeacon(backgroundBeaconFirst)).status, 204, 'a delayed duplicate beacon is harmless');
    const backgroundBeaconQueue = await fetch(`${baseUrl}/api/prompt-queues/${backgroundBeaconThreadId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(backgroundBeaconQueue.status, 200);
    const backgroundBeaconPayload = await backgroundBeaconQueue.json();
    assert.deepEqual(backgroundBeaconPayload.items.map((item) => item.id), [
      backgroundBeaconFirst.id,
      backgroundBeaconSecond.id,
    ]);
    assert.ok(backgroundBeaconPayload.items.every((item) => item.source === 'web' && item.autoDispatch === true));
    const rejectedAppBeacon = await appendBackgroundBeacon({
      id: 'spoofed-app-item',
      message: 'must not take over Codex App queue ownership',
      source: 'codex-app',
    });
    assert.equal(rejectedAppBeacon.status, 400);
    const rejectedIdlessBeacon = await appendBackgroundBeacon({ message: 'must have a stable id', source: 'web' });
    assert.equal(rejectedIdlessBeacon.status, 400);

    const queueItemA = {
      id: 'queue-client-a',
      message: 'same queue prompt',
      serviceTier: 'priority',
      createdAt: '2026-07-26T10:00:00.000Z',
      source: 'web',
      autoDispatch: false,
    };
    const queueItemB = {
      id: 'queue-client-b',
      message: 'same queue prompt',
      serviceTier: null,
      createdAt: '2026-07-26T10:00:01.000Z',
      source: 'web',
      autoDispatch: false,
    };
    const queueBaseline = await fetch(`${baseUrl}/api/prompt-queues/${nativeSessionId}`, {
      headers: { Cookie: cookie },
    });
    const queueBaselinePayload = await queueBaseline.json();
    assert.equal(queueBaseline.status, 200, queueBaselinePayload.error);
    assert.deepEqual(queueBaselinePayload.items, []);
    const queueClientA = await fetch(`${baseUrl}/api/prompt-queues/${nativeSessionId}`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: queueBaselinePayload.revision, items: [queueItemA] }),
    });
    assert.equal(queueClientA.status, 200);
    const queueClientAPayload = await queueClientA.json();
    assert.equal(queueClientAPayload.revision, queueBaselinePayload.revision + 1);
    const staleQueueClientB = await fetch(`${baseUrl}/api/prompt-queues/${nativeSessionId}`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: queueBaselinePayload.revision, items: [queueItemB] }),
    });
    assert.equal(staleQueueClientB.status, 409);
    const staleQueuePayload = await staleQueueClientB.json();
    assert.deepEqual(staleQueuePayload.items.map((item) => item.id), [queueItemA.id]);
    const mergedQueueClientB = await fetch(`${baseUrl}/api/prompt-queues/${nativeSessionId}`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: staleQueuePayload.revision,
        items: [queueItemB, ...staleQueuePayload.items],
      }),
    });
    assert.equal(mergedQueueClientB.status, 200);
    const mergedQueuePayload = await mergedQueueClientB.json();
    assert.deepEqual(mergedQueuePayload.items.map((item) => item.id), [queueItemB.id, queueItemA.id]);
    assert.deepEqual(mergedQueuePayload.items.map((item) => item.serviceTier), [null, 'priority']);

    const queueTurn = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...concurrentTurnPayload,
        message: queueItemA.message,
        serviceTier: queueItemA.serviceTier,
        queueItemId: queueItemA.id,
      }),
    });
    assert.equal(queueTurn.status, 202);
    const queueTurnPayload = await queueTurn.json();
    assert.deepEqual(queueTurnPayload.queue.items.map((item) => item.id), [queueItemB.id]);
    const queueAfterTurn = await fetch(`${baseUrl}/api/prompt-queues/${nativeSessionId}`, {
      headers: { Cookie: cookie },
    });
    const queueAfterTurnPayload = await queueAfterTurn.json();
    assert.deepEqual(queueAfterTurnPayload.items.map((item) => item.id), [queueItemB.id]);
    assert.deepEqual(queueAfterTurnPayload.dismissedItemIds, [queueItemA.id]);
    const staleQueueAfterConsume = await fetch(`${baseUrl}/api/prompt-queues/${nativeSessionId}`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: mergedQueuePayload.revision, items: [queueItemA, queueItemB] }),
    });
    assert.equal(staleQueueAfterConsume.status, 409);
    const staleAfterConsumePayload = await staleQueueAfterConsume.json();
    assert.deepEqual(staleAfterConsumePayload.items.map((item) => item.id), [queueItemB.id]);
    assert.deepEqual(staleAfterConsumePayload.dismissedItemIds, [queueItemA.id]);
    const retriedQueueAfterConsume = await fetch(`${baseUrl}/api/prompt-queues/${nativeSessionId}`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: staleAfterConsumePayload.revision, items: [queueItemA, queueItemB] }),
    });
    assert.equal(retriedQueueAfterConsume.status, 200);
    const retriedQueueAfterConsumePayload = await retriedQueueAfterConsume.json();
    assert.deepEqual(retriedQueueAfterConsumePayload.items.map((item) => item.id), [queueItemB.id]);
    const steerQueueItem = {
      id: 'queue-steer',
      message: 'steer queue prompt',
      createdAt: '2026-07-26T10:00:01.500Z',
      source: 'web',
      autoDispatch: false,
    };
    const queuedSteerItem = await fetch(`${baseUrl}/api/prompt-queues/${nativeSessionId}`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: retriedQueueAfterConsumePayload.revision,
        items: [queueItemB, steerQueueItem],
      }),
    });
    assert.equal(queuedSteerItem.status, 200);
    const queueSteer = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/steer`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: steerQueueItem.message,
        turnId: queueTurnPayload.turnId,
        queueItemId: steerQueueItem.id,
      }),
    });
    assert.equal(queueSteer.status, 202);
    const queueSteerPayload = await queueSteer.json();
    assert.deepEqual(queueSteerPayload.queue.items.map((item) => item.id), [queueItemB.id]);
    const steersBeforeDuplicateQueue = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((message) => message.method === 'turn/steer').length;
    const duplicateQueueSteer = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/steer`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: steerQueueItem.message,
        turnId: queueTurnPayload.turnId,
        queueItemId: steerQueueItem.id,
      }),
    });
    assert.equal(duplicateQueueSteer.status, 409);
    assert.match((await duplicateQueueSteer.json()).error, /不存在|已消费/);
    const steersAfterDuplicateQueue = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((message) => message.method === 'turn/steer').length;
    assert.equal(steersAfterDuplicateQueue, steersBeforeDuplicateQueue);
    const interruptedQueueTurn = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: queueTurnPayload.turnId }),
    });
    assert.equal(interruptedQueueTurn.status, 200);
    const turnStartsBeforeDuplicateQueue = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((message) => message.method === 'turn/start').length;
    const duplicateQueueTurn = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...concurrentTurnPayload,
        message: queueItemA.message,
        queueItemId: queueItemA.id,
      }),
    });
    assert.equal(duplicateQueueTurn.status, 409);
    assert.match((await duplicateQueueTurn.json()).error, /不存在|已消费/);
    const turnStartsAfterDuplicateQueue = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((message) => message.method === 'turn/start').length;
    assert.equal(turnStartsAfterDuplicateQueue, turnStartsBeforeDuplicateQueue);

    const runningSideChatId = '019f4f84-ea9f-73c2-b997-deba7b4aa740';
    await writeFile(appServerControlFile, JSON.stringify({ threadStartId: runningSideChatId }));
    const runningSideChat = await fetch(`${baseUrl}/api/native-sessions`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...concurrentTurnPayload,
        message: queueItemB.message,
        serviceTier: queueItemB.serviceTier,
        sideChat: true,
        sourceThreadId: nativeSessionId,
        queueItemId: queueItemB.id,
      }),
    });
    assert.equal(runningSideChat.status, 202);
    const runningSideChatPayload = await runningSideChat.json();
    assert.equal(runningSideChatPayload.threadId, runningSideChatId);
    assert.deepEqual(runningSideChatPayload.queue.items, []);
    const sideChatStateFile = path.join(runtime, 'side-chat-threads.json');
    await writeFile(appServerControlFile, JSON.stringify({
      threadStartId: runningSideChatId,
      failArchiveThreadId: runningSideChatId,
    }));
    const closeRunningSideChat = await fetch(`${baseUrl}/api/native-sessions/${runningSideChatId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(closeRunningSideChat.status, 502);
    assert.match((await closeRunningSideChat.json()).error, /controlled thread\/archive failure/);
    assert.ok(desktopIpc.messages.some((message) => (
      message.method === 'thread-follower-interrupt-turn'
      && message.params?.conversationId === runningSideChatId
    )));
    const runningSideChatState = JSON.parse(await readFile(sideChatStateFile, 'utf8'));
    assert.ok(runningSideChatState['side-chat-thread-ids'].includes(runningSideChatId));
    const runningArchiveAttempts = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((message) => message.method === 'thread/archive' && message.params?.threadId === runningSideChatId);
    assert.equal(runningArchiveAttempts.length, 1);
    await writeFile(appServerControlFile, JSON.stringify({ threadStartId: runningSideChatId }));
    const closedSideChat = await fetch(`${baseUrl}/api/native-sessions/${runningSideChatId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(closedSideChat.status, 200);
    const closedSideChatState = JSON.parse(await readFile(sideChatStateFile, 'utf8'));
    assert.equal(closedSideChatState['side-chat-thread-ids'].includes(runningSideChatId), false);
    const restoredRunningSideChat = await fetch(
      `${baseUrl}/api/native-archived-sessions/${runningSideChatId}/unarchive`,
      { method: 'POST', headers: { Cookie: cookie } },
    );
    assert.equal(restoredRunningSideChat.status, 200);

    const failedSideChatId = '019f4f84-ea9f-73c2-b997-deba7b4aa741';
    const queueBeforeFailedSideChat = await fetch(`${baseUrl}/api/prompt-queues/${nativeSessionId}`, {
      headers: { Cookie: cookie },
    });
    const queueBeforeFailedSideChatPayload = await queueBeforeFailedSideChat.json();
    const failedSideChatQueueItem = {
      id: 'queue-sidechat-failure',
      message: 'fail side chat second stage',
      createdAt: '2026-07-26T10:00:02.000Z',
      source: 'web',
      autoDispatch: false,
    };
    const queuedFailedSideChat = await fetch(`${baseUrl}/api/prompt-queues/${nativeSessionId}`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: queueBeforeFailedSideChatPayload.revision,
        items: [failedSideChatQueueItem],
      }),
    });
    assert.equal(queuedFailedSideChat.status, 200);
    await writeFile(appServerControlFile, JSON.stringify({
      threadStartId: failedSideChatId,
      failTurnStartText: failedSideChatQueueItem.message,
      failArchiveThreadId: failedSideChatId,
    }));
    const failedSideChat = await fetch(`${baseUrl}/api/native-sessions`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...concurrentTurnPayload,
        message: failedSideChatQueueItem.message,
        sideChat: true,
        sourceThreadId: nativeSessionId,
        queueItemId: failedSideChatQueueItem.id,
      }),
    });
    assert.equal(failedSideChat.status, 502);
    const failedSideChatPayload = await failedSideChat.json();
    assert.match(failedSideChatPayload.error, /controlled turn\/start failure/);
    assert.equal(failedSideChatPayload.recoverableThreadId, failedSideChatId);
    const failedSideChatState = JSON.parse(await readFile(sideChatStateFile, 'utf8'));
    assert.equal(failedSideChatState['side-chat-thread-ids'].includes(failedSideChatId), false);
    const queueAfterFailedSideChat = await fetch(`${baseUrl}/api/prompt-queues/${nativeSessionId}`, {
      headers: { Cookie: cookie },
    });
    assert.deepEqual((await queueAfterFailedSideChat.json()).items.map((item) => item.id), [failedSideChatQueueItem.id]);
    const failedSideChatArchive = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((message) => message.method === 'thread/archive' && message.params?.threadId === failedSideChatId);
    assert.equal(failedSideChatArchive.length, 1);
    const failedSideChatTrace = await waitForAppServerTrace(
      appServerTraceFile,
      (messages) => messages.some((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === failedSideChatId
      )),
      'failed Web side chat did not release its app-server subscription',
    );
    assert.equal(
      failedSideChatTrace.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === failedSideChatId
      )).length,
      1,
    );
    await writeFile(appServerControlFile, '{}');
    const clearFailedSideChatQueue = await fetch(
      `${baseUrl}/api/prompt-queues/${nativeSessionId}/items/${failedSideChatQueueItem.id}`,
      { method: 'DELETE', headers: { Cookie: cookie } },
    );
    assert.equal(clearFailedSideChatQueue.status, 200);

    const blockedWrite = await fetch(`${baseUrl}/api/defaults`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'fake', model: 'test-model' }),
    });
    assert.equal(blockedWrite.status, 403);

    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'reply once',
        provider: 'fake',
        model: 'test-model',
        reasoningEffort: 'max',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'untrusted',
      }),
    });
    assert.equal(chat.status, 200);
    assert.match(await chat.text(), /FAKE_OK/);

    const trace = JSON.parse(await readFile(traceFile, 'utf8'));
    assert.deepEqual(trace.args.slice(0, 3), ['-a', 'untrusted', 'exec']);
    assert.ok(trace.args.includes('model_reasoning_effort="max"'));
    assert.equal(trace.codexHome, codexHome);
    assert.equal(trace.home, temporary);
    assert.equal(trace.sub2ApiKey, undefined);

    const customPermissionChat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'use config permissions',
        provider: 'fake',
        model: 'test-model',
        cwd: temporary,
        permissionMode: 'custom',
      }),
    });
    assert.equal(customPermissionChat.status, 200);
    assert.match(await customPermissionChat.text(), /FAKE_OK/);
    const customPermissionTrace = JSON.parse(await readFile(traceFile, 'utf8'));
    assert.equal(customPermissionTrace.args.includes('-a'), false);
    assert.equal(customPermissionTrace.args.includes('-s'), false);
    assert.equal(customPermissionTrace.args[0], 'exec');

    const created = await fetch(`${baseUrl}/api/native-sessions`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'create native thread',
        provider: 'fake',
        model: 'test-model',
        reasoningEffort: 'max',
        serviceTier: 'priority',
        cwd: temporary,
        sandbox: 'workspace-write',
        approval: 'on-request',
      }),
    });
    assert.equal(created.status, 202);
    const createdPayload = await created.json();
    assert.equal(createdPayload.threadId, createdNativeSessionId);
    assert.ok(createdPayload.turnId);

    const traceBeforeCreatedInterrupt = await readAppServerTrace(appServerTraceFile);
    const interrupted = await fetch(`${baseUrl}/api/native-sessions/${createdNativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: createdPayload.turnId }),
    });
    assert.equal(interrupted.status, 200);
    const createdInterruptTrace = await waitForAppServerTrace(
      appServerTraceFile,
      (messages) => messages.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === createdNativeSessionId
      )).length > traceBeforeCreatedInterrupt.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === createdNativeSessionId
      )).length,
      'Web interrupt did not release its app-server subscription',
    );
    const createdInterruptUnsubscribeCount = createdInterruptTrace.filter((message) => (
      message.method === 'thread/unsubscribe'
      && message.params?.threadId === createdNativeSessionId
    )).length;
    const beforeCreatedInterruptUnsubscribeCount = traceBeforeCreatedInterrupt.filter((message) => (
      message.method === 'thread/unsubscribe'
      && message.params?.threadId === createdNativeSessionId
    )).length;
    assert.ok(
      createdInterruptUnsubscribeCount > beforeCreatedInterruptUnsubscribeCount,
      'Web interrupt must release its app-server subscription',
    );

    const renamed = await fetch(`${baseUrl}/api/native-sessions/${createdNativeSessionId}`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed native thread' }),
    });
    assert.equal(renamed.status, 200);

    const protocolBeforeThreadSettingsUpdate = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const updatedThreadSettings = await fetch(`${baseUrl}/api/native-sessions/${createdNativeSessionId}`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'switchtest', model: 'switch-model', reasoningEffort: 'xhigh' }),
    });
    assert.equal(updatedThreadSettings.status, 200);
    const updatedThreadSettingsPayload = await updatedThreadSettings.json();
    assert.equal(updatedThreadSettingsPayload.provider, 'switchtest');
    assert.equal(updatedThreadSettingsPayload.model, 'switch-model');
    assert.equal(updatedThreadSettingsPayload.reasoningEffort, 'xhigh');
    const threadSettingsProtocol = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .slice(protocolBeforeThreadSettingsUpdate.length);
    assert.ok(threadSettingsProtocol.some((message) => message.type === 'process_env'));
    const threadSettingsCalls = threadSettingsProtocol
      .filter((message) => ['thread/resume', 'thread/settings/update'].includes(message.method));
    assert.equal(threadSettingsCalls.length, 2);
    assert.equal(threadSettingsCalls[0].method, 'thread/resume');
    assert.deepEqual(threadSettingsCalls[0].params, {
      threadId: createdNativeSessionId,
      modelProvider: 'switchtest',
      model: 'switch-model',
      excludeTurns: true,
    });
    assert.equal(threadSettingsCalls[1].method, 'thread/settings/update');
    assert.deepEqual(threadSettingsCalls[1].params, {
      threadId: createdNativeSessionId,
      model: 'switch-model',
      effort: 'xhigh',
    });
    assert.equal(
      threadSettingsProtocol.filter((message) => (
        message.method === 'thread/unsubscribe'
        && message.params?.threadId === createdNativeSessionId
      )).length,
      1,
      'settings update did not release the temporary Web subscription',
    );

    const protocolBeforeSameProviderUpdate = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const sameProviderSettings = await fetch(`${baseUrl}/api/native-sessions/${createdNativeSessionId}`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'switchtest', model: 'switch-model' }),
    });
    assert.equal(sameProviderSettings.status, 200);
    const sameProviderProtocol = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .slice(protocolBeforeSameProviderUpdate.length);
    assert.equal(sameProviderProtocol.some((message) => message.type === 'process_env'), false);

    const archived = await fetch(`${baseUrl}/api/native-sessions/${createdNativeSessionId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(archived.status, 200);
    assert.ok(desktopIpc.messages.some((message) => (
      message.type === 'broadcast'
      && message.method === 'thread-archived'
      && message.version === 2
      && message.params?.hostId === 'local'
      && message.params?.conversationId === createdNativeSessionId
      && message.params?.cwd === temporary
    )));

    const deletedArchivedTask = await fetch(
      `${baseUrl}/api/native-archived-sessions/${createdNativeSessionId}`,
      { method: 'DELETE', headers: { Cookie: cookie } },
    );
    assert.equal(deletedArchivedTask.status, 200);
    assert.equal((await deletedArchivedTask.json()).id, createdNativeSessionId);

    const continued = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'needs approval',
        provider: 'fake',
        model: 'test-model',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'on-request',
      }),
    });
    assert.equal(continued.status, 202);
    const continuedPayload = await continued.json();

    const steered = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/steer`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'change direction while running',
        turnId: continuedPayload.turnId,
      }),
    });
    assert.equal(steered.status, 202);
    assert.equal((await steered.json()).turnId, continuedPayload.turnId);

    const pendingRequest = await waitForPendingRequest(baseUrl, cookie);
    assert.equal(pendingRequest.method, 'item/commandExecution/requestApproval');
    assert.equal(pendingRequest.threadId, nativeSessionId);

    const approved = await fetch(`${baseUrl}/api/native-requests/${pendingRequest.id}/respond`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'accept' }),
    });
    assert.equal(approved.status, 200);

    const interruptCountBeforeRunningArchive = desktopIpc.messages.filter((message) => (
      message.method === 'thread-follower-interrupt-turn'
      && message.params?.conversationId === nativeSessionId
    )).length;
    const runningProjectArchive = await fetch(`${baseUrl}/api/native-projects/archive`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: temporary }),
    });
    assert.equal(runningProjectArchive.status, 200);
    const runningProjectArchivePayload = await runningProjectArchive.json();
    assert.deepEqual(runningProjectArchivePayload.archived, [nativeSessionId]);
    assert.equal(
      desktopIpc.messages.filter((message) => (
        message.method === 'thread-follower-interrupt-turn'
        && message.params?.conversationId === nativeSessionId
      )).length,
      interruptCountBeforeRunningArchive + 1,
    );

    const restoredRunningProjectSession = await fetch(
      `${baseUrl}/api/native-archived-sessions/${nativeSessionId}/unarchive`,
      { method: 'POST', headers: { Cookie: cookie } },
    );
    assert.equal(restoredRunningProjectSession.status, 200);

    const desktopStartsBeforeProviderSwitch = desktopIpc.messages.filter(
      (message) => message.method === 'thread-follower-start-turn',
    ).length;
    const mismatchedProvider = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'switch native provider',
        provider: 'custom',
        model: 'custom-model',
        reasoningEffort: 'max',
        serviceTier: 'priority',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'on-request',
      }),
    });
    assert.equal(mismatchedProvider.status, 202);
    const mismatchedProviderPayload = await mismatchedProvider.json();
    assert.equal(
      desktopIpc.messages.filter((message) => message.method === 'thread-follower-start-turn').length,
      desktopStartsBeforeProviderSwitch,
    );
    const mismatchedProviderConversation = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}`,
      { headers: { Cookie: cookie } },
    );
    const mismatchedProviderMetadata = (await mismatchedProviderConversation.json()).conversation.metadata;
    assert.equal(mismatchedProviderMetadata.modelProvider, 'custom');
    assert.equal(mismatchedProviderMetadata.model, 'custom-model');

    const mismatchedInterrupted = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: mismatchedProviderPayload.turnId }),
    });
    assert.equal(mismatchedInterrupted.status, 200);

    const archivedProject = await fetch(`${baseUrl}/api/native-projects/archive`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: temporary }),
    });
    assert.equal(archivedProject.status, 200);
    const archivedProjectPayload = await archivedProject.json();
    assert.deepEqual(archivedProjectPayload.archived, [nativeSessionId]);
    assert.ok(desktopIpc.messages.some((message) => (
      message.type === 'broadcast'
      && message.method === 'thread-archived'
      && message.version === 2
      && message.params?.hostId === 'local'
      && message.params?.conversationId === nativeSessionId
      && message.params?.cwd === temporary
    )));

    const rejectedDeleteAll = await fetch(`${baseUrl}/api/native-archived-sessions`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'delete' }),
    });
    assert.equal(rejectedDeleteAll.status, 400);

    const deletedAllArchived = await fetch(`${baseUrl}/api/native-archived-sessions`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: '永久删除全部已归档任务' }),
    });
    assert.equal(deletedAllArchived.status, 200);
    const deletedAllArchivedPayload = await deletedAllArchived.json();
    assert.deepEqual(deletedAllArchivedPayload.deleted, [nativeSessionId]);
    assert.deepEqual(deletedAllArchivedPayload.skipped, []);
    assert.deepEqual(deletedAllArchivedPayload.failed, []);

    const protocolMessages = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(protocolMessages.some((message) => (
      message.type === 'process_env'
      && message.openaiBaseUrl === `${providerBaseUrl}/v1`
      && message.openaiApiKey === 'test-token'
      && message.sub2ApiKey === undefined
    )));
    assert.ok(protocolMessages.some((message) => message.method === 'initialize'));
    assert.ok(protocolMessages.some((message) => (
      message.method === 'model/list'
      && message.params.limit === 100
      && message.params.includeHidden === false
    )));
    assert.ok(protocolMessages.some((message) => message.method === 'thread/start'));
    assert.ok(protocolMessages.some((message) => (
      message.method === 'thread/list'
      && message.params.archived === true
      && message.params.useStateDbOnly === true
    )));
    assert.ok(protocolMessages.some((message) => (
      message.method === 'thread/unarchive'
      && message.params.threadId === archivedNativeSessionId
    )));
    assert.deepEqual(
      protocolMessages.filter((message) => message.method === 'thread/delete').map((message) => message.params.threadId),
      [createdNativeSessionId, nativeSessionId],
    );

    const archivedForRace = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(archivedForRace.status, 200);
    const deleteCountBeforeRace = protocolMessages
      .filter((message) => message.method === 'thread/delete' && message.params.threadId === nativeSessionId)
      .length;
    await writeFile(appServerControlFile, JSON.stringify({
      unarchiveAfterFirstListToken: 'single-delete-race',
      unarchiveAfterFirstListId: nativeSessionId,
    }));
    const racedArchivedDelete = await fetch(`${baseUrl}/api/native-archived-sessions/${nativeSessionId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(racedArchivedDelete.status, 409);
    assert.deepEqual((await racedArchivedDelete.json()).skipped, [nativeSessionId]);
    const protocolMessagesAfterRace = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      protocolMessagesAfterRace
        .filter((message) => message.method === 'thread/delete' && message.params.threadId === nativeSessionId)
        .length,
      deleteCountBeforeRace,
    );

    for (const threadId of [nativeSessionId, createdNativeSessionId]) {
      const archivedForBulkRace = await fetch(`${baseUrl}/api/native-sessions/${threadId}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });
      assert.equal(archivedForBulkRace.status, 200);
    }
    const createdDeleteCountBeforeBulkRace = protocolMessagesAfterRace
      .filter((message) => message.method === 'thread/delete' && message.params.threadId === createdNativeSessionId)
      .length;
    await writeFile(appServerControlFile, JSON.stringify({
      unarchiveAfterFirstListToken: 'bulk-delete-race',
      unarchiveAfterFirstListId: createdNativeSessionId,
    }));
    const bulkRaceDelete = await fetch(`${baseUrl}/api/native-archived-sessions`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: '永久删除全部已归档任务' }),
    });
    assert.equal(bulkRaceDelete.status, 200);
    const bulkRaceDeletePayload = await bulkRaceDelete.json();
    assert.deepEqual(bulkRaceDeletePayload.deleted, [nativeSessionId]);
    assert.deepEqual(bulkRaceDeletePayload.skipped, [createdNativeSessionId]);
    assert.deepEqual(bulkRaceDeletePayload.failed, []);
    const protocolMessagesAfterBulkRace = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      protocolMessagesAfterBulkRace
        .filter((message) => message.method === 'thread/delete' && message.params.threadId === createdNativeSessionId)
        .length,
      createdDeleteCountBeforeBulkRace,
    );
    assert.equal(protocolMessages.filter((message) => message.method === 'thread/resume').length, 7);
    assert.equal(protocolMessages.filter((message) => message.method === 'turn/start').length, 10);
    const switchedProviderResume = protocolMessages.find((message) => (
      message.method === 'thread/resume'
      && message.params.modelProvider === 'custom'
    ));
    assert.ok(switchedProviderResume);
    assert.equal(switchedProviderResume.params.model, 'custom-model');
    assert.equal(switchedProviderResume.params.serviceTier, 'priority');
    const restartFromFirstMessage = protocolMessages.find((message) => (
      message.method === 'thread/start'
      && message.params.sandbox === 'read-only'
      && message.params.approvalPolicy === 'untrusted'
    ));
    assert.ok(restartFromFirstMessage);
    assert.equal(restartFromFirstMessage.params.serviceTier, null);
    const forkMessages = protocolMessages.filter((message) => message.method === 'thread/fork');
    assert.equal(forkMessages.length, 2);
    const forkMessage = forkMessages[0];
    assert.equal(forkMessage.params.threadId, nativeSessionId);
    assert.equal(forkMessage.params.lastTurnId, nativeFirstTurnId);
    assert.equal(forkMessage.params.sandbox, 'workspace-write');
    assert.equal(forkMessage.params.approvalPolicy, 'on-request');
    assert.equal(forkMessage.params.serviceTier, 'priority');
    assert.equal(forkMessages[1].params.serviceTier, null);
    const turnStartMessages = protocolMessages.filter((message) => message.method === 'turn/start');
    const turnStartText = (message) => (
      message.params.input.find((item) => item.type === 'text')?.text || ''
    );
    const createdTurnStart = turnStartMessages.find((message) => turnStartText(message) === 'create native thread');
    assert.equal(createdTurnStart.params.sandboxPolicy.type, 'workspaceWrite');
    assert.deepEqual(createdTurnStart.params.sandboxPolicy.writableRoots, [temporary]);
    assert.equal(createdTurnStart.params.serviceTier, 'priority');
    const createdTurnStartIndex = protocolMessages.indexOf(createdTurnStart);
    const createdThreadStart = protocolMessages
      .slice(0, createdTurnStartIndex)
      .reverse()
      .find((message) => message.method === 'thread/start');
    assert.equal(createdThreadStart.params.serviceTier, 'priority');
    const approvalTurnStart = turnStartMessages.find((message) => turnStartText(message) === 'needs approval');
    assert.equal(approvalTurnStart.params.sandboxPolicy.type, 'readOnly');
    assert.equal(approvalTurnStart.params.serviceTier, null);
    const switchedProviderTurnStart = turnStartMessages.find((message) => turnStartText(message) === 'switch native provider');
    assert.equal(switchedProviderTurnStart.params.model, 'custom-model');
    assert.equal(switchedProviderTurnStart.params.effort, 'max');
    assert.equal(switchedProviderTurnStart.params.serviceTier, 'priority');
    const queuedFastTurnStart = turnStartMessages.find((message) => (
      message.params.threadId === nativeSessionId
      && turnStartText(message) === queueItemA.message
      && message.params.serviceTier === 'priority'
    ));
    assert.ok(queuedFastTurnStart);
    const standardSideChatTurnStart = turnStartMessages.find((message) => (
      message.params.threadId === runningSideChatId
      && turnStartText(message) === queueItemB.message
    ));
    assert.equal(standardSideChatTurnStart.params.serviceTier, null);
    const steerMessage = protocolMessages.find((message) => (
      message.method === 'turn/steer'
      && message.params.input?.some((item) => item.text === 'change direction while running')
    ));
    assert.equal(steerMessage.params.expectedTurnId, continuedPayload.turnId);
    assert.deepEqual(steerMessage.params.input, [{ type: 'text', text: 'change direction while running' }]);
    assert.ok(protocolMessages.some((message) => message.method === 'turn/interrupt'));
    assert.ok(protocolMessages.some((message) => message.method === 'thread/name/set'));
    assert.ok(protocolMessages.some((message) => (
      message.method === 'thread/goal/set'
      && message.params.objective === 'Verify the native goal controls'
    )));
    assert.ok(protocolMessages.some((message) => (
      message.method === 'thread/goal/set'
      && message.params.status === 'paused'
    )));
    assert.ok(protocolMessages.some((message) => message.method === 'thread/goal/clear'));
    assert.ok(protocolMessages.some((message) => message.method === 'thread/archive'));
    assert.ok(protocolMessages.some((message) => message.id === 'approval-1' && message.result?.decision === 'accept'));

    const secondLogin = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    assert.equal(secondLogin.status, 200);
    const secondCookie = secondLogin.headers.get('set-cookie').split(';', 1)[0];

    const wrongCurrentPassword = await fetch(`${baseUrl}/api/password`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: 'wrong-password',
        newPassword: 'new-test-password',
        confirmPassword: 'new-test-password',
      }),
    });
    assert.equal(wrongCurrentPassword.status, 401);

    const changedPassword = await fetch(`${baseUrl}/api/password`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: 'test-password',
        newPassword: 'new-test-password',
        confirmPassword: 'new-test-password',
      }),
    });
    assert.equal(changedPassword.status, 200);
    assert.match(await readFile(webEnv, 'utf8'), /^CODEX_WEB_PASSWORD="new-test-password"$/m);

    const staleSession = await fetch(`${baseUrl}/api/config`, { headers: { Cookie: secondCookie } });
    assert.equal(staleSession.status, 401);
    const currentSession = await fetch(`${baseUrl}/api/config`, { headers: { Cookie: cookie } });
    assert.equal(currentSession.status, 200);
    const oldPasswordLogin = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    assert.equal(oldPasswordLogin.status, 401);
    const newPasswordLogin = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'new-test-password' }),
    });
    assert.equal(newPasswordLogin.status, 200);

    await stopServer(child);
    child = undefined;
    await unlink(path.join(runtime, 'port'));

    child = await startServer({
      temporary,
      runtime,
      codexHome,
      fakeCodex,
      traceFile,
      appServerTraceFile,
      webEnv,
      localImageRoots: externalImageRoot,
      sub2ApiBaseUrl: providerBaseUrl,
    });
    port = await waitForServer(child, runtime);
    const restored = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { Cookie: cookie } });
    assert.equal(restored.status, 200);
    const restoredPlaygroundConfig = await fetch(`http://127.0.0.1:${port}/api/playground-config`, { headers: { Cookie: cookie } });
    assert.equal(restoredPlaygroundConfig.status, 200);
    const restoredSubQuotaConfig = await fetch(`http://127.0.0.1:${port}/api/sub-quota-config`, { headers: { Cookie: cookie } });
    assert.equal(restoredSubQuotaConfig.status, 200);
    const restoredSubQuotaConfigPayload = await restoredSubQuotaConfig.json();
    assert.equal(restoredSubQuotaConfigPayload.baseUrl, providerBaseUrl);
    assert.equal(restoredSubQuotaConfigPayload.keyConfigured, true);
    assert.equal(restoredSubQuotaConfigPayload.codexApp.visible, false);
    assert.deepEqual(
      restoredSubQuotaConfigPayload.sources.map((source) => [source.provider, source.visible]),
      [
        ['deepseek', true],
        ['cpa-codex', false],
        ['sub2api', false],
        ['grok2api', true],
      ],
    );
  } finally {
    if (child) await stopServer(child);
    if (desktopIpc) await desktopIpc.close();
    if (providerServer) {
      providerServer.closeAllConnections?.();
      await new Promise((resolve) => providerServer.close(resolve));
    }
    if (customProviderServer) {
      customProviderServer.closeAllConnections?.();
      await new Promise((resolve) => customProviderServer.close(resolve));
    }
    if (externalImageRoot) await rm(externalImageRoot, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

test('writable provider changes preserve unrelated Codex config', { timeout: 30000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-config-test-'));
  const runtime = path.join(temporary, 'runtime');
  const codexHome = path.join(temporary, 'codex-home');
  const webEnv = path.join(temporary, 'web.env');
  const fakeCodex = path.join(temporary, 'fake-codex.mjs');
  const appServerTraceFile = path.join(temporary, 'app-server-trace.jsonl');
  let child;

  try {
    await mkdir(runtime, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), `model_provider = "alpha"
model = "alpha-model"
review_model = "alpha-model"
notify = ["/bin/echo", "keep-me"]

[model_providers.alpha]
name = "Alpha"
base_url = "https://alpha.invalid/v1"
env_key = "ALPHA_API_KEY"
wire_api = "responses"
requires_openai_auth = false

[model_providers.beta]
name = "Beta"
base_url = "https://beta.invalid/v1"
env_key = "BETA_API_KEY"
wire_api = "responses"
requires_openai_auth = false

[mcp_servers.keep]
command = "/bin/echo"
args = ["keep-me"]

[projects."/keep"]
trust_level = "trusted"
`);
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
if (process.argv[2] !== 'app-server') process.exit(2);
appendFileSync(process.env.FAKE_APP_SERVER_TRACE, JSON.stringify({
  type: 'process_env',
  openaiBaseUrl: process.env.OPENAI_BASE_URL,
  openaiApiKey: process.env.OPENAI_API_KEY,
  gammaApiKeyLength: String(process.env.GAMMA_API_KEY || '').length,
}) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (!Object.hasOwn(message, 'id') || !message.method) continue;
    const result = message.method === 'initialize'
      ? { userAgent: 'fake' }
      : message.method === 'model/list'
        ? { data: [], nextCursor: null }
        : {};
    process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
  }
});
`);
    await chmod(fakeCodex, 0o755);

    child = startServer({
      temporary,
      runtime,
      codexHome,
      fakeCodex,
      traceFile: path.join(temporary, 'unused-trace.json'),
      appServerTraceFile,
      webEnv,
      configWritable: 'true',
    });
    const port = await waitForServer(child, runtime);
    const baseUrl = `http://127.0.0.1:${port}`;
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];

    const initial = await fetch(`${baseUrl}/api/config`, { headers: { Cookie: cookie } });
    assert.equal((await initial.json()).capabilities.manageProviders, true);
    const initialCapabilities = await fetch(`${baseUrl}/api/native-model-capabilities`, {
      headers: { Cookie: cookie },
    });
    assert.equal(initialCapabilities.status, 200);
    let appServerEnvironments = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(appServerEnvironments.length, 1);
    assert.equal(appServerEnvironments[0].openaiBaseUrl, 'https://alpha.invalid/v1');
    assert.equal(appServerEnvironments[0].gammaApiKeyLength, 0);

    const added = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'gamma',
        baseUrl: 'https://gamma.invalid/v1',
        apiKey: 'gamma-test-key',
        model: 'gamma-model',
        wireApi: 'responses',
      }),
    });
    assert.equal(added.status, 200);
    appServerEnvironments = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(appServerEnvironments.length, 2);
    assert.equal(appServerEnvironments.at(-1).openaiBaseUrl, 'https://gamma.invalid/v1');
    assert.equal(appServerEnvironments.at(-1).openaiApiKey, 'gamma-test-key');
    assert.equal(appServerEnvironments.at(-1).gammaApiKeyLength, 14);

    let config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /notify = \["\/bin\/echo", "keep-me"\]/);
    assert.match(config, /\[mcp_servers\.keep\]/);
    assert.match(config, /\[projects\."\/keep"\]/);
    assert.match(config, /\[model_providers\.alpha\]/);
    assert.match(config, /\[model_providers\.beta\]/);
    assert.match(config, /\[model_providers\.gamma\]/);

    const defaults = await fetch(`${baseUrl}/api/defaults`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gamma', model: 'gamma-model', reasoningEffort: 'max' }),
    });
    assert.equal(defaults.status, 200);
    appServerEnvironments = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(appServerEnvironments.length, 3);
    assert.equal(appServerEnvironments.at(-1).gammaApiKeyLength, 14);

    config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /^model_provider = "gamma"/m);
    assert.match(config, /^model = "gamma-model"/m);
    assert.match(config, /^model_reasoning_effort = "max"/m);
    assert.match(config, /\[mcp_servers\.keep\]/);

    const deleted = await fetch(`${baseUrl}/api/providers/gamma`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(deleted.status, 200);
    appServerEnvironments = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(appServerEnvironments.length, 4);
    assert.equal(appServerEnvironments.at(-1).openaiBaseUrl, 'https://alpha.invalid/v1');
    assert.equal(appServerEnvironments.at(-1).gammaApiKeyLength, 0);

    config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.doesNotMatch(config, /\[model_providers\.gamma\]/);
    assert.match(config, /\[model_providers\.alpha\]/);
    assert.match(config, /\[model_providers\.beta\]/);
    assert.match(config, /\[mcp_servers\.keep\]/);
    assert.doesNotMatch(await readFile(webEnv, 'utf8'), /^GAMMA_API_KEY=/m);
  } finally {
    if (child) await stopServer(child);
    await rm(temporary, { recursive: true, force: true });
  }
});

function startServer({
  temporary,
  runtime,
  codexHome,
  fakeCodex,
  traceFile,
  appServerTraceFile = path.join(temporary, 'app-server-trace.jsonl'),
  appServerControlFile = path.join(temporary, 'app-server-control.json'),
  webEnv = path.join(temporary, 'web.env'),
  configWritable = 'false',
  desktopIpcEnabled = 'false',
  desktopIpcSocket = '',
  desktopIpcTimeoutMs = '',
  playgroundProxyAllowedOrigins = '',
  localImageRoots = '',
  fetchFixture = '',
  dockerBin = '',
  sub2ApiBaseUrl,
  sub2ApiKey,
}) {
  const env = {
    ...process.env,
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: '',
    GAMMA_API_KEY: '',
    APP_NAME: 'Codex Web Test',
    CODEX_WEB_PASSWORD: 'test-password',
    SESSION_SECRET: 'test-session-secret-with-enough-entropy',
    HOST: '127.0.0.1',
    PORT: '0',
    PORT_MIN: '41000',
    PORT_MAX: '41999',
    CODEX_BIN: fakeCodex,
    CODEX_HOME: codexHome,
    CODEX_PROCESS_HOME: temporary,
    CODEX_WEB_ENV_FILE: webEnv,
    CODEX_WEB_RUNTIME_DIR: runtime,
    CODEX_CONFIG_WRITABLE: configWritable,
    CODEX_DESKTOP_IPC_ENABLED: desktopIpcEnabled,
    CODEX_DESKTOP_IPC_SOCKET: desktopIpcSocket,
    PLAYGROUND_PROXY_ALLOWED_ORIGINS: playgroundProxyAllowedOrigins,
    CODEX_WEB_LOCAL_IMAGE_ROOTS: localImageRoots,
    PLAYGROUND_PROXY_HEARTBEAT_MS: '20',
    HOMEPAGE_API_TOKEN: '',
    IMAGE_PROMPT_AUTO_SYNC: 'false',
    PLAYGROUND_UPDATE_ENABLED: 'false',
    DEFAULT_CWD: temporary,
    DEFAULT_SANDBOX: 'read-only',
    DEFAULT_APPROVAL: 'never',
    FORCE_FULL_ACCESS: 'false',
    FAKE_CODEX_TRACE: traceFile,
    FAKE_APP_SERVER_TRACE: appServerTraceFile,
    FAKE_APP_SERVER_CONTROL: appServerControlFile,
  };
  if (desktopIpcTimeoutMs) env.CODEX_DESKTOP_IPC_TIMEOUT_MS = desktopIpcTimeoutMs;
  if (fetchFixture) {
    env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${fetchFixture}`].filter(Boolean).join(' ');
  }
  if (dockerBin) env.DOCKER_BIN = dockerBin;
  env.CPA_QUOTA_BASE_URL = '';
  env.CPA_QUOTA_API_KEY = '';
  delete env.SUB2API_BASE_URL;
  delete env.SUB2API_API_KEY;
  env.SUB2API_ADMIN_API_KEY = '';
  env.GROK2API_BASE_URL = '';
  env.GROK2API_ADMIN_PASSWORD = '';
  env.GROK2API_API_KEY = '';
  // Keep repository-level .env values out of the isolated quota fixture.
  env.DEEPSEEK_BASE_URL = '';
  env.DEEPSEEK_API_KEY = '';
    env.CODEX_APP_QUOTA_VISIBLE = 'true';
    env.CODEX_APP_CREDIT_LIMIT = '2500';
  env.CPA_QUOTA_VISIBLE = 'true';
  env.SUB2API_QUOTA_VISIBLE = 'true';
  env.GROK2API_QUOTA_VISIBLE = 'true';
  env.DEEPSEEK_QUOTA_VISIBLE = 'true';
  env.SUB_QUOTA_ORDER = '';
  env.SUB_QUOTA_SOURCES = '';
  env.SUB_QUOTA_PROVIDER = 'cpa-codex';
  if (sub2ApiBaseUrl !== undefined) env.SUB2API_BASE_URL = sub2ApiBaseUrl;
  if (sub2ApiKey !== undefined) env.SUB2API_API_KEY = sub2ApiKey;
  Object.assign(env, readPersistedTestEnv(webEnv));
  return spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readPersistedTestEnv(file) {
  try {
    const values = {};
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const index = trimmed.indexOf('=');
      const key = trimmed.slice(0, index).trim();
      const raw = trimmed.slice(index + 1).trim();
      if (!key) continue;
      if (raw.startsWith('"') && raw.endsWith('"')) {
        try {
          values[key] = JSON.parse(raw);
          continue;
        } catch {}
      }
      values[key] = raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
    }
    return values;
  } catch {
    return {};
  }
}

async function readAppServerTrace(file) {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitForAppServerTrace(file, predicate, errorMessage) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const messages = await readAppServerTrace(file);
    if (predicate(messages)) return messages;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(errorMessage);
}

async function createDesktopIpcFixture(temporary) {
  const socketPath = path.join(tmpdir(), `cwi-${path.basename(temporary)}.sock`);
  const queuedFollowUpsStateFile = path.join(temporary, 'codex-home', '.codex-global-state.json');
  await unlink(socketPath).catch(() => {});
  const sockets = new Set();
  const fixture = {
    socketPath,
    messages: [],
    ownerAvailable: true,
    startTurnMode: 'respond',
    onStartTurn: null,
    steerMode: 'respond',
    onSteer: null,
    interruptMode: 'respond',
    failNextSteer: false,
    failNextQueuedFollowUpsSet: false,
    failAfterWriteNextQueuedFollowUpsSet: false,
    ignoreNextQueuedFollowUpsBroadcast: false,
    lastError: null,
    initializeCount: 0,
    historySnapshots: new Map(),
    broadcast(message) {
      for (const socket of sockets) writeDesktopFrame(socket, message);
    },
    disconnectClients() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await unlink(socketPath).catch(() => {});
    },
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    attachDesktopFrameReader(socket, (message) => {
      fixture.messages.push(message);
      if (message.method === 'initialize') {
        fixture.initializeCount += 1;
        writeDesktopFrame(socket, {
          type: 'response',
          requestId: message.requestId,
          resultType: 'success',
          method: message.method,
          result: { clientId: 'desktop-test-client' },
        });
        return;
      }
      if (message.type === 'broadcast') {
        if (message.method !== 'thread-queued-followups-changed' || !fixture.ownerAvailable) return;
        if (fixture.ignoreNextQueuedFollowUpsBroadcast) {
          fixture.ignoreNextQueuedFollowUpsBroadcast = false;
          return;
        }
        void (async () => {
          const globalState = JSON.parse(await readFile(queuedFollowUpsStateFile, 'utf8'));
          const queued = globalState['queued-follow-ups'] && typeof globalState['queued-follow-ups'] === 'object'
            ? { ...globalState['queued-follow-ups'] }
            : {};
          const conversationId = String(message.params?.conversationId || '');
          const messages = Array.isArray(message.params?.messages) ? message.params.messages : [];
          if (messages.length) queued[conversationId] = messages;
          else delete queued[conversationId];
          globalState['queued-follow-ups'] = queued;
          await writeFile(queuedFollowUpsStateFile, JSON.stringify(globalState));
        })().catch((error) => {
          fixture.lastError = error;
        });
        return;
      }
      if (!fixture.ownerAvailable) {
        writeDesktopFrame(socket, {
          type: 'response',
          requestId: message.requestId,
          resultType: 'error',
          error: 'no-client-found',
        });
        return;
      }
      if (message.method === 'thread-follower-interrupt-turn' && fixture.interruptMode === 'timeout') {
        return;
      }
      if (message.method === 'thread-follower-set-queued-follow-ups-state') {
        if (fixture.failNextQueuedFollowUpsSet) {
          fixture.failNextQueuedFollowUpsSet = false;
          writeDesktopFrame(socket, {
            type: 'response',
            requestId: message.requestId,
            resultType: 'error',
            error: 'controlled-queued-follow-ups-failure',
          });
          return;
        }
        const failAfterWrite = fixture.failAfterWriteNextQueuedFollowUpsSet;
        fixture.failAfterWriteNextQueuedFollowUpsSet = false;
        void (async () => {
          const globalState = JSON.parse(await readFile(queuedFollowUpsStateFile, 'utf8'));
          globalState['queued-follow-ups'] = message.params?.state || {};
          await writeFile(queuedFollowUpsStateFile, JSON.stringify(globalState));
          if (failAfterWrite) {
            writeDesktopFrame(socket, {
              type: 'response',
              requestId: message.requestId,
              resultType: 'error',
              error: 'controlled-queued-follow-ups-after-write-failure',
            });
            return;
          }
          writeDesktopFrame(socket, {
            type: 'response',
            requestId: message.requestId,
            resultType: 'success',
            method: message.method,
            handledByClientId: 'desktop-owner',
            result: { result: { ok: true } },
          });
        })().catch((error) => {
          fixture.lastError = error;
          writeDesktopFrame(socket, {
            type: 'response',
            requestId: message.requestId,
            resultType: 'error',
            error: `controlled-queued-follow-ups-write-failure: ${error.message}`,
          });
        });
        return;
      }
      if (message.method === 'thread-follower-steer-turn' && fixture.failNextSteer) {
        fixture.failNextSteer = false;
        writeDesktopFrame(socket, {
          type: 'response',
          requestId: message.requestId,
          resultType: 'error',
          error: 'controlled-steer-failure',
        });
        return;
      }
      if (message.method === 'thread-follower-steer-turn' && fixture.steerMode === 'echo-only') {
        Promise.resolve(fixture.onSteer?.(message)).catch((error) => {
          fixture.lastError = error;
        });
        return;
      }
      if (message.method === 'thread-follower-start-turn' && fixture.startTurnMode === 'echo-only') {
        Promise.resolve(fixture.onStartTurn?.(message)).catch((error) => {
          fixture.lastError = error;
        });
        return;
      }
      if (message.method === 'thread-follower-load-complete-history') {
        writeDesktopFrame(socket, {
          type: 'response',
          requestId: message.requestId,
          resultType: 'success',
          method: message.method,
          handledByClientId: 'desktop-owner',
          result: { result: { ok: true } },
        });
        const snapshot = fixture.historySnapshots.get(message.params?.conversationId);
        if (snapshot) {
          setImmediate(() => fixture.broadcast(snapshot));
        }
        return;
      }
      const result = message.method === 'thread-follower-start-turn'
        ? { turn: { id: 'desktop-turn-1', status: 'inProgress' } }
        : message.method === 'thread-follower-steer-turn'
          ? { turnId: 'desktop-turn-1' }
          : message.method.includes('approval') || message.method.includes('submit-')
            ? { ok: true }
            : {};
      writeDesktopFrame(socket, {
        type: 'response',
        requestId: message.requestId,
        resultType: 'success',
        method: message.method,
        handledByClientId: 'desktop-owner',
        result: { result },
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return fixture;
}

function attachDesktopFrameReader(socket, onMessage) {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0);
      if (buffer.length < size + 4) return;
      const payload = buffer.subarray(4, size + 4);
      buffer = buffer.subarray(size + 4);
      onMessage(JSON.parse(payload.toString('utf8')));
    }
  });
}

function writeDesktopFrame(socket, message) {
  const payload = Buffer.from(JSON.stringify(message));
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  socket.write(frame);
}

async function waitForPendingRequest(baseUrl, cookie) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${baseUrl}/api/native-requests`, {
      headers: { Cookie: cookie },
    });
    if (response.ok) {
      const request = (await response.json()).requests?.[0];
      if (request) return request;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('native approval request did not arrive');
}

async function waitForPendingRequestGone(baseUrl, cookie, requestId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${baseUrl}/api/native-requests`, {
      headers: { Cookie: cookie },
    });
    if (response.ok) {
      const requests = (await response.json()).requests || [];
      if (!requests.some((request) => request.id === requestId)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('native approval request did not clear');
}

async function waitForPendingRequestState(baseUrl, cookie, predicate, errorMessage) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await fetch(`${baseUrl}/api/native-requests`, {
      headers: { Cookie: cookie },
    });
    if (response.ok) {
      const requests = (await response.json()).requests || [];
      const request = requests.find(predicate);
      if (request) return request;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(errorMessage);
}

async function waitForDesktopInitializeCount(fixture, expected) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (fixture.initializeCount >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Desktop IPC initialize count did not reach ${expected}`);
}

async function waitForServer(child, runtime) {
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    try {
      const port = Number((await readFile(path.join(runtime, 'port'), 'utf8')).trim());
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return port;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become ready:\n${output}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
