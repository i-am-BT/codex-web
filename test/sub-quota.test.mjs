import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeSubQuota,
  normalizeSubQuotaBaseUrl,
  parseSubQuotaSources,
  SubQuotaService,
} from '../sub-quota.mjs';

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
    apiKeyEnv: 'SUB_MAIN_API_KEY',
    apiKey: 'secret-key',
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
