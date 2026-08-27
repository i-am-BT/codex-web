import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  loadCwdMigrations,
  parseCwdMigrations,
  remapMigratedCwd,
  resolveCwdMigrationsFile,
} from '../cwd-migrations.mjs';

test('requires explicit migration configuration and resolves configured paths from home', () => {
  assert.equal(resolveCwdMigrationsFile('', { home: '/home/tester' }), '');
  assert.equal(resolveCwdMigrationsFile('   ', { home: '/home/tester' }), '');
  assert.equal(
    resolveCwdMigrationsFile('~/config/cwd-migrations.tsv', { home: '/home/tester' }),
    '/home/tester/config/cwd-migrations.tsv',
  );
  assert.equal(
    resolveCwdMigrationsFile('config/cwd-migrations.tsv', { home: '/home/tester' }),
    '/home/tester/config/cwd-migrations.tsv',
  );
});

test('maps migrated project roots and their descendants without matching siblings', () => {
  const migrations = parseCwdMigrations([
    'id\tsource\tdestination\tcategory',
    'project\t/root/example\t/root/projects/active/example\tactive',
  ].join('\n'), { destinationExists: () => true });

  assert.equal(remapMigratedCwd('/root/example', migrations), '/root/projects/active/example');
  assert.equal(
    remapMigratedCwd('/root/example/src/module', migrations),
    '/root/projects/active/example/src/module',
  );
  assert.equal(remapMigratedCwd('/root/example-copy', migrations), '/root/example-copy');
});

test('loads only mappings whose destination exists', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'codex-web-cwd-migrations-'));
  const destination = path.join(temporary, 'projects', 'active', 'example');
  const migrationsFile = path.join(temporary, 'project-migrations.tsv');
  mkdirSync(destination, { recursive: true });
  writeFileSync(migrationsFile, [
    'id\tsource\tdestination\tcategory',
    `present\t/old/example\t${destination}\tactive`,
    `missing\t/old/missing\t${path.join(temporary, 'missing')}\tactive`,
  ].join('\n'));

  const migrations = loadCwdMigrations(migrationsFile);
  assert.deepEqual(migrations, [{ from: '/old/example', to: destination }]);
});

test('prefers the most specific source and leaves relative paths unchanged', () => {
  const migrations = parseCwdMigrations([
    'source\tdestination',
    '/root/project\t/archive/project',
    '/root/project/packages/app\t/workspace/app',
  ].join('\n'), { destinationExists: () => true });

  assert.equal(remapMigratedCwd('/root/project/packages/app/src', migrations), '/workspace/app/src');
  assert.equal(remapMigratedCwd('project/packages/app', migrations), 'project/packages/app');
});

test('rejects migration files without the required path columns', () => {
  assert.throws(
    () => parseCwdMigrations('id\tpath\nproject\t/root/example'),
    /source and destination columns/,
  );
});
