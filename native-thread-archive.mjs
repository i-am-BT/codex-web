import {
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const THREAD_UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const THREAD_ID_PATTERN = new RegExp(`^${THREAD_UUID_SOURCE}$`, 'i');
const THREAD_FILE_PATTERN = new RegExp(
  `(${THREAD_UUID_SOURCE})(?:_${THREAD_UUID_SOURCE})?\\.jsonl$`,
  'i',
);

export function archiveInactiveNativeThread({
  codexHome,
  threadId,
  expectedRolloutRevision = '',
} = {}) {
  const home = path.resolve(String(codexHome || ''));
  const id = String(threadId || '').trim().toLowerCase();
  if (!THREAD_ID_PATTERN.test(id)) {
    return { archived: false, reason: 'invalid-thread-id' };
  }

  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'), { timeout: 5000 });
  let transactionOpen = false;
  let movedFrom = '';
  let movedTo = '';

  const rollback = () => {
    if (!transactionOpen) return;
    try {
      db.exec('ROLLBACK');
    } finally {
      transactionOpen = false;
    }
  };

  const rollbackMove = () => {
    if (!movedFrom || !movedTo || !existsSync(movedTo) || existsSync(movedFrom)) return;
    mkdirSync(path.dirname(movedFrom), { recursive: true });
    renameSync(movedTo, movedFrom);
    movedFrom = '';
    movedTo = '';
  };

  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;

    const row = db.prepare(`
      SELECT archived, rollout_path AS rolloutPath
      FROM threads
      WHERE id = ?
    `).get(id);
    if (!row) {
      rollback();
      return { archived: false, reason: 'not-found' };
    }

    const rawRolloutPath = String(row.rolloutPath || '').trim();
    if (!rawRolloutPath) {
      rollback();
      return { archived: false, reason: 'missing-rollout-path' };
    }

    const rolloutPath = path.resolve(rawRolloutPath);
    if (Number(row.archived) === 1) {
      db.exec('COMMIT');
      transactionOpen = false;
      return {
        archived: true,
        alreadyArchived: true,
        rolloutPath,
      };
    }

    const sessionsDir = path.resolve(home, 'sessions');
    const archivedSessionsDir = path.resolve(home, 'archived_sessions');
    const inSessions = isPathWithin(sessionsDir, rolloutPath);
    const inArchivedSessions = isPathWithin(archivedSessionsDir, rolloutPath);
    if (!inSessions && !inArchivedSessions) {
      rollback();
      return { archived: false, reason: 'unsafe-rollout-path' };
    }

    const fileThreadId = rolloutPath.match(THREAD_FILE_PATTERN)?.[1]?.toLowerCase() || '';
    if (fileThreadId !== id) {
      rollback();
      return { archived: false, reason: 'rollout-thread-mismatch' };
    }

    const destination = inArchivedSessions
      ? rolloutPath
      : path.join(archivedSessionsDir, path.basename(rolloutPath));
    let fileStat = safeFileStat(rolloutPath);

    if (!fileStat && inSessions) {
      fileStat = safeFileStat(destination);
      if (!fileStat) {
        rollback();
        return { archived: false, reason: 'rollout-missing' };
      }
    } else if (!fileStat) {
      rollback();
      return { archived: false, reason: 'rollout-missing' };
    }

    if (
      expectedRolloutRevision
      && !rolloutRevisionMatches(expectedRolloutRevision, fileStat)
    ) {
      rollback();
      return { archived: false, reason: 'rollout-changed' };
    }

    if (inSessions && existsSync(rolloutPath)) {
      if (existsSync(destination)) {
        rollback();
        return { archived: false, reason: 'archive-destination-exists' };
      }
      mkdirSync(archivedSessionsDir, { recursive: true });
      renameSync(rolloutPath, destination);
      movedFrom = rolloutPath;
      movedTo = destination;

      const movedStat = safeFileStat(destination);
      if (
        !movedStat
        || (
          expectedRolloutRevision
          && !rolloutRevisionMatches(expectedRolloutRevision, movedStat)
        )
      ) {
        rollback();
        rollbackMove();
        return { archived: false, reason: 'rollout-changed' };
      }
    }

    const update = db.prepare(`
      UPDATE threads
      SET archived = 1, archived_at = ?, rollout_path = ?
      WHERE id = ? AND archived = 0 AND rollout_path = ?
    `).run(
      Math.floor(Date.now() / 1000),
      destination,
      id,
      rawRolloutPath,
    );

    if (Number(update.changes) !== 1) {
      const current = db.prepare(`
        SELECT archived, rollout_path AS rolloutPath
        FROM threads
        WHERE id = ?
      `).get(id);
      if (Number(current?.archived) !== 1) {
        rollback();
        rollbackMove();
        return { archived: false, reason: 'thread-state-changed' };
      }
    }

    db.exec('COMMIT');
    transactionOpen = false;
    return {
      archived: true,
      alreadyArchived: false,
      rolloutPath: destination,
    };
  } catch (error) {
    try {
      rollback();
    } catch {}
    try {
      rollbackMove();
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

function safeFileStat(filePath) {
  try {
    const stat = statSync(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function rolloutRevisionMatches(revision, stat) {
  const [expectedIno, expectedSize, expectedMtimeMs] = String(revision || '').split(':');
  if (!expectedIno || !expectedSize || !expectedMtimeMs) return false;
  return String(stat.ino) === expectedIno
    && String(stat.size) === expectedSize
    && Math.abs(Number(stat.mtimeMs) - Number(expectedMtimeMs)) < 0.001;
}

function isPathWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}
