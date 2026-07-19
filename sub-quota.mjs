const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_MS = 30000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const RATE_LIMIT_WINDOWS = new Set(['5h', '1d', '7d']);

export class SubQuotaService {
  constructor(options = {}) {
    this.sources = Array.isArray(options.sources) ? options.sources : [];
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.cacheTtlMs = positiveNumber(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS);
    this.now = options.now || Date.now;
    this.configurationError = String(options.configurationError || '');
    this.cache = null;
    this.pending = null;
  }

  static fromEnvironment(env = process.env, options = {}) {
    let sources = [];
    let configurationError = '';
    try {
      sources = parseSubQuotaSources(env.SUB_QUOTA_SOURCES, env);
    } catch (error) {
      configurationError = String(error?.message || 'Sub 额度配置无效');
    }
    return new SubQuotaService({
      ...options,
      sources,
      configurationError,
      timeoutMs: positiveNumber(env.SUB_QUOTA_TIMEOUT_MS, options.timeoutMs || DEFAULT_TIMEOUT_MS),
      cacheTtlMs: positiveNumber(env.SUB_QUOTA_CACHE_SECONDS, options.cacheTtlMs
        ? options.cacheTtlMs / 1000
        : DEFAULT_CACHE_TTL_MS / 1000) * 1000,
    });
  }

  async list({ refresh = false } = {}) {
    const now = this.now();
    if (!refresh && this.cache && now - this.cache.cachedAt < this.cacheTtlMs) return this.cache.value;
    if (this.pending) return this.pending;

    this.pending = this.load().then((value) => {
      this.cache = { cachedAt: this.now(), value };
      return value;
    }).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async load() {
    const fetchedAt = new Date(this.now()).toISOString();
    const quotas = await Promise.all(this.sources.map((source) => this.fetchSource(source, fetchedAt)));
    return {
      configured: this.sources.length > 0,
      count: quotas.length,
      availableCount: quotas.filter((item) => !item.error).length,
      fetchedAt,
      quotas,
      ...(this.configurationError ? { configurationError: this.configurationError } : {}),
    };
  }

  async fetchSource(source, fetchedAt) {
    const base = { id: source.id, name: source.name, fetchedAt };
    if (!source.apiKey) return { ...base, error: `缺少环境变量 ${source.apiKeyEnv}` };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(source.usageUrl, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${source.apiKey}`,
        },
        redirect: 'error',
        signal: controller.signal,
      });
      const declaredLength = Number(response.headers?.get?.('content-length') || 0);
      if (declaredLength > MAX_RESPONSE_BYTES) {
        await response.body?.cancel?.().catch(() => {});
        throw new Error('响应内容过大');
      }
      const bodyText = await readLimitedBody(response, MAX_RESPONSE_BYTES);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let data;
      try {
        data = JSON.parse(bodyText);
      } catch {
        throw new Error('响应不是 JSON');
      }
      return { ...base, ...normalizeSubQuota(data) };
    } catch (error) {
      const message = error?.name === 'AbortError' ? '请求超时' : String(error?.message || '请求失败');
      return { ...base, error: message.slice(0, 160) };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseSubQuotaSources(value, env = process.env) {
  const text = String(value || '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('SUB_QUOTA_SOURCES 必须是 JSON 数组');
  }
  if (!Array.isArray(parsed)) throw new Error('SUB_QUOTA_SOURCES 必须是 JSON 数组');
  if (parsed.length > 12) throw new Error('SUB_QUOTA_SOURCES 最多配置 12 个来源');

  const ids = new Set();
  return parsed.map((item, index) => {
    const id = String(item?.id || `sub-${index + 1}`).trim();
    const name = String(item?.name || id).trim().slice(0, 80);
    const apiKeyEnv = String(item?.apiKeyEnv || '').trim();
    if (!SOURCE_ID_PATTERN.test(id)) throw new Error(`Sub 额度来源 ${index + 1} 的 id 无效`);
    if (ids.has(id)) throw new Error(`Sub 额度来源 id 重复: ${id}`);
    if (!name) throw new Error(`Sub 额度来源 ${id} 缺少名称`);
    if (!ENV_KEY_PATTERN.test(apiKeyEnv)) throw new Error(`Sub 额度来源 ${id} 的 apiKeyEnv 无效`);
    ids.add(id);
    return {
      id,
      name,
      apiKeyEnv,
      apiKey: String(env[apiKeyEnv] || '').trim(),
      usageUrl: normalizeSubUsageUrl(item?.baseUrl),
    };
  });
}

export function normalizeSubQuota(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('额度响应格式无效');
  const subscription = isRecord(data.subscription)
    ? {
      daily: quotaWindow(data.subscription.daily_usage_usd, data.subscription.daily_limit_usd),
      weekly: quotaWindow(data.subscription.weekly_usage_usd, data.subscription.weekly_limit_usd),
      monthly: quotaWindow(data.subscription.monthly_usage_usd, data.subscription.monthly_limit_usd),
      expiresAt: cleanDate(data.subscription.expires_at),
      weeklyWindowStart: cleanDate(data.subscription.weekly_window_start),
    }
    : null;
  const quota = isRecord(data.quota) ? {
    ...quotaWindow(data.quota.used, data.quota.limit, data.quota.remaining),
    unit: cleanText(data.quota.unit, 16),
  } : null;
  return {
    valid: data.isValid !== false,
    mode: cleanText(data.mode, 40),
    status: cleanText(data.status, 40),
    planName: cleanText(data.planName, 100),
    unit: cleanText(data.unit, 16) || quota?.unit || 'USD',
    remaining: nonNegativeNumber(data.remaining),
    balance: nonNegativeNumber(data.balance),
    quota,
    subscription,
    rateLimits: normalizeRateLimits(data.rate_limits),
    expiresAt: cleanDate(data.expires_at),
    daysUntilExpiry: nonNegativeInteger(data.days_until_expiry),
    today: normalizeUsage(data.usage?.today),
    total: normalizeUsage(data.usage?.total),
  };
}

function normalizeSubUsageUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('Sub 额度来源 baseUrl 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Sub 额度来源 baseUrl 必须是 http/https URL');
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1/usage';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function quotaWindow(usedValue, limitValue, remainingValue) {
  const used = nonNegativeNumber(usedValue);
  const limit = nonNegativeNumber(limitValue);
  const explicitRemaining = nonNegativeNumber(remainingValue);
  if (used === null && limit === null && explicitRemaining === null) return null;

  let remaining = explicitRemaining;
  if (remaining === null && limit === 0) remaining = 0;
  if (remaining === null && limit !== null && used !== null) remaining = Math.max(0, limit - used);
  return {
    used,
    limit,
    remaining,
  };
}

function normalizeRateLimits(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const limits = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const window = cleanText(item.window, 8).toLowerCase();
    if (!RATE_LIMIT_WINDOWS.has(window) || seen.has(window)) continue;
    seen.add(window);
    const quota = quotaWindow(item.used, item.limit, item.remaining) || {
      used: null,
      limit: null,
      remaining: null,
    };
    limits.push({
      window,
      ...quota,
      windowStart: cleanDate(item.window_start),
      resetAt: cleanDate(item.reset_at),
    });
  }
  return limits;
}

function normalizeUsage(value) {
  if (!isRecord(value)) return null;
  return {
    requests: nonNegativeNumber(value.requests),
    inputTokens: nonNegativeNumber(value.input_tokens),
    outputTokens: nonNegativeNumber(value.output_tokens),
    totalTokens: nonNegativeNumber(value.total_tokens),
    cost: nonNegativeNumber(value.cost),
    actualCost: nonNegativeNumber(value.actual_cost),
  };
}

function finiteNumber(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  if (number === null || number < 0) return null;
  return number === 0 ? 0 : number;
}

function nonNegativeInteger(value) {
  const number = nonNegativeNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanDate(value) {
  const text = cleanText(value, 80);
  return text && Number.isFinite(Date.parse(text)) ? text : '';
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

async function readLimitedBody(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('响应内容过大');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  let oversized = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        oversized = true;
        throw new Error('响应内容过大');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (oversized) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}
