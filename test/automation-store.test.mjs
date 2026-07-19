import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AutomationStore,
  buildAutomationRrule,
  describeAutomationRrule,
  nextAutomationRunAt,
} from '../automation-store.mjs';

test('creates App-compatible automation.toml without writing a database', () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'codex-web-automation-'));
  const store = new AutomationStore(codexHome);
  const item = store.create({
    name: 'Daily Brief',
    prompt: 'Summarize the latest work.',
    rrule: buildAutomationRrule({ frequency: 'weekdays', time: '08:30' }),
    cwd: '/workspace/project',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    notificationPolicy: 'failed_runs_only',
  });

  assert.equal(item.id, 'daily-brief');
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.get(item.id).cwds, ['/workspace/project']);
  const source = readFileSync(path.join(codexHome, 'automations', item.id, 'automation.toml'), 'utf8');
  assert.match(source, /kind = "cron"/);
  assert.match(source, /rrule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=30"/);
  assert.doesNotMatch(source, /target =/);
});

test('updates status atomically and preserves the official fields', () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'codex-web-automation-'));
  const store = new AutomationStore(codexHome);
  const created = store.create({
    name: 'Monitor',
    prompt: 'Check status.',
    rrule: buildAutomationRrule({ frequency: 'hourly', interval: 3 }),
  });
  const paused = store.setStatus(created.id, 'PAUSED');

  assert.equal(paused.status, 'PAUSED');
  assert.equal(store.get(created.id).rrule, 'FREQ=HOURLY;INTERVAL=3;BYMINUTE=0');
  assert.ok(paused.updatedAt >= created.updatedAt);
});

test('edits an automation while preserving its id and creation metadata', () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'codex-web-automation-'));
  const store = new AutomationStore(codexHome);
  const created = store.create({
    name: 'Monitor',
    prompt: 'Check status.',
    rrule: buildAutomationRrule({ frequency: 'daily', time: '09:00' }),
    cwd: '/workspace/project',
  });
  const updated = store.update(created.id, {
    name: 'Morning monitor',
    prompt: 'Check status and report changes.',
    rrule: buildAutomationRrule({ frequency: 'weekdays', time: '09:30' }),
    cwd: '/workspace/other',
    status: 'PAUSED',
  });

  assert.equal(updated.id, created.id);
  assert.equal(updated.name, 'Morning monitor');
  assert.equal(updated.prompt, 'Check status and report changes.');
  assert.equal(updated.status, 'PAUSED');
  assert.deepEqual(updated.cwds, ['/workspace/other']);
  assert.equal(updated.createdAt, created.createdAt);
  assert.ok(updated.updatedAt >= created.updatedAt);
});

test('edits a heartbeat automation without changing its target task', () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'codex-web-automation-'));
  const store = new AutomationStore(codexHome);
  store.write({
    version: 1,
    id: 'existing-task-check',
    kind: 'heartbeat',
    name: 'Existing task check',
    prompt: 'Check the existing task.',
    status: 'ACTIVE',
    rrule: 'FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;BYHOUR=9;BYMINUTE=30',
    model: null,
    reasoningEffort: null,
    notificationPolicy: null,
    executionEnvironment: 'local',
    targetThreadId: '019f7813-f6f5-7240-8a16-49ec4f7cf9f7',
    createdAt: 100,
    updatedAt: 100,
  });

  const updated = store.update('existing-task-check', {
    name: 'Updated existing task check',
    prompt: 'Check and report the existing task.',
    rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=15',
    cwd: '/ignored/for-heartbeat',
    notificationPolicy: 'failed_runs_only',
    status: 'PAUSED',
  });

  assert.equal(updated.kind, 'heartbeat');
  assert.equal(updated.targetThreadId, '019f7813-f6f5-7240-8a16-49ec4f7cf9f7');
  assert.equal(updated.target, undefined);
  assert.equal(updated.cwds, undefined);
  assert.equal(updated.rrule, 'FREQ=DAILY;BYHOUR=10;BYMINUTE=15');
  assert.equal(updated.notificationPolicy, 'failed_runs_only');
});

test('preserves an App-owned cron project target when the editor cannot represent it', () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'codex-web-automation-'));
  const store = new AutomationStore(codexHome);
  store.write({
    version: 1,
    id: 'project-target-check',
    kind: 'cron',
    name: 'Project target check',
    prompt: 'Check the project target.',
    status: 'ACTIVE',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=30',
    model: null,
    reasoningEffort: null,
    notificationPolicy: null,
    executionEnvironment: 'local',
    target: { type: 'project', projectId: 'project-123' },
    cwds: [],
    createdAt: 100,
    updatedAt: 100,
  });

  const updated = store.update('project-target-check', {
    name: 'Updated project target check',
    prompt: 'Check and report the project target.',
    rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=15',
    cwd: '',
    preserveTarget: true,
  });

  assert.deepEqual(updated.target, { type: 'project', projectId: 'project-123' });
  assert.deepEqual(updated.cwds, []);
});

test('formats common schedules and calculates the next run', () => {
  assert.equal(describeAutomationRrule('FREQ=DAILY;BYHOUR=9;BYMINUTE=5'), '每天 09:05');
  assert.equal(
    describeAutomationRrule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0'),
    '工作日 08:00',
  );
  assert.equal(
    describeAutomationRrule('FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;BYHOUR=9;BYMINUTE=30'),
    '每天 09:30',
  );
  const next = nextAutomationRunAt({
    status: 'ACTIVE',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  }, new Date(2026, 6, 19, 8, 30).getTime());
  assert.equal(next, new Date(2026, 6, 19, 9, 0).getTime());
});

test('lists and pauses official heartbeat automations', () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'codex-web-automation-'));
  const directory = path.join(codexHome, 'automations', 'thread-follow-up');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'automation.toml'), `version = 1
id = "thread-follow-up"
kind = "heartbeat"
name = "Follow up"
prompt = "Continue this task."
status = "ACTIVE"
rrule = "RRULE:FREQ=HOURLY;INTERVAL=1;BYMINUTE=0"
target_thread_id = "019f7813-f6f5-7240-8a16-49ec4f7cf9f7"
created_at = 1784426535162
updated_at = 1784426535162
`);
  const store = new AutomationStore(codexHome);
  const item = store.list()[0];
  assert.equal(item.kind, 'heartbeat');
  assert.equal(item.targetThreadId, '019f7813-f6f5-7240-8a16-49ec4f7cf9f7');
  store.setStatus(item.id, 'PAUSED');
  const source = readFileSync(path.join(directory, 'automation.toml'), 'utf8');
  assert.match(source, /kind = "heartbeat"/);
  assert.match(source, /target_thread_id = "019f7813-f6f5-7240-8a16-49ec4f7cf9f7"/);
  assert.match(source, /status = "PAUSED"/);
});
