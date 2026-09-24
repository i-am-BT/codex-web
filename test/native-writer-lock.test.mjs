import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { quarantineUnlockedWriterLock } from '../native-writer-lock.mjs';

test('writer takeover preserves live locks and only moves old unlocked regular files', {
  skip: process.platform !== 'linux',
  timeout: 10000,
}, async () => {
  assert.equal(spawnSync('flock', ['--version']).status, 0);
  const dir = mkdtempSync(path.join(tmpdir(), 'writer-lock-test-'));
  const lock = path.join(dir, 'thread.lock');
  const backup = `${lock}.backup`;
  let owner;
  try {
    writeFileSync(lock, '');
    assert.equal(quarantineUnlockedWriterLock(lock, backup), false, 'young lock stays');
    const old = new Date(Date.now() - 10000);
    utimesSync(lock, old, old);
    owner = spawn('flock', [lock, process.execPath, '-e',
      'process.stdout.write("locked"); process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    await once(owner.stdout, 'data');
    assert.equal(quarantineUnlockedWriterLock(lock, backup), false, 'live owner keeps its inode');
    assert.equal(existsSync(lock), true);
    assert.equal(existsSync(backup), false);
    const exited = once(owner, 'exit');
    owner.stdin.end();
    await exited;
    assert.equal(quarantineUnlockedWriterLock(lock, backup), true, 'released old lock can move');
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(backup), true);
    symlinkSync(backup, lock);
    assert.equal(quarantineUnlockedWriterLock(lock, `${backup}.other`), false, 'symlinks stay');
  } finally {
    if (owner && owner.exitCode === null) owner.stdin.end();
    rmSync(dir, { recursive: true, force: true });
  }
});
