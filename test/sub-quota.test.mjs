import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectSubQuotaProvider,
  normalizeCpaCodexQuota,
  normalizeSubQuota,
  normalizeSubQuotaBaseUrl,
  parseSubQuotaSources,
  SubQuotaService,
} from '../sub-quota.mjs';
// CPA Codex + Sub2API quota adapters

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

test('keeps valid free accounts and normalizes daily and relative resets safely', () => {
  const now = Date.parse('2026-07-29T00:00:00Z');
  const quota = normalizeCpaCodexQuota({
    plan_type: 'free',
    account_id: 'private-account-id',
    rate_limit: {
      allowed: true,
      primary_window: {
        used_percent: 40,
        limit_window_seconds: 86400,
        reset_after_seconds: 3600,
      },
    },
    rate_limit_reset_credits: {
      available_count: 4,
      applicable_available_count: 1,
    },
  }, { account_type: 'oauth' }, now);
  assert.equal(quota.planName, 'Free');
  assert.equal(quota.valid, true);
  assert.equal(quota.status, 'active');
  assert.equal(quota.rateLimitResetCredits, 1);
  assert.equal(quota.rateLimits[0].window, '1d');
  assert.equal(quota.rateLimits[0].remaining, 60);
  assert.equal(quota.rateLimits[0].resetAt, '2026-07-29T01:00:00.000Z');
  assert.equal(Object.hasOwn(quota, 'accountId'), false);

  const noAccess = normalizeCpaCodexQuota({
    plan_type: 'plus',
    codex_access: false,
    rate_limit: { allowed: true },
  });
  assert.equal(noAccess.valid, false);
  assert.equal(noAccess.status, 'no_access');
  assert.equal(normalizeCpaCodexQuota({
    rate_limit: { allowed: true },
  }, { account_type: 'oauth' }).planName, 'Codex');

  const extremeReset = normalizeCpaCodexQuota({
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 18000,
        reset_at: Number.MAX_VALUE,
      },
    },
  });
  assert.equal(extremeReset.rateLimits[0].resetAt, '');

  const unknownWindow = normalizeCpaCodexQuota({
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 7200,
      },
    },
  });
  assert.deepEqual(unknownWindow.rateLimits, []);

  const zeroAbsoluteReset = normalizeCpaCodexQuota({
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      primary_window: {
        used_percent: 20,
        limit_window_seconds: 18000,
        reset_at: 0,
        reset_after_seconds: 7200,
      },
    },
  }, {}, now);
  assert.equal(zeroAbsoluteReset.rateLimits[0].resetAt, '2026-07-29T02:00:00.000Z');

  const slightlyDriftedWindows = normalizeCpaCodexQuota({
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      primary_window: { used_percent: 1, limit_window_seconds: 18030 },
      secondary_window: { used_percent: 2, limit_window_seconds: 604830 },
    },
  });
  assert.deepEqual(slightlyDriftedWindows.rateLimits.map((item) => item.window), ['5h', '7d']);
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
  assert.throws(() => parseSubQuotaSources('[{"baseUrl":"file:///tmp/key"}]'), /apiKeyEnv/);
  assert.throws(() => parseSubQuotaSources(JSON.stringify([{
    id: 'typo',
    name: 'Typo',
    provider: 'cpa-cdoex',
    baseUrl: 'http://127.0.0.1:8327',
    apiKeyEnv: 'TYPO_KEY',
  }]), { TYPO_KEY: 'secret' }), /不支持的额度来源 provider/);
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
      daily: { used: 3, limit: 0, remaining: 0 },
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
    status: 'active',
    quota: { limit: 100, used: 25, remaining: 75, unit: 'USD' },
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
    daily: { used: null, limit: 0, remaining: 0 },
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

test('fetches CPA Codex accounts through Management and isolates account errors', async () => {
  const requests = [];
  const service = new SubQuotaService({
    sources: [{
      id: 'cpa',
      name: 'CPA',
      provider: 'cpa-codex',
      apiKeyEnv: 'CPA_KEY',
      apiKey: 'management-key',
      baseUrl: 'http://cpa.test',
      usageUrl: '',
    }],
    now: () => Date.parse('2026-07-29T00:00:00Z'),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      assert.equal(options.headers['X-Management-Key'], 'management-key');
      if (url.endsWith('/v0/management/auth-files')) {
        return new Response(JSON.stringify({
          files: [
            {
              id: 'codex-plus.json',
              name: 'codex-plus.json',
              type: 'codex',
              email: 'plus@example.com',
              auth_index: 'auth-plus',
              account_id: 'account-plus',
            },
            {
              id: 'codex-broken.json',
              name: 'codex-broken.json',
              type: 'codex',
              email: 'broken@example.com',
              auth_index: 'auth-broken',
            },
            { id: 'codex-disabled.json', type: 'codex', disabled: true },
            { id: 'other.json', type: 'openai' },
            {
              id: 'codex-misleading.json',
              name: 'codex-misleading.json',
              provider: 'claude',
              auth_index: 'must-not-be-used',
            },
          ],
        }), { status: 200 });
      }
      if (url.includes('/v0/management/auth-files/download')) {
        assert.match(url, /name=codex-broken\.json/);
        return new Response(JSON.stringify({ chatgpt_account_id: 'account-broken' }), { status: 200 });
      }
      if (url.endsWith('/v0/management/api-call')) {
        const payload = JSON.parse(options.body);
        assert.equal(payload.method, 'GET');
        assert.equal(payload.url, 'https://chatgpt.com/backend-api/wham/usage');
        assert.equal(payload.header.Authorization, 'Bearer $TOKEN$');
        if (payload.auth_index === 'auth-plus') {
          assert.equal(payload.header['Chatgpt-Account-Id'], 'account-plus');
          return new Response(JSON.stringify({
            status_code: 200,
            body: JSON.stringify({
              plan_type: 'plus',
              rate_limit: {
                allowed: true,
                primary_window: {
                  used_percent: 25,
                  limit_window_seconds: 604800,
                  reset_at: 1785312000,
                },
              },
            }),
          }), { status: 200 });
        }
        assert.equal(payload.auth_index, 'auth-broken');
        assert.equal(payload.header['Chatgpt-Account-Id'], 'account-broken');
        return new Response(JSON.stringify({
          status_code: 401,
          body: JSON.stringify({ error: 'expired' }),
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    },
  });

  const result = await service.list();
  assert.equal(result.count, 2);
  assert.equal(result.availableCount, 1);
  assert.equal(result.quotas[0].name, 'plus@example.com');
  assert.equal(result.quotas[0].planName, 'Plus');
  assert.equal(result.quotas[0].rateLimits[0].remaining, 75);
  assert.equal(result.quotas[1].name, 'broken@example.com');
  assert.match(result.quotas[1].error, /HTTP 401: expired/);
  assert.equal(requests.filter((item) => item.url.endsWith('/v0/management/api-call')).length, 2);
});

test('uses embedded CPA account claims without downloading runtime-only credentials', async () => {
  const observedAccountIds = [];
  let downloadRequests = 0;
  const service = new SubQuotaService({
    sources: [{
      id: 'cpa',
      name: 'CPA',
      provider: 'cpa-codex',
      apiKeyEnv: 'CPA_KEY',
      apiKey: 'management-key',
      baseUrl: 'http://cpa.test',
      usageUrl: '',
    }],
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/v0/management/auth-files')) {
        return new Response(JSON.stringify({
          files: [
            {
              id: 'runtime-snake',
              type: 'codex',
              runtime_only: true,
              auth_index: 'auth-snake',
              id_token: { chatgpt_account_id: 'account-snake' },
            },
            {
              id: 'runtime-camel',
              provider: 'codex',
              runtime_only: true,
              authIndex: 'auth-camel',
              id_token: { chatgptAccountId: 'account-camel' },
            },
          ],
        }), { status: 200 });
      }
      if (url.includes('/v0/management/auth-files/download')) {
        downloadRequests += 1;
        return new Response('{}', { status: 500 });
      }
      if (url.endsWith('/v0/management/api-call')) {
        const payload = JSON.parse(options.body);
        observedAccountIds.push(payload.header['Chatgpt-Account-Id']);
        return new Response(JSON.stringify({
          status_code: 200,
          body: { plan_type: 'plus' },
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    },
  });

  const result = await service.list();
  assert.equal(result.availableCount, 2);
  assert.equal(downloadRequests, 0);
  assert.deepEqual(observedAccountIds.sort(), ['account-camel', 'account-snake']);
  assert.deepEqual(result.quotas.map((quota) => quota.id), ['runtime-snake', 'runtime-camel']);
});

test('bounds concurrent CPA account requests while preserving account order and errors', async () => {
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const files = Array.from({ length: 9 }, (_, index) => ({
    id: `codex-${index}`,
    type: 'codex',
    auth_index: `auth-${index}`,
    account_id: `account-${index}`,
  }));
  const service = new SubQuotaService({
    sources: [{
      id: 'cpa',
      name: 'CPA',
      provider: 'cpa-codex',
      apiKeyEnv: 'CPA_KEY',
      apiKey: 'management-key',
      baseUrl: 'http://cpa.test',
      usageUrl: '',
    }],
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/v0/management/auth-files')) {
        return new Response(JSON.stringify({ files }), { status: 200 });
      }
      if (!url.endsWith('/v0/management/api-call')) return new Response('{}', { status: 404 });
      const payload = JSON.parse(options.body);
      const index = Number(payload.auth_index.replace('auth-', ''));
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 5 + ((8 - index) % 3)));
      activeRequests -= 1;
      if (index === 4) {
        return new Response(JSON.stringify({
          status_code: 429,
          body: { error: 'rate limited' },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        status_code: 200,
        body: { plan_type: index % 2 ? 'free' : 'plus' },
      }), { status: 200 });
    },
  });

  const result = await service.list();
  assert.equal(maxActiveRequests, 4);
  assert.equal(result.count, 9);
  assert.equal(result.availableCount, 8);
  assert.deepEqual(result.quotas.map((quota) => quota.id), files.map((file) => file.id));
  assert.match(result.quotas[4].error, /HTTP 429: rate limited/);
});

test('rejects CPA Management error and empty usage bodies without status codes', async () => {
  const responses = [
    { body: { error: 'expired' } },
    {},
    { body: { plan_type: null, rate_limit: null, credits: null } },
    { body: { rate_limit: {} } },
    { body: { plan_type: 'plus' } },
  ];
  const service = new SubQuotaService({
    fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
  });
  const source = { apiKey: 'management-key', baseUrl: 'http://cpa.test' };
  const file = { auth_index: 'auth-plus' };

  await assert.rejects(
    service.fetchCpaCodexUsage(source, file, 'account-plus'),
    /expired/,
  );
  await assert.rejects(
    service.fetchCpaCodexUsage(source, file, 'account-plus'),
    /Codex 额度响应无效/,
  );
  await assert.rejects(
    service.fetchCpaCodexUsage(source, file, 'account-plus'),
    /Codex 额度响应无效/,
  );
  await assert.rejects(
    service.fetchCpaCodexUsage(source, file, 'account-plus'),
    /Codex 额度响应无效/,
  );
  assert.deepEqual(
    await service.fetchCpaCodexUsage(source, file, 'account-plus'),
    { plan_type: 'plus' },
  );
});

test('does not expose arbitrary CPA error response fields', async () => {
  const secret = 'private-account-and-token';
  const responses = [
    { status_code: 502, body: { account_id: secret, debug: { token: secret } } },
    { status_code: 401, body: { error: { account_id: secret } } },
  ];
  const service = new SubQuotaService({
    fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
  });
  const source = { apiKey: 'management-key', baseUrl: 'http://cpa.test' };
  const file = { auth_index: 'auth-plus' };

  await assert.rejects(
    service.fetchCpaCodexUsage(source, file, 'account-plus'),
    (error) => error.message === 'HTTP 502' && !error.message.includes(secret),
  );
  await assert.rejects(
    service.fetchCpaCodexUsage(source, file, 'account-plus'),
    (error) => error.message === 'HTTP 401: Codex 额度请求失败' && !error.message.includes(secret),
  );
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
      return new Response(JSON.stringify({ isValid: true, remaining: 12, unit: 'USD' }), {
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
  assert.match(first.quotas[1].error, /MISSING_KEY/);
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
