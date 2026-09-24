import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Hold the same inode's flock throughout the rename. A zero-byte lock may
// still belong to a live writer; snapshots and file ages cannot prove otherwise.
export function quarantineUnlockedWriterLock(lockPath, backupPath, minAgeMs = 5000) {
  if (process.platform !== 'linux') return false;
  let fd;
  try {
    fd = openSync(lockPath, constants.O_RDWR | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== 0 || Date.now() - stat.mtimeMs < minAgeMs) return false;
    const result = spawnSync('flock', [
      '--exclusive', '--nonblock', '--conflict-exit-code', '75', '/proc/self/fd/3',
      process.execPath, '--input-type=module', '-e', `
        import { fstatSync, lstatSync, renameSync } from 'node:fs';
        const [source, target, age] = process.argv.slice(1);
        const held = fstatSync(3);
        const current = lstatSync(source);
        if (!current.isFile() || current.dev !== held.dev || current.ino !== held.ino
            || held.size !== 0 || Date.now() - held.mtimeMs < Number(age)) process.exit(75);
        renameSync(source, target);
      `, lockPath, backupPath, String(minAgeMs),
    ], { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 3000 });
    return !result.error && result.status === 0;
  } catch {
    // Missing flock, inaccessible files and unknown ownership all fail closed.
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
