import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function resolveCwdMigrationsFile(value, { home = homedir() } = {}) {
  const configured = String(value || '').trim();
  if (!configured) return '';
  const expanded = configured === '~'
    ? home
    : (configured.startsWith('~/') ? path.join(home, configured.slice(2)) : configured);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(home, expanded);
}

export function loadCwdMigrations(filePath, options = {}) {
  if (!filePath || !existsSync(filePath)) return [];
  return parseCwdMigrations(readFileSync(filePath, 'utf8'), options);
}

export function parseCwdMigrations(source, { destinationExists = existsSync } = {}) {
  const lines = String(source || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const headers = lines.shift().replace(/^\uFEFF/, '').split('\t');
  const sourceIndex = headers.indexOf('source');
  const destinationIndex = headers.indexOf('destination');
  if (sourceIndex < 0 || destinationIndex < 0) {
    throw new Error('cwd migration file requires source and destination columns');
  }

  const migrations = [];
  const seenSources = new Set();
  for (const line of lines) {
    const columns = line.split('\t');
    const from = normalizeMigrationRoot(columns[sourceIndex]);
    const to = normalizeMigrationRoot(columns[destinationIndex]);
    if (!from || !to || from === to || seenSources.has(from) || !destinationExists(to)) continue;
    seenSources.add(from);
    migrations.push({ from, to });
  }

  return migrations.sort((left, right) => right.from.length - left.from.length);
}

export function remapMigratedCwd(value, migrations = []) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = path.normalize(raw);
  if (!path.isAbsolute(normalized)) return raw;

  for (const migration of migrations) {
    const relative = path.relative(migration.from, normalized);
    const isWithinSource = relative === ''
      || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    if (!isWithinSource) continue;
    return relative ? path.join(migration.to, relative) : migration.to;
  }
  return raw;
}

function normalizeMigrationRoot(value) {
  const normalized = path.normalize(String(value || '').trim());
  if (!normalized || !path.isAbsolute(normalized)) return '';
  return normalized === path.parse(normalized).root ? '' : normalized.replace(/[\\/]+$/, '');
}
