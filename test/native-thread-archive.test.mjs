import assert from 'node:assert/strict';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { archiveInactiveNativeThread } from '../native-thread-archive.mjs';

test('inactive native archive moves the rollout and updates SQLite idempotently', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-native-archive-'));
  const codexHome = path.join(temporary, '.codex');
  const threadId = '01a03858-2711-7ff3-8ba3-1dc3623863a6';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '08', '25');
  const rolloutPath = path.join(
    sessionDir,
    `rollout-2026-08-25T17-54-56-${threadId}.jsonl`,
  );
  let db;

  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(rolloutPath, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    db = createThreadDb(codexHome);
    db.prepare(`
      INSERT INTO threads (id, rollout_path, archived, archived_at)
      VALUES (?, ?, 0, NULL)
    `).run(threadId, rolloutPath);
    db.close();
    db = null;

    const before = await stat(rolloutPath);
    const expectedRolloutRevision = rolloutRevision(before);
    const archived = archiveInactiveNativeThread({
      codexHome,
      threadId,
      expectedRolloutRevision,
    });
    const archivedPath = path.join(codexHome, 'archived_sessions', path.basename(rolloutPath));

    assert.equal(archived.archived, true);
    assert.equal(archived.alreadyArchived, false);
    assert.equal(archived.rolloutPath, archivedPath);
    assert.equal(await readFile(archivedPath, 'utf8'), '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    await assert.rejects(readFile(rolloutPath, 'utf8'), { code: 'ENOENT' });

    db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
    const row = db.prepare(`
      SELECT archived, archived_at AS archivedAt, rollout_path AS rolloutPath
      FROM threads
      WHERE id = ?
    `).get(threadId);
    assert.equal(row.archived, 1);
    assert.ok(Number(row.archivedAt) > 0);
    assert.equal(row.rolloutPath, archivedPath);
    db.close();
    db = null;

    const repeated = archiveInactiveNativeThread({
      codexHome,
      threadId,
      expectedRolloutRevision,
    });
    assert.equal(repeated.archived, true);
    assert.equal(repeated.alreadyArchived, true);
    assert.equal(repeated.rolloutPath, archivedPath);
  } finally {
    try {
      db?.close();
    } catch {}
    await rm(temporary, { recursive: true, force: true });
  }
});

test('inactive native archive refuses changed or unsafe rollout files', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-native-archive-guard-'));
  const codexHome = path.join(temporary, '.codex');
  const changedId = '01a03858-2711-7ff3-8ba3-1dc3623863a7';
  const unsafeId = '01a03858-2711-7ff3-8ba3-1dc3623863a8';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '08', '25');
  const changedPath = path.join(
    sessionDir,
    `rollout-2026-08-25T17-54-57-${changedId}.jsonl`,
  );
  const unsafePath = path.join(temporary, `rollout-2026-08-25T17-54-58-${unsafeId}.jsonl`);
  let db;

  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(changedPath, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    await writeFile(unsafePath, '{"type":"event_msg","payload":{"type":"task_complete"}}\n');
    const before = await stat(changedPath);
    await appendFile(changedPath, '{"type":"event_msg","payload":{"type":"task_started"}}\n');

    db = createThreadDb(codexHome);
    const insert = db.prepare(`
      INSERT INTO threads (id, rollout_path, archived, archived_at)
      VALUES (?, ?, 0, NULL)
    `);
    insert.run(changedId, changedPath);
    insert.run(unsafeId, unsafePath);
    db.close();
    db = null;

    const changed = archiveInactiveNativeThread({
      codexHome,
      threadId: changedId,
      expectedRolloutRevision: rolloutRevision(before),
    });
    assert.deepEqual(changed, { archived: false, reason: 'rollout-changed' });
    assert.match(await readFile(changedPath, 'utf8'), /task_started/);

    const unsafeStat = await stat(unsafePath);
    const unsafe = archiveInactiveNativeThread({
      codexHome,
      threadId: unsafeId,
      expectedRolloutRevision: rolloutRevision(unsafeStat),
    });
    assert.deepEqual(unsafe, { archived: false, reason: 'unsafe-rollout-path' });

    db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
    assert.deepEqual(
      db.prepare('SELECT id, archived FROM threads ORDER BY id').all().map((row) => ({
        id: row.id,
        archived: row.archived,
      })),
      [
        { id: changedId, archived: 0 },
        { id: unsafeId, archived: 0 },
      ],
    );
  } finally {
    try {
      db?.close();
    } catch {}
    await rm(temporary, { recursive: true, force: true });
  }
});

function createThreadDb(codexHome) {
  const db = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER
    )
  `);
  return db;
}

function rolloutRevision(fileStat) {
  return `${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}`;
}
