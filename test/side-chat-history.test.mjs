import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NativeSessionStore } from '../native-sessions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('server marks and filters side chat threads from history', () => {
  const server = fs.readFileSync(path.join(root, 'server.mjs'), 'utf8');
  for (const needle of [
    'markSideChatThread',
    'isSideChatThread',
    'unmarkSideChatThread',
    'includeSideChat',
    'sideChat:true,sourceThreadId:threadId',
    'historyItems=items.filter((item)=>!item?.sideChat',
    'sideChatStateFile',
    'side-chat-threads.json',
  ]) {
    assert.ok(server.includes(needle), needle);
  }
});

test('native store persists side-chat-thread-ids and annotates list summaries', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-sidechat-'));
  try {
    const sessionsDir = path.join(temporary, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sideId = '019f8888-aaaa-bbbb-cccc-ddddeeee0001';
    const mainId = '019f8888-aaaa-bbbb-cccc-ddddeeee0002';
    const now = new Date().toISOString();
    for (const id of [sideId, mainId]) {
      fs.writeFileSync(
        path.join(sessionsDir, id + '.jsonl'),
        JSON.stringify({
          timestamp: now,
          type: 'session_meta',
          payload: { id, cwd: '/tmp/project', originator: 'appServer' },
        }) + '\n',
      );
    }
    fs.writeFileSync(
      path.join(temporary, '.codex-global-state.json'),
      JSON.stringify({ 'projectless-thread-ids': [], 'pinned-thread-ids': [] }) + '\n',
    );

    const store = new NativeSessionStore(temporary, { watchChanges: false, pollIntervalMs: 60000, sideChatStateFile: path.join(temporary, 'side-chat-threads.json') });
    assert.equal(store.isSideChatThread(sideId), false);
    assert.equal(store.markSideChatThread(sideId, { sourceThreadId: mainId }), true);
    assert.equal(store.isSideChatThread(sideId), true);
    assert.equal(store.sideChatSourceThreadId(sideId), mainId);

    const persisted = JSON.parse(fs.readFileSync(path.join(temporary, '.codex-global-state.json'), 'utf8'));
    const ids = Array.isArray(persisted['side-chat-thread-ids'])
      ? persisted['side-chat-thread-ids']
      : Object.keys(persisted['side-chat-thread-ids'] || {});
    assert.ok(ids.map((id) => String(id).toLowerCase()).includes(sideId));

    // Local durable registry should survive Codex App rewriting global state.
    const localFile = path.join(temporary, 'side-chat-threads.json');
    assert.equal(fs.existsSync(localFile), true);
    const localState = JSON.parse(fs.readFileSync(localFile, 'utf8'));
    const localIds = Array.isArray(localState['side-chat-thread-ids'])
      ? localState['side-chat-thread-ids']
      : Object.keys(localState['side-chat-thread-ids'] || {});
    assert.ok(localIds.map((id) => String(id).toLowerCase()).includes(sideId));
    fs.writeFileSync(
      path.join(temporary, '.codex-global-state.json'),
      JSON.stringify({ 'projectless-thread-ids': [], 'pinned-thread-ids': [] }) + '\n',
    );
    store.refresh();
    assert.equal(store.isSideChatThread(sideId), true);

    store.refresh();
    const list = store.list(100);
    const side = list.find((item) => item.id === sideId);
    const main = list.find((item) => item.id === mainId);
    if (side) {
      assert.equal(side.sideChat, true);
      assert.equal(side.sideChatSourceThreadId, mainId);
    }
    if (main) assert.notEqual(main.sideChat, true);

    assert.equal(store.unmarkSideChatThread(sideId), true);
    assert.equal(store.isSideChatThread(sideId), false);
    store.stop();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
