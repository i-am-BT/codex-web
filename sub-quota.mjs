const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_MS = 30000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const RATE_LIMIT_WINDOWS = new Set(['5h', '1d', '7d', '30d']);
const MAX_BASE_URL_LENGTH = 2048;
const CPA_ACCOUNT_CONCURRENCY = 4;
const WINDOW_SECONDS_TOLERANCE = 60;
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_USAGE_HEADERS = {
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal',
};

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
      configurationError = String(error?.message || '额度配置无效');
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
    const quotas = (await Promise.all(this.sources.map((source) => this.fetchSource(source, fetchedAt)))).flat();
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
    if (source.provider === 'cpa-codex') return this.fetchCpaCodexSource(source, fetchedAt);
    return this.fetchSub2ApiSource(source, fetchedAt);
  }

  async fetchSub2ApiSource(source, fetchedAt) {
    const base = { id: source.id, name: source.name, provider: 'sub2api', fetchedAt };
    if (!source.apiKey) return [{ ...base, error: `缺少环境变量 ${source.apiKeyEnv}` }];

    try {
      const data = await this.requestJson(source.usageUrl, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${source.apiKey}`,
        },
      });
      return [{ ...base, ...normalizeSubQuota(data) }];
    } catch (error) {
      return [{ ...base, error: formatFetchError(error) }];
    }
  }

  async fetchCpaCodexSource(source, fetchedAt) {
    const base = { id: source.id, name: source.name, provider: 'cpa-codex', fetchedAt };
    if (!source.apiKey) return [{ ...base, error: `缺少环境变量 ${source.apiKeyEnv}` }];

    try {
      const authFiles = await this.listCpaAuthFiles(source);
      const codexFiles = authFiles.filter((file) => isCodexAuthFile(file) && !file.disabled);
      if (!codexFiles.length) {
        return [{ ...base, error: 'CPA 中暂无可用的 Codex 认证' }];
      }

      return mapWithConcurrency(codexFiles, CPA_ACCOUNT_CONCURRENCY, async (file) => {
        const accountBase = {
          id: cleanText(file.id || file.name || file.auth_index || `${source.id}-codex`, 120) || `${source.id}-codex`,
          name: cleanText(file.email || file.label || file.account || file.name || 'Codex', 100) || 'Codex',
          provider: 'cpa-codex',
          fetchedAt,
          sourceName: source.name,
        };
        try {
          const accountId = await this.resolveCpaAccountId(source, file);
          const usage = await this.fetchCpaCodexUsage(source, file, accountId);
          return { ...accountBase, ...normalizeCpaCodexQuota(usage, file, this.now()) };
        } catch (error) {
          return { ...accountBase, error: formatFetchError(error) };
        }
      });
    } catch (error) {
      return [{ ...base, error: formatFetchError(error) }];
    }
  }

  async listCpaAuthFiles(source) {
    const data = await this.requestJson(`${source.baseUrl}/v0/management/auth-files`, {
      headers: managementHeaders(source.apiKey),
    });
    const files = data?.files ?? data?.auth_files ?? data;
    if (!Array.isArray(files)) throw new Error('CPA auth-files 响应无效');
    return files;
  }

  async resolveCpaAccountId(source, file) {
    const direct = extractCpaAccountId(file);
    if (direct) return direct;
    const name = cleanText(file.name || file.id, 240);
    if (!name) throw new Error('Codex 凭证缺少文件名');
    const auth = await this.requestJson(
      `${source.baseUrl}/v0/management/auth-files/download?name=${encodeURIComponent(name)}`,
      { headers: managementHeaders(source.apiKey) },
    );
    const accountId = extractCpaAccountId(auth);
    if (!accountId) throw new Error('Codex 凭证缺少 ChatGPT 账号 ID');
    return accountId;
  }

  async fetchCpaCodexUsage(source, file, accountId) {
    const authIndex = cleanText(file.auth_index || file.authIndex, 80);
    if (!authIndex) throw new Error('Codex 凭证缺少 auth_index');
    const payload = {
      auth_index: authIndex,
      method: 'GET',
      url: CODEX_USAGE_URL,
      header: {
        ...CODEX_USAGE_HEADERS,
        'Chatgpt-Account-Id': accountId,
      },
    };
    const outer = await this.requestJson(`${source.baseUrl}/v0/management/api-call`, {
      method: 'POST',
      headers: {
        ...managementHeaders(source.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const statusCode = Number(outer?.status_code ?? outer?.statusCode ?? 0);
    const body = parseMaybeJson(outer?.body ?? outer?.bodyText ?? outer);
    const bodyError = extractCpaUsageError(body);
    if (statusCode && (statusCode < 200 || statusCode >= 300)) {
      throw new Error(bodyError.detail ? `HTTP ${statusCode}: ${bodyError.detail}` : `HTTP ${statusCode}`);
    }
    if (bodyError.present) throw new Error(bodyError.detail || 'Codex 额度请求失败');
    if (!isCpaCodexUsageResponse(body)) throw new Error('Codex 额度响应无效');
    return body;
  }

  async requestJson(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...options,
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
      return data;
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
    const provider = normalizeProvider(item?.provider);
    if (!SOURCE_ID_PATTERN.test(id)) throw new Error(`额度来源 ${index + 1} 的 id 无效`);
    if (ids.has(id)) throw new Error(`额度来源 id 重复: ${id}`);
    if (!name) throw new Error(`额度来源 ${id} 缺少名称`);
    if (!ENV_KEY_PATTERN.test(apiKeyEnv)) throw new Error(`额度来源 ${id} 的 apiKeyEnv 无效`);
    ids.add(id);
    const baseUrl = normalizeSubQuotaBaseUrl(item?.baseUrl, { provider });
    return {
      id,
      name,
      provider,
      apiKeyEnv,
      apiKey: String(env[apiKeyEnv] || '').trim(),
      baseUrl,
      usageUrl: provider === 'cpa-codex' ? '' : `${baseUrl}/v1/usage`,
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

export function normalizeCpaCodexQuota(data, file = {}, now = Date.now()) {
  if (!isRecord(data)) throw new Error('Codex 额度响应格式无效');
  const planType = cleanText(data.plan_type || data.planType || file.plan_type, 40);
  const rateLimit = data.rate_limit || data.rateLimit || null;
  const codeReview = data.code_review_rate_limit || data.codeReviewRateLimit || null;
  const additional = Array.isArray(data.additional_rate_limits || data.additionalRateLimits)
    ? (data.additional_rate_limits || data.additionalRateLimits)
    : [];
  const rateLimits = [
    ...mapCodexRateLimitGroup(rateLimit, '', now),
    ...mapCodexRateLimitGroup(codeReview, 'code-review-', now),
    ...additional.flatMap((item, index) => {
      const nested = item?.rate_limit || item?.rateLimit || item;
      const prefix = cleanText(item?.limit_name || item?.limitName || item?.metered_feature || item?.meteredFeature || `extra-${index + 1}`, 40)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || `extra-${index + 1}`;
      return mapCodexRateLimitGroup(nested, `${prefix}-`, now);
    }),
  ];
  const allowed = rateLimit?.allowed;
  const limitReached = rateLimit?.limit_reached ?? rateLimit?.limitReached;
  const hasAccess = data.codex_access ?? data.codexAccess ?? data.has_access ?? data.hasAccess;
  return {
    valid: hasAccess !== false,
    mode: 'cpa_codex',
    status: hasAccess === false
      ? 'no_access'
      : limitReached
        ? 'quota_exhausted'
        : allowed === false
          ? 'blocked'
          : 'active',
    planName: formatCodexPlanName(planType),
    unit: '%',
    remaining: null,
    balance: nonNegativeNumber(data?.credits?.balance),
    quota: null,
    subscription: null,
    rateLimits,
    expiresAt: '',
    daysUntilExpiry: null,
    today: null,
    total: null,
    email: cleanText(data.email || file.email || file.account, 120),
    rateLimitResetCredits: nonNegativeInteger(
      data?.rate_limit_reset_credits?.applicable_available_count
      ?? data?.rateLimitResetCredits?.applicableAvailableCount
      ?? data?.rate_limit_reset_credits?.available_count
      ?? data?.rateLimitResetCredits?.availableCount
    ),
  };
}

export async function detectSubQuotaProvider(baseUrl, apiKey, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('API Key 不能为空');

  const cpaBase = normalizeSubQuotaBaseUrl(baseUrl, { provider: 'cpa-codex' });
  const subBase = normalizeSubQuotaBaseUrl(baseUrl, { provider: 'sub2api' });

  const tryRequest = async (url, headers) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: controller.signal,
      });
      const text = await response.text().catch(() => '');
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { ok: response.ok, status: response.status, data, text };
    } finally {
      clearTimeout(timeout);
    }
  };

  // Prefer CPA management probe first when the host exposes /v0/management.
  try {
    const cpa = await tryRequest(`${cpaBase}/v0/management/auth-files`, managementHeaders(key));
    if (cpa.ok) {
      return {
        provider: 'cpa-codex',
        baseUrl: cpaBase,
        label: 'CPA Codex',
        detail: '已识别为 CLIProxyAPI / CPA Management',
      };
    }
  } catch {
    // fall through to Sub2API probe
  }

  try {
    const sub = await tryRequest(`${subBase}/v1/usage`, {
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
    });
    if (sub.ok && isRecord(sub.data)) {
      return {
        provider: 'sub2api',
        baseUrl: subBase,
        label: 'Sub2API',
        detail: '已识别为 Sub2API /v1/usage',
      };
    }
    // Some Sub2API forks return non-object but still 200 with usage body; accept JSON text.
    if (sub.ok) {
      return {
        provider: 'sub2api',
        baseUrl: subBase,
        label: 'Sub2API',
        detail: '已识别为 Sub2API /v1/usage',
      };
    }
  } catch {
    // fall through
  }

  // Last resort: if CPA returned auth error (reachable management), treat as CPA.
  try {
    const cpa = await tryRequest(`${cpaBase}/v0/management/auth-files`, managementHeaders(key));
    if (cpa.status === 401 || cpa.status === 403) {
      throw new Error('CPA Management Key 无效或无权限');
    }
  } catch (error) {
    if (String(error?.message || '').includes('Management Key')) throw error;
  }

  throw new Error('无法识别上游服务，请确认 URL/Key 对应 CPA Management 或 Sub2API');
}

export function normalizeSubQuotaBaseUrl(value, options = {}) {
  const provider = normalizeProvider(options.provider);
  const label = provider === 'cpa-codex' ? 'CPA Management URL' : 'API URL';
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} 不能为空`);
  if (text.length > MAX_BASE_URL_LENGTH || /[\r\n\0]/.test(text)) {
    throw new Error(`${label} 包含无效字符或过长`);
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${label} 无效`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label} 必须是无凭据的 http/https 地址`);
  }
  url.search = '';
  url.hash = '';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (provider === 'cpa-codex') {
    pathname = pathname
      .replace(/\/v0\/management(?:\/.*)?$/i, '')
      .replace(/\/v0$/i, '')
      .replace(/\/v1\/usage$/i, '')
      .replace(/\/v1$/i, '');
  } else {
    pathname = pathname
      .replace(/\/v1\/usage$/i, '')
      .replace(/\/v1$/i, '');
  }
  url.pathname = pathname;
  return url.toString().replace(/\/+$/, '');
}

function mapCodexRateLimitGroup(group, idPrefix = '', now = Date.now()) {
  if (!isRecord(group)) return [];
  const windows = pickCodexWindows(group);
  const limits = [];
  if (windows.fiveHour) {
    limits.push(codexWindowToRateLimit(`${idPrefix}5h`.replace(/^-/, ''), '5h', windows.fiveHour, now));
  }
  if (windows.daily) {
    limits.push(codexWindowToRateLimit(`${idPrefix}1d`.replace(/^-/, ''), '1d', windows.daily, now));
  }
  if (windows.weekly) {
    const seconds = nonNegativeNumber(windows.weekly.limit_window_seconds ?? windows.weekly.limitWindowSeconds);
    const window = isMonthlyWindowSeconds(seconds) ? '30d' : '7d';
    limits.push(codexWindowToRateLimit(`${idPrefix}${window}`.replace(/^-/, ''), window, windows.weekly, now));
  }
  return limits.filter(Boolean);
}

function pickCodexWindows(group) {
  const primary = group.primary_window || group.primaryWindow || null;
  const secondary = group.secondary_window || group.secondaryWindow || null;
  let fiveHour = null;
  let daily = null;
  let weekly = null;
  for (const [index, item] of [primary, secondary].entries()) {
    if (!item) continue;
    const seconds = nonNegativeNumber(item.limit_window_seconds ?? item.limitWindowSeconds);
    if (isWindowSeconds(seconds, 18000) && !fiveHour) fiveHour = item;
    else if (isWindowSeconds(seconds, 86400) && !daily) daily = item;
    else if ((isWindowSeconds(seconds, 604800) || isMonthlyWindowSeconds(seconds)) && !weekly) weekly = item;
    else if (seconds === null && index === 0 && !fiveHour) fiveHour = item;
    else if (seconds === null && index === 1 && !weekly) weekly = item;
  }
  return { fiveHour, daily, weekly };
}

function codexWindowToRateLimit(id, window, data, now = Date.now()) {
  if (!isRecord(data)) return null;
  const usedPercent = nonNegativeNumber(data.used_percent ?? data.usedPercent);
  const remainingPercent = usedPercent === null ? null : Math.max(0, 100 - usedPercent);
  const resetAtSeconds = nonNegativeNumber(data.reset_at ?? data.resetAt);
  const resetAfterSeconds = nonNegativeNumber(data.reset_after_seconds ?? data.resetAfterSeconds);
  let resetAt = '';
  if (resetAtSeconds !== null && resetAtSeconds > 0) resetAt = safeIsoDate(resetAtSeconds * 1000);
  else if (resetAfterSeconds !== null) resetAt = safeIsoDate(now + resetAfterSeconds * 1000);
  return {
    id,
    window,
    used: usedPercent,
    limit: usedPercent === null && remainingPercent === null ? null : 100,
    remaining: remainingPercent,
    windowStart: '',
    resetAt,
  };
}

function isWindowSeconds(seconds, target) {
  return seconds !== null && Math.abs(seconds - target) <= WINDOW_SECONDS_TOLERANCE;
}

function isMonthlyWindowSeconds(seconds) {
  return seconds !== null && seconds >= 2419200 && seconds <= 2678400;
}

function formatCodexPlanName(planType) {
  const value = cleanText(planType, 40).toLowerCase();
  return ({
    plus: 'Plus',
    free: 'Free',
    pro: 'Pro 20x',
    prolite: 'Pro 5x',
    team: 'Team',
    enterprise: 'Enterprise',
  })[value] || (value ? value.replace(/(^|[_\s-])([a-z])/g, (_, p1, p2) => (p1 ? ' ' : '') + p2.toUpperCase()) : 'Codex');
}

function isCodexAuthFile(file) {
  if (!isRecord(file)) return false;
  const provider = cleanText(file.provider, 40).toLowerCase();
  if (provider) return provider === 'codex';
  const type = cleanText(file.type, 40).toLowerCase();
  if (type) return type === 'codex';
  const name = cleanText(file.name || file.id, 120).toLowerCase();
  return name.includes('codex');
}

function isCpaCodexUsageResponse(value) {
  if (!isRecord(value)) return false;
  const planType = value.plan_type ?? value.planType;
  if (typeof planType === 'string' && planType.trim()) return true;

  if ([value.rate_limit, value.rateLimit, value.code_review_rate_limit, value.codeReviewRateLimit]
    .some((group) => isCpaRateLimitGroup(group))) return true;

  const additional = value.additional_rate_limits ?? value.additionalRateLimits;
  if (Array.isArray(additional) && additional.some((item) => {
    if (!isRecord(item)) return false;
    return isCpaRateLimitGroup(item.rate_limit ?? item.rateLimit ?? item);
  })) return true;

  if (isCpaCredits(value.credits)) return true;
  if ([value.codex_access, value.codexAccess, value.has_access, value.hasAccess]
    .some((flag) => typeof flag === 'boolean')) return true;
  return isCpaResetCredits(value.rate_limit_reset_credits ?? value.rateLimitResetCredits);
}

function isCpaRateLimitGroup(value) {
  if (!isRecord(value)) return false;
  if (typeof value.allowed === 'boolean') return true;
  if (typeof (value.limit_reached ?? value.limitReached) === 'boolean') return true;
  return [value.primary_window, value.primaryWindow, value.secondary_window, value.secondaryWindow]
    .some((window) => isCpaRateLimitWindow(window));
}

function isCpaRateLimitWindow(value) {
  if (!isRecord(value)) return false;
  return [
    value.used_percent,
    value.usedPercent,
    value.limit_window_seconds,
    value.limitWindowSeconds,
    value.reset_at,
    value.resetAt,
    value.reset_after_seconds,
    value.resetAfterSeconds,
  ].some((item) => nonNegativeNumber(item) !== null);
}

function isCpaCredits(value) {
  if (!isRecord(value)) return false;
  if (nonNegativeNumber(value.balance) !== null) return true;
  return [value.has_credits, value.hasCredits, value.unlimited]
    .some((flag) => typeof flag === 'boolean');
}

function isCpaResetCredits(value) {
  if (!isRecord(value)) return false;
  return [
    value.applicable_available_count,
    value.applicableAvailableCount,
    value.available_count,
    value.availableCount,
  ].some((item) => nonNegativeInteger(item) !== null);
}

function normalizeProvider(value) {
  const text = cleanText(value, 40).toLowerCase();
  if (!text || text === 'sub2api' || text === 'sub') return 'sub2api';
  if (text === 'cpa' || text === 'cpa-codex' || text === 'codex' || text === 'cliproxyapi') return 'cpa-codex';
  throw new Error(`不支持的额度来源 provider: ${text}`);
}

function safeIsoDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function extractCpaAccountId(value) {
  if (!isRecord(value)) return '';
  return cleanText(
    value.account_id
    || value.accountId
    || value.chatgpt_account_id
    || value.chatgptAccountId
    || value.id_token?.chatgpt_account_id
    || value.id_token?.chatgptAccountId
    || value.idToken?.chatgpt_account_id
    || value.idToken?.chatgptAccountId,
    80,
  );
}

function extractCpaUsageError(value) {
  if (!isRecord(value)) return { present: false, detail: '' };
  for (const key of ['error', 'detail', 'message']) {
    if (!Object.hasOwn(value, key)) continue;
    const detail = cleanErrorText(value[key], 120);
    return {
      present: true,
      detail: detail || 'Codex 额度请求失败',
    };
  }
  return { present: false, detail: '' };
}

function cleanErrorText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function managementHeaders(apiKey) {
  return {
    Accept: 'application/json',
    'X-Management-Key': apiKey,
  };
}

function parseMaybeJson(value) {
  if (isRecord(value) || Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function formatFetchError(error) {
  const message = error?.name === 'AbortError' ? '请求超时' : String(error?.message || '请求失败');
  return message.slice(0, 160);
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

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
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
