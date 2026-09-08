import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NativeSessionStore } from '../native-sessions.mjs';

const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

function soundPipeline(nativeSessions, appServerLoadedThreads = new Map()) {
  let sounds = 0;
  const events = [];
  const frontend = new Function('playTaskCompleteSound', `
    const TASK_COMPLETE_SOUND_STORAGE_KEY = 'sound';
    const TASK_COMPLETE_SOUND_DEDUPE_LIMIT = 100;
    const localStorage = { getItem: () => '1', setItem() {} };
    let taskCompleteSoundEnabled = true;
    const taskCompleteSoundTurnKeys = new Set();
    ${between('function readTaskCompleteSoundEnabled', 'async function playTaskCompleteSound')}
    ${between('function maybePlayTaskCompleteSound', 'function readHistoryCompletionState')}
    return { maybePlayTaskCompleteSound, setTaskCompleteSoundEnabled,
      remembered: () => [...taskCompleteSoundTurnKeys] };
  `)(() => { sounds++; });
  const activeNativeTurns = new Map();
  const backend = new Function('nativeSessions', 'activeNativeTurns', 'appServerLoadedThreads', 'broadcastNativeRuntime', `
    const cleanNativeThreadId = (id) => String(id || '').trim().toLowerCase();
    const cleanServiceTier = (value) => value;
    function requestDesktopThreadSnapshot() {}
    ${between('function nativeTurnStatus', '// A completed JSONL turn')}
    ${between('function isTaskCompleteSoundThread', 'function recordNativeTurnStarted')}
    return { setNativeTurnState, isTaskCompleteSoundThread };
  `)(nativeSessions, activeNativeTurns, appServerLoadedThreads, (event) => {
    events.push(event);
    frontend.maybePlayTaskCompleteSound(event);
  });
  return { ...frontend, ...backend, events, activeNativeTurns, sounds: () => sounds };
}

test('child completions stay silent and the parent completion sounds once even without a state database', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-main-task-sound-'));
  const parent = '019f4f84-ea9f-73c2-b997-deba7b4aa701';
  const child = '019f4f84-ea9f-73c2-b997-deba7b4aa702';
  const nestedChild = '019f4f84-ea9f-73c2-b997-deba7b4aa703';
  const background = '019f4f84-ea9f-73c2-b997-deba7b4aa704';
  let store;
  try {
    const sessions = path.join(directory, 'sessions');
    await mkdir(sessions);
    for (const [id, sessionSource] of [
      [parent, 'appServer'],
      [background, 'vscode'],
      [child, { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: '/root/child', depth: 1 } } }],
      [nestedChild, { subagent: { thread_spawn: { parent_thread_id: child, agent_path: '/root/child/nested', depth: 2 } } }],
    ]) {
      await writeFile(path.join(sessions, `rollout-${id}.jsonl`), JSON.stringify({
        type: 'session_meta', timestamp: new Date().toISOString(),
        payload: { id, source: sessionSource, cwd: '/workspace', originator: 'Codex' },
      }) + '\n');
    }
    store = new NativeSessionStore(directory, { watchChanges: false });
    // The no-database fallback lists children as ordinary conversations; a UI
    // history allowlist alone would therefore still permit false notifications.
    assert.equal(store.get(child).source, 'codex');
    assert.equal(store.subagentEntries.size, 0);
    const beforeClassification = store.version;
    assert.equal(store.getThreadSource(parent), 'appServer');
    assert.ok(store.getThreadSource(child).subagent);
    assert.equal(store.version, beforeClassification, 'source lookup must not trigger a store refresh');
    const pipeline = soundPipeline(store);
    pipeline.setNativeTurnState(parent, { turnId: 'parent-turn', status: 'inProgress' });
    for (const id of [child, nestedChild]) {
      pipeline.setNativeTurnState(id, { turnId: 'child-turn', status: 'completed' });
      pipeline.setNativeTurnState(id, { turnId: 'follow-up', status: 'completed' });
    }
    assert.equal(pipeline.sounds(), 0);
    assert.equal(pipeline.activeNativeTurns.get(parent).status, 'running');
    assert.equal(pipeline.events.length, 5, 'child runtime events must remain available to other consumers');
    assert.deepEqual(pipeline.remembered(), [], 'child events must not consume deduplication slots');

    pipeline.setNativeTurnState(parent, { turnId: 'parent-turn', status: 'completed' });
    pipeline.setNativeTurnState(parent, { turnId: 'parent-turn', status: 'completed' });
    assert.equal(pipeline.sounds(), 1);
    pipeline.setNativeTurnState(child, { turnId: 'late-child-turn', status: 'completed' });
    assert.equal(pipeline.sounds(), 1, 'late child completions stay silent too');
    pipeline.setNativeTurnState(background, { turnId: 'background-turn', status: 'completed' });
    assert.equal(pipeline.sounds(), 2, 'other main tasks still notify when their view is not open');
    for (const status of ['failed', 'interrupted']) {
      pipeline.setNativeTurnState(parent, { turnId: status, status });
    }
    assert.equal(pipeline.sounds(), 2);
    pipeline.setTaskCompleteSoundEnabled(false);
    pipeline.setNativeTurnState(parent, { turnId: 'muted-turn', status: 'completed' });
    pipeline.setTaskCompleteSoundEnabled(true);
    pipeline.setNativeTurnState(parent, { turnId: 'muted-turn', status: 'completed' });
    assert.equal(pipeline.sounds(), 2);
  } finally {
    store?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('indexed subagents, unknown threads and unclassified runtime events cannot trigger sound', () => {
  const store = {
    getThreadSource(id) {
      if (['indexed-child', 'rollout-child'].includes(id)) return 'subagent';
      if (id === 'unavailable') throw new Error('session unavailable');
      if (id === 'unknown' || id === 'new-main') return '';
      return id === 'main' ? 'app_server' : { subagent: 'review' };
    },
    scheduleRefresh() {},
  };
  const pipeline = soundPipeline(store, new Map([['new-main', {}], ['indexed-child', {}], ['review-child', {}]]));
  for (const id of ['indexed-child', 'rollout-child', 'review-child', 'unknown', 'unavailable']) {
    pipeline.setNativeTurnState(id, { turnId: 'turn', status: 'completed' });
  }
  assert.equal(pipeline.sounds(), 0);
  pipeline.maybePlayTaskCompleteSound({ type: 'turn', threadId: 'main', turnId: 'turn', status: 'done' });
  assert.equal(pipeline.sounds(), 0);
  assert.deepEqual(pipeline.remembered(), []);
  pipeline.setNativeTurnState('main', { turnId: 'turn', status: 'completed' });
  assert.equal(pipeline.sounds(), 1);
  pipeline.setNativeTurnState('new-main', { turnId: 'new-turn', status: 'completed' });
  assert.equal(pipeline.sounds(), 2, 'a Web-started main task can notify before its rollout appears');
});
