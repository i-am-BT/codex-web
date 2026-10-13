#!/usr/bin/env node
// Isolated RPC fixture: no model/network access, only synthetic test rollouts.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const fixture = JSON.parse(readFileSync(process.env.FORK_TEST_FIXTURE, 'utf8'));
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id === undefined) return;
  appendFileSync(fixture.traceFile, JSON.stringify({ method: request.method, params: request.params }) + '\n');
  let result = {};
  if (request.method === 'initialize') result = { userAgent: 'fork-test', capabilities: {} };
  if (request.method === 'thread/fork') {
    writeFileSync(fixture.childFile, fixture.childRecords);
    result = { thread: { id: fixture.childId, turns: [], status: { type: 'idle' } }, model: 'first-model', modelProvider: 'openai' };
  }
  if (request.method === 'thread/resume' || request.method === 'thread/read') {
    result = { thread: { id: request.params.threadId, turns: [], status: { type: 'idle' } } };
  }
  if (request.method === 'thread/settings/update') {
    appendFileSync(fixture.childFile, JSON.stringify({
      timestamp: new Date().toISOString(), type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_settings: request.params },
    }) + '\n');
  }
  if (request.method === 'model/list' || request.method === 'thread/list') result = { data: [], nextCursor: null };
  if (request.method === 'account/read') result = { account: null, requiresOpenaiAuth: false };
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
});
