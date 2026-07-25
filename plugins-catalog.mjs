import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

const MAX_DESCRIPTION = 160;
const DEFAULT_CACHE_TTL_MS = 5_000;
let pluginCache = null;

function safeRealpath(target) {
  try { return realpathSync(target); } catch { return path.resolve(target); }
}

function isDirectory(target) {
  try { return existsSync(target) && statSync(target).isDirectory(); } catch { return false; }
}

function scrubText(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  text = text.split('/Users/').join('[path]');
  text = text.split('/home/').join('[path]');
  return text.slice(0, MAX_DESCRIPTION);
}

function sanitizePluginName(value) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function titleCasePlugin(name) {
  const map = {
    pdf: 'PDF',
    cowart: 'Cowart',
    documents: 'Documents',
    spreadsheets: 'Spreadsheets',
    presentations: 'Presentations',
    browser: 'Browser',
    chrome: 'Chrome',
    sites: 'Sites',
    visualize: 'Visualize',
    latex: 'LaTeX',
  };
  const key = String(name || '').toLowerCase();
  if (map[key]) return map[key];
  return String(name || '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function pluginRoots(codexHome, home = homedir()) {
  const homeDir = home || homedir();
  const codex = codexHome || path.join(homeDir, '.codex');
  const roots = [];
  for (const dir of [path.join(codex, 'plugins', 'cache'), path.join(homeDir, '.codex', 'plugins', 'cache')]) {
    if (isDirectory(dir)) roots.push(safeRealpath(dir));
  }
  return [...new Set(roots)];
}

function readPluginJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function collectPluginsFromCache(cacheRoot, seen, out) {
  if (!isDirectory(cacheRoot)) return;
  let markets = [];
  try { markets = readdirSync(cacheRoot, { withFileTypes: true }); } catch { return; }
  for (const market of markets) {
    if (!market.isDirectory() || market.name.startsWith('.')) continue;
    const marketDir = path.join(cacheRoot, market.name);
    let plugins = [];
    try { plugins = readdirSync(marketDir, { withFileTypes: true }); } catch { continue; }
    for (const plugin of plugins) {
      if (!plugin.isDirectory() || plugin.name.startsWith('.')) continue;
      const pluginDir = path.join(marketDir, plugin.name);
      let versions = [];
      try { versions = readdirSync(pluginDir, { withFileTypes: true }); } catch { continue; }
      const versionDirs = versions
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort();
      if (!versionDirs.length) continue;
      const version = versionDirs[versionDirs.length - 1];
      const manifest = path.join(pluginDir, version, '.codex-plugin', 'plugin.json');
      if (!existsSync(manifest)) continue;
      const data = readPluginJson(manifest) || {};
      const name = sanitizePluginName(data.name || plugin.name);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: name,
        name,
        title: titleCasePlugin(data.name || name),
        description: scrubText(data.description || ''),
        market: market.name,
        invocation: '@' + name,
      });
    }
  }
}

export function listCodexPluginsUncached(codexHome, home = homedir()) {
  const seen = new Set();
  const plugins = [];
  for (const root of pluginRoots(codexHome, home)) {
    collectPluginsFromCache(root, seen, plugins);
  }
  plugins.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
  return plugins;
}

export function listCodexPlugins(codexHome, {
  home = homedir(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  force = false,
} = {}) {
  const now = Date.now();
  if (!force && pluginCache && pluginCache.expiresAt > now) return pluginCache.plugins;
  const plugins = listCodexPluginsUncached(codexHome, home);
  pluginCache = {
    expiresAt: now + Math.max(0, Number(cacheTtlMs) || 0),
    plugins,
  };
  return plugins;
}

export function clearCodexPluginsCache() {
  pluginCache = null;
}

export { sanitizePluginName, titleCasePlugin, scrubText as scrubPluginText };
