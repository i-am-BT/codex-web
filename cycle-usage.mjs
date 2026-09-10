import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, open, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import path from 'node:path';

// USD / million tokens, standard short-context API equivalent; not subscription billing.
// https://developers.openai.com/api/docs/pricing — checked 2026-09-07.
const PRICES = {
  'gpt-6-astra': [10, 1, 50], 'gpt-5.6-sol': [4, .4, 20],
  'gpt-5.6-terra': [2, .2, 12], 'gpt-5.6-luna': [.2, .02, 1.2],
  'gpt-5.5': [5, .5, 30], 'gpt-5.4': [2.5, .25, 15],
  'gpt-5.4-mini': [.75, .075, 4.5],
};
export function estimateTokenCost(model, input, cached, output) {
  const price = PRICES[model];
  if (!price || ![input, cached, output].every(value => Number.isSafeInteger(value) && value >= 0) || cached > input) return null;
  return ((input - cached) * price[0] + cached * price[1] + output * price[2]) / 1e6;
}
const parse = line => { try { return JSON.parse(line); } catch { return null; } };
const empty = () => ({ input: 0, output: 0, cached: 0, cost: 0, unpriced: 0, cacheKnown: true });
function settingsProvider(settings) {
  for (const key of ['modelProvider', 'model_provider_id', 'model_provider']) {
    if (Object.hasOwn(settings || {}, key)) return String(settings[key] || '');
  }
  return undefined;
}

export function usageDelta(previous, current) {
  if (!current || !Number.isFinite(current.input_tokens) || !Number.isFinite(current.output_tokens)) return null;
  const reset = previous && current.input_tokens + current.output_tokens < previous.input_tokens + previous.output_tokens;
  const base = reset ? null : previous;
  const delta = key => Number.isFinite(current[key]) && (!base || Number.isFinite(base[key]))
    ? Math.max(0, current[key] - (base?.[key] || 0)) : null;
  return { input: delta('input_tokens'), output: delta('output_tokens'), cached: delta('cached_input_tokens') };
}

// Locate the pre-cycle baseline from the tail, not by parsing the entire history.
async function findStart(file, size, since, initialProvider) {
  const handle = await open(file, 'r');
  let position = size, prefix = Buffer.alloc(0), baseline = null, context = null, provider;
  try {
    while (position > 0) {
      const lookback = baseline === null ? Infinity : 2 * 1024 * 1024 - (baseline - position);
      // ponytail: attribution beyond this lookback stays unknown; never rescan an old multi-GB tool result.
      if (lookback <= 0) return { offset: context ?? baseline, provider: '' };
      const count = Math.min(position, 256 * 1024, lookback);
      position -= count;
      const chunk = Buffer.alloc(count);
      const { bytesRead } = await handle.read(chunk, 0, count, position);
      const block = Buffer.concat([chunk.subarray(0, bytesRead), prefix]);
      let end = block.length;
      for (let i = block.length - 1; i >= 0; i--) {
        if (block[i] !== 10) continue;
        const line = block.subarray(i + 1, end).toString();
        end = i;
        if (!line.includes('token_count') && !line.includes('turn_context') && !line.includes('thread_settings_applied')) continue;
        const event = parse(line);
        if (!baseline && event?.type === 'event_msg' && event.payload?.type === 'token_count'
          && Date.parse(event.timestamp) < since) baseline = position + i + 1;
        if (baseline !== null && provider === undefined) {
          provider = settingsProvider(event?.type === 'turn_context' ? event.payload : event?.payload?.thread_settings);
        }
        if (baseline !== null && context === null && event?.type === 'turn_context') context = position + i + 1;
        if (context !== null && provider !== undefined) return { offset: context, provider };
      }
      prefix = block.subarray(0, end);
    }
    return { offset: context ?? baseline ?? 0, provider: provider ?? initialProvider };
  } finally { await handle.close(); }
}

export function createCycleUsageReader(codexHome, cacheFile) {
  let cached;
  try { cached = parse(readFileSync(cacheFile, 'utf8')); } catch {}
  let state, pending;
  function select(quota) {
    const window = (quota?.windows || []).filter(w => w.id === 'codex' && w.resetsAt > 0 && w.windowDurationMins > 0)
      .sort((a, b) => b.windowDurationMins - a.windowDurationMins)[0];
    if (!window || quota.stale || quota.valid === false) return null;
    let account = '';
    try {
      const auth = parse(readFileSync(path.join(codexHome, 'auth.json'), 'utf8'));
      account = String(auth?.tokens?.account_id || '');
    } catch {}
    if (!account) return null;
    const identity = createHash('sha256').update(account).digest('hex');
    const end = window.resetsAt * 1000;
    return { key: identity + ':' + end, identity, start: end - window.windowDurationMins * 60000, end, unused: window.remainingPercent === 100 };
  }
  function result(cycle, totals, loading = false) {
    return {
      available: !loading, loading, cycleStart: new Date(cycle.start).toISOString(), cycleEnd: new Date(cycle.end).toISOString(),
      totalTokens: totals.input + totals.output, cachedInputTokens: totals.cacheKnown ? totals.cached : null,
      cacheHitPercent: totals.cacheKnown && totals.input > 0 ? totals.cached / totals.input * 100 : null,
      estimatedUsd: totals.unpriced ? null : totals.cost, unpricedTokens: totals.unpriced,
      scope: '本周期本机 OpenAI 调用', pricingBasis: '标准短上下文 API 等价估算，非账号扣费；不含长上下文、加速、缓存写入及工具附加费用',
    };
  }
  async function save(target) {
    if (target !== state) return;
    await mkdir(path.dirname(cacheFile), { recursive: true });
    const tmp = cacheFile + '.' + process.pid + '.tmp';
    await writeFile(tmp, JSON.stringify({ version: 2, key: target.cycle.key, start: target.cycle.start, value: target.value, files: [...target.files] }), { mode: 0o600 });
    if (target === state) await rename(tmp, cacheFile);
    target.needsSave = false;
  }
  async function scan(target) {
    const seen = new Set();
    for (const folder of ['sessions', 'archived_sessions']) {
      let entries;
      try { entries = await readdir(path.join(codexHome, folder), { recursive: true, withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const entry of entries) {
        if (target !== state) return;
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const file = path.join(entry.parentPath, entry.name);
        const info = await stat(file).catch(() => null);
        if (!info?.size || info.mtimeMs < target.cycle.start) continue;
        seen.add(file);
        let record = target.files.get(file);
        if (record?.ino === info.ino && record.offset === info.size && record.mtime === info.mtimeMs) continue;
        if (!record || record.ino !== info.ino || info.size <= record.offset) {
          const input = createReadStream(file);
          const lines = createInterface({ input, crlfDelay: Infinity });
          let meta;
          try { for await (const line of lines) { meta = parse(line)?.payload; break; } }
          finally { lines.close(); input.destroy(); }
          const start = Math.max(target.cycle.start, meta?.forked_from_id ? Date.parse(meta.timestamp) || 0 : 0);
          record = { id: meta?.id || file, provider: meta?.model_provider, start, totals: empty(), previous: null, model: '', offset: 0 };
          Object.assign(record, await findStart(file, info.size, start, record.provider));
        }
        if (record.offset < info.size) {
          const input = createReadStream(file, { start: record.offset, end: info.size - 1 });
          const lines = createInterface({ input, crlfDelay: Infinity });
          try {
            for await (const line of lines) {
              const bytes = Buffer.byteLength(line) + 1;
              if (record.offset + bytes > info.size) break;
              record.offset += bytes;
              if (!line.includes('token_count') && !line.includes('turn_context') && !line.includes('thread_settings_applied')) continue;
              const event = parse(line);
              const settings = event?.type === 'turn_context' ? event.payload : event?.payload?.type === 'thread_settings_applied' ? event.payload.thread_settings : null;
              if (settings) {
                const provider = settingsProvider(settings);
                if (provider !== undefined) record.provider = provider;
                if (Object.hasOwn(settings, 'model')) record.model = settings.model || '';
                continue;
              }
              if (event?.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;
              const current = event.payload.info?.total_token_usage;
              const delta = usageDelta(record.previous, current);
              if (!delta) continue;
              record.previous = current;
              const timestamp = Date.parse(event.timestamp);
              if (record.provider !== 'openai' || !(timestamp >= record.start && timestamp < target.cycle.end)) continue;
              const totals = record.totals;
              totals.input += delta.input; totals.output += delta.output;
              totals.cacheKnown &&= delta.cached !== null;
              const hit = Math.min(delta.input, delta.cached || 0);
              totals.cached += hit;
              const price = PRICES[record.model];
              if (price && delta.cached !== null) totals.cost += ((delta.input - hit) * price[0] + hit * price[1] + delta.output * price[2]) / 1e6;
              else totals.unpriced += delta.input + delta.output;
            }
          } finally { lines.close(); input.destroy(); }
        } else record.offset = info.size;
        target.files.set(file, { ...record, ino: info.ino, mtime: info.mtimeMs });
      }
    }
    const sessions = new Map();
    for (const [file, record] of target.files) {
      if (!seen.has(file)) { target.files.delete(file); continue; }
      if (!sessions.has(record.id) || sessions.get(record.id).mtime < record.mtime) sessions.set(record.id, record);
    }
    const totals = empty();
    for (const { totals: item } of sessions.values()) {
      for (const key of ['input', 'output', 'cached', 'cost', 'unpriced']) totals[key] += item[key];
      totals.cacheKnown &&= item.cacheKnown;
    }
    if (target !== state) return;
    target.value = { ...result(target.cycle, totals), fetchedAt: new Date().toISOString() };
    await save(target);
  }
  function read(quota) {
    const cycle = select(quota);
    if (!cycle) return { available: false, loading: false };
    if (state?.cycle.key !== cycle.key || cycle.unused !== state.cycle.unused) {
      const previousIdentity = state?.cycle.identity || String(cached?.key || '').split(':')[0];
      const accountChanged = !previousIdentity || previousIdentity !== cycle.identity;
      const saved = !cycle.unused && cached?.version === 2 && cached.key === cycle.key;
      if (saved && Number.isFinite(cached.start)) cycle.start = Math.max(cycle.start, cached.start);
      if (accountChanged) cycle.start = Math.max(cycle.start, Date.now());
      if (state?.cycle.key === cycle.key) cycle.start = Math.max(cycle.start, state.cycle.start);
      if (cycle.unused) cycle.start = Math.max(cycle.start, Date.now());
      state = { cycle, files: new Map(saved ? cached.files : []), value: saved ? cached.value : result(cycle, empty(), !cycle.unused), checkedAt: 0, needsSave: true };
      cached = null;
    }
    if (cycle.unused && !pending && state.needsSave) {
      const target = state;
      pending = save(target).catch(() => {}).finally(() => { pending = null; });
    }
    if (!cycle.unused && !pending && Date.now() - state.checkedAt > 30000) {
      const target = state;
      target.checkedAt = Date.now();
      pending = scan(target).catch(() => { target.value = { ...target.value, loading: false, error: '周期统计暂不可用' }; }).finally(() => { pending = null; });
    }
    return state.value;
  }
  read.settled = () => pending;
  return read;
}
