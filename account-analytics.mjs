import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ORIGIN = 'https://chatgpt.com';
const USD_PER_CREDIT = 0.04; // Codex Meter's credit-equivalent convention, not a billing record.
const number = value => value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const sum = values => values.every(value => value !== null) ? values.reduce((a, b) => a + b, 0) : null;

export function normalizeAccountAnalytics(data, window, now = Date.now()) {
  if (!Array.isArray(data?.data) || data.balance_unit !== 'credit' || data.group_by !== 'day') throw new Error('官方用量格式不受支持');
  const start = new Date((window.reset_at - window.limit_window_seconds) * 1000).toISOString().slice(0, 10);
  const end = new Date(now + 86400000).toISOString().slice(0, 10);
  const seen = new Set();
  const daily = data.data.filter(row => typeof row?.date === 'string' && row.date >= start && row.date < end).map(row => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || seen.has(row.date) || !row.totals) throw new Error('官方每日用量格式不受支持');
    seen.add(row.date);
    const totals = row.totals;
    const credits = number(totals.credits), cached = number(totals.cached_text_input_tokens);
    const uncached = number(totals.uncached_text_input_tokens), output = number(totals.text_output_tokens);
    return { date: row.date, credits, cachedInputTokens: cached, inputTokens: sum([cached, uncached]), outputTokens: output,
      totalTokens: number(totals.text_total_tokens) ?? sum([cached, uncached, output]), turns: number(totals.turns) };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const credits = sum(daily.map(row => row.credits));
  const input = sum(daily.map(row => row.inputTokens)), cached = sum(daily.map(row => row.cachedInputTokens));
  const used = number(window.used_percent);
  const projectedCredits = credits !== null && used > 0 && used <= 100 ? credits / (used / 100) : null;
  return {
    available: true, loading: false, source: 'official-analytics', aggregation: 'day',
    cycleStart: new Date((window.reset_at - window.limit_window_seconds) * 1000).toISOString(),
    cycleEnd: new Date(window.reset_at * 1000).toISOString(), startDate: start,
    creditsUsed: credits, inputTokens: input, cachedInputTokens: cached,
    outputTokens: sum(daily.map(row => row.outputTokens)), totalTokens: sum(daily.map(row => row.totalTokens)),
    cacheHitPercent: input > 0 && cached !== null && cached <= input ? cached / input * 100 : null,
    turns: sum(daily.map(row => row.turns)),
    creditEquivalentUsd: credits === null ? null : credits * USD_PER_CREDIT,
    projectedCredits, projectedUsd: projectedCredits === null ? null : projectedCredits * USD_PER_CREDIT,
    daily, fetchedAt: new Date(now).toISOString(),
    scope: '官方账号每日用量；周期起始日整日计入',
    pricingBasis: 'Credits × $0.04 折算；推算周期额度不等于实际总额度，折算金额非账单扣费',
  };
}

export function createAccountAnalyticsReader(codexHome, { fetchImpl = fetch, now = Date.now } = {}) {
  let cache = null, pending = null;
  async function get(url, auth) {
    const response = await fetchImpl(ORIGIN + url, {
      headers: { Authorization: 'Bearer ' + auth.access_token, 'ChatGPT-Account-Id': auth.account_id },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('官方账号用量读取失败（HTTP ' + response.status + '）'); }
    return response.json();
  }
  return async function read({ refresh = false } = {}) {
    let auth;
    try { auth = JSON.parse(await readFile(path.join(codexHome, 'auth.json'), 'utf8'))?.tokens; } catch {}
    if (!auth?.account_id || !auth?.access_token) return { available: false, loading: false };
    const key = auth.account_id + ':' + new Date(now()).toISOString().slice(0, 10);
    if (!refresh && cache?.key === key && cache.expiresAt > now()) return cache.value;
    if (pending?.key === key) return pending.promise;
    const request = { key };
    request.promise = (async () => {
      try {
        const usage = await get('/backend-api/wham/usage', auth);
        if (usage.account_id !== auth.account_id) throw new Error('官方用量账号不匹配');
        const windows = Object.values(usage.rate_limit || {}).filter(w => w && number(w.reset_at) > 0 && number(w.limit_window_seconds) > 0);
        const window = windows.sort((a, b) => b.limit_window_seconds - a.limit_window_seconds)[0];
        if (!window) throw new Error('官方账号未返回额度周期');
        const start = new Date((window.reset_at - window.limit_window_seconds) * 1000).toISOString().slice(0, 10);
        const end = new Date(now() + 86400000).toISOString().slice(0, 10);
        const query = new URLSearchParams({ start_date: start, end_date: end, group_by: 'day' });
        const daily = await get('/backend-api/wham/analytics/daily-workspace-usage-counts?' + query, auth);
        const current = JSON.parse(await readFile(path.join(codexHome, 'auth.json'), 'utf8'))?.tokens;
        if (current?.account_id !== auth.account_id) throw new Error('账号已切换，请重新刷新');
        const value = normalizeAccountAnalytics(daily, window, now());
        cache = { key, value, expiresAt: now() + 60000 };
        return value;
      } catch (error) {
        // Do not return raw upstream bodies or credentials in errors, or another account's cache.
        const safe = String(error?.message || '').startsWith('官方') || String(error?.message || '').startsWith('账号已切换');
        return { available: false, loading: false, source: 'official-analytics', error: safe ? error.message : '官方账号用量暂不可用，请重试' };
      }
    })().finally(() => { if (pending === request) pending = null; });
    pending = request;
    return request.promise;
  };
}
