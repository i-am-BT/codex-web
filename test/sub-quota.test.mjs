import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectSubQuotaProvider,
  normalizeCpaCodexQuota,
  normalizeDeepSeekBalance,
  normalizeGrok2ApiSummary,
  normalizeSubQuota,
  normalizeSub2ApiCodexAccounts,
  normalizeSub2ApiRateLimitProbe,
  normalizeSubQuotaBaseUrl,
  parseSubQuotaSources,
  SubQuotaService,
} from '../sub-quota.mjs';
// CPA Codex + Sub2API quota adapters

function cpaAuthFile(id) {
  return {
    id,
    name: `${id}.json`,
    type: 'codex',
    email: `${id}@example.test`,
    auth_index: `auth-${id}`,
    account_id: `account-${id}`,
    disabled: false,
  };
}

function cpaUsageEnvelope(usedPercent) {
  return {
    status_code: 200,
    body: {
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: usedPercent, limit_window_seconds: 18000 },
      },
    },
  };
}

test('normalizes editable Sub2API URLs and rejects unsafe values', () => {
  assert.equal(normalizeSubQuotaBaseUrl(' https://sub.example.test/ '), 'https://sub.example.test');
  assert.equal(normalizeSubQuotaBaseUrl('https://sub.example.test/v1'), 'https://sub.example.test');
  assert.equal(normalizeSubQuotaBaseUrl('https://sub.example.test/v1/usage/'), 'https://sub.example.test');
  assert.equal(normalizeSubQuotaBaseUrl('https://sub.example.test/api/v1/usage?token=hidden#fragment'), 'https://sub.example.test/api');
  assert.throws(() => normalizeSubQuotaBaseUrl(''), /不能为空/);
  assert.throws(() => normalizeSubQuotaBaseUrl('file:///tmp/sub2api'), /http\/https/);
  assert.throws(() => normalizeSubQuotaBaseUrl('https://user:pass@sub.example.test'), /无凭据/);
  assert.throws(() => normalizeSubQuotaBaseUrl('https://sub.example.test/\ninvalid'), /无效字符/);
  assert.throws(() => normalizeSubQuotaBaseUrl(`https://sub.example.test/${'a'.repeat(2048)}`), /过长/);
});


test('normalizes editable CPA Management URLs and rejects unsafe values', () => {
  assert.equal(normalizeSubQuotaBaseUrl(' http://127.0.0.1:8327/ ', { provider: 'cpa-codex' }), 'http://127.0.0.1:8327');
  assert.equal(normalizeSubQuotaBaseUrl('http://127.0.0.1:8327/v0/management', { provider: 'cpa-codex' }), 'http://127.0.0.1:8327');
  assert.equal(normalizeSubQuotaBaseUrl('http://127.0.0.1:8327/v0/management/auth-files', { provider: 'cpa-codex' }), 'http://127.0.0.1:8327');
  assert.equal(normalizeSubQuotaBaseUrl('http://127.0.0.1:8327/v1/usage', { provider: 'cpa-codex' }), 'http://127.0.0.1:8327');
  assert.throws(() => normalizeSubQuotaBaseUrl('', { provider: 'cpa-codex' }), /不能为空/);
  assert.throws(() => normalizeSubQuotaBaseUrl('file:///tmp/cpa', { provider: 'cpa-codex' }), /http\/https/);
});

test('normalizes editable DeepSeek API URLs', () => {
  assert.equal(normalizeSubQuotaBaseUrl('https://api.deepseek.com/', { provider: 'deepseek' }), 'https://api.deepseek.com');
  assert.equal(normalizeSubQuotaBaseUrl('https://api.deepseek.com/v1', { provider: 'deepseek' }), 'https://api.deepseek.com');
  assert.equal(normalizeSubQuotaBaseUrl('https://api.deepseek.com/v1/usage/', { provider: 'deepseek' }), 'https://api.deepseek.com');
  assert.throws(() => normalizeSubQuotaBaseUrl('', { provider: 'deepseek' }), /不能为空/);
  assert.throws(() => normalizeSubQuotaBaseUrl('ftp://api.deepseek.com', { provider: 'deepseek' }), /http\/https/);
});

test('normalizes CPA Codex usage windows into percent rate limits', () => {
  const quota = normalizeCpaCodexQuota({
    plan_type: 'plus',
    email: 'plus@example.com',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 18,
        limit_window_seconds: 604800,
        reset_after_seconds: 100,
        reset_at: 1785141573,
      },
      secondary_window: null,
    },
    rate_limit_reset_credits: { available_count: 2 },
  }, { email: 'plus@example.com' });
  assert.equal(quota.planName, 'Plus');
  assert.equal(quota.unit, '%');
  assert.equal(quota.valid, true);
  assert.equal(quota.rateLimitResetCredits, 2);
  assert.equal(quota.rateLimits.length, 1);
  assert.equal(quota.rateLimits[0].window, '7d');
  assert.equal(quota.rateLimits[0].used, 18);
  assert.equal(quota.rateLimits[0].remaining, 82);
  assert.equal(quota.rateLimits[0].limit, 100);
  assert.equal(quota.rateLimits[0].resetAt, '2026-07-27T08:39:33.000Z');
});
test('parses server-side Sub quota sources without embedding credentials', () => {
  const sources = parseSubQuotaSources(JSON.stringify([{
    id: 'main-sub',
    name: 'Main Sub',
    baseUrl: 'https://sub.example.test/v1',
    apiKeyEnv: 'SUB_MAIN_API_KEY',
  }]), { SUB_MAIN_API_KEY: 'secret-key' });

  assert.deepEqual(sources, [{
    id: 'main-sub',
    name: 'Main Sub',
    provider: 'sub2api',
    apiKeyEnv: 'SUB_MAIN_API_KEY',
    apiKey: 'secret-key',
    baseUrl: 'https://sub.example.test',
    usageUrl: 'https://sub.example.test/v1/usage',
  }]);
  const fullUsageUrl = parseSubQuotaSources(JSON.stringify([{
    id: 'full-url',
    name: 'Full URL',
    baseUrl: 'https://sub.example.test/v1/usage',
    apiKeyEnv: 'SUB_MAIN_API_KEY',
  }]), { SUB_MAIN_API_KEY: 'secret-key' });
  assert.equal(fullUsageUrl[0].usageUrl, 'https://sub.example.test/v1/usage');
  const adminEnriched = parseSubQuotaSources(JSON.stringify([{
    id: 'admin-enriched',
    baseUrl: 'https://sub.example.test',
    apiKeyEnv: 'SUB_MAIN_API_KEY',
    adminApiKeyEnv: 'SUB_ADMIN_API_KEY',
  }]), {
    SUB_MAIN_API_KEY: 'usage-secret',
    SUB_ADMIN_API_KEY: 'admin-secret',
  });
  assert.equal(adminEnriched[0].adminApiKeyEnv, 'SUB_ADMIN_API_KEY');
  assert.equal(adminEnriched[0].adminApiKey, 'admin-secret');
  assert.throws(() => parseSubQuotaSources('[{"baseUrl":"file:///tmp/key"}]'), /apiKeyEnv/);
});

test('parses DeepSeek official quota sources with a default base URL', () => {
  const sources = parseSubQuotaSources(JSON.stringify([{
    id: 'deepseek',
    name: 'DeepSeek 官方',
    provider: 'deepseek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  }]), { DEEPSEEK_API_KEY: 'sk-deepseek' });

  assert.deepEqual(sources, [{
    id: 'deepseek',
    name: 'DeepSeek 官方',
    provider: 'deepseek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    apiKey: 'sk-deepseek',
    baseUrl: 'https://api.deepseek.com',
    usageUrl: '',
  }]);
});

test('normalizes DeepSeek balance responses', () => {
  const quota = normalizeDeepSeekBalance({
    is_available: true,
    balance_infos: [{
      currency: 'CNY',
      total_balance: '110.00',
      granted_balance: '10.00',
      topped_up_balance: '100.00',
    }],
  });
  assert.equal(quota.mode, 'deepseek');
  assert.equal(quota.planName, 'DeepSeek 官方');
  assert.equal(quota.balance, 110);
  assert.equal(quota.remaining, 110);
  assert.equal(quota.currency, 'CNY');
  assert.equal(quota.grantedBalance, 10);
  assert.equal(quota.toppedUpBalance, 100);
  assert.equal(quota.status, 'active');
  assert.equal(quota.valid, true);
  assert.deepEqual(quota.rateLimits, []);

  const unavailable = normalizeDeepSeekBalance({ is_available: false, balance_infos: [] });
  assert.equal(unavailable.valid, false);
  assert.equal(unavailable.status, 'no_access');
  assert.throws(() => normalizeDeepSeekBalance(null), /格式无效/);
});

test('fetches DeepSeek official balance without leaking credentials', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    assert.equal(options.headers.Authorization, 'Bearer sk-deepseek');
    return new Response(JSON.stringify({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: '88.50',
        granted_balance: '0.00',
        topped_up_balance: '88.50',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const service = new SubQuotaService({
    sources: [{
      id: 'deepseek',
      name: 'DeepSeek',
      provider: 'deepseek',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      apiKey: 'sk-deepseek',
      baseUrl: 'https://api.deepseek.com',
      usageUrl: '',
    }],
    fetchImpl,
    now: () => 1000000,
  });

  const listed = await service.list({ refresh: true });
  assert.equal(listed.count, 1);
  assert.equal(listed.quotas[0].provider, 'deepseek');
  assert.equal(listed.quotas[0].balance, 88.5);
  assert.equal(listed.quotas[0].currency, 'CNY');
  assert.equal(listed.quotas[0].mode, 'deepseek');
  assert.doesNotMatch(JSON.stringify(listed), /sk-deepseek/);
});

test('normalizes Sub2API subscription and quota-limited responses', () => {
  assert.deepEqual(normalizeSubQuota({
    isValid: true,
    mode: 'unrestricted',
    planName: 'GPT Plan',
    remaining: 70,
    unit: 'USD',
    subscription: {
      daily_limit_usd: 0,
      daily_usage_usd: 3,
      weekly_limit_usd: 100,
      weekly_usage_usd: 30,
      monthly_limit_usd: 400,
      monthly_usage_usd: 50,
      expires_at: '2026-08-01T00:00:00Z',
    },
    usage: { today: { requests: 4, total_tokens: 123, actual_cost: 3 } },
  }), {
    valid: true,
    mode: 'unrestricted',
    status: '',
    planName: 'GPT Plan',
    unit: 'USD',
    remaining: 70,
    balance: null,
    quota: null,
    subscription: {
      daily: { used: 3, limit: 0, remaining: null },
      weekly: { used: 30, limit: 100, remaining: 70 },
      monthly: { used: 50, limit: 400, remaining: 350 },
      expiresAt: '2026-08-01T00:00:00Z',
      weeklyWindowStart: '',
    },
    rateLimits: [],
    expiresAt: '',
    daysUntilExpiry: null,
    today: {
      requests: 4,
      inputTokens: null,
      outputTokens: null,
      totalTokens: 123,
      cost: null,
      actualCost: 3,
    },
    total: null,
  });

  const limited = normalizeSubQuota({
    mode: 'quota_limited',
    status: 'quota_exhausted',
    quota: { limit: 100, used: 25, remaining: 75, unit: 'USD' },
    api_key: { rate_limit_5h: 999, usage_5h: 999 },
    rate_limits: [
      {
        window: '5h',
        used: 10,
        limit: 50,
        remaining: 40,
        window_start: '2026-07-19T00:00:00Z',
        reset_at: '2026-07-19T05:00:00Z',
      },
      {
        window: '1d',
        used: '20',
        limit: '100',
        window_start: '2026-07-19T00:00:00Z',
        reset_at: '2026-07-20T00:00:00Z',
      },
      { window: '7d', used: 0, limit: 0, remaining: 0 },
      { window: '30d', used: 1, limit: 10, remaining: 9 },
    ],
    expires_at: '2026-08-02T00:00:00Z',
    days_until_expiry: 14,
  });
  assert.deepEqual(limited.quota, { limit: 100, used: 25, remaining: 75, unit: 'USD' });
  assert.deepEqual(limited.rateLimits, [
    {
      window: '5h',
      used: 10,
      limit: 50,
      remaining: 40,
      windowStart: '2026-07-19T00:00:00Z',
      resetAt: '2026-07-19T05:00:00Z',
    },
    {
      window: '1d',
      used: 20,
      limit: 100,
      remaining: 80,
      windowStart: '2026-07-19T00:00:00Z',
      resetAt: '2026-07-20T00:00:00Z',
    },
    {
      window: '7d',
      used: 0,
      limit: 0,
      remaining: 0,
      windowStart: '',
      resetAt: '',
    },
    {
      window: '30d',
      used: 1,
      limit: 10,
      remaining: 9,
      windowStart: '',
      resetAt: '',
    },
  ]);
  assert.equal(limited.expiresAt, '2026-08-02T00:00:00Z');
  assert.equal(limited.daysUntilExpiry, 14);
  assert.equal(limited.remaining, null);
  assert.equal(limited.status, 'quota_exhausted');
});

test('normalizes Sub2API API key DTO five-hour fields without replacing subscription windows', () => {
  const quota = normalizeSubQuota({
    mode: 'unrestricted',
    unit: 'USD',
    subscription: {
      weekly_usage_usd: 30,
      weekly_limit_usd: 100,
    },
    api_key: {
      rate_limit_5h: '50',
      usage_5h: '12.5',
      window_5h_start: '2026-07-30T00:00:00Z',
      reset_5h_at: 1785387600,
      rate_limit_1d: 0,
      usage_1d: 0,
    },
  });

  assert.deepEqual(quota.subscription.weekly, { used: 30, limit: 100, remaining: 70 });
  assert.deepEqual(quota.rateLimits, [{
    window: '5h',
    used: 12.5,
    limit: 50,
    remaining: 37.5,
    windowStart: '2026-07-30T00:00:00Z',
    resetAt: '2026-07-30T05:00:00.000Z',
    unit: 'USD',
  }]);
});

test('normalizes Sub2API subscription five-hour USD usage with an optional reset window', () => {
  const quota = normalizeSubQuota({
    mode: 'unrestricted',
    subscription: {
      usage_5h_usd: '18.72',
      limit_5h_usd: 60,
      window_5h_start: '2026-07-30T06:00:00Z',
      daily_usage_usd: 78.9,
      daily_limit_usd: 100,
    },
  });

  assert.deepEqual(quota.rateLimits, [{
    window: '5h',
    used: 18.72,
    limit: 60,
    remaining: 41.28,
    windowStart: '2026-07-30T06:00:00Z',
    resetAt: '2026-07-30T11:00:00.000Z',
    unit: 'USD',
    display: 'used',
  }]);
});

test('normalizes Sub2API five-hour utilization as percent and leaves absent windows absent', () => {
  const quota = normalizeSubQuota({
    mode: 'unrestricted',
    unit: 'USD',
    subscription: { monthly_usage_usd: 10, monthly_limit_usd: 200 },
    usage_info: {
      five_hour: {
        utilization: '72.5',
        resets_at: '2026-07-30T05:00:00Z',
      },
    },
  });
  assert.deepEqual(quota.rateLimits, [{
    window: '5h',
    used: 72.5,
    limit: 100,
    remaining: 27.5,
    windowStart: '',
    resetAt: '2026-07-30T05:00:00Z',
    unit: '%',
  }]);

  const absent = normalizeSubQuota({
    mode: 'unrestricted',
    api_key: { rate_limit_5h: 0, usage_5h: 0 },
  });
  assert.deepEqual(absent.rateLimits, []);
});

test('normalizes cached Sub2API Codex account five-hour percentages and reset timestamps', () => {
  const quotas = normalizeSub2ApiCodexAccounts({
    data: {
      items: [{
        id: 42,
        name: 'Codex Plus',
        status: 'active',
        extra: {
          plan_type: 'plus',
          codex_usage_updated_at: '2026-07-30T01:00:00Z',
          codex_5h_used_percent: '72.5',
          codex_5h_reset_after_seconds: 7200,
          codex_5h_window_minutes: 300,
          codex_7d_used_percent: 100,
          codex_7d_reset_at: '2026-08-02T03:00:00Z',
          codex_7d_window_minutes: 10080,
        },
      }],
    },
  });

  assert.equal(quotas.length, 1);
  assert.equal(quotas[0].accountId, '42');
  assert.equal(quotas[0].status, 'quota_exhausted');
  assert.equal(quotas[0].unit, '%');
  assert.deepEqual(quotas[0].rateLimits, [{
    window: '5h',
    used: 72.5,
    limit: 100,
    remaining: 27.5,
    windowStart: '2026-07-29T22:00:00.000Z',
    resetAt: '2026-07-30T03:00:00.000Z',
    unit: '%',
  }, {
    window: '7d',
    used: 100,
    limit: 100,
    remaining: 0,
    windowStart: '2026-07-26T03:00:00.000Z',
    resetAt: '2026-08-02T03:00:00Z',
    unit: '%',
  }]);
});

test('normalizes legacy Sub2API Codex windows by duration and ignores accounts without usage', () => {
  const quotas = normalizeSub2ApiCodexAccounts({
    items: [{
      id: 'legacy',
      email: 'legacy@example.test',
      updated_at: '2026-07-30T00:00:00Z',
      extra: {
        codex_primary_used_percent: 20,
        codex_primary_reset_after_seconds: 1800,
        codex_primary_window_minutes: 300,
        codex_secondary_used_percent: 45,
        codex_secondary_reset_after_seconds: 3600,
        codex_secondary_window_minutes: 10080,
      },
    }, {
      id: 'absent',
      name: 'No cached usage',
      extra: { plan_type: 'plus' },
    }],
  });

  assert.equal(quotas.length, 1);
  assert.equal(quotas[0].name, 'legacy@example.test');
  assert.deepEqual(quotas[0].rateLimits.map((item) => ({
    window: item.window,
    used: item.used,
    remaining: item.remaining,
    resetAt: item.resetAt,
  })), [{
    window: '5h',
    used: 20,
    remaining: 80,
    resetAt: '2026-07-30T00:30:00.000Z',
  }, {
    window: '7d',
    used: 45,
    remaining: 55,
    resetAt: '2026-07-30T01:00:00.000Z',
  }]);
});

test('normalizes wallet balances and rejects invalid negative quota values', () => {
  const wallet = normalizeSubQuota({
    mode: 'wallet',
    balance: '42.5',
    remaining: 0,
    days_until_expiry: '0',
    usage: {
      today: {
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cost: 0,
        actual_cost: 0,
      },
    },
  });
  assert.equal(wallet.balance, 42.5);
  assert.equal(wallet.remaining, 0);
  assert.equal(wallet.daysUntilExpiry, 0);
  assert.deepEqual(wallet.today, {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
    actualCost: 0,
  });

  const invalid = normalizeSubQuota({
    balance: -1,
    remaining: '-2',
    expires_at: 'not-a-date',
    days_until_expiry: -1,
    quota: { used: -1, limit: 0, remaining: -2 },
    subscription: {
      daily_usage_usd: -1,
      daily_limit_usd: 0,
      weekly_usage_usd: 0,
      weekly_limit_usd: -1,
      monthly_usage_usd: -1,
      monthly_limit_usd: -1,
    },
    rate_limits: [
      { window: '5H', used: -1, limit: 0, remaining: -1, reset_at: 'invalid' },
      { window: '5h', used: 1, limit: 2, remaining: 1 },
      { window: '1d', used: 5, limit: -1, remaining: -1 },
      { window: '7d', used: 'invalid', limit: '', remaining: null },
      { window: '30d', used: 1, limit: 2, remaining: 1 },
      null,
    ],
  });
  assert.equal(invalid.balance, null);
  assert.equal(invalid.remaining, null);
  assert.equal(invalid.expiresAt, '');
  assert.equal(invalid.daysUntilExpiry, null);
  assert.deepEqual(invalid.quota, { used: null, limit: 0, remaining: 0, unit: '' });
  assert.deepEqual(invalid.subscription, {
    daily: { used: null, limit: 0, remaining: null },
    weekly: { used: 0, limit: null, remaining: null },
    monthly: null,
    expiresAt: '',
    weeklyWindowStart: '',
  });
  assert.deepEqual(invalid.rateLimits, [
    {
      window: '5h',
      used: null,
      limit: 0,
      remaining: 0,
      windowStart: '',
      resetAt: '',
    },
    {
      window: '1d',
      used: 5,
      limit: null,
      remaining: null,
      windowStart: '',
      resetAt: '',
    },
    {
      window: '7d',
      used: null,
      limit: null,
      remaining: null,
      windowStart: '',
      resetAt: '',
    },
    {
      window: '30d',
      used: 1,
      limit: 2,
      remaining: 1,
      windowStart: '',
      resetAt: '',
    },
  ]);
});

test('fetches all sources, isolates errors, and caches the result', async () => {
  let requests = 0;
  const service = new SubQuotaService({
    sources: [
      { id: 'ready', name: 'Ready', apiKeyEnv: 'READY_KEY', apiKey: 'key', usageUrl: 'https://ready.test/v1/usage' },
      { id: 'missing', name: 'Missing', apiKeyEnv: 'MISSING_KEY', apiKey: '', usageUrl: 'https://missing.test/v1/usage' },
    ],
    now: () => Date.parse('2026-07-19T00:00:00Z'),
    fetchImpl: async (_url, options) => {
      requests += 1;
      assert.equal(options.headers.Authorization, 'Bearer key');
      return new Response(JSON.stringify({
        isValid: true,
        remaining: 12,
        unit: 'USD',
        apiKey: {
          rateLimit5h: 20,
          usage5h: 5,
          reset5hAt: '2026-07-19T05:00:00Z',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const first = await service.list();
  const second = await service.list();
  assert.equal(first, second);
  assert.equal(requests, 1);
  assert.equal(first.availableCount, 1);
  assert.equal(first.quotas[0].remaining, 12);
  assert.deepEqual(first.quotas[0].rateLimits, [{
    window: '5h',
    used: 5,
    limit: 20,
    remaining: 15,
    windowStart: '',
    resetAt: '2026-07-19T05:00:00Z',
    unit: 'USD',
  }]);
  assert.match(first.quotas[1].error, /MISSING_KEY/);
});

test('enriches Sub2API usage without skipping the five-hour probe', async () => {
  const calls = [];
  const service = new SubQuotaService({
    sources: [{
      id: 'sub',
      name: 'Sub2API',
      provider: 'sub2api',
      baseUrl: 'https://sub.test',
      usageUrl: 'https://sub.test/v1/usage',
      apiKeyEnv: 'SUB2API_API_KEY',
      apiKey: 'usage-secret',
      adminApiKeyEnv: 'SUB2API_ADMIN_API_KEY',
      adminApiKey: 'admin-secret',
    }],
    now: () => Date.parse('2026-07-30T01:00:00Z'),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), headers: init.headers });
      if (String(url).endsWith('/v1/usage')) {
        return new Response(JSON.stringify({
          mode: 'unrestricted',
          subscription: { weekly_usage_usd: 10, weekly_limit_usd: 100 },
        }), { status: 200 });
      }
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          error: { code: 'FIVE_HOUR_LIMIT_EXCEEDED' },
        }), {
          status: 429,
          headers: {
            'x-codex-primary-used-percent': '100',
            'x-codex-primary-window-minutes': '300',
            'x-codex-primary-reset-at': '1785390371',
          },
        });
      }
      return new Response(JSON.stringify({
        data: {
          items: [{
            id: 7,
            name: 'Provider Codex',
            extra: {
              codex_usage_updated_at: '2026-07-30T01:00:00Z',
              codex_5h_used_percent: 80,
              codex_5h_reset_after_seconds: 3600,
            },
          }],
        },
      }), { status: 200 });
    },
  });

  const result = await service.list();
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://sub.test/v1/usage');
  assert.equal(calls[0].headers.Authorization, 'Bearer usage-secret');
  assert.equal(calls[0].headers['x-api-key'], undefined);
  assert.equal(calls[1].url, 'https://sub.test/v1/models');
  assert.equal(calls[1].headers.Authorization, 'Bearer usage-secret');
  assert.equal(calls[2].url, 'https://sub.test/api/v1/admin/accounts?platform=openai&type=oauth&page=1&page_size=1000');
  assert.equal(calls[2].headers['x-api-key'], 'admin-secret');
  assert.equal(calls[2].headers.Authorization, undefined);
  assert.equal(result.availableCount, 2);
  assert.deepEqual(result.quotas[0].subscription.weekly, { used: 10, limit: 100, remaining: 90 });
  assert.equal(result.quotas[0].rateLimits[0].window, '5h');
  assert.equal(result.quotas[0].rateLimits[0].remaining, 0);
  assert.equal(result.quotas[1].rateLimits[0].window, '5h');
  assert.equal(result.quotas[1].rateLimits[0].remaining, 20);
  assert.equal(JSON.stringify(result).includes('usage-secret'), false);
  assert.equal(JSON.stringify(result).includes('admin-secret'), false);
});

test('probes Sub2API five-hour limits without requesting admin accounts', async () => {
  let requests = 0;
  const service = new SubQuotaService({
    sources: [{
      id: 'sub',
      name: 'Sub2API',
      provider: 'sub2api',
      baseUrl: 'https://sub.test',
      usageUrl: 'https://sub.test/v1/usage',
      apiKeyEnv: 'SUB2API_API_KEY',
      apiKey: 'usage-secret',
    }],
    now: () => Date.parse('2026-07-30T04:00:00Z'),
    fetchImpl: async (url, init) => {
      requests += 1;
      assert.equal(init.headers.Authorization, 'Bearer usage-secret');
      if (String(url).endsWith('/v1/usage')) {
        return new Response(JSON.stringify({ mode: 'unrestricted', remaining: 9 }), { status: 200 });
      }
      assert.equal(String(url), 'https://sub.test/v1/models');
      return new Response(JSON.stringify({
        error: { type: 'usage_limit_reached', code: 'FIVE_HOUR_LIMIT_EXCEEDED' },
      }), {
        status: 429,
        headers: {
          'retry-after': '3600',
          'x-codex-primary-used-percent': '100',
          'x-codex-primary-window-minutes': '300',
        },
      });
    },
  });

  const result = await service.list();
  assert.equal(requests, 2);
  assert.equal(result.count, 1);
  assert.equal(result.quotas[0].remaining, 9);
  assert.equal(result.quotas[0].status, 'quota_exhausted');
  assert.deepEqual(result.quotas[0].rateLimits, [{
    window: '5h',
    used: 100,
    limit: 100,
    remaining: 0,
    windowStart: '2026-07-30T00:00:00.000Z',
    resetAt: '2026-07-30T05:00:00.000Z',
    unit: '%',
  }]);
});

test('normalizes live Sub2API five-hour probe headers and ignores unrelated responses', () => {
  const liveHeaders = new Headers({
    'retry-after': '4575',
    'x-codex-primary-reset-at': '1785390371',
    'x-codex-primary-used-percent': '100',
    'x-codex-primary-window-minutes': '300',
  });
  assert.deepEqual(normalizeSub2ApiRateLimitProbe(
    liveHeaders,
    JSON.stringify({ error: { code: 'FIVE_HOUR_LIMIT_EXCEEDED' } }),
    Date.parse('2026-07-30T04:00:00Z'),
  ), [{
    window: '5h',
    used: 100,
    limit: 100,
    remaining: 0,
    windowStart: '2026-07-30T00:46:11.000Z',
    resetAt: '2026-07-30T05:46:11.000Z',
    unit: '%',
  }]);
  assert.deepEqual(normalizeSub2ApiRateLimitProbe(new Headers(), '{"object":"list"}'), []);
});

test('does not invent a Sub2API five-hour window when the successful probe omits usage data', async () => {
  const service = new SubQuotaService({
    sources: [{
      id: 'sub',
      name: 'Sub2API',
      provider: 'sub2api',
      baseUrl: 'https://sub.test',
      usageUrl: 'https://sub.test/v1/usage',
      apiKeyEnv: 'SUB2API_API_KEY',
      apiKey: 'usage-secret',
    }],
    fetchImpl: async (url) => String(url).endsWith('/v1/usage')
      ? new Response(JSON.stringify({ mode: 'unrestricted', remaining: 9 }), { status: 200 })
      : new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 }),
  });

  const result = await service.list();
  assert.deepEqual(result.quotas[0].rateLimits, []);
});

test('keeps Sub2API subscription and last-known-good accounts on transient admin failure', async () => {
  let round = 1;
  const service = new SubQuotaService({
    sources: [{
      id: 'sub',
      name: 'Sub2API',
      provider: 'sub2api',
      baseUrl: 'https://sub.test',
      usageUrl: 'https://sub.test/v1/usage',
      apiKeyEnv: 'SUB2API_API_KEY',
      apiKey: 'usage-secret',
      adminApiKeyEnv: 'SUB2API_ADMIN_API_KEY',
      adminApiKey: 'admin-secret',
    }],
    fetchImpl: async (url) => {
      if (String(url).endsWith('/v1/usage')) {
        return new Response(JSON.stringify({ mode: 'unrestricted', remaining: round === 1 ? 30 : 25 }), { status: 200 });
      }
      if (round === 2) throw new DOMException('aborted', 'AbortError');
      return new Response(JSON.stringify({ items: [{
        id: 'codex',
        extra: { codex_5h_used_percent: 10, codex_5h_reset_at: '2026-07-30T05:00:00Z' },
      }] }), { status: 200 });
    },
  });

  const ready = await service.list();
  round = 2;
  const degraded = await service.list({ refresh: true });
  assert.equal(degraded.quotas.find((item) => item.id === 'sub').remaining, 25);
  const staleAccount = degraded.quotas.find((item) => item.id === 'sub-codex-codex');
  assert.equal(staleAccount.rateLimits[0].remaining, 90);
  assert.equal(staleAccount.stale, true);
  assert.equal(staleAccount.warning, '请求超时');
  assert.equal(staleAccount.fetchedAt, ready.quotas.find((item) => item.id === 'sub-codex-codex').fetchedAt);
});

test('uses recent source success after a timeout and replaces it after recovery', async () => {
  let now = Date.parse('2026-07-19T00:00:00Z');
  let mode = 'ready';
  let requests = 0;
  const service = new SubQuotaService({
    sources: [{ id: 'sub', name: 'Sub', apiKeyEnv: 'SUB_KEY', apiKey: 'key', usageUrl: 'https://sub.test/v1/usage' }],
    now: () => now,
    fetchImpl: async () => {
      requests += 1;
      if (mode === 'timeout') throw new DOMException('aborted', 'AbortError');
      const remaining = mode === 'recovered' ? 34 : 12;
      return new Response(JSON.stringify({ isValid: true, remaining, unit: 'USD' }), { status: 200 });
    },
  });

  const ready = await service.list();
  const originalFetchedAt = ready.quotas[0].fetchedAt;
  mode = 'timeout';
  now += 1000;
  const stale = await service.list({ refresh: true });
  assert.equal(stale.availableCount, 1);
  assert.equal(stale.quotas[0].remaining, 12);
  assert.equal(stale.quotas[0].fetchedAt, originalFetchedAt);
  assert.equal(stale.quotas[0].stale, true);
  assert.equal(stale.quotas[0].warning, '请求超时');
  assert.equal(stale.quotas[0].error, undefined);

  mode = 'recovered';
  now += 1000;
  const recovered = await service.list({ refresh: true });
  assert.equal(recovered.quotas[0].remaining, 34);
  assert.notEqual(recovered.quotas[0].fetchedAt, originalFetchedAt);
  assert.equal(recovered.quotas[0].stale, undefined);
  assert.equal(recovered.quotas[0].warning, undefined);
  assert.equal(requests, 3);
});

test('returns an initial timeout error and retries an error cache after five seconds', async () => {
  let now = Date.parse('2026-07-19T00:00:00Z');
  let healthy = false;
  let requests = 0;
  const service = new SubQuotaService({
    sources: [{ id: 'sub', name: 'Sub', apiKeyEnv: 'SUB_KEY', apiKey: 'key', usageUrl: 'https://sub.test/v1/usage' }],
    cacheTtlMs: 30000,
    now: () => now,
    fetchImpl: async () => {
      requests += 1;
      if (!healthy) throw new DOMException('aborted', 'AbortError');
      return new Response(JSON.stringify({ isValid: true, remaining: 21, unit: 'USD' }), { status: 200 });
    },
  });

  const failed = await service.list();
  assert.equal(failed.availableCount, 0);
  assert.equal(failed.quotas[0].error, '请求超时');
  assert.equal(failed.quotas[0].stale, undefined);

  now += 4999;
  assert.equal(await service.list(), failed);
  assert.equal(requests, 1);

  healthy = true;
  now += 1;
  const recovered = await service.list();
  assert.equal(recovered.availableCount, 1);
  assert.equal(recovered.quotas[0].remaining, 21);
  assert.equal(requests, 2);
});

test('keeps last-known-good fallback for at most five minutes', async () => {
  let now = Date.parse('2026-07-19T00:00:00Z');
  let timeout = false;
  const service = new SubQuotaService({
    sources: [{ id: 'sub', name: 'Sub', apiKeyEnv: 'SUB_KEY', apiKey: 'key', usageUrl: 'https://sub.test/v1/usage' }],
    now: () => now,
    fetchImpl: async () => {
      if (timeout) throw new DOMException('aborted', 'AbortError');
      return new Response(JSON.stringify({ isValid: true, remaining: 8, unit: 'USD' }), { status: 200 });
    },
  });

  const ready = await service.list();
  timeout = true;
  now += 5 * 60 * 1000;
  const boundary = await service.list({ refresh: true });
  assert.equal(boundary.quotas[0].remaining, 8);
  assert.equal(boundary.quotas[0].fetchedAt, ready.quotas[0].fetchedAt);
  assert.equal(boundary.quotas[0].stale, true);

  now += 1;
  const expired = await service.list({ refresh: true });
  assert.equal(expired.availableCount, 0);
  assert.equal(expired.quotas[0].error, '请求超时');
  assert.equal(expired.quotas[0].stale, undefined);
});

test('isolates last-known-good results by source during transient failures', async () => {
  let now = Date.parse('2026-07-19T00:00:00Z');
  let round = 1;
  const service = new SubQuotaService({
    sources: [
      { id: 'alpha', name: 'Alpha', apiKeyEnv: 'ALPHA_KEY', apiKey: 'alpha-key', usageUrl: 'https://alpha.test/v1/usage' },
      { id: 'beta', name: 'Beta', apiKeyEnv: 'BETA_KEY', apiKey: 'beta-key', usageUrl: 'https://beta.test/v1/usage' },
    ],
    now: () => now,
    fetchImpl: async (url) => {
      if (round === 2 && String(url).includes('alpha.test')) throw new TypeError('fetch failed');
      const remaining = String(url).includes('alpha.test') ? 10 : (round === 1 ? 20 : 30);
      return new Response(JSON.stringify({ isValid: true, remaining, unit: 'USD' }), { status: 200 });
    },
  });

  const first = await service.list();
  const firstAlpha = first.quotas.find((item) => item.id === 'alpha');
  round = 2;
  now += 1000;
  const second = await service.list({ refresh: true });
  const alpha = second.quotas.find((item) => item.id === 'alpha');
  const beta = second.quotas.find((item) => item.id === 'beta');
  assert.equal(alpha.remaining, 10);
  assert.equal(alpha.fetchedAt, firstAlpha.fetchedAt);
  assert.equal(alpha.stale, true);
  assert.equal(alpha.warning, 'fetch failed');
  assert.equal(beta.remaining, 30);
  assert.notEqual(beta.fetchedAt, firstAlpha.fetchedAt);
  assert.equal(beta.stale, undefined);
});

test('returns expired usable cache immediately while refreshing once in the background', async () => {
  let now = Date.parse('2026-07-19T00:00:00Z');
  let requests = 0;
  let resolveRefresh;
  const pendingResponse = new Promise((resolve) => { resolveRefresh = resolve; });
  const service = new SubQuotaService({
    sources: [{ id: 'sub', name: 'Sub', apiKeyEnv: 'SUB_KEY', apiKey: 'key', usageUrl: 'https://sub.test/v1/usage' }],
    cacheTtlMs: 1000,
    now: () => now,
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) {
        return new Response(JSON.stringify({ isValid: true, remaining: 40, unit: 'USD' }), { status: 200 });
      }
      return pendingResponse;
    },
  });

  const first = await service.list();
  now += 1001;
  let immediateTimer;
  const immediate = await Promise.race([
    service.list(),
    new Promise((_, reject) => {
      immediateTimer = setTimeout(() => reject(new Error('expired cache did not return immediately')), 50);
    }),
  ]).finally(() => clearTimeout(immediateTimer));
  assert.equal(immediate, first);
  assert.equal(await service.list(), first);
  assert.equal(requests, 2);

  const refresh = service.list({ refresh: true });
  assert.equal(requests, 2);
  resolveRefresh(new Response(JSON.stringify({ isValid: true, remaining: 55, unit: 'USD' }), { status: 200 }));
  const updated = await refresh;
  assert.equal(updated.quotas[0].remaining, 55);
  assert.equal(requests, 2);
  assert.equal((await service.list()).quotas[0].remaining, 55);
});

test('clears source last-known-good after an unauthorized response', async () => {
  let mode = 'ready';
  const service = new SubQuotaService({
    sources: [{ id: 'sub', name: 'Sub', apiKeyEnv: 'SUB_KEY', apiKey: 'key', usageUrl: 'https://sub.test/v1/usage' }],
    fetchImpl: async () => {
      if (mode === 'unauthorized') return new Response('{}', { status: 401 });
      if (mode === 'timeout') throw new DOMException('aborted', 'AbortError');
      return new Response(JSON.stringify({ isValid: true, remaining: 18, unit: 'USD' }), { status: 200 });
    },
  });

  await service.list();
  mode = 'unauthorized';
  const unauthorized = await service.list({ refresh: true });
  assert.equal(unauthorized.availableCount, 0);
  assert.equal(unauthorized.quotas[0].error, 'HTTP 401');

  mode = 'timeout';
  const timeout = await service.list({ refresh: true });
  assert.equal(timeout.availableCount, 0);
  assert.equal(timeout.quotas[0].error, '请求超时');
  assert.equal(timeout.quotas[0].stale, undefined);
});

test('treats invalid quota as unavailable, short-lived, and ineligible for fallback', async () => {
  let now = Date.parse('2026-07-19T00:00:00Z');
  let mode = 'ready';
  let requests = 0;
  const service = new SubQuotaService({
    sources: [{ id: 'sub', name: 'Sub', apiKeyEnv: 'SUB_KEY', apiKey: 'key', usageUrl: 'https://sub.test/v1/usage' }],
    cacheTtlMs: 30000,
    now: () => now,
    fetchImpl: async () => {
      requests += 1;
      if (mode === 'timeout') throw new DOMException('aborted', 'AbortError');
      return new Response(JSON.stringify({ isValid: mode !== 'invalid', remaining: 18, unit: 'USD' }), { status: 200 });
    },
  });

  await service.list();
  mode = 'invalid';
  now += 1000;
  const invalid = await service.list({ refresh: true });
  assert.equal(invalid.availableCount, 0);
  assert.equal(invalid.quotas[0].valid, false);
  assert.equal(requests, 2);

  now += 4999;
  assert.equal(await service.list(), invalid);
  assert.equal(requests, 2);

  mode = 'timeout';
  now += 1;
  const timeout = await service.list();
  assert.equal(timeout.availableCount, 0);
  assert.equal(timeout.quotas[0].error, '请求超时');
  assert.equal(timeout.quotas[0].stale, undefined);
  assert.equal(requests, 3);
});

test('falls back for a transient CPA api-call status code', async () => {
  let round = 1;
  const file = cpaAuthFile('alpha');
  const service = new SubQuotaService({
    sources: [{ id: 'cpa', name: 'CPA', provider: 'cpa-codex', baseUrl: 'https://cpa.test', apiKey: 'key' }],
    fetchImpl: async (url) => {
      if (String(url).endsWith('/auth-files')) {
        return new Response(JSON.stringify({ files: [file] }), { status: 200 });
      }
      if (round === 2) {
        return new Response(JSON.stringify({ status_code: 503, body: { error: 'upstream busy' } }), { status: 200 });
      }
      return new Response(JSON.stringify(cpaUsageEnvelope(20)), { status: 200 });
    },
  });

  const ready = await service.list();
  round = 2;
  const stale = await service.list({ refresh: true });
  assert.equal(stale.availableCount, 1);
  assert.equal(stale.quotas[0].id, 'alpha');
  assert.equal(stale.quotas[0].rateLimits[0].remaining, 80);
  assert.equal(stale.quotas[0].fetchedAt, ready.quotas[0].fetchedAt);
  assert.equal(stale.quotas[0].stale, true);
  assert.equal(stale.quotas[0].warning, 'HTTP 503: upstream busy');
});

test('does not revive CPA quota for an unauthorized status containing network wording', async () => {
  let round = 1;
  const file = cpaAuthFile('alpha');
  const service = new SubQuotaService({
    sources: [{ id: 'cpa', name: 'CPA', provider: 'cpa-codex', baseUrl: 'https://cpa.test', apiKey: 'key' }],
    fetchImpl: async (url) => {
      if (String(url).endsWith('/auth-files')) {
        return new Response(JSON.stringify({ files: [file] }), { status: 200 });
      }
      if (round === 2) {
        return new Response(JSON.stringify({
          status_code: 401,
          body: { error: 'upstream connection timed out' },
        }), { status: 200 });
      }
      return new Response(JSON.stringify(cpaUsageEnvelope(20)), { status: 200 });
    },
  });

  await service.list();
  round = 2;
  const unauthorized = await service.list({ refresh: true });
  assert.equal(unauthorized.availableCount, 0);
  assert.equal(unauthorized.quotas[0].error, 'HTTP 401: upstream connection timed out');
  assert.equal(unauthorized.quotas[0].stale, undefined);
});

test('merges fresh and stale CPA accounts by stable account id', async () => {
  let now = Date.parse('2026-07-19T00:00:00Z');
  let round = 1;
  const files = [cpaAuthFile('alpha'), cpaAuthFile('beta')];
  const service = new SubQuotaService({
    sources: [{ id: 'cpa', name: 'CPA', provider: 'cpa-codex', baseUrl: 'https://cpa.test', apiKey: 'key' }],
    now: () => now,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/auth-files')) {
        return new Response(JSON.stringify({ files }), { status: 200 });
      }
      const authIndex = JSON.parse(init.body).auth_index;
      if (round === 2 && authIndex === 'auth-beta') throw new DOMException('aborted', 'AbortError');
      const usedPercent = authIndex === 'auth-alpha' ? (round === 1 ? 10 : 30) : 20;
      return new Response(JSON.stringify(cpaUsageEnvelope(usedPercent)), { status: 200 });
    },
  });

  const first = await service.list();
  const firstBeta = first.quotas.find((item) => item.id === 'beta');
  round = 2;
  now += 1000;
  const second = await service.list({ refresh: true });
  const alpha = second.quotas.find((item) => item.id === 'alpha');
  const beta = second.quotas.find((item) => item.id === 'beta');
  assert.equal(alpha.rateLimits[0].remaining, 70);
  assert.equal(alpha.stale, undefined);
  assert.equal(beta.rateLimits[0].remaining, 80);
  assert.equal(beta.fetchedAt, firstBeta.fetchedAt);
  assert.equal(beta.stale, true);
  assert.equal(beta.warning, '请求超时');
});

test('uses all recent CPA accounts after a source-wide transient failure', async () => {
  let round = 1;
  const files = [cpaAuthFile('alpha'), cpaAuthFile('beta')];
  const service = new SubQuotaService({
    sources: [{ id: 'cpa', name: 'CPA', provider: 'cpa-codex', baseUrl: 'https://cpa.test', apiKey: 'key' }],
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/auth-files')) {
        if (round === 2) throw new DOMException('aborted', 'AbortError');
        return new Response(JSON.stringify({ files }), { status: 200 });
      }
      const authIndex = JSON.parse(init.body).auth_index;
      return new Response(JSON.stringify(cpaUsageEnvelope(authIndex === 'auth-alpha' ? 10 : 20)), { status: 200 });
    },
  });

  await service.list();
  round = 2;
  const stale = await service.list({ refresh: true });
  assert.deepEqual(stale.quotas.map((item) => item.id), ['alpha', 'beta']);
  assert.ok(stale.quotas.every((item) => item.stale === true && item.warning === '请求超时'));
  assert.equal(stale.availableCount, 2);
});

test('removes disappeared CPA accounts from source-wide fallback state', async () => {
  let round = 1;
  const alpha = cpaAuthFile('alpha');
  const beta = cpaAuthFile('beta');
  const service = new SubQuotaService({
    sources: [{ id: 'cpa', name: 'CPA', provider: 'cpa-codex', baseUrl: 'https://cpa.test', apiKey: 'key' }],
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/auth-files')) {
        if (round === 3) throw new DOMException('aborted', 'AbortError');
        return new Response(JSON.stringify({ files: round === 1 ? [alpha, beta] : [alpha] }), { status: 200 });
      }
      const authIndex = JSON.parse(init.body).auth_index;
      return new Response(JSON.stringify(cpaUsageEnvelope(authIndex === 'auth-alpha' ? 10 : 20)), { status: 200 });
    },
  });

  await service.list();
  round = 2;
  const reduced = await service.list({ refresh: true });
  assert.deepEqual(reduced.quotas.map((item) => item.id), ['alpha']);

  round = 3;
  const stale = await service.list({ refresh: true });
  assert.deepEqual(stale.quotas.map((item) => item.id), ['alpha']);
  assert.equal(stale.quotas[0].stale, true);
});

test('cancels an oversized upstream response stream', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const service = new SubQuotaService({
    sources: [{ id: 'large', name: 'Large', apiKeyEnv: 'LARGE_KEY', apiKey: 'key', usageUrl: 'https://large.test/v1/usage' }],
    fetchImpl: async () => new Response(body, { status: 200 }),
  });

  const result = await service.list();
  assert.match(result.quotas[0].error, /响应内容过大/);
  assert.equal(cancelled, true);
});

test('reports optional configuration errors without breaking service startup', async () => {
  const service = SubQuotaService.fromEnvironment({ SUB_QUOTA_SOURCES: '{broken' });
  const result = await service.list();
  assert.equal(result.configured, false);
  assert.equal(result.count, 0);
  assert.match(result.configurationError, /JSON/);
});

test('detects CPA Management before Sub2API on shared host', async () => {
  const calls = [];
  const detected = await detectSubQuotaProvider('http://127.0.0.1:8327/', 'mg-key', {
    timeoutMs: 1000,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers || {} });
      if (String(url).endsWith('/v0/management/auth-files')) {
        return new Response(JSON.stringify({ files: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  assert.equal(detected.provider, 'cpa-codex');
  assert.equal(detected.baseUrl, 'http://127.0.0.1:8327');
  assert.equal(detected.label, 'CPA Codex');
  assert.ok(calls.some((item) => item.url.endsWith('/v0/management/auth-files')));
  const headers = calls[0].headers;
  assert.equal(headers['X-Management-Key'] || headers['x-management-key'], 'mg-key');
});

test('detects Sub2API when only /v1/usage is available', async () => {
  const detected = await detectSubQuotaProvider('https://sub.example.test/v1/usage', 'sub-key', {
    timeoutMs: 1000,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/v0/management/auth-files')) {
        return new Response('missing', { status: 404 });
      }
      if (String(url).endsWith('/v1/usage')) {
        assert.match(init?.headers?.Authorization || '', /Bearer sub-key/);
        return new Response(JSON.stringify({
          plan_name: 'Pro',
          total: { used: 10, limit: 100, remaining: 90, unit: 'USD' },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('nope', { status: 500 });
    },
  });
  assert.equal(detected.provider, 'sub2api');
  assert.equal(detected.baseUrl, 'https://sub.example.test');
  assert.equal(detected.label, 'Sub2API');
});

test('rejects unknown upstream when neither provider responds', async () => {
  await assert.rejects(
    () => detectSubQuotaProvider('https://unknown.example.test', 'key', {
      timeoutMs: 200,
      fetchImpl: async () => new Response('no', { status: 404 }),
    }),
    /无法识别上游服务/,
  );
});

test('normalizes Grok2API account summary into callable and abnormal stats', () => {
  const quota = normalizeGrok2ApiSummary({
    total: 10,
    available: 7,
    recovering: 2,
    attention: 1,
    risk: 0,
    issues: { disabled: 1, reauthRequired: 0 },
    recovery: { cooldown: 0, waitingReset: 2, probing: 0 },
    providers: {
      grok_web: { total: 6, available: 5 },
      grok_build: { total: 4, available: 2 },
    },
  });
  assert.equal(quota.mode, 'grok2api_accounts');
  assert.equal(quota.unit, 'accounts');
  assert.equal(quota.supportsReset, true);
  assert.equal(quota.planName, 'Grok2API Build');
  assert.equal(quota.accountStats.pool, 'grok_build');
  assert.equal(quota.accountStats.total, 4);
  assert.equal(quota.accountStats.available, 2);
  assert.equal(quota.accountStats.abnormal, 2);
  assert.equal(quota.accountStats.providers.grok_web.available, 5);
  assert.equal(quota.quota.remaining, 2);
});

test('fetches Grok2API summary with admin login and can reset quotas', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body || null, headers: options.headers || {} });
    if (String(url).endsWith('/api/admin/v1/auth/login')) {
      return new Response(JSON.stringify({
        data: {
          tokens: {
            accessToken: 'grok-token',
            accessTokenExpiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/api/admin/v1/accounts/summary')) {
      assert.equal(options.headers.Authorization, 'Bearer grok-token');
      return new Response(JSON.stringify({
        data: {
          total: 4,
          available: 3,
          recovering: 1,
          attention: 0,
          risk: 0,
          issues: { disabled: 0, reauthRequired: 0 },
          recovery: { cooldown: 0, waitingReset: 1, probing: 0 },
          providers: {
            grok_web: { total: 4, available: 3 },
            grok_build: { total: 5, available: 4 },
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).endsWith('/api/admin/v1/accounts/reset-quota')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer grok-token');
      return new Response(JSON.stringify({ data: { reset: 4 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const service = new SubQuotaService({
    sources: [{
      id: 'grok2api',
      name: 'Grok2API',
      provider: 'grok2api',
      apiKeyEnv: 'GROK2API_ADMIN_PASSWORD',
      apiKey: 'admin:secret',
      baseUrl: 'http://grok.example',
      usageUrl: '',
    }],
    fetchImpl,
    now: () => 1000000,
  });

  const listed = await service.list({ refresh: true });
  assert.equal(listed.count, 1);
  assert.equal(listed.quotas[0].provider, 'grok2api');
  assert.equal(listed.quotas[0].accountStats.pool, 'grok_build');
  assert.equal(listed.quotas[0].accountStats.available, 4);
  assert.equal(listed.quotas[0].accountStats.abnormal, 1);
  assert.equal(listed.quotas[0].accountStats.total, 5);
  assert.doesNotMatch(JSON.stringify(listed), /secret|grok-token/);

  const reset = await service.resetGrok2ApiQuota(service.sources[0]);
  assert.equal(reset.ok, true);
  assert.equal(reset.reset, 4);
  assert.ok(calls.some((item) => item.url.endsWith('/api/admin/v1/accounts/reset-quota')));
});

test('normalizes Grok2API admin URLs', () => {
  assert.equal(
    normalizeSubQuotaBaseUrl('http://127.0.0.1:8100/api/admin/v1/accounts', { provider: 'grok2api' }),
    'http://127.0.0.1:8100',
  );
});
