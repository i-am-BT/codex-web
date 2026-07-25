import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

const SKILL_FILE = 'SKILL.md';
const DEFAULT_CACHE_TTL_MS = 5_000;
const MAX_DESCRIPTION = 240;

let skillCache = null;

function sanitizeSkillName(value) {
  return String(value || '')
    .trim()
    .replace(/^\$+/, '')
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function scrubSkillText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/(?:\/Users|\/home|\/var\/folders|C:\\Users)[^\s"'<>]*/gi, '[path]')
    .replace(/\b[A-Za-z0-9._-]+@[^\s"'<>]+/g, '[email]')
    .trim()
    .slice(0, MAX_DESCRIPTION);
}

function parseFrontmatter(text) {
  const match = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    let value = line.slice(sep + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function safeRealpath(target) {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function isDirectory(target) {
  try {
    return existsSync(target) && statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function shouldSkipDirName(name) {
  return name === 'node_modules'
    || name === '.git'
    || name === '.DS_Store'
    || name === 'dist'
    || name === 'build';
}

function collectSkillsFromRoot(rootDir, source, {
  maxDepth = 4,
  seenNames = new Set(),
  out = [],
} = {}) {
  if (!isDirectory(rootDir)) return out;

  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const skillFile = path.join(dir, SKILL_FILE);
    if (depth > 0 && existsSync(skillFile)) {
      try {
        const content = readFileSync(skillFile, 'utf8');
        const frontmatter = parseFrontmatter(content);
        const folderName = path.basename(dir);
        const name = sanitizeSkillName(frontmatter.name || folderName);
        if (!name) return;
        const key = name.toLowerCase();
        if (seenNames.has(key)) return;
        seenNames.add(key);
        const description = scrubSkillText(frontmatter.description || '');
        out.push({
          id: name,
          name,
          description,
          source,
          invocation: '$' + name,
        });
      } catch {
        // ignore unreadable skill packages
      }
      return;
    }

    for (const entry of entries) {
      if (shouldSkipDirName(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.system') continue;
      const full = path.join(dir, entry.name);
      if (!isDirectory(full)) continue;
      visit(full, depth + 1);
    }
  };

  visit(safeRealpath(rootDir), 0);
  return out;
}

function skillRoots(codexHome, home = homedir()) {
  const roots = [];
  const push = (dir, source, maxDepth = 4) => {
    if (!dir || !isDirectory(dir)) return;
    roots.push({ dir: safeRealpath(dir), source, maxDepth });
  };

  const homeDir = home || homedir();
  const codex = codexHome || path.join(homeDir, '.codex');
  push(path.join(codex, 'skills'), 'user', 3);
  push(path.join(homeDir, '.agents', 'skills'), 'agents', 3);
  push(path.join(homeDir, '.claude', 'skills'), 'claude', 4);
  push(path.join(codex, 'plugins', 'cache'), 'plugins', 7);
  return roots;
}

function sourceRank(source) {
  switch (source) {
    case 'user': return 0;
    case 'agents': return 1;
    case 'claude': return 2;
    case 'plugins': return 3;
    case 'system': return 4;
    default: return 9;
  }
}

export function listCodexSkillsUncached(codexHome, home = homedir()) {
  const seenNames = new Set();
  const skills = [];
  for (const root of skillRoots(codexHome, home)) {
    collectSkillsFromRoot(root.dir, root.source, {
      maxDepth: root.maxDepth,
      seenNames,
      out: skills,
    });
  }
  skills.sort((left, right) => {
    const bySource = sourceRank(left.source) - sourceRank(right.source);
    if (bySource) return bySource;
    const byName = left.name.localeCompare(right.name, 'en', { sensitivity: 'base' });
    if (byName) return byName;
    return 0;
  });
  // Keep the picker usable; plugins cache can contain hundreds of packages.
  const MAX_SKILLS = 120;
  return skills.slice(0, MAX_SKILLS);
}

export function listCodexSkills(codexHome, {
  home = homedir(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  force = false,
} = {}) {
  const now = Date.now();
  if (!force && skillCache && skillCache.expiresAt > now) {
    return skillCache.skills;
  }
  const skills = listCodexSkillsUncached(codexHome, home);
  skillCache = {
    expiresAt: now + Math.max(0, Number(cacheTtlMs) || 0),
    skills,
  };
  return skills;
}

export function clearCodexSkillsCache() {
  skillCache = null;
}

export {
  parseFrontmatter,
  sanitizeSkillName,
  collectSkillsFromRoot,
  skillRoots,
};
