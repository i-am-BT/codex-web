import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
function codeBetween(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

function queueClient({ items = [], revision = 0, fetch = async () => { throw new Error('unexpected fetch'); } } = {}) {
  let local = items;
  const timers = [];
  const syncs = [];
  const pauses = [];
  const revisions = new Map([['thread', revision]]);
  const inflight = new Map();
  const env = {
    promptQueueServerSyncInflight: inflight,
    promptQueueServerSyncTimers: new Map(),
    promptQueueOrderSyncing: new Map(),
    promptQueueOrderIntents: new Map(),
    promptQueueServerSyncPending: new Map(),
    promptQueueServerRevisions: revisions,
    promptQueueBeaconItemIds: new Map(),
    promptQueueFor: () => local,
    isAppOwnedQueuedPrompt: (item) => item.source === 'app',
    setTimeout: (fn) => timers.push(fn),
    schedulePromptQueueServerSync: (id) => syncs.push(id),
    setPromptQueuePauseLocal: (_id, pause) => pauses.push(pause),
    applyPromptQueueLocal: (_id, next, options) => {
      assert.equal(options.persist, true);
      local = next;
    },
    statusEl: {},
    fetch,
  };
  const api = new Function(...Object.keys(env), `let promptQueueRemoteSyncing=false;
    ${codeBetween('function rememberPromptQueueBeaconItem(', 'function appendPromptQueueItemViaBeacon(')}
    ${codeBetween('async function pushPromptQueueToServer(', 'function promptQueueOrderIds(')}
    ${codeBetween('const deferredPromptQueueEvents=', 'function createQueuedPrompt(')}
    return { pushPromptQueueToServer, applyRemotePromptQueueEvent };
  `)(...Object.values(env));
  return { ...api, timers, syncs, pauses, revisions, inflight, items: () => local };
}

test('Desktop interruption pauses Web follow-ups before publishing terminal state', () => {
  const active = new Map([['thread', { turnId: 'turn', status: 'running', transport: 'desktop-ipc' }]]);
  let paused = null;
  const events = [];
  const env = {
    activeNativeTurns: active,
    nativeSessions: { get: () => ({ status: 'running', latestTurnId: 'turn' }) },
    isPromptQueuePaused: () => Boolean(paused),
    setPromptQueuePause: (_id, pause) => { paused = pause; events.push('pause'); },
    setNativeTurnState: (id, state) => { active.set(id, state); events.push(state.status); },
    scheduleServerPromptQueueDispatch: () => events.push('dispatch'),
  };
  const sync = new Function(...Object.keys(env),
    codeBetween('function syncDesktopTurnState(', 'function desktopPendingKey(') + ';return syncDesktopTurnState;',
  )(...Object.values(env));
  assert.equal(sync('thread', { turns: [{ id: 'turn', status: 'interrupted' }] }), true);
  assert.equal(paused.reason, 'app-paused');
  assert.deepEqual(events, ['pause', 'interrupted']);

  events.length = 0;
  active.set('thread', { turnId: 'turn', status: 'running', transport: 'desktop-ipc' });
  paused = { reason: 'rate_limit' };
  sync('thread', { turns: [{ id: 'turn', status: 'interrupted' }] });
  assert.equal(paused.reason, 'rate_limit');
  assert.deepEqual(events, ['interrupted']);

  events.length = 0;
  active.set('thread', { turnId: 'turn', status: 'running', transport: 'desktop-ipc' });
  paused = null;
  sync('thread', { turns: [{ id: 'turn', status: 'completed' }] });
  assert.deepEqual(events, ['done', 'dispatch']);
});

test('deferred SSE preserves the durable outbox after a failed upload but removes consumed items', async () => {
  let rejectPut;
  const pending = new Promise((_, reject) => { rejectPut = reject; });
  const unsent = { id: 'unsent', source: 'web', message: 'keep this prompt' };
  const consumed = { id: 'consumed', source: 'web', message: 'already sent' };
  const appOwned = { id: 'app-owned', source: 'app', message: 'App consumed this' };
  const client = queueClient({ items: [consumed, unsent, appOwned], revision: 7, fetch: () => pending });
  const put = client.pushPromptQueueToServer('thread');
  const pause = { reason: 'app-paused' };
  client.applyRemotePromptQueueEvent({ threadId: 'thread', revision: 8, items: [], pause, dismissedItemIds: ['consumed'] });
  assert.equal(client.timers.length, 1);
  assert.deepEqual(client.pauses, [pause], 'an interrupted App must stop browser dispatch before the deferred queue merge');
  rejectPut(new Error('Failed to fetch'));
  await put;
  assert.deepEqual(client.items(), [consumed, unsent, appOwned]);
  client.timers.shift()();
  assert.deepEqual(client.items(), [unsent]);
  assert.deepEqual(client.syncs, ['thread']);
  assert.equal(client.revisions.get('thread'), 8);
  client.applyRemotePromptQueueEvent({ threadId: 'thread', revision: 7, items: [consumed] });
  assert.deepEqual(client.items(), [unsent]);
});

test('queue broadcasts carry tombstones so a consumed Web item cannot be restored by SSE merging', () => {
  const sent = [];
  const env = {
    sessionEventClients: new Set(['browser']),
    promptQueuePauseState: () => null,
    getPromptQueueDismissedItemIds: () => ['consumed'],
    writeNamedEvent: (_client, _name, event) => sent.push(event),
  };
  const broadcast = new Function(...Object.keys(env),
    codeBetween('function broadcastPromptQueueChange(', 'function loadConversations(') + ';return broadcastPromptQueueChange;',
  )(...Object.values(env));
  broadcast({ threadId: 'thread', revision: 9, items: [] });
  const client = queueClient({ items: [{ id: 'consumed', source: 'web' }], revision: 8 });
  client.applyRemotePromptQueueEvent(sent[0]);
  assert.deepEqual(sent[0].dismissedItemIds, ['consumed']);
  assert.equal(sent[0].pause, null);
  assert.deepEqual(client.items(), []);
  assert.deepEqual(client.syncs, []);
});

test('resuming an empty paused queue preserves its revision and reaches another browser', () => {
  let raw = { thread: { revision: 5, items: [], pause: { reason: 'app-paused', message: 'paused' } } };
  const events = [];
  const env = {
    cleanNativeThreadId: (id) => id,
    loadPromptQueuesRaw: () => structuredClone(raw),
    loadPromptQueueDismissedRaw: () => ({}),
    getPromptQueueState: () => ({ items: raw.thread?.items || [], revision: raw.thread?.revision || 0, pause: raw.thread?.pause || null }),
    filterDismissedPromptQueueItems: (_id, items) => items,
    savePromptQueuesWithDismissed: (queues) => { raw = queues; },
    broadcastPromptQueueChange: (event) => events.push(event),
    scheduleServerPromptQueueDispatch: () => {},
  };
  const setPause = new Function(...Object.keys(env),
    codeBetween('function setPromptQueuePause(', 'function pausePromptQueueForProviderLimit(') + ';return setPromptQueuePause;',
  )(...Object.values(env));
  const result = setPause('thread', null);
  assert.equal(result.revision, 6);
  assert.equal(raw.thread.revision, 6);
  assert.deepEqual(raw.thread.items, []);
  const client = queueClient({ revision: 5 });
  client.applyRemotePromptQueueEvent(events[0]);
  assert.deepEqual(client.pauses, [null]);
  assert.equal(client.revisions.get('thread'), 6);
});
