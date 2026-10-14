import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Missing source section: ${start}`);
  return source.slice(first, last);
}
const routeSource = section("app.patch('/api/native-sessions/:id',", "\napp.patch('/api/native-sessions/:id/goal'");

function harness() {
  const calls = [];
  const conversations = new Map();
  const owners = [];
  const shared = {
    child: { shared: true }, initialized: true, operationCount: 1,
    pending: new Map([[1, {}]]),
    async restart() { throw new Error('Thread settings must never restart the shared client'); },
  };
  const context = vm.createContext({
    app: { patch(_path, _auth, handler) { context.handler = handler; } },
    requireAuth() {},
    cleanNativeThreadId: (value) => String(value || '').trim(),
    cleanProviderName: (value) => String(value || '').trim(),
    cleanThreadSettingsModel: (value) => String(value || '').trim(),
    cleanReasoningEffort: (value) => value,
    cleanServiceTier: (value) => value,
    readProviders: () => ['cpa', 'sub2api', 'deepseek'],
    readCodexDefaults: () => ({ provider: 'cpa' }), DEFAULT_PROVIDER: 'cpa',
    CODEX_EXISTING_THREAD_APP_SERVER_FALLBACK: true,
    parseBoolean: (value, fallback) => value ?? fallback,
    appServerClient: shared,
    appServerLoadedThreads: new Map(), appServerUnsubscribeRequests: new Map(),
    appServerThreadIdleReleaseAttempts: new Map(),
    nativeTurnReservations: new Set(), nativeThreadProviderChanges: new Set(),
    serverPromptQueueDispatchingThreads: new Set(), pendingNativeRequests: new Map(),
    activeNativeTurns: new Map(),
    nativeSessions: {
      get: (id) => conversations.get(id) || null,
      applyThreadSettings(settings) {
        const conversation = conversations.get(settings.threadId);
        conversation.metadata = { ...conversation.metadata, ...settings };
        calls.push({ method: 'overlay', settings });
      },
      scheduleRefresh() {},
    },
    nativeConversationHasFreshRunningActivity: (conversation) => conversation?.status === 'running',
    async waitForAppServerThreadUnsubscribe() {},
    clearAppServerThreadIdleReleaseTimer() {},
    markAppServerWriterConnection() {}, scheduleAppServerWriterIdleStop() {},
    isAmbiguousAppServerRequestError: () => false,
    nativeAppErrorStatus: (error) => error.statusCode || 500,
    isNativeActiveWriterConflict: () => false,
    appServerThreadReleaseError(id, message) {
      return Object.assign(new Error(`Cannot release ${id}: ${message}`), { statusCode: 409 });
    },
    async stopAppServerWriterIfIdle(options) {
      calls.push({ method: 'shared-stop', options });
      return context.sharedStopAllowed ?? true;
    },
    async closeThreadAppServerClient(client) {
      if (client === shared) return true;
      calls.push({ method: 'close', owner: client.name });
      client.child = null;
      client.initialized = false;
      return true;
    },
    markAppServerThreadLoaded(id, connection, client) {
      context.appServerLoadedThreads.set(id, { client, connection, turnId: '', loadedAt: Date.now() });
      return true;
    },
    async releaseAppServerThreadAfterTurn(id) {
      const record = context.appServerLoadedThreads.get(id);
      if (!record || context.activeNativeTurns.get(id)?.status === 'running') return false;
      await context.closeThreadAppServerClient(record.client);
      context.appServerLoadedThreads.delete(id);
      return true;
    },
    async reconcileUnconfirmedAppServerThread(id, _turnId, options) {
      calls.push({ method: 'reconcile', id, options });
      if (context.reconcileHook) return context.reconcileHook(id, options);
      if (context.ownerRunning) return { released: false, state: 'running' };
      if (context.releaseFailure) throw new Error('Owner release failed');
      await context.releaseAppServerThreadAfterTurn(id);
      return { released: true, state: 'terminal' };
    },
  });
  function owner(name, provider = 'cpa', model = 'old-model') {
    const state = { provider, model, loaded: false };
    const client = {
      name, state, child: { name }, initialized: true,
      async requestWithConnection(method, params) {
        calls.push({ method, params, owner: name });
        if (method === 'thread/resume') {
          // Match the real CLI: an already-loaded resume ignores modelProvider.
          if (!state.loaded) state.provider = params.modelProvider || state.provider;
          state.loaded = true;
          state.model = params.model || state.model;
          return { child: client.child, result: { thread: { id: params.threadId }, modelProvider: state.provider, model: state.model } };
        }
        if (method === 'thread/settings/update') {
          if (context.settingsFailure) throw new Error('Settings RPC failed');
          state.model = params.model || state.model;
        }
        return { child: client.child, result: {} };
      },
    };
    owners.push(client);
    return client;
  }
  context.createThreadAppServerClient = () => owner(`new-${owners.length}`);
  vm.runInContext(section('async function releaseAppServerThreadForProviderChange(', '\nasync function requestThreadAppServer('), context);
  vm.runInContext(section('async function requestThreadAppServer(', '\nfunction closeThreadAppServerClient('), context);
  vm.runInContext(section('function nativeActiveTurnFor(', '\nfunction nativeSessionSummaries('), context);
  vm.runInContext(section('function appServerThreadHasPendingWebRequest(', '\nfunction releaseIdleAppServerThreadSubscriptions('), context);
  vm.runInContext(routeSource, context);
  const target = { id: 'target', status: 'done', latestTurnId: 'completed-turn', metadata: { modelProvider: 'cpa', model: 'old-model' } };
  conversations.set('target', target);
  const patch = async (body = { provider: 'sub2api', model: 'new-model' }, id = 'target') => {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) {
      this.body = data;
      this.reservedAtResponse = context.nativeTurnReservations.has(id) || context.nativeThreadProviderChanges.has(id);
      return this;
    } };
    await context.handler({ params: { id }, body }, response);
    return response;
  };
  const loadOwner = (id = 'target', client = owner('old-owner')) => {
    client.state.loaded = true;
    context.appServerLoadedThreads.set(id, { client, connection: client.child, turnId: 'completed-turn' });
    return client;
  };
  return { context, calls, owners, conversations, target, shared, owner, loadOwner, patch };
}

test('idle provider changes bypass unrelated shared RPCs, running threads and reservations', async () => {
  const h = harness();
  h.loadOwner('other');
  h.context.activeNativeTurns.set('other', { status: 'running', transport: 'app-server' });
  h.context.nativeTurnReservations.add('other');
  h.context.serverPromptQueueDispatchingThreads.add('other');
  const response = await h.patch();
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.provider, 'sub2api');
  assert.equal(response.reservedAtResponse, false, 'the successful HTTP response must be ready for an immediate continuation');
  assert.equal(h.owners.at(-1).state.provider, 'sub2api');
  assert.equal(h.target.metadata.modelProvider, 'sub2api');
  assert.equal(h.context.activeNativeTurns.get('other').status, 'running');
  assert.equal(h.context.nativeTurnReservations.has('other'), true);
  assert.equal(h.calls.some(call => call.method === 'shared-stop'), false);
});

test('changing a loaded dedicated thread closes its old owner and applies provider on cold resume', async () => {
  const h = harness();
  const old = h.loadOwner();
  const response = await h.patch();
  assert.equal(response.statusCode, 200);
  assert.equal(old.child, null);
  assert.equal(h.owners.length, 2);
  assert.equal(h.owners[1].state.provider, 'sub2api');
  assert.equal(h.owners[1].state.model, 'new-model');
  assert.equal(h.calls.find(call => call.method === 'thread/resume').owner, 'new-1');
  const probe = h.calls.find(call => call.method === 'reconcile');
  assert.equal(probe.options.allowReservationRelease, true);
  assert.equal(probe.options.allowProbeWhileBusy, true);
  assert.equal(h.context.nativeTurnReservations.size, 0);
  assert.equal(h.context.nativeThreadProviderChanges.size, 0);
});

test('a target running turn blocks cross-provider changes without closing its owner', async () => {
  const h = harness();
  const old = h.loadOwner();
  h.context.activeNativeTurns.set('target', { status: 'running', turnId: 'new-turn', transport: 'app-server' });
  const response = await h.patch();
  assert.equal(response.statusCode, 409);
  assert.match(response.body.error, /该 Codex App 会话任务正在运行/);
  assert.ok(old.child);
  assert.equal(h.calls.length, 0);
});

test('persisted completion clears a matching stale running marker before switching', async () => {
  const h = harness();
  h.context.activeNativeTurns.set('target', { status: 'running', turnId: 'completed-turn', transport: 'app-server' });
  assert.equal((await h.patch()).statusCode, 200);
  assert.equal(h.context.activeNativeTurns.has('target'), false);
});

test('live owner running state rejects a locally completed target without force closing', async () => {
  const h = harness();
  const old = h.loadOwner();
  h.context.ownerRunning = true;
  assert.equal((await h.patch()).statusCode, 409);
  assert.ok(old.child);
  assert.deepEqual(h.calls.map(call => call.method), ['reconcile']);
  assert.equal(h.context.nativeTurnReservations.size, 0);
});

test('pending approvals and existing turn reservations block only their target', async () => {
  for (const reason of ['approval', 'reservation', 'queue']) {
    const h = harness();
    const old = h.loadOwner();
    if (reason === 'approval') h.context.pendingNativeRequests.set('approval', { threadId: 'target', transport: 'app-server', sourceClient: old });
    if (reason === 'reservation') h.context.nativeTurnReservations.add('target');
    if (reason === 'queue') h.context.serverPromptQueueDispatchingThreads.add('target');
    assert.equal((await h.patch()).statusCode, 409, reason);
    assert.ok(old.child, reason);
    assert.equal(h.calls.length, 0, reason);
    if (reason === 'reservation') assert.equal(h.context.nativeTurnReservations.has('target'), true);
  }
});

test('same-provider and model-only updates keep a running dedicated client', async () => {
  for (const body of [{ provider: 'cpa', model: 'new-model' }, { model: 'new-model' }]) {
    const h = harness();
    const old = h.loadOwner();
    h.context.activeNativeTurns.set('target', { status: 'running', turnId: 'new-turn', transport: 'app-server' });
    assert.equal((await h.patch(body)).statusCode, 200);
    assert.equal(h.owners.length, 1);
    assert.equal(old.state.provider, 'cpa');
    assert.equal(old.state.model, 'new-model');
    assert.ok(old.child);
    assert.equal(h.calls.some(call => call.method === 'reconcile'), false);
  }
});

test('failed owner release and settings writes cannot leak provider-change reservations', async () => {
  for (const failure of ['releaseFailure', 'settingsFailure']) {
    const h = harness();
    h.loadOwner();
    h.context[failure] = true;
    assert.equal((await h.patch()).statusCode, 500, failure);
    assert.equal(h.context.nativeTurnReservations.size, 0, failure);
    assert.equal(h.context.nativeThreadProviderChanges.size, 0, failure);
    assert.equal(h.target.metadata.modelProvider, 'cpa', failure);
  }
});

test('a concurrent settings request cannot release the first provider change owner', async () => {
  const h = harness();
  const old = h.loadOwner();
  let release;
  h.context.reconcileHook = () => new Promise(resolve => { release = resolve; });
  const first = h.patch();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.context.nativeThreadProviderChanges.has('target'), true);
  const second = await h.patch({ model: 'another-model' });
  assert.equal(second.statusCode, 409);
  assert.ok(old.child);
  assert.equal(h.calls.some(call => call.method === 'close'), false);
  await h.context.releaseAppServerThreadAfterTurn('target');
  release({ released: true });
  assert.equal((await first).statusCode, 200);
  assert.equal(h.context.nativeTurnReservations.size, 0);
});

test('an idle legacy shared owner is stopped safely, not restarted, before cold resume', async () => {
  const h = harness();
  h.context.appServerLoadedThreads.set('target', { client: h.shared, connection: h.shared.child });
  assert.equal((await h.patch()).statusCode, 200);
  assert.equal(h.calls.filter(call => call.method === 'shared-stop').length, 1);
  assert.equal(h.owners.at(-1).state.provider, 'sub2api');
});

test('a legacy owner with real shared work remains protected', async () => {
  const h = harness();
  h.context.appServerLoadedThreads.set('target', { client: h.shared, connection: h.shared.child });
  h.context.sharedStopAllowed = false;
  assert.equal((await h.patch()).statusCode, 409);
  assert.ok(h.shared.child);
  assert.equal(h.calls.some(call => call.method === 'thread/resume'), false);
  assert.equal(h.context.nativeTurnReservations.size, 0);
});

test('shared writer guard excludes known dedicated work but preserves shared or unknown owners', () => {
  const h = harness();
  h.shared.operationCount = 0;
  h.shared.pending.clear();
  h.context.appServerThreadReconcileRequests = new Map();
  vm.runInContext(section('function appServerWriterHasBlockingWork(', '\nfunction stopAppServerWriterIfIdle('), h.context);
  const dedicated = h.loadOwner('other');
  h.context.activeNativeTurns.set('other', { status: 'running', transport: 'app-server' });
  h.context.pendingNativeRequests.set('approval', { threadId: 'other', transport: 'app-server', sourceClient: dedicated });
  h.context.nativeTurnReservations.add('other');
  h.context.serverPromptQueueDispatchingThreads.add('other');
  h.context.appServerThreadReconcileRequests.set('other', { __appServerRecord: { client: dedicated } });
  assert.equal(h.context.appServerWriterHasBlockingWork(h.shared.child), false);
  h.context.pendingNativeRequests.set('shared', { transport: 'app-server', sourceClient: h.shared });
  assert.equal(h.context.appServerWriterHasBlockingWork(h.shared.child), true);
  h.context.pendingNativeRequests.delete('shared');
  h.context.appServerLoadedThreads.delete('other');
  assert.equal(h.context.appServerWriterHasBlockingWork(h.shared.child), true);
  h.context.activeNativeTurns.set('other', { status: 'running', transport: 'app-server-status' });
  assert.equal(h.context.appServerWriterHasBlockingWork(h.shared.child), true, 'reconciled running state must still protect its writer');
});

test('settings errors survive session refreshes and clear on successful retry', async () => {
  const statusEl = { textContent: '' };
  const conversation = { id: 'target', source: 'codex', status: 'done' };
  const error = '修改 Codex App 会话设置失败: target busy';
  let success = false;
  const context = vm.createContext({
    currentConversationSource: 'codex', currentConversationId: 'target',
    nativeComposerSettingsWriteId: 0, nativeComposerSettingsError: null,
    nativeComposerSettingsQueue: Promise.resolve(), nativeComposerOverride: null,
    provider: { value: 'sub2api', options: [{ value: 'sub2api' }] },
    model: { value: 'new-model', options: [{ value: 'new-model' }] },
    reasoningEffort: { value: 'max' }, statusEl,
    async fetch() { return { ok: success, async json() { return success ? { provider: 'sub2api', model: 'new-model' } : { error }; } }; },
    rememberNativeComposerOverride({ writeId }) { context.nativeComposerOverride = { writeId }; },
    clearNativeComposerOverride() { context.nativeComposerOverride = null; },
    syncComposerChrome() {},
    async syncCurrentNativeConversation() { context.updateConversationStatus(conversation); },
    clearConversationStatusLoading() {}, promptQueueTurnLocked: () => false,
    nativeCancelPendingMatches: () => false, isPromptQueuePausedLocal: () => false,
    conversationHasResumableLimitPause: () => false,
    setNativeNoticeText() {},
    setTopStatusText(text) { statusEl.textContent = text; },
    showNativeRunningTimestamp() { statusEl.textContent = 'running'; },
  });
  vm.runInContext(section('function syncNativeComposerSettings(', '\nfunction newChat('), context);
  vm.runInContext(section('function updateConversationStatus(', '\nasync function applyNativeConversationMetadata('), context);
  assert.equal(await context.syncNativeComposerSettings({ provider: 'sub2api', model: 'new-model' }), false);
  context.updateConversationStatus(conversation);
  context.updateConversationStatus(conversation);
  assert.equal(statusEl.textContent, error);
  context.updateConversationStatus({ ...conversation, id: 'other' });
  assert.match(statusEl.textContent, /已同步/);
  success = true;
  assert.equal(await context.syncNativeComposerSettings({ provider: 'sub2api', model: 'new-model' }), true);
  assert.equal(context.nativeComposerSettingsError, null);
  assert.match(statusEl.textContent, /已同步/);
});
