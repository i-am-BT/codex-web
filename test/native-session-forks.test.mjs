import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { NativeSessionStore } from '../native-sessions.mjs';

const parentId = '019f638d-488c-7520-b72a-9c0be60aa001';
const childId = '019f638d-488c-7520-b72a-9c0be60aa002';
const grandchildId = '019f638d-488c-7520-b72a-9c0be60aa003';
const timestamp = '2026-10-13T02:01:18.000Z';
const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
const event = (payload) => ({ timestamp, type: 'event_msg', payload });
const settings = (model) => event({ type: 'thread_settings_applied', thread_settings: { model } });
const meta = (id, historyBase = null) => ({
  timestamp, type: 'session_meta',
  payload: {
    id, timestamp, cwd: '/workspace', source: 'vscode', model_provider: 'child-provider',
    history_mode: 'paginated', ...(historyBase ? { history_base: historyBase } : {}),
  },
});
const turn = (id, text) => [
  event({ type: 'task_started', turn_id: id }),
  { timestamp, type: 'turn_context', payload: { turn_id: id, model: 'parent-model' } },
  { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
  { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: `reply:${text}` }] } },
  event({ type: 'task_complete', turn_id: id }),
];
const base = (id, records, ordinal = records.length) => ({
  thread_id: id, end_ordinal_exclusive: ordinal, end_byte_offset: Buffer.byteLength(jsonl(records)),
});

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'codex-native-fork-'));
  const directory = path.join(home, 'sessions', '2026', '10', '13');
  await mkdir(directory, { recursive: true });
  let store;
  t.after(async () => { store?.stop(); await rm(home, { recursive: true, force: true }); });
  return {
    async write(id, records, archived = false) {
      const folder = archived ? path.join(home, 'archived_sessions') : directory;
      await mkdir(folder, { recursive: true });
      const file = path.join(folder, `rollout-2026-10-13T10-01-18-${id}.jsonl`);
      await writeFile(file, jsonl(records));
      return file;
    },
    home,
    open(options = {}) { store = new NativeSessionStore(home, { watchChanges: false, ...options }); return store; },
  };
}

test('metadata-only threads stay idle through model changes until a task actually starts', async (t) => {
  const f = await fixture(t);
  const file = await f.write(childId, [meta(childId), settings('first-model')]);
  const store = f.open();
  assert.equal(store.get(childId).status, 'done');
  assert.equal(store.list().find((item) => item.id === childId).status, 'done');
  await appendFile(file, jsonl([settings('second-model')]));
  const changed = store.get(childId);
  assert.equal(changed.metadata.model, 'second-model');
  assert.equal(changed.status, 'done');
  assert.equal(changed.latestTurnId, '');
  assert.equal(changed.messages.length, 0);
  await appendFile(file, jsonl(turn('child-turn', 'start').slice(0, -1)));
  assert.equal(store.get(childId).status, 'running');
  await appendFile(file, jsonl([event({ type: 'task_complete', turn_id: 'child-turn' })]));
  assert.equal(store.get(childId).status, 'done');
});

test('paginated forks restore only their frozen parent prefix and follow child turns incrementally', async (t) => {
  const f = await fixture(t);
  const prefix = [meta(parentId), ...turn('parent-turn', '继承的中文历史')];
  const parentFile = await f.write(parentId, [...prefix, ...turn('later-parent-turn', 'not-in-fork')]);
  const childFile = await f.write(childId, [meta(childId, base(parentId, prefix)), settings('child-model')]);
  const store = f.open();
  const first = store.get(childId);
  assert.equal(first.status, 'done');
  assert.equal(first.latestTurnId, 'parent-turn');
  assert.equal(first.metadata.id, childId);
  assert.equal(first.metadata.model, 'child-model');
  assert.deepEqual(first.messages.filter((item) => ['user', 'assistant'].includes(item.role)).map((item) => item.content), [
    '继承的中文历史', 'reply:继承的中文历史',
  ]);
  await appendFile(parentFile, jsonl(turn('new-parent-turn', 'also-not-in-fork')));
  await appendFile(childFile, jsonl([settings('switched-model')]));
  const changed = store.get(childId);
  assert.equal(changed.status, 'done');
  assert.equal(changed.metadata.model, 'switched-model');
  assert.equal(changed.cursor, first.cursor);
  assert.equal(changed.generation, first.generation);
  assert.equal(store.list().find((item) => item.id === childId).status, 'done');
  await appendFile(childFile, jsonl(turn('child-turn', 'child-message').slice(0, -1)));
  const running = store.get(childId, { after: changed.cursor, generation: changed.generation });
  assert.equal(running.status, 'running');
  assert.equal(running.latestTurnId, 'child-turn');
  assert.equal(running.reset, false);
  assert.ok(running.messages.some((item) => item.content === 'child-message'));
  assert.ok(running.messages.every((item) => item.turnId === 'child-turn'));
  await appendFile(childFile, jsonl([event({ type: 'task_complete', turn_id: 'child-turn' })]));
  assert.equal(store.get(childId).status, 'done');
  assert.equal(store.get(parentId).latestTurnId, 'new-parent-turn');
});

test('nested paginated forks resolve archived ancestors without including newer source turns', async (t) => {
  const f = await fixture(t);
  const root = [meta(parentId), ...turn('root-turn', 'root-history')];
  await f.write(parentId, [...root, ...turn('excluded-root', 'excluded-root')], true);
  const child = [meta(childId, base(parentId, root)), ...turn('middle-turn', 'middle-history')];
  await f.write(childId, [...child, ...turn('excluded-middle', 'excluded-middle')]);
  await f.write(grandchildId, [meta(grandchildId, base(childId, child, root.length + child.length)), settings('grandchild-model')]);
  const conversation = f.open().get(grandchildId);
  assert.equal(conversation.status, 'done');
  assert.equal(conversation.latestTurnId, 'middle-turn');
  assert.equal(conversation.metadata.id, grandchildId);
  assert.equal(conversation.metadata.model, 'grandchild-model');
  assert.deepEqual(conversation.messages.filter((item) => item.role === 'user').map((item) => item.content), ['root-history', 'middle-history']);
});

test('bounded paginated history remains idle when only settings follow its inherited snapshot', async (t) => {
  const f = await fixture(t);
  const prefix = [meta(parentId), ...turn('parent-turn', 'x'.repeat(8000))];
  await f.write(parentId, prefix);
  await f.write(childId, [meta(childId, base(parentId, prefix)), settings('child-model')]);
  const store = f.open({ maxReadBytes: 1024 });
  const conversation = store.get(childId);
  assert.equal(conversation.status, 'done');
  assert.equal(conversation.metadata.model, 'child-model');
  assert.equal(conversation.truncated, true);
  assert.equal(store.list().find((item) => item.id === childId).status, 'done');
  store.details.delete(childId);
  store.maxReadBytes = Buffer.byteLength(jsonl([settings('child-model')])) + 8;
  const settingsOnlyTail = store.get(childId);
  assert.equal(settingsOnlyTail.status, 'done');
  assert.equal(settingsOnlyTail.metadata.model, 'child-model');
});

test('bounded forks infer running only from local turn metadata and retain terminal states across settings writes', async (t) => {
  const f = await fixture(t);
  const prefix = [meta(parentId), ...turn('parent-turn', 'parent')];
  await f.write(parentId, prefix);
  const local = [
    meta(childId, base(parentId, prefix)),
    event({ type: 'task_started', turn_id: 'child-turn' }),
    { timestamp, type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'x'.repeat(8000) }] } },
    { timestamp, type: 'turn_context', payload: { turn_id: 'child-turn' } },
    settings('child-model'),
  ];
  const file = await f.write(childId, local);
  const store = f.open({ maxReadBytes: 512 });
  assert.equal(store.get(childId).status, 'running');
  await appendFile(file, jsonl([event({ type: 'task_complete', turn_id: 'child-turn' }), settings('after-completion')]));
  assert.equal(store.get(childId).status, 'done');
  await appendFile(file, jsonl([settings('another-switch')]));
  assert.equal(store.get(childId).status, 'done');
});

test('inherited task status never gives a fresh fork live ownership', async (t) => {
  const f = await fixture(t);
  const parent = [meta(parentId), event({ type: 'task_started', turn_id: 'running-parent' })];
  await f.write(parentId, parent);
  await f.write(childId, [meta(childId, base(parentId, parent)), settings('child-model')]);
  const store = f.open();
  assert.equal(store.get(parentId).status, 'running');
  assert.equal(store.get(childId).status, 'done');
});

test('paginated history cannot escape the configured store through a source symlink', async (t) => {
  const f = await fixture(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'codex-fork-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const parent = [meta(parentId), ...turn('parent-turn', 'outside')];
  const source = path.join(outside, 'parent.jsonl');
  await writeFile(source, jsonl(parent));
  await symlink(source, path.join(f.home, 'sessions', '2026', '10', '13', `rollout-2026-10-13T10-01-18-${parentId}.jsonl`));
  await f.write(childId, [meta(childId, base(parentId, parent))]);
  const store = f.open();
  // A state-index entry can point at a symlink even though filesystem scans do not.
  store.entries.set(parentId, { id: parentId, filePath: source });
  assert.throws(() => store.get(childId), /父历史不在会话存储内/);
});

test('invalid paginated references fail locally without breaking the session list', async (t) => {
  for (const kind of ['missing', 'cycle', 'path', 'oversized', 'partial', 'ordinal']) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      const prefix = [meta(parentId), ...turn('parent-turn', 'parent')];
      await f.write(parentId, prefix);
      const reference = base(parentId, prefix);
      if (kind === 'missing') reference.thread_id = grandchildId;
      if (kind === 'cycle') reference.thread_id = childId;
      if (kind === 'path') reference.thread_id = `../../${parentId}`;
      if (kind === 'oversized') reference.end_byte_offset += 100;
      if (kind === 'partial') reference.end_byte_offset -= 1;
      if (kind === 'ordinal') reference.end_ordinal_exclusive = -1;
      await f.write(childId, [meta(childId, reference)]);
      const store = f.open();
      assert.throws(() => store.get(childId), /分页分支历史/);
      assert.equal(store.list().find((item) => item.id === childId).status, 'error');
      assert.equal(store.get(parentId).status, 'done');
    });
  }
});

test('HTTP create-fork then change-model never starts a turn or reports running', { timeout: 30000 }, async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-fork-http-'));
  const home = path.join(temporary, 'codex-home');
  const runtime = path.join(temporary, 'runtime');
  const directory = path.join(home, 'sessions', '2026', '10', '13');
  let server;
  t.after(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, 'exit');
      server.kill('SIGTERM');
      await stopped;
    }
    await rm(temporary, { recursive: true, force: true });
  });
  await mkdir(directory, { recursive: true });
  await mkdir(runtime);
  const configFile = path.join(home, 'config.toml');
  await writeFile(configFile, 'model_provider = "openai"\nmodel = "first-model"\n');
  const records = [meta(parentId), ...turn('parent-turn', 'HTTP inherited message')];
  const parentFile = path.join(directory, `rollout-2026-10-13T10-01-18-${parentId}.jsonl`);
  const childFile = path.join(directory, `rollout-2026-10-13T10-01-18-${childId}.jsonl`);
  await writeFile(parentFile, jsonl(records));
  const traceFile = path.join(temporary, 'rpc.jsonl');
  await writeFile(traceFile, '');
  const fixtureFile = path.join(temporary, 'fixture.json');
  await writeFile(fixtureFile, JSON.stringify({
    childId, childFile, traceFile,
    childRecords: jsonl([meta(childId, base(parentId, records)), settings('first-model')]),
  }));
  const bin = path.join(temporary, 'fork-app-server.mjs');
  await copyFile(path.join(root, 'scripts', 'test-fixtures', 'fork-app-server.mjs'), bin);
  await chmod(bin, 0o755);
  server = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root, stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: '0', PORT_MIN: '45000', PORT_MAX: '45999',
      CODEX_WEB_PASSWORD: 'test-password', SESSION_SECRET: 'test-secret-with-enough-entropy',
      CODEX_HOME: home, CODEX_PROCESS_HOME: temporary, CODEX_CONFIG_FILE: configFile,
      CODEX_BIN: bin, FORK_TEST_FIXTURE: fixtureFile, CODEX_CONFIG_WRITABLE: 'false',
      CODEX_WEB_ENV_FILE: path.join(temporary, 'web.env'), CODEX_ENV_FILE: path.join(temporary, 'codex.env'),
      CODEX_WEB_RUNTIME_DIR: runtime, DEFAULT_CWD: temporary,
      CODEX_DESKTOP_IPC_ENABLED: 'false', CODEX_EXISTING_THREAD_APP_SERVER_FALLBACK: 'true',
      IMAGE_PROMPT_AUTO_SYNC: 'false', PLAYGROUND_UPDATE_ENABLED: 'false',
      CODEX_APP_QUOTA_VISIBLE: 'false', CPA_QUOTA_VISIBLE: 'false', SUB2API_QUOTA_VISIBLE: 'false',
      GROK2API_QUOTA_VISIBLE: 'false', DEEPSEEK_QUOTA_VISIBLE: 'false', SUB_QUOTA_SOURCES: '',
    },
  });
  let diagnostics = '';
  server.stderr.on('data', (chunk) => { diagnostics += chunk; });
  let url;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { url = `http://127.0.0.1:${Number(await readFile(path.join(runtime, 'port'), 'utf8'))}`; break; } catch {}
    if (server.exitCode !== null) throw new Error(diagnostics);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(url, diagnostics);
  const login = await fetch(`${url}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const request = (pathname, body, method = 'GET') => fetch(url + pathname, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  });
  const parent = (await (await request(`/api/native-sessions/${parentId}`)).json()).conversation;
  const assistant = parent.messages.find((message) => message.role === 'assistant');
  assert.ok(assistant);
  const created = await request(`/api/native-sessions/${parentId}/fork`, {
    messageSeq: assistant.seq, turnId: assistant.turnId, role: assistant.role,
    provider: 'openai', model: 'first-model', cwd: temporary,
  }, 'POST');
  assert.equal(created.status, 201);
  const createdPayload = await created.json();
  assert.equal(createdPayload.conversation.status, 'done');
  assert.equal(createdPayload.conversation.activeTurnId, '');
  assert.ok(createdPayload.conversation.messages.some((message) => message.content === 'HTTP inherited message'));
  const changed = await request(`/api/native-sessions/${childId}`, { model: 'second-model', allowWebTakeover: true }, 'PATCH');
  assert.equal(changed.status, 200);
  const after = (await (await request(`/api/native-sessions/${childId}`)).json()).conversation;
  assert.equal(after.status, 'done');
  assert.equal(after.activeTurnId, '');
  assert.equal(after.metadata.model, 'second-model');
  const config = await (await request('/api/config')).json();
  assert.equal(config.conversations.find((item) => item.id === childId).status, 'done');
  const calls = (await readFile(traceFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some((call) => call.method === 'thread/fork'));
  assert.ok(calls.some((call) => call.method === 'thread/settings/update'));
  assert.equal(calls.some((call) => call.method === 'turn/start'), false);
  assert.equal(await readFile(parentFile, 'utf8'), jsonl(records));
});
