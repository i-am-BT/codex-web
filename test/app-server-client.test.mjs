import test from 'node:test';
import assert from 'node:assert/strict';
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
    client.close();
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
