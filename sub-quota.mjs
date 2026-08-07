const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_MS = 30000;
const ERROR_CACHE_TTL_MS = 5000;
const LAST_GOOD_TTL_MS = 5 * 60 * 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const RATE_LIMIT_WINDOWS = new Set(['5h', '1d', '7d', '30d']);
const MAX_BASE_URL_LENGTH = 2048;
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_USAGE_HEADERS = {
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal',
};
const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';
const TRANSIENT_FETCH_ERROR = Symbol('transientFetchError');
const SOURCE_WIDE_FETCH_ERROR = Symbol('sourceWideFetchError');
const PARTIAL_SOURCE_FETCH_ERROR = Symbol('partialSourceFetchError');

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
    this.lastSuccessfulBySource = new Map();
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
    if (!refresh && this.cache) {
      if (now - this.cache.cachedAt < this.cache.ttlMs) return this.cache.value;
      if (hasUsableQuota(this.cache.value)) {
        void this.refreshCache().catch(() => {});
        return this.cache.value;
      }
    }
    return this.refreshCache();
  }

  refreshCache() {
    if (this.pending) return this.pending;
    const pending = this.load().then((value) => {
      this.cache = {
        cachedAt: this.now(),
        ttlMs: cacheTtlFor(value, this.cacheTtlMs),
        value,
      };
      return value;
    }).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  async load() {
    const fetchedAt = new Date(this.now()).toISOString();
    const quotas = (await Promise.all(this.sources.map((source) => this.fetchSourceWithFallback(source, fetchedAt)))).flat();
    return {
      configured: this.sources.length > 0,
      count: quotas.length,
      availableCount: quotas.filter(isUsableQuota).length,
      fetchedAt,
      quotas,
      ...(this.configurationError ? { configurationError: this.configurationError } : {}),
    };
  }

  async fetchSource(source, fetchedAt) {
    if (source.provider === 'cpa-codex') return this.fetchCpaCodexSource(source, fetchedAt);
    if (source.provider === 'grok2api') return this.fetchGrok2ApiSource(source, fetchedAt);
    if (source.provider === 'deepseek') return this.fetchDeepSeekSource(source, fetchedAt);
    return this.fetchSub2ApiSource(source, fetchedAt);
  }

  async fetchGrok2ApiSource(source, fetchedAt) {
    const base = { id: source.id, name: source.name, provider: 'grok2api', fetchedAt };
    if (!source.apiKey) return [{ ...base, error: `缺少环境变量 ${source.apiKeyEnv}` }];

    try {
      const summary = await this.fetchGrok2ApiSummary(source);
      return [{ ...base, ...normalizeGrok2ApiSummary(summary) }];
    } catch (error) {
      return [fetchErrorQuota(base, error, { sourceWide: true })];
    }
  }

  async fetchGrok2ApiSummary(source) {
    const data = await this.requestGrok2ApiJson(source, '/api/admin/v1/accounts/summary');
    const summary = unwrapGrok2ApiData(data);
    if (!isRecord(summary)) throw new Error('Grok2API 账号汇总响应无效');
    return summary;
  }

  async fetchDeepSeekSource(source, fetchedAt) {
    const base = { id: source.id, name: source.name, provider: 'deepseek', fetchedAt };
    if (!source.apiKey) return [{ ...base, error: `缺少环境变量 ${source.apiKeyEnv}` }];

    try {
      const data = await this.requestJson(`${source.baseUrl}/user/balance`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${source.apiKey}`,
        },
      });
      return [{ ...base, ...normalizeDeepSeekBalance(data) }];
    } catch (error) {
      return [fetchErrorQuota(base, error, { sourceWide: true })];
    }
  }

  async resetGrok2ApiQuota(source, options = {}) {
    if (!source || source.provider !== 'grok2api') throw new Error('未配置 Grok2API 额度来源');
    if (!source.apiKey) throw new Error(`缺少环境变量 ${source.apiKeyEnv || 'GROK2API_ADMIN_PASSWORD'}`);
    const ids = Array.isArray(options.ids)
      ? options.ids.map((id) => cleanText(id, 64)).filter(Boolean)
      : [];
    const provider = cleanText(options.accountProvider, 40);
    let data;
    if (ids.length) {
      data = await this.requestGrok2ApiJson(source, '/api/admin/v1/accounts/batch/reset-quota', {
        method: 'POST',
        body: {
          ids,
          ...(provider ? { provider } : {}),
        },
      });
    } else {
      data = await this.requestGrok2ApiJson(source, '/api/admin/v1/accounts/reset-quota', {
        method: 'POST',
        body: {},
      });
    }
    this.cache = null;
    const payload = unwrapGrok2ApiData(data);
    return {
      ok: true,
      reset: nonNegativeInteger(payload?.reset ?? data?.reset ?? ids.length) ?? (ids.length || null),
      raw: isRecord(payload) ? payload : (isRecord(data) ? data : {}),
    };
  }

  async requestGrok2ApiJson(source, path, options = {}) {
    const { username, password } = parseGrok2ApiCredentials(source.apiKey);
    if (!password) throw new Error('Grok2API 管理员密码不能为空');
    const token = await this.loginGrok2Api(source, username, password);
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    };
    const request = {
      method: options.method || 'GET',
      headers,
    };
    if (options.body !== undefined) request.body = JSON.stringify(options.body);
    try {
      return await this.requestJson(`${source.baseUrl}${path}`, request);
    } catch (error) {
      if (Number(error?.statusCode || 0) !== 401) throw error;
      const retryToken = await this.loginGrok2Api(source, username, password, { force: true });
      return this.requestJson(`${source.baseUrl}${path}`, {
        ...request,
        headers: {
          ...headers,
          Authorization: `Bearer ${retryToken}`,
        },
      });
    }
  }

  async loginGrok2Api(source, username, password, { force = false } = {}) {
    if (!this.grok2ApiTokens) this.grok2ApiTokens = new Map();
    const cacheKey = `${source.baseUrl}::${username}`;
    const cached = this.grok2ApiTokens.get(cacheKey);
    const now = this.now();
    if (!force && cached?.token && cached.expiresAt > now + 5000) return cached.token;

    const data = await this.requestJson(`${source.baseUrl}/api/admin/v1/auth/login`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username, password }),
    });
    const payload = unwrapGrok2ApiData(data);
    const token = cleanText(
      payload?.tokens?.accessToken
      || payload?.accessToken
      || data?.tokens?.accessToken
      || data?.accessToken,
      4096,
    );
    if (!token) throw new Error('Grok2API 登录未返回 accessToken');
    const expiresAtText = cleanDate(
      payload?.tokens?.accessTokenExpiresAt
      || payload?.accessTokenExpiresAt
      || data?.tokens?.accessTokenExpiresAt
      || data?.accessTokenExpiresAt,
    );
    const expiresAt = expiresAtText ? Date.parse(expiresAtText) : now + 10 * 60 * 1000;
    this.grok2ApiTokens.set(cacheKey, {
      token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + 10 * 60 * 1000,
    });
    return token;
  }

  async fetchSourceWithFallback(source, fetchedAt) {
    const quotas = await this.fetchSource(source, fetchedAt);
    const now = this.now();
    const previous = this.lastSuccessfulBySource.get(source) || new Map();
    const sourceWideFailure = quotas.find((item) => item[SOURCE_WIDE_FETCH_ERROR]);
    if (sourceWideFailure) {
      if (!sourceWideFailure[TRANSIENT_FETCH_ERROR]) {
        this.lastSuccessfulBySource.delete(source);
        return quotas;
      }
      const fallback = [];
      const fresh = new Map();
      for (const [key, entry] of previous) {
        if (now - entry.succeededAt > LAST_GOOD_TTL_MS) continue;
        fresh.set(key, entry);
        fallback.push(staleQuota(entry.quota, sourceWideFailure.error));
      }
      if (fresh.size) this.lastSuccessfulBySource.set(source, fresh);
      else this.lastSuccessfulBySource.delete(source);
      return fallback.length ? fallback : quotas;
    }
    const partialFailure = quotas.find((item) => item[PARTIAL_SOURCE_FETCH_ERROR]);

    const next = new Map(previous);
    const returnedKeys = new Set();
    const resolved = quotas.map((item, index) => {
      const key = quotaItemKey(item, index);
      returnedKeys.add(key);
      if (isUsableQuota(item)) {
        next.set(key, { succeededAt: now, quota: { ...item } });
        return item;
      }
      if (item[TRANSIENT_FETCH_ERROR]) {
        const entry = previous.get(key);
        if (entry && now - entry.succeededAt <= LAST_GOOD_TTL_MS) {
          return staleQuota(entry.quota, item.error);
        }
      }
      next.delete(key);
      return item;
    });
    for (const [key, entry] of previous) {
      if (returnedKeys.has(key)) continue;
      if (partialFailure?.[TRANSIENT_FETCH_ERROR] && now - entry.succeededAt <= LAST_GOOD_TTL_MS) {
        next.set(key, entry);
        resolved.push(staleQuota(entry.quota, partialFailure.error));
      } else {
        next.delete(key);
      }
    }
    if (next.size) this.lastSuccessfulBySource.set(source, next);
    else this.lastSuccessfulBySource.delete(source);
    return resolved;
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
      const quota = { ...base, ...normalizeSubQuota(data) };
      if (source.baseUrl && !quota.rateLimits.some((item) => item.window === '5h')) {
        try {
          const probedLimits = await this.fetchSub2ApiRateLimitProbe(source);
          const existingWindows = new Set(quota.rateLimits.map((item) => item.window));
          quota.rateLimits.push(...probedLimits.filter((item) => !existingWindows.has(item.window)));
          if (quota.rateLimits.some((item) => item.used !== null && item.limit !== null && item.used >= item.limit)) {
            quota.status = 'quota_exhausted';
          }
        } catch {
          // The models probe is optional. Keep a valid /v1/usage result intact.
        }
      }
      if (!source.adminApiKey) return [quota];
      try {
        const accounts = await this.fetchSub2ApiCodexAccounts(source, fetchedAt);
        return [quota, ...accounts];
      } catch (error) {
        return [quota, fetchErrorQuota({
          ...base,
          id: `${source.id}-codex-accounts`,
          name: `${source.name} Codex`,
        }, error, { partial: true })];
      }
    } catch (error) {
      return [fetchErrorQuota(base, error, { sourceWide: true })];
    }
  }

  async fetchSub2ApiRateLimitProbe(source) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${source.baseUrl}/v1/models`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${source.apiKey}`,
        },
        redirect: 'error',
        signal: controller.signal,
      });
      const bodyText = await readLimitedBody(response, MAX_RESPONSE_BYTES);
      return normalizeSub2ApiRateLimitProbe(response.headers, bodyText, this.now());
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchSub2ApiCodexAccounts(source, fetchedAt) {
    const data = await this.requestJson(
      `${source.baseUrl}/api/v1/admin/accounts?platform=openai&type=oauth&page=1&page_size=1000`,
      {
        headers: {
          Accept: 'application/json',
          'x-api-key': source.adminApiKey,
        },
      },
    );
    return normalizeSub2ApiCodexAccounts(data).map((quota, index) => ({
      id: `${source.id}-codex-${quota.accountId || index + 1}`,
      name: quota.name,
      provider: 'sub2api',
      sourceName: source.name,
      fetchedAt,
      ...quota,
    }));
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

      const quotas = [];
      for (const file of codexFiles) {
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
          quotas.push({ ...accountBase, ...normalizeCpaCodexQuota(usage, file) });
        } catch (error) {
          quotas.push(fetchErrorQuota(accountBase, error));
        }
      }
      return quotas;
    } catch (error) {
      return [fetchErrorQuota(base, error, { sourceWide: true })];
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
    const direct = cleanText(file.account_id || file.accountId || file.chatgpt_account_id, 80);
    if (direct) return direct;
    const name = cleanText(file.name || file.id, 240);
    if (!name) throw new Error('Codex 凭证缺少文件名');
    const auth = await this.requestJson(
      `${source.baseUrl}/v0/management/auth-files/download?name=${encodeURIComponent(name)}`,
      { headers: managementHeaders(source.apiKey) },
    );
    const accountId = cleanText(auth?.account_id || auth?.accountId, 80);
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
    if (statusCode && (statusCode < 200 || statusCode >= 300)) {
      const detail = cleanText(body?.error || body?.detail || body?.message || JSON.stringify(body || {}), 120);
      const error = new Error(detail ? `HTTP ${statusCode}: ${detail}` : `HTTP ${statusCode}`);
      error.statusCode = statusCode;
      throw error;
    }
    if (!isRecord(body)) throw new Error('Codex 额度响应无效');
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
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.statusCode = response.status;
        throw error;
      }
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
    const adminApiKeyEnv = String(item?.adminApiKeyEnv || '').trim();
    const provider = normalizeProvider(item?.provider);
    if (!SOURCE_ID_PATTERN.test(id)) throw new Error(`额度来源 ${index + 1} 的 id 无效`);
    if (ids.has(id)) throw new Error(`额度来源 id 重复: ${id}`);
    if (!name) throw new Error(`额度来源 ${id} 缺少名称`);
    if (!ENV_KEY_PATTERN.test(apiKeyEnv)) throw new Error(`额度来源 ${id} 的 apiKeyEnv 无效`);
    if (adminApiKeyEnv && !ENV_KEY_PATTERN.test(adminApiKeyEnv)) {
      throw new Error(`额度来源 ${id} 的 adminApiKeyEnv 无效`);
    }
    ids.add(id);
    const baseUrl = provider === 'deepseek'
      ? normalizeSubQuotaBaseUrl(String(item?.baseUrl || '').trim() || DEEPSEEK_DEFAULT_BASE_URL, { provider: 'deepseek' })
      : normalizeSubQuotaBaseUrl(item?.baseUrl, { provider });
    return {
      id,
      name,
      provider,
      apiKeyEnv,
      apiKey: String(env[apiKeyEnv] || '').trim(),
      baseUrl,
      usageUrl: provider === 'sub2api' ? `${baseUrl}/v1/usage` : '',
      ...(provider === 'sub2api' && adminApiKeyEnv ? {
        adminApiKeyEnv,
        adminApiKey: String(env[adminApiKeyEnv] || '').trim(),
      } : {}),
    };
  });
}

export function normalizeSubQuota(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('额度响应格式无效');
  const subscriptionData = isRecord(data.subscription) ? data.subscription : null;
  const subscription = isRecord(data.subscription)
    ? {
      daily: quotaWindow(data.subscription.daily_usage_usd, data.subscription.daily_limit_usd, undefined, { zeroLimitUnlimited: true }),
      weekly: quotaWindow(data.subscription.weekly_usage_usd, data.subscription.weekly_limit_usd, undefined, { zeroLimitUnlimited: true }),
      monthly: quotaWindow(data.subscription.monthly_usage_usd, data.subscription.monthly_limit_usd, undefined, { zeroLimitUnlimited: true }),
      expiresAt: cleanDate(data.subscription.expires_at),
      weeklyWindowStart: cleanDate(data.subscription.weekly_window_start),
    }
    : null;
  const quota = isRecord(data.quota) ? {
    ...quotaWindow(data.quota.used, data.quota.limit, data.quota.remaining),
    unit: cleanText(data.quota.unit, 16),
  } : null;
  const rateLimits = normalizeSubRateLimits(data);
  if (subscriptionData && !rateLimits.some((item) => item.window === '5h')) {
    const fiveHour = quotaWindow(
      subscriptionData.usage_5h_usd,
      subscriptionData.limit_5h_usd,
      undefined,
      { zeroLimitUnlimited: true },
    );
    if (fiveHour?.limit > 0) {
      const windowStart = cleanQuotaTimestamp(
        subscriptionData.window_5h_start ?? subscriptionData.window5hStart,
      );
      const explicitResetAt = cleanQuotaTimestamp(
        subscriptionData.reset_5h_at ?? subscriptionData.reset5hAt,
      );
      rateLimits.unshift({
        window: '5h',
        ...fiveHour,
        windowStart,
        resetAt: explicitResetAt || (
          windowStart
            ? new Date(Date.parse(windowStart) + 5 * 60 * 60 * 1000).toISOString()
            : ''
        ),
        unit: 'USD',
        display: 'used',
      });
    }
  }
  return {
    valid: data.isValid !== false,
    mode: cleanText(data.mode, 40),
    status: cleanText(data.status, 40),
    planName: cleanText(data.planName, 100),
    unit: cleanText(data.unit, 16) || quota?.unit || inferRateLimitUnit(rateLimits) || 'USD',
    remaining: nonNegativeNumber(data.remaining),
    balance: nonNegativeNumber(data.balance),
    quota,
    subscription,
    rateLimits,
    expiresAt: cleanDate(data.expires_at),
    daysUntilExpiry: nonNegativeInteger(data.days_until_expiry),
    today: normalizeUsage(data.usage?.today),
    total: normalizeUsage(data.usage?.total),
  };
}

export function normalizeSub2ApiCodexAccounts(data) {
  const payload = isRecord(data?.data) ? data.data : data;
  const accounts = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload?.accounts)
      ? payload.accounts
      : Array.isArray(payload)
        ? payload
        : [];
  const quotas = [];
  for (const account of accounts) {
    if (!isRecord(account)) continue;
    const rateLimits = normalizeSub2ApiCodexAccountRateLimits(account);
    if (!rateLimits.length) continue;
    const status = cleanText(account.status, 40).toLowerCase();
    quotas.push({
      valid: !['disabled', 'inactive', 'error'].includes(status),
      mode: 'sub2api_codex_account',
      status: rateLimits.some((item) => item.used !== null && item.used >= 100)
        ? 'quota_exhausted'
        : status || 'active',
      planName: formatCodexPlanName(account.extra?.plan_type ?? account.extra?.planType),
      unit: '%',
      remaining: null,
      balance: null,
      quota: null,
      subscription: null,
      rateLimits,
      expiresAt: cleanQuotaTimestamp(account.expires_at ?? account.expiresAt),
      daysUntilExpiry: null,
      today: null,
      total: null,
      name: cleanText(account.name || account.email || `Codex ${account.id || ''}`, 100) || 'Codex',
      accountId: cleanText(account.id, 80),
    });
  }
  return quotas;
}

export function normalizeCpaCodexQuota(data, file = {}) {
  if (!isRecord(data)) throw new Error('Codex 额度响应格式无效');
  const planType = cleanText(data.plan_type || data.planType || file.account_type || file.plan_type, 40);
  const rateLimit = data.rate_limit || data.rateLimit || null;
  const codeReview = data.code_review_rate_limit || data.codeReviewRateLimit || null;
  const additional = Array.isArray(data.additional_rate_limits || data.additionalRateLimits)
    ? (data.additional_rate_limits || data.additionalRateLimits)
    : [];
  const rateLimits = [
    ...mapCodexRateLimitGroup(rateLimit, ''),
    ...mapCodexRateLimitGroup(codeReview, 'code-review-'),
    ...additional.flatMap((item, index) => {
      const nested = item?.rate_limit || item?.rateLimit || item;
      const prefix = cleanText(item?.limit_name || item?.limitName || item?.metered_feature || item?.meteredFeature || `extra-${index + 1}`, 40)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || `extra-${index + 1}`;
      return mapCodexRateLimitGroup(nested, `${prefix}-`);
    }),
  ];
  const allowed = rateLimit?.allowed;
  const limitReached = rateLimit?.limit_reached ?? rateLimit?.limitReached;
  return {
    valid: planType.toLowerCase() !== 'free',
    mode: 'cpa_codex',
    status: planType.toLowerCase() === 'free'
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
    accountId: cleanText(data.account_id || data.accountId || file.account_id, 80),
    rateLimitResetCredits: nonNegativeInteger(
      data?.rate_limit_reset_credits?.available_count
      ?? data?.rateLimitResetCredits?.availableCount
      ?? data?.rate_limit_reset_credits?.applicable_available_count,
    ),
  };
}


export function normalizeGrok2ApiSummary(data) {
  if (!isRecord(data)) throw new Error('Grok2API 账号汇总响应无效');
  const recovering = nonNegativeInteger(data.recovering) ?? 0;
  const attention = nonNegativeInteger(data.attention) ?? 0;
  const risk = nonNegativeInteger(data.risk) ?? 0;
  const issues = isRecord(data.issues) ? data.issues : {};
  const recovery = isRecord(data.recovery) ? data.recovery : {};
  const disabled = nonNegativeInteger(issues.disabled) ?? 0;
  const reauthRequired = nonNegativeInteger(issues.reauthRequired) ?? 0;
  const waitingReset = nonNegativeInteger(recovery.waitingReset) ?? 0;
  const probing = nonNegativeInteger(recovery.probing) ?? 0;
  const cooldown = nonNegativeInteger(recovery.cooldown) ?? 0;

  const providers = {};
  if (isRecord(data.providers)) {
    for (const [key, value] of Object.entries(data.providers)) {
      if (!isRecord(value)) continue;
      const providerTotal = nonNegativeInteger(value.total) ?? 0;
      const providerAvailable = nonNegativeInteger(value.available) ?? 0;
      providers[cleanText(key, 40) || key] = {
        total: providerTotal,
        available: providerAvailable,
        abnormal: Math.max(0, providerTotal - providerAvailable),
      };
    }
  }

  // Callable quota is intentionally scoped to the grok_build pool only.
  const buildPool = providers.grok_build || providers.grokBuild || {
    total: 0,
    available: 0,
    abnormal: 0,
  };
  const total = nonNegativeInteger(buildPool.total) ?? 0;
  const available = nonNegativeInteger(buildPool.available) ?? 0;
  const abnormal = Math.max(0, total - available);
  const used = Math.max(0, total - available);
  const usagePercent = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;

  return {
    valid: true,
    mode: 'grok2api_accounts',
    status: available > 0 ? 'active' : (total > 0 ? 'quota_exhausted' : 'no_access'),
    planName: 'Grok2API Build',
    unit: 'accounts',
    remaining: available,
    balance: available,
    quota: {
      ...quotaWindow(used, total, available),
      unit: 'accounts',
    },
    subscription: null,
    rateLimits: total > 0 ? [{
      id: 'grok-build-accounts',
      window: '30d',
      used,
      limit: total,
      remaining: available,
      resetAt: '',
    }] : [],
    expiresAt: '',
    daysUntilExpiry: null,
    today: null,
    total: null,
    supportsReset: true,
    accountStats: {
      pool: 'grok_build',
      total,
      available,
      abnormal,
      recovering,
      attention,
      risk,
      normalAvailable: nonNegativeInteger(data.available) ?? 0,
      totalAccounts: nonNegativeInteger(data.total) ?? 0,
      disabled,
      reauthRequired,
      waitingReset,
      probing,
      cooldown,
      usagePercent,
      providers,
    },
  };
}

export function normalizeDeepSeekBalance(data) {
  if (!isRecord(data)) throw new Error('DeepSeek 余额响应格式无效');
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos.filter(isRecord) : [];
  const info = infos.find((item) => cleanText(item.currency, 8).toUpperCase() === 'CNY')
    || infos.find((item) => cleanText(item.currency, 8).toUpperCase() === 'USD')
    || infos[0];
  const currency = cleanText(info?.currency, 8).toUpperCase() || 'CNY';
  const totalBalance = nonNegativeNumber(info?.total_balance);
  const grantedBalance = nonNegativeNumber(info?.granted_balance);
  const toppedUpBalance = nonNegativeNumber(info?.topped_up_balance);
  return {
    valid: data.is_available !== false,
    mode: 'deepseek',
    status: data.is_available === false
      ? 'no_access'
      : totalBalance !== null && totalBalance > 0
        ? 'active'
        : 'no_access',
    planName: 'DeepSeek 官方',
    unit: currency,
    remaining: totalBalance,
    balance: totalBalance,
    currency,
    grantedBalance,
    toppedUpBalance,
    quota: null,
    subscription: null,
    rateLimits: [],
    expiresAt: '',
    daysUntilExpiry: null,
    today: null,
    total: null,
  };
}

export async function detectSubQuotaProvider(baseUrl, apiKey, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('API Key 不能为空');
  const preferred = normalizeProvider(options.provider);

  const tryRequest = async (url, init = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: init.method || 'GET',
        headers: init.headers,
        body: init.body,
        redirect: 'error',
        signal: controller.signal,
      });
      const textBody = await response.text().catch(() => '');
      let data = null;
      try { data = textBody ? JSON.parse(textBody) : null; } catch { data = textBody; }
      return { ok: response.ok, status: response.status, data, text: textBody };
    } finally {
      clearTimeout(timeout);
    }
  };

  const probeGrok = async () => {
    const grokBase = normalizeSubQuotaBaseUrl(baseUrl, { provider: 'grok2api' });
    const { username, password } = parseGrok2ApiCredentials(key);
    const login = await tryRequest(`${grokBase}/api/admin/v1/auth/login`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username, password }),
    });
    if (login.status === 401 || login.status === 403) {
      throw new Error('Grok2API 管理员账号或密码无效');
    }
    if (!login.ok) return null;
    const payload = unwrapGrok2ApiData(login.data);
    const token = cleanText(
      payload?.tokens?.accessToken
      || payload?.accessToken
      || login.data?.tokens?.accessToken
      || login.data?.accessToken,
      4096,
    );
    if (!token) return null;
    const summary = await tryRequest(`${grokBase}/api/admin/v1/accounts/summary`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    if (summary.ok) {
      return {
        provider: 'grok2api',
        baseUrl: grokBase,
        label: 'Grok2API',
        detail: '已识别为 Grok2API 管理接口',
      };
    }
    if (summary.status === 401 || summary.status === 403) {
      throw new Error('Grok2API 管理员登录成功但汇总接口无权限');
    }
    return {
      provider: 'grok2api',
      baseUrl: grokBase,
      label: 'Grok2API',
      detail: '已识别为 Grok2API 管理登录',
    };
  };

  if (preferred === 'grok2api') {
    const grok = await probeGrok();
    if (grok) return grok;
    throw new Error('无法识别为 Grok2API，请确认 URL 与管理员密码');
  }

  const cpaBase = normalizeSubQuotaBaseUrl(baseUrl, { provider: 'cpa-codex' });
  const subBase = normalizeSubQuotaBaseUrl(baseUrl, { provider: 'sub2api' });

  try {
    const cpa = await tryRequest(`${cpaBase}/v0/management/auth-files`, {
      headers: managementHeaders(key),
    });
    if (cpa.ok) {
      return {
        provider: 'cpa-codex',
        baseUrl: cpaBase,
        label: 'CPA Codex',
        detail: '已识别为 CLIProxyAPI / CPA Management',
      };
    }
  } catch {
    // fall through
  }

  try {
    const grok = await probeGrok();
    if (grok) return grok;
  } catch {
    // fall through to Sub2API
  }

  try {
    const sub = await tryRequest(`${subBase}/v1/usage`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${key}`,
      },
    });
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

  try {
    const cpa = await tryRequest(`${cpaBase}/v0/management/auth-files`, {
      headers: managementHeaders(key),
    });
    if (cpa.status === 401 || cpa.status === 403) {
      throw new Error('CPA Management Key 无效或无权限');
    }
  } catch (error) {
    if (String(error?.message || '').includes('Management Key')) throw error;
  }

  try {
    const grok = await probeGrok();
    if (grok) return grok;
  } catch (error) {
    if (String(error?.message || '').includes('Grok2API')) throw error;
  }

  throw new Error('无法识别上游服务，请确认 URL/Key 对应 CPA Management、Grok2API 或 Sub2API');
}

export function normalizeSubQuotaBaseUrl(value, options = {}) {
  const provider = normalizeProvider(options.provider);
  const label = provider === 'cpa-codex'
    ? 'CPA Management URL'
    : provider === 'grok2api'
      ? 'Grok2API URL'
      : provider === 'deepseek'
        ? 'DeepSeek API URL'
        : 'API URL';
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
  } else if (provider === 'grok2api') {
    pathname = pathname
      .replace(/\/api\/admin(?:\/.*)?$/i, '')
      .replace(/\/admin(?:\/.*)?$/i, '')
      .replace(/\/v1\/usage$/i, '')
      .replace(/\/v1$/i, '');
  } else if (provider === 'deepseek') {
    pathname = pathname
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

function mapCodexRateLimitGroup(group, idPrefix = '') {
  if (!isRecord(group)) return [];
  const windows = pickCodexWindows(group);
  const limits = [];
  if (windows.fiveHour) {
    limits.push(codexWindowToRateLimit(`${idPrefix}5h`.replace(/^-/, ''), '5h', windows.fiveHour));
  }
  if (windows.weekly) {
    const seconds = nonNegativeNumber(windows.weekly.limit_window_seconds ?? windows.weekly.limitWindowSeconds);
    const window = isMonthlyWindowSeconds(seconds) ? '30d' : '7d';
    limits.push(codexWindowToRateLimit(`${idPrefix}${window}`.replace(/^-/, ''), window, windows.weekly));
  }
  return limits.filter(Boolean);
}

function pickCodexWindows(group) {
  const primary = group.primary_window || group.primaryWindow || null;
  const secondary = group.secondary_window || group.secondaryWindow || null;
  let fiveHour = null;
  let weekly = null;
  for (const item of [primary, secondary]) {
    if (!item) continue;
    const seconds = nonNegativeNumber(item.limit_window_seconds ?? item.limitWindowSeconds);
    if (seconds === 18000 && !fiveHour) fiveHour = item;
    else if ((seconds === 604800 || isMonthlyWindowSeconds(seconds)) && !weekly) weekly = item;
  }
  if (!fiveHour && primary && primary !== weekly) fiveHour = primary;
  if (!weekly && secondary && secondary !== fiveHour) weekly = secondary;
  if (!fiveHour && !weekly && primary) weekly = primary;
  return { fiveHour, weekly };
}

function codexWindowToRateLimit(id, window, data) {
  if (!isRecord(data)) return null;
  const usedPercent = nonNegativeNumber(data.used_percent ?? data.usedPercent);
  const remainingPercent = usedPercent === null ? null : Math.max(0, 100 - usedPercent);
  const resetAtSeconds = nonNegativeNumber(data.reset_at ?? data.resetAt);
  const resetAfterSeconds = nonNegativeNumber(data.reset_after_seconds ?? data.resetAfterSeconds);
  let resetAt = '';
  if (resetAtSeconds !== null) resetAt = new Date(resetAtSeconds * 1000).toISOString();
  else if (resetAfterSeconds !== null) resetAt = new Date(Date.now() + resetAfterSeconds * 1000).toISOString();
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
  const type = cleanText(file.type || file.provider, 40).toLowerCase();
  const name = cleanText(file.name || file.id, 120).toLowerCase();
  return type === 'codex' || name.includes('codex');
}

function normalizeProvider(value) {
  const text = cleanText(value, 40).toLowerCase();
  if (!text || text === 'sub2api' || text === 'sub') return 'sub2api';
  if (text === 'cpa' || text === 'cpa-codex' || text === 'codex' || text === 'cliproxyapi') return 'cpa-codex';
  if (text === 'grok2api' || text === 'grok' || text === 'grok-api' || text === 'grok_api') return 'grok2api';
  if (text === 'deepseek' || text === 'deep-seek' || text === 'deepseek-api' || text === 'deep_seek' || text === 'ds') return 'deepseek';
  return 'sub2api';
}

function parseGrok2ApiCredentials(apiKey) {
  const raw = String(apiKey || '').trim();
  if (!raw) return { username: 'admin', password: '' };
  const newline = String.fromCharCode(10);
  const separators = [newline, '|', '::'];
  for (const separator of separators) {
    if (!raw.includes(separator)) continue;
    const [username, ...rest] = raw.split(separator);
    const password = rest.join(separator).trim();
    if (username.trim() && password) {
      return { username: username.trim().slice(0, 80), password: password.slice(0, 4096) };
    }
  }
  if (raw.includes(':')) {
    const index = raw.indexOf(':');
    const username = raw.slice(0, index).trim();
    const password = raw.slice(index + 1).trim();
    if (username && password && username.length <= 64 && !/\s/.test(username) && !username.includes('.')) {
      return { username: username.slice(0, 80), password: password.slice(0, 4096) };
    }
  }
  return { username: 'admin', password: raw.slice(0, 4096) };
}

function unwrapGrok2ApiData(data) {
  if (isRecord(data) && isRecord(data.data)) return data.data;
  return data;
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

function fetchErrorQuota(base, error, { sourceWide = false, partial = false } = {}) {
  const quota = { ...base, error: formatFetchError(error) };
  if (isTransientFetchError(error)) {
    Object.defineProperty(quota, TRANSIENT_FETCH_ERROR, { value: true });
  }
  if (sourceWide) Object.defineProperty(quota, SOURCE_WIDE_FETCH_ERROR, { value: true });
  if (partial) Object.defineProperty(quota, PARTIAL_SOURCE_FETCH_ERROR, { value: true });
  return quota;
}

function isTransientFetchError(error) {
  if (error?.name === 'AbortError') return true;
  const statusCode = Number(error?.statusCode || 0);
  if (statusCode > 0) return statusCode === 408 || statusCode === 429 || statusCode >= 500;
  const code = String(error?.cause?.code || error?.code || '').toUpperCase();
  if (/^(?:ECONN|ENET|EHOST|EAI_|ETIMEDOUT|UND_ERR_)/.test(code)) return true;
  return /(?:fetch failed|network|socket|connection|timed?\s*out)/i.test(String(error?.message || ''));
}

function hasUsableQuota(value) {
  return Array.isArray(value?.quotas) && value.quotas.some(isUsableQuota);
}

function cacheTtlFor(value, healthyTtlMs) {
  const degraded = Boolean(value?.configurationError)
    || (Array.isArray(value?.quotas) && value.quotas.some((item) => !isUsableQuota(item) || item?.stale));
  return degraded ? Math.min(healthyTtlMs, ERROR_CACHE_TTL_MS) : healthyTtlMs;
}

function isUsableQuota(item) {
  return Boolean(item) && !item.error && item.valid !== false;
}

function quotaItemKey(item, index) {
  return String(item?.id || `${item?.provider || 'quota'}:${item?.name || index}`);
}

function staleQuota(quota, warning) {
  return {
    ...quota,
    stale: true,
    warning: String(warning || '请求失败'),
  };
}

function quotaWindow(usedValue, limitValue, remainingValue, { zeroLimitUnlimited = false } = {}) {
  const used = nonNegativeNumber(usedValue);
  const limit = nonNegativeNumber(limitValue);
  const explicitRemaining = nonNegativeNumber(remainingValue);
  if (used === null && limit === null && explicitRemaining === null) return null;

  if (zeroLimitUnlimited && limit === 0) {
    return { used, limit, remaining: null };
  }
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
    const window = normalizeRateLimitWindow(item.window ?? item.window_name ?? item.windowName);
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
      windowStart: cleanQuotaTimestamp(item.window_start ?? item.windowStart),
      resetAt: cleanQuotaTimestamp(item.reset_at ?? item.resetAt),
      ...(cleanText(item.unit, 16) ? { unit: cleanText(item.unit, 16) } : {}),
    });
  }
  return limits;
}

function normalizeSubRateLimits(data) {
  const limits = normalizeRateLimits(data.rate_limits ?? data.rateLimits);
  const seen = new Set(limits.map((item) => item.window));
  const appendMissing = (items) => {
    for (const item of items) {
      if (seen.has(item.window)) continue;
      seen.add(item.window);
      limits.push(item);
    }
  };

  for (const candidate of [data.api_key, data.apiKey, data.key, data]) {
    if (isRecord(candidate)) appendMissing(normalizeApiKeyRateLimits(candidate));
  }
  for (const candidate of [data.usage_info, data.usageInfo, data.account_usage, data.accountUsage, data]) {
    if (isRecord(candidate)) appendMissing(normalizeUsageProgressRateLimits(candidate));
  }
  return limits;
}

function normalizeApiKeyRateLimits(value) {
  const limits = [];
  for (const definition of [
    ['5h', '5h'],
    ['1d', '1d'],
    ['7d', '7d'],
  ]) {
    const [window, suffix] = definition;
    const camelSuffix = suffix[0].toUpperCase() + suffix.slice(1);
    const limit = nonNegativeNumber(value[`rate_limit_${suffix}`] ?? value[`rateLimit${camelSuffix}`]);
    const used = nonNegativeNumber(value[`usage_${suffix}`] ?? value[`usage${camelSuffix}`]);
    if (limit === 0 || (limit === null && used === null)) continue;
    const quota = quotaWindow(used, limit, undefined) || { used: null, limit: null, remaining: null };
    limits.push({
      window,
      ...quota,
      windowStart: cleanQuotaTimestamp(value[`window_${suffix}_start`] ?? value[`window${camelSuffix}Start`]),
      resetAt: cleanQuotaTimestamp(value[`reset_${suffix}_at`] ?? value[`reset${camelSuffix}At`]),
      unit: cleanText(value.unit, 16) || 'USD',
    });
  }
  return limits;
}

function normalizeUsageProgressRateLimits(value) {
  const limits = [];
  for (const [window, snakeName, camelName] of [
    ['5h', 'five_hour', 'fiveHour'],
    ['7d', 'seven_day', 'sevenDay'],
  ]) {
    const progress = value[snakeName] ?? value[camelName];
    if (!isRecord(progress)) continue;
    const used = nonNegativeNumber(progress.utilization ?? progress.used_percent ?? progress.usedPercent);
    if (used === null) continue;
    limits.push({
      window,
      used,
      limit: 100,
      remaining: Math.max(0, 100 - used),
      windowStart: '',
      resetAt: cleanQuotaTimestamp(progress.resets_at ?? progress.resetsAt ?? progress.reset_at ?? progress.resetAt),
      unit: '%',
    });
  }
  return limits;
}

export function normalizeSub2ApiRateLimitProbe(headers, bodyText = '', nowValue = Date.now()) {
  const getHeader = (name) => cleanText(headers?.get?.(name), 80);
  const body = parseMaybeJson(bodyText);
  const errorCode = cleanText(body?.error?.code || body?.code, 80).toUpperCase();
  const usedPercent = nonNegativeNumber(getHeader('x-codex-primary-used-percent'));
  const windowMinutes = nonNegativeInteger(getHeader('x-codex-primary-window-minutes'));
  const resetAtHeader = cleanQuotaTimestamp(getHeader('x-codex-primary-reset-at'));
  const resetAfterSeconds = nonNegativeInteger(getHeader('x-codex-primary-reset-after-seconds'));
  const retryAfterSeconds = nonNegativeInteger(getHeader('retry-after'));
  const isFiveHour = windowMinutes === 300 || errorCode === 'FIVE_HOUR_LIMIT_EXCEEDED';
  if (!isFiveHour) return [];

  const now = Number(nowValue);
  const relativeSeconds = resetAfterSeconds ?? retryAfterSeconds;
  const resetAt = resetAtHeader || (
    relativeSeconds !== null && Number.isFinite(now)
      ? new Date(now + relativeSeconds * 1000).toISOString()
      : ''
  );
  const used = usedPercent ?? (errorCode === 'FIVE_HOUR_LIMIT_EXCEEDED' ? 100 : null);
  return [{
    window: '5h',
    used,
    limit: 100,
    remaining: used === null ? null : Math.max(0, 100 - used),
    windowStart: resetAt ? new Date(Date.parse(resetAt) - 5 * 60 * 60 * 1000).toISOString() : '',
    resetAt,
    unit: '%',
  }];
}

function normalizeSub2ApiCodexAccountRateLimits(account) {
  const extra = isRecord(account.extra) ? account.extra : {};
  const limits = [];
  for (const [window, prefix, seconds] of [
    ['5h', 'codex_5h', 5 * 60 * 60],
    ['7d', 'codex_7d', 7 * 24 * 60 * 60],
  ]) {
    const used = nonNegativeNumber(extra[`${prefix}_used_percent`]);
    if (used === null) continue;
    const resetAt = cleanQuotaTimestamp(extra[`${prefix}_reset_at`])
      || resetAtFromRelativeSeconds(
        extra[`${prefix}_reset_after_seconds`],
        extra.codex_usage_updated_at ?? account.updated_at ?? account.updatedAt,
      );
    limits.push({
      window,
      used,
      limit: 100,
      remaining: Math.max(0, 100 - used),
      windowStart: resetAt ? new Date(Date.parse(resetAt) - seconds * 1000).toISOString() : '',
      resetAt,
      unit: '%',
    });
  }
  if (limits.length) return limits;

  const legacy = [];
  for (const [usedKey, resetKey, minutesKey] of [
    ['codex_primary_used_percent', 'codex_primary_reset_after_seconds', 'codex_primary_window_minutes'],
    ['codex_secondary_used_percent', 'codex_secondary_reset_after_seconds', 'codex_secondary_window_minutes'],
  ]) {
    const used = nonNegativeNumber(extra[usedKey]);
    const minutes = nonNegativeNumber(extra[minutesKey]);
    if (used === null || minutes === null) continue;
    const window = minutes >= 240 && minutes <= 360
      ? '5h'
      : minutes >= 9360 && minutes <= 10800
        ? '7d'
        : '';
    if (!window || legacy.some((item) => item.window === window)) continue;
    const resetAt = resetAtFromRelativeSeconds(
      extra[resetKey],
      extra.codex_usage_updated_at ?? account.updated_at ?? account.updatedAt,
    );
    legacy.push({
      window,
      used,
      limit: 100,
      remaining: Math.max(0, 100 - used),
      windowStart: resetAt ? new Date(Date.parse(resetAt) - minutes * 60 * 1000).toISOString() : '',
      resetAt,
      unit: '%',
    });
  }
  return legacy;
}

function resetAtFromRelativeSeconds(value, baseValue) {
  const seconds = nonNegativeNumber(value);
  if (seconds === null) return '';
  const base = cleanQuotaTimestamp(baseValue);
  const baseMilliseconds = base ? Date.parse(base) : NaN;
  if (!Number.isFinite(baseMilliseconds)) return '';
  return new Date(baseMilliseconds + seconds * 1000).toISOString();
}

function normalizeRateLimitWindow(value) {
  const window = cleanText(value, 24).toLowerCase().replace(/[\s_-]+/g, '');
  return ({
    '5h': '5h',
    '5hour': '5h',
    '5hours': '5h',
    fivehour: '5h',
    '1d': '1d',
    '1day': '1d',
    daily: '1d',
    '7d': '7d',
    '7day': '7d',
    weekly: '7d',
    '30d': '30d',
    '30day': '30d',
    monthly: '30d',
  })[window] || window;
}

function inferRateLimitUnit(rateLimits) {
  if (!rateLimits.length) return '';
  const units = new Set(rateLimits.map((item) => cleanText(item.unit, 16)).filter(Boolean));
  return units.size === 1 ? [...units][0] : '';
}

function cleanQuotaTimestamp(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const number = nonNegativeNumber(value);
    if (number === null) return '';
    const milliseconds = number >= 1e12 ? number : number * 1000;
    const parsed = new Date(milliseconds);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
  }
  return cleanDate(value);
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
