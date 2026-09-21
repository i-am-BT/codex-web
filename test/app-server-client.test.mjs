import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CodexAppServerClient } from '../app-server-client.mjs';

test('app-server error notifications do not emit an unhandled EventEmitter error', () => {
  const client = new CodexAppServerClient();
  const params = {
    error: { message: 'Reconnecting... 1/5' },
    willRetry: true,
    threadId: '019f647e-5ce7-7cb3-98d9-c8646fed896d',
    turnId: '019f64c3-8e99-7f90-98b5-11fe25ac82ed',
  };
  let notification;
  let appServerError;
  client.on('notification', (event) => {
    notification = event;
  });
  client.on('appServerError', (eventParams) => {
    appServerError = eventParams;
  });

  assert.doesNotThrow(() => {
    client.handleLine(JSON.stringify({ method: 'error', params }));
  });
  assert.deepEqual(notification, { method: 'error', params });
  assert.deepEqual(appServerError, params);
});

test('app-server environment overrides can remove inherited provider credentials', () => {
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_BASE_URL = 'https://inherited-provider.example';
  process.env.OPENAI_API_KEY = 'inherited-secret';
  try {
    const client = new CodexAppServerClient({
      env: {
        OPENAI_BASE_URL: undefined,
        OPENAI_API_KEY: undefined,
      },
    });
    const environment = client.buildEnv();
    assert.equal(environment.OPENAI_BASE_URL, undefined);
    assert.equal(environment.OPENAI_API_KEY, undefined);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test('app-server restart applies the latest environment before requests continue', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-app-server-client-'));
  const fakeCodex = path.join(temporary, 'fake-codex.mjs');
  const traceFile = path.join(temporary, 'trace.jsonl');
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.TRACE_FILE, JSON.stringify({
  marker: process.env.RESTART_MARKER,
  args: process.argv.slice(2),
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
      : { marker: process.env.RESTART_MARKER };
    process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
  }
});
`);
  await chmod(fakeCodex, 0o755);

  const client = new CodexAppServerClient({
    bin: fakeCodex,
    cwd: temporary,
    env: { TRACE_FILE: traceFile, RESTART_MARKER: 'first' },
  });
  try {
    assert.deepEqual(await client.request('ping'), { marker: 'first' });
    const firstPid = client.child.pid;

    const firstRestart = client.restart({
      env: { TRACE_FILE: traceFile, RESTART_MARKER: 'second' },
    });
    const latestRestart = client.restart({
      env: { TRACE_FILE: traceFile, RESTART_MARKER: 'latest' },
    });
    const requestDuringRestart = client.request('ping');
    await Promise.all([firstRestart, latestRestart]);

    assert.notEqual(client.child.pid, firstPid);
    assert.deepEqual(await requestDuringRestart, { marker: 'latest' });
    assert.deepEqual(
      (await readFile(traceFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).marker),
      ['first', 'second', 'latest'],
    );
    assert.deepEqual(
      (await readFile(traceFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).args),
      [
        ['app-server', '--stdio'],
        ['app-server', '--stdio'],
        ['app-server', '--stdio'],
      ],
    );
  } finally {
    const closing = client.close();
    assert.strictEqual(client.stop(), closing);
    await closing;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('retries one timed-out initialize before sending a request', async () => {
  const client = new CodexAppServerClient({
    initializeRetryCount: 1,
    initializeRetryDelayMs: 1,
  });
  let attempts = 0;
  client.spawnAndInitialize = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Codex app-server \u8bf7\u6c42\u8d85\u65f6: initialize');
    client.initialized = true;
  };

  await client.start();

  assert.equal(attempts, 2);
  assert.equal(client.initialized, true);
});

test('a failed restart revision does not block a later restart with corrected settings', async () => {
  const client = new CodexAppServerClient({ initializeRetryCount: 0 });
  const attempts = [];
  client.terminateChild = async () => {};
  client.spawnAndInitialize = async () => {
    const marker = client.envOverrides.RESTART_MARKER;
    attempts.push(marker);
    if (marker === 'bad') throw new Error('bad restart');
    client.child = { marker, exitCode: null, signalCode: null };
    client.initialized = true;
  };

  await assert.rejects(
    client.restart({ env: { RESTART_MARKER: 'bad' } }),
    /bad restart/,
  );
  await client.restart({ env: { RESTART_MARKER: 'good' } });

  assert.deepEqual(attempts, ['bad', 'good']);
  assert.equal(client.child.marker, 'good');
  client.close();
  await client.stop();
});

test('stop releases the current app-server process before resolving', async () => {
  const fixture = await createLifecycleFixture({ sigtermDelayMs: 25 });
  const { client } = fixture;
  try {
    const response = await client.request('ping');
    const oldChild = client.child;

    await client.stop();

    assert.equal(client.child, null);
    assert.equal(client.initialized, false);
    assert.ok(oldChild.exitCode !== null || oldChild.signalCode !== null);
    const trace = await fixture.readTrace();
    assert.equal(
      trace.filter((entry) => entry.event === 'sigterm' && entry.pid === response.pid).length,
      1,
    );
    assert.equal(
      trace.filter((entry) => entry.event === 'exit' && entry.pid === response.pid).length,
      1,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('operations begun before stop finish on the old process before it closes', async () => {
  const fixture = await createLifecycleFixture({ sigtermDelayMs: 80 });
  const { client } = fixture;
  try {
    const first = await client.request('ping');
    const oldChild = client.child;
    const request = client.request('ping');
    const requestWithConnection = client.requestWithConnection('ping');
    const notify = client.notify('client/test', { marker: 'before-stop' });
    const stopping = client.stop();

    const [requestResult, connectedResult] = await Promise.all([request, requestWithConnection]);
    await Promise.all([notify, stopping]);

    assert.equal(requestResult.pid, first.pid);
    assert.equal(connectedResult.result.pid, first.pid);
    assert.strictEqual(connectedResult.child, oldChild);
    assert.equal(client.child, null);
    const trace = await fixture.readTrace();
    const notifyIndex = trace.findIndex((entry) => (
      entry.event === 'message'
      && entry.pid === first.pid
      && entry.method === 'client/test'
    ));
    const exitIndex = trace.findIndex((entry) => entry.event === 'exit' && entry.pid === first.pid);
    assert.ok(notifyIndex >= 0);
    assert.ok(exitIndex > notifyIndex);
  } finally {
    await fixture.cleanup();
  }
});

test('close remains a permanent shutdown while stop remains restartable', async () => {
  const fixture = await createLifecycleFixture({ sigtermDelayMs: 20 });
  const { client } = fixture;
  try {
    await client.request('ping');

    client.close();
    await client.stop();

    await assert.rejects(client.request('ping'), /已关闭/);
    const trace = await fixture.readTrace();
    assert.equal(trace.filter((entry) => entry.event === 'start').length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('an operation begun before restart stays on the old process while later work waits', async () => {
  const fixture = await createLifecycleFixture({ sigtermDelayMs: 60 });
  const { client } = fixture;
  try {
    const first = await client.request('ping');
    const requestBeforeRestart = client.request('ping');
    const restarting = client.restart();
    const requestAfterRestart = client.request('ping');

    const beforeResult = await requestBeforeRestart;
    await restarting;
    const afterResult = await requestAfterRestart;

    assert.equal(beforeResult.pid, first.pid);
    assert.notEqual(afterResult.pid, first.pid);
    const trace = await fixture.readTrace();
    const oldExitIndex = trace.findIndex((entry) => entry.event === 'exit' && entry.pid === first.pid);
    const newStartIndex = trace.findIndex((entry) => entry.event === 'start' && entry.pid === afterResult.pid);
    assert.ok(oldExitIndex >= 0);
    assert.ok(newStartIndex > oldExitIndex);
  } finally {
    await fixture.cleanup();
  }
});

test('request during stop waits for the old process to exit before lazily starting a new one', async () => {
  const fixture = await createLifecycleFixture({ sigtermDelayMs: 120 });
  const { client } = fixture;
  try {
    const first = await client.request('ping');
    const oldChild = client.child;
    const stopping = client.stop();
    const requestDuringStop = client.request('ping');

    assert.strictEqual(client.child, oldChild);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(client.child, oldChild);
    assert.equal(oldChild.exitCode, null);
    assert.equal(oldChild.signalCode, null);

    await stopping;
    const second = await requestDuringStop;
    assert.notEqual(second.pid, first.pid);

    const trace = await fixture.readTrace();
    const oldExitIndex = trace.findIndex((entry) => entry.event === 'exit' && entry.pid === first.pid);
    const newStartIndex = trace.findIndex((entry) => entry.event === 'start' && entry.pid === second.pid);
    assert.ok(oldExitIndex >= 0);
    assert.ok(newStartIndex > oldExitIndex);
  } finally {
    await fixture.cleanup();
  }
});

test('concurrent stop calls share one shutdown and signal the child once', async () => {
  const fixture = await createLifecycleFixture({ sigtermDelayMs: 40 });
  const { client } = fixture;
  try {
    const response = await client.request('ping');
    const firstStop = client.stop();
    const secondStop = client.stop();

    assert.strictEqual(secondStop, firstStop);
    await Promise.all([firstStop, secondStop]);

    const trace = await fixture.readTrace();
    assert.equal(
      trace.filter((entry) => entry.event === 'sigterm' && entry.pid === response.pid).length,
      1,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('concurrent stop and close share one termination and wait for the child close event', async () => {
  const client = new CodexAppServerClient({ stopTimeoutMs: 1000 });
  const signals = [];
  const child = createUnclosedChild((signal) => {
    signals.push(signal);
    return true;
  });
  client.child = child;
  client.initialized = true;

  const stopping = client.stop();
  const closing = client.close();
  assert.strictEqual(closing, stopping);

  let settled = false;
  void closing.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(settled, false);
  assert.strictEqual(client.child, child);

  child.signalCode = 'SIGTERM';
  child.emit('close', 0, 'SIGTERM');
  await Promise.all([stopping, closing]);

  assert.equal(settled, true);
  assert.equal(client.child, null);
  assert.equal(client.initialized, false);
  assert.equal(client.closed, true);
});

test('stop invoked during restart runs after the restart and leaves the client stopped', async () => {
  const fixture = await createLifecycleFixture({ sigtermDelayMs: 35 });
  const { client } = fixture;
  try {
    const first = await client.request('ping');
    const restarting = client.restart();
    const stopping = client.stop();

    await Promise.all([restarting, stopping]);

    assert.equal(client.child, null);
    assert.equal(client.initialized, false);
    const trace = await fixture.readTrace();
    const starts = trace.filter((entry) => entry.event === 'start');
    assert.equal(starts.length, 2);
    assert.equal(starts[0].pid, first.pid);
    assert.equal(trace.filter((entry) => entry.event === 'sigterm').length, 2);
    assert.equal(trace.filter((entry) => entry.event === 'exit').length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('stop rejects and retains the child when SIGTERM cannot be sent', async () => {
  const client = new CodexAppServerClient({ stopTimeoutMs: 10 });
  const signals = [];
  const child = createUnclosedChild((signal) => {
    signals.push(signal);
    return false;
  });
  client.child = child;
  client.initialized = true;

  await assert.rejects(
    client.stop(),
    (error) => error.code === 'CODEX_APP_SERVER_STOP_FAILED' && /SIGTERM/.test(error.message),
  );

  assert.deepEqual(signals, ['SIGTERM']);
  assert.strictEqual(client.child, child);
  await assert.rejects(client.request('ping'), /SIGTERM/);
  client.handleChildFailure(child, new Error('late close'));
  await client.close();
});

test('close retries and releases a retained child after the first stop attempt fails', async () => {
  const client = new CodexAppServerClient({ stopTimeoutMs: 1000 });
  const signals = [];
  const child = createUnclosedChild((signal) => {
    signals.push(signal);
    return signals.length > 1;
  });
  client.child = child;
  client.initialized = true;

  await assert.rejects(
    client.stop(),
    (error) => error.code === 'CODEX_APP_SERVER_STOP_FAILED' && /SIGTERM/.test(error.message),
  );
  assert.deepEqual(signals, ['SIGTERM']);
  assert.strictEqual(client.child, child);
  assert.equal(client.initialized, false);

  const closing = client.close();
  let settled = false;
  void closing.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(signals, ['SIGTERM', 'SIGTERM']);
  assert.equal(settled, false);
  assert.strictEqual(client.child, child);

  child.signalCode = 'SIGTERM';
  child.emit('close', 0, 'SIGTERM');
  await closing;

  assert.equal(settled, true);
  assert.equal(client.child, null);
  assert.equal(client.stopFailure, null);
  assert.equal(client.closed, true);
});

test('stop rejects when SIGKILL is not followed by the old child close event', async () => {
  const client = new CodexAppServerClient({ stopTimeoutMs: 10 });
  const signals = [];
  const child = createUnclosedChild((signal) => {
    signals.push(signal);
    return true;
  });
  client.child = child;
  client.initialized = true;

  await assert.rejects(
    client.stop(),
    (error) => error.code === 'CODEX_APP_SERVER_STOP_FAILED' && /SIGKILL 后未收到 close/.test(error.message),
  );

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.strictEqual(client.child, child);
  await assert.rejects(client.request('ping'), /SIGKILL 后未收到 close/);
  client.handleChildFailure(child, new Error('late close'));
  await client.close();
});

test('stop force kills an app-server that ignores SIGTERM', async () => {
  const fixture = await createLifecycleFixture({
    ignoreSigterm: true,
    stopTimeoutMs: 30,
  });
  const { client } = fixture;
  try {
    const response = await client.request('ping');
    const oldChild = client.child;

    await client.stop();

    assert.equal(oldChild.signalCode, 'SIGKILL');
    const trace = await fixture.readTrace();
    assert.equal(
      trace.filter((entry) => entry.event === 'sigterm' && entry.pid === response.pid).length,
      1,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('inbound request callbacks cannot respond through a replacement connection', () => {
  const client = new CodexAppServerClient();
  const oldWrites = [];
  const newWrites = [];
  const oldChild = createWritableChild(oldWrites);
  const newChild = createWritableChild(newWrites);
  const requests = [];
  client.child = oldChild;
  client.initialized = true;
  client.connectionGeneration = 7;
  client.on('request', (request) => requests.push(request));

  client.handleLine(
    JSON.stringify({ id: 41, method: 'item/tool/requestUserInput', params: {} }),
    oldChild,
    7,
  );
  client.handleLine(
    JSON.stringify({ id: 42, method: 'item/commandExecution/requestApproval', params: {} }),
    oldChild,
    7,
  );
  client.child = newChild;
  client.connectionGeneration = 8;

  assert.throws(
    () => requests[0].respond({ answers: {} }),
    (error) => error.code === 'CODEX_APP_SERVER_CONNECTION_CHANGED',
  );
  assert.throws(
    () => requests[1].reject(-32603, 'stale request'),
    (error) => error.code === 'CODEX_APP_SERVER_CONNECTION_CHANGED',
  );
  assert.deepEqual(oldWrites, []);
  assert.deepEqual(newWrites, []);

  client.handleLine(
    JSON.stringify({ id: 43, method: 'item/commandExecution/requestApproval', params: {} }),
    newChild,
    8,
  );
  assert.equal(requests[2].respond({ decision: 'accept' }), true);
  assert.deepEqual(JSON.parse(newWrites[0]), {
    id: 43,
    result: { decision: 'accept' },
  });
});

function createUnclosedChild(kill) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdin = { writable: true, write() {} };
  child.kill = kill;
  return child;
}

function createWritableChild(writes) {
  return {
    exitCode: null,
    signalCode: null,
    killed: false,
    stdin: {
      writable: true,
      write(value) {
        writes.push(value);
      },
    },
  };
}

async function createLifecycleFixture({
  sigtermDelayMs = 0,
  ignoreSigterm = false,
  stopTimeoutMs = 1000,
} = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-app-server-lifecycle-'));
  const fakeCodex = path.join(temporary, 'fake-codex.mjs');
  const traceFile = path.join(temporary, 'trace.jsonl');
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const trace = (entry) => appendFileSync(
  process.env.TRACE_FILE,
  JSON.stringify({ ...entry, at: Date.now() }) + '\\n',
);
trace({ event: 'start', pid: process.pid });
let stopping = false;
process.on('SIGTERM', () => {
  if (stopping) return;
  stopping = true;
  trace({ event: 'sigterm', pid: process.pid });
  if (${JSON.stringify(ignoreSigterm)}) return;
  setTimeout(() => {
    trace({ event: 'exit', pid: process.pid });
    process.exit(0);
  }, ${JSON.stringify(sigtermDelayMs)});
});
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    trace({ event: 'message', pid: process.pid, method: message.method || '', id: message.id ?? null });
    if (!Object.hasOwn(message, 'id') || !message.method) continue;
    const result = message.method === 'initialize'
      ? { userAgent: 'fake' }
      : { pid: process.pid };
    process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
  }
});
`);
  await chmod(fakeCodex, 0o755);

  const client = new CodexAppServerClient({
    bin: fakeCodex,
    cwd: temporary,
    env: { TRACE_FILE: traceFile },
    stopTimeoutMs,
  });
  return {
    client,
    async readTrace() {
      const contents = await readFile(traceFile, 'utf8');
      return contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    async cleanup() {
      client.close();
      await client.stop();
      await rm(temporary, { recursive: true, force: true });
    },
  };
}
