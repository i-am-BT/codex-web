import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const sendStart = source.indexOf('async function send(){');
const sendSource = source.slice(sendStart, source.indexOf('\n</script>', sendStart));
const recoverySource = source.slice(source.indexOf('function renderFailedNativeSendDrafts(){'), sendStart);
const readSyncSource = source.slice(
  source.indexOf('async function syncHistoryCompletionReadFromServer(){'),
  source.indexOf('function pushHistoryCompletionReadToServer(){'),
);

function sendHarness(initialThreadId = 'A') {
  let respond;
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const timers = [];
  const locks = new Map();
  const uiCalls = [];
  const originalAttachment = { kind: 'image', url: '/a.png' };
  const env = {
    input: { value: 'message for A', style: {}, scrollHeight: 30, focus: () => uiCalls.push('focus') },
    pendingAttachments: [originalAttachment], sendBtn: { disabled: false }, appQueueEditDraft: null,
    conversationLoadSeq: 1, currentConversationId: initialThreadId, currentConversationSource: 'codex',
    nativeComposerSettingsQueue: Promise.resolve(), webRunActive: false,
    composerPermissionMode: 'default', currentNativeRunStatus: 'done', activeNativeTurnId: '',
    provider: { value: 'openai' }, model: { value: 'm' }, reasoningEffort: { value: 'low' },
    composerServiceTier: '', sandbox: { value: 'read-only' }, approval: { value: 'never' },
    cwd: { value: '/a' }, nativeNotice: {}, statusEl: {}, lastTurnErrorElement: null,
    nativeComposerOverride: null,
    failedNativeSendDrafts: new Map(),
    conversationKey: (source, id) => `${source}:${id}`,
    renderFailedNativeSendDrafts: () => {},
    canResumeInterruptedNativeTask: () => false,
    waitForLatestComposerProviderChange: async () => true,
    waitForLatestComposerModelLoad: async () => true,
    composerPermissionPayload: () => ({}),
    clearPendingAttachments: () => { env.pendingAttachments = []; },
    markPromptQueueTurnRunning: (id, turn) => locks.set(id, turn),
    setNativeComposerOverride: (threadId) => { env.nativeComposerOverride = { threadId, pending: true }; },
    clearNativeComposerOverride: () => { env.nativeComposerOverride = null; },
    addMsg: () => { uiCalls.push('addMsg'); return {}; },
    refreshHistory: () => {},
    fetch: () => new Promise((resolve) => {
      respond = (ok = true) => resolve({ ok, json: async () => ok
        ? { threadId: 'A', turnId: 'turnA' }
        : { error: 'A failed' } });
      started();
    }),
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
  };
  for (const name of [
    'closeComposerPopovers', 'showNativePromptOptimistically', 'clearNativeCancelPending',
    'applyConversationMode', 'showNativeRunningTimestamp', 'updateActiveHistory',
    'removeNativeRunningElement', 'clearNativeOptimisticElements', 'renderAttachmentTray',
    'resumeNativeLiveFollowBottom', 'scrollChatToLatest', 'alignChatToBottomStable',
    'syncCurrentNativeConversation',
  ]) env[name] = () => { uiCalls.push(name); };
  vm.createContext(env);
  vm.runInContext(sendSource, env);
  const switchTask = (threadId = 'B') => {
    Object.assign(env, {
      conversationLoadSeq: env.conversationLoadSeq + 1, currentConversationId: threadId,
      currentConversationSource: 'codex', webRunActive: true, currentNativeRunStatus: 'running',
      activeNativeTurnId: 'turnB', nativeComposerOverride: { threadId, pending: true },
      pendingAttachments: [{ kind: 'image', url: '/b.png' }],
    });
    env.input.value = 'unsent B draft';
    uiCalls.length = 0;
  };
  return { env, timers, locks, uiCalls, requestStarted, respond: (...args) => respond(...args), switchTask, originalAttachment };
}

for (const ok of [true, false]) {
  test(`a ${ok ? 'successful' : 'failed'} send receipt cannot overwrite a newly selected task`, async () => {
    for (const initialThreadId of ['A', '']) {
      const h = sendHarness(initialThreadId);
      const sending = h.env.send();
      await h.requestStarted;
      h.switchTask();
      const attachments = h.env.pendingAttachments;
      const override = h.env.nativeComposerOverride;
      h.respond(ok);
      await sending;
      assert.equal(h.env.currentConversationId, 'B');
      assert.equal(h.env.input.value, 'unsent B draft');
      assert.equal(h.env.activeNativeTurnId, 'turnB');
      assert.equal(h.env.webRunActive, true);
      assert.equal(h.env.currentNativeRunStatus, 'running');
      assert.equal(h.env.pendingAttachments, attachments);
      assert.equal(h.env.nativeComposerOverride, override);
      assert.deepEqual(h.uiCalls, []);
      assert.equal(h.locks.get('A'), ok ? 'turnA' : undefined);
      const recovered = h.env.failedNativeSendDrafts.get(`codex:${initialThreadId}`);
      if (ok) assert.equal(recovered, undefined);
      else {
        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].message, 'message for A');
        assert.equal(recovered[0].attachments[0], h.originalAttachment);
      }
    }
  });
}

test('returning to the original task still invalidates an earlier send receipt', async () => {
  const h = sendHarness();
  const sending = h.env.send();
  await h.requestStarted;
  h.switchTask();
  h.switchTask('A');
  h.respond(false);
  await sending;
  assert.equal(h.env.input.value, 'unsent B draft');
  assert.equal(h.env.activeNativeTurnId, 'turnB');
  assert.deepEqual(h.uiCalls, []);
});

test('an unchanged send still applies success or restores the failed message', async () => {
  for (const ok of [true, false]) {
    const h = sendHarness();
    const sending = h.env.send();
    await h.requestStarted;
    h.respond(ok);
    await sending;
    assert.equal(h.env.currentConversationId, 'A');
    assert.equal(h.env.input.value, ok ? '' : 'message for A');
    assert.equal(h.env.activeNativeTurnId, ok ? 'turnA' : '');
    assert.equal(h.env.webRunActive, ok);
    if (!ok) assert.equal(h.env.pendingAttachments[0], h.originalAttachment);
  }
});

test('post-send delayed refresh does not touch a task selected after the response', async () => {
  const h = sendHarness();
  const sending = h.env.send();
  await h.requestStarted;
  h.respond();
  await sending;
  assert.equal(h.timers.length, 1);
  h.switchTask();
  const override = h.env.nativeComposerOverride;
  await h.timers[0]();
  assert.deepEqual(h.uiCalls, []);
  assert.equal(h.env.nativeComposerOverride, override);
});

test('a failed send can be recovered only in its original task without overwriting an existing draft', async () => {
  for (const initialThreadId of ['A', '']) {
    const h = sendHarness(initialThreadId);
    const sending = h.env.send();
    await h.requestStarted;
    h.switchTask();
    h.respond(false);
    await sending;
    const children = [];
    h.env.document = {
      createElement: () => ({
        children: [],
        appendChild(child) { this.children.push(child); },
        addEventListener(type, listener) { this[type] = listener; },
        remove() { children.splice(children.indexOf(this), 1); },
      }),
    };
    h.env.chat = {
      querySelectorAll: () => [...children],
      appendChild: (node) => children.push(node),
    };
    vm.runInContext(recoverySource, h.env);
    h.env.renderFailedNativeSendDrafts();
    assert.equal(children.length, 0, 'the failure recovery entry must not appear in task B');
    h.switchTask(initialThreadId);
    h.env.input.value = 'existing original-task draft';
    const existingAttachment = h.env.pendingAttachments[0];
    h.env.renderFailedNativeSendDrafts();
    assert.equal(children.length, 1);
    const recover = children[0].children[0];
    assert.equal(recover.textContent, '将未发送消息追加到输入框');
    recover.click();
    assert.equal(h.env.input.value, 'existing original-task draft\n\nmessage for A');
    assert.equal(h.env.pendingAttachments[0], existingAttachment);
    assert.equal(h.env.pendingAttachments[1], h.originalAttachment);
    assert.equal(h.env.failedNativeSendDrafts.size, 0);
    assert.equal(children.length, 0);
    assert.equal(h.locks.size, 0, 'recovery must not dispatch or queue a turn');
  }
});

test('read-state changes during a request produce one follow-up request with the new state', async () => {
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const env = {
    historyCompletionSyncTimer: null, historyCompletionSyncInFlight: null,
    historyCompletionSyncQueued: false, historyCompletionRead: new Map(),
    HISTORY_COMPLETION_SYNC_DELAY_MS: 5000,
    fetch: () => new Promise((resolve) => requests.push(resolve)),
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    selectHistoryCompletionReadVersion: (_key, _local, remote) => remote,
    pushHistoryCompletionReadToServer: () => {}, renderHistory: () => {},
  };
  vm.createContext(env);
  vm.runInContext(readSyncSource, env);
  const first = env.syncHistoryCompletionReadFromServer();
  env.scheduleHistoryCompletionReadSync();
  env.scheduleHistoryCompletionReadSync();
  const joined = env.syncHistoryCompletionReadFromServer();
  assert.equal(requests.length, 1);
  requests[0]({ ok: true, json: async () => ({ read: {} }) });
  await Promise.all([first, joined]);
  assert.equal(timers.size, 1);
  const followUp = [...timers.values()][0];
  timers.clear();
  followUp();
  assert.equal(requests.length, 2);
  requests[1]({ ok: true, json: async () => ({ read: { 'codex:A': 'done|2026-09-08T01:00:00Z' } }) });
  await env.historyCompletionSyncInFlight;
  await Promise.resolve();
  assert.equal(env.historyCompletionRead.get('codex:A'), 'done|2026-09-08T01:00:00Z');
  assert.equal(env.historyCompletionSyncInFlight, null);
  assert.equal(timers.size, 0, 'no polling loop after the queued change is reconciled');
});
