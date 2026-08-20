import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('stores and returns CPA and Sub2API quotas together', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-dual-quota-'));
  const runtime = path.join(temporary, 'runtime');
  const codexHome = path.join(temporary, 'codex-home');
  const envFile = path.join(temporary, 'web.env');
  const fakeCodex = path.join(temporary, 'fake-codex.mjs');
  let provider;
  let child;
  try {
    await mkdir(runtime, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), 'model = "test"\n');
    await writeFile(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('codex-cli test');
  process.exit(0);
}
if (process.argv[2] === 'app-server') {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (Object.hasOwn(message, 'id')) process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
    }
  });
  setInterval(() => {}, 1000);
}
`);
    await chmod(fakeCodex, 0o755);

    provider = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v0/management/auth-files') {
        res.end(JSON.stringify({ files: [{
          id: 'codex.json',
          name: 'codex.json',
          type: 'codex',
          email: 'cpa@example.com',
          auth_index: 'auth-1',
          account_id: 'account-1',
          disabled: false,
        }] }));
        return;
      }
      if (req.url === '/v0/management/api-call') {
        assert.equal(req.headers['x-management-key'], 'cpa-key');
        assert.equal(JSON.parse(body).method, 'GET');
        res.end(JSON.stringify({
          status_code: 200,
          body: {
            plan_type: 'plus',
            email: 'cpa@example.com',
            rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } },
          },
        }));
        return;
      }
      if (req.url === '/v1/usage') {
        assert.equal(req.headers.authorization, 'Bearer sub-key');
        res.end(JSON.stringify({ isValid: true, planName: 'Sub plan', remaining: 42, unit: 'USD' }));
        return;
      }
      if (req.url === '/user/balance') {
        assert.equal(req.headers.authorization, 'Bearer deepseek-key');
        res.end(JSON.stringify({
          is_available: true,
          balance_infos: [{
            currency: 'CNY',
            total_balance: '100.00',
            granted_balance: '10.00',
            topped_up_balance: '90.00',
          }],
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise((resolve, reject) => {
      provider.once('error', reject);
      provider.listen(0, '127.0.0.1', resolve);
    });
    const providerBaseUrl = `http://127.0.0.1:${provider.address().port}`;

    child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        OPENAI_API_KEY: '',
        OPENAI_BASE_URL: '',
        APP_NAME: 'Dual quota test',
        CODEX_WEB_PASSWORD: 'test-password',
        SESSION_SECRET: 'dual-quota-test-session-secret',
        HOST: '127.0.0.1',
        PORT: '0',
        PORT_MIN: '43000',
        PORT_MAX: '43999',
        CODEX_BIN: fakeCodex,
        CODEX_HOME: codexHome,
        CODEX_PROCESS_HOME: temporary,
        CODEX_WEB_ENV_FILE: envFile,
        CODEX_WEB_RUNTIME_DIR: runtime,
        CODEX_DESKTOP_IPC_ENABLED: 'false',
        IMAGE_PROMPT_AUTO_SYNC: 'false',
        CPA_QUOTA_BASE_URL: '',
        CPA_QUOTA_API_KEY: '',
        SUB2API_BASE_URL: '',
        SUB2API_API_KEY: '',
        GROK2API_BASE_URL: '',
        GROK2API_ADMIN_PASSWORD: '',
        GROK2API_API_KEY: '',
        DEEPSEEK_BASE_URL: '',
        DEEPSEEK_API_KEY: '',
        SUB_QUOTA_ORDER: '',
        SUB_QUOTA_PROVIDER: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const port = await waitForPort(child, runtime);
    const baseUrl = `http://127.0.0.1:${port}`;
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];

    const saved = await fetch(`${baseUrl}/api/sub-quota-config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sources: [
          { provider: 'cpa-codex', baseUrl: providerBaseUrl, apiKey: 'cpa-key' },
          { provider: 'sub2api', baseUrl: providerBaseUrl, apiKey: 'sub-key' },
          { provider: 'deepseek', baseUrl: providerBaseUrl, apiKey: 'deepseek-key' },
        ],
        order: ['sub2api', 'deepseek', 'cpa-codex', 'grok2api'],
      }),
    });
    assert.equal(saved.status, 200);
    const savedPayload = await saved.json();
    assert.equal(savedPayload.provider, 'multi');
    assert.equal(savedPayload.configuredCount, 3);
    assert.equal(savedPayload.sources.filter((source) => source.configured).length, 3);
    assert.deepEqual(savedPayload.sources.map((source) => source.provider), ['sub2api', 'deepseek', 'cpa-codex', 'grok2api']);
    assert.doesNotMatch(JSON.stringify(savedPayload), /cpa-key|sub-key|deepseek-key/);

    const configAfterSave = await fetch(`${baseUrl}/api/sub-quota-config`, { headers: { Cookie: cookie } });
    const configAfterSavePayload = await configAfterSave.json();
    assert.deepEqual(configAfterSavePayload.sources.map((source) => source.provider), ['sub2api', 'deepseek', 'cpa-codex', 'grok2api']);

    const quotas = await fetch(`${baseUrl}/api/sub-quotas?refresh=1`, { headers: { Cookie: cookie } });
    assert.equal(quotas.status, 200);
    const quotaPayload = await quotas.json();
    assert.equal(quotaPayload.count, 3);
    assert.deepEqual(quotaPayload.quotas.map((quota) => quota.provider), ['sub2api', 'deepseek', 'cpa-codex']);
    assert.doesNotMatch(JSON.stringify(quotaPayload), /cpa-key|sub-key|deepseek-key/);
    const deepSeekQuota = quotaPayload.quotas.find((quota) => quota.provider === 'deepseek');
    assert.equal(deepSeekQuota.balance, 100);
    assert.equal(deepSeekQuota.currency, 'CNY');

    const persisted = await readFile(envFile, 'utf8');
    assert.match(persisted, /^SUB_QUOTA_PROVIDER="multi"$/m);
    assert.match(persisted, /^SUB_QUOTA_ORDER="sub2api,deepseek,cpa-codex,grok2api"$/m);
    assert.match(persisted, /^CPA_QUOTA_API_KEY="cpa-key"$/m);
    assert.match(persisted, /^SUB2API_API_KEY="sub-key"$/m);
    assert.match(persisted, /^DEEPSEEK_API_KEY="deepseek-key"$/m);

    const visibilityOnlySave = await fetch(`${baseUrl}/api/sub-quota-config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codexAppVisible: true,
        sources: [
          { provider: 'cpa-codex', baseUrl: '', apiKey: '', visible: true },
          { provider: 'sub2api', baseUrl: '', apiKey: '', visible: true },
          { provider: 'deepseek', baseUrl: '', apiKey: '', visible: false },
        ],
      }),
    });
    assert.equal(visibilityOnlySave.status, 200);
    const visibilityOnlyPayload = await visibilityOnlySave.json();
    assert.equal(visibilityOnlyPayload.configuredCount, 3);
    assert.deepEqual(
      visibilityOnlyPayload.sources.map((source) => [source.provider, source.configured, source.visible]),
      [
        ['sub2api', true, true],
        ['deepseek', true, false],
        ['cpa-codex', true, true],
        ['grok2api', false, true],
      ],
    );
    const persistedAfterVisibilityOnlySave = await readFile(envFile, 'utf8');
    assert.match(persistedAfterVisibilityOnlySave, /^CPA_QUOTA_API_KEY="cpa-key"$/m);
    assert.match(persistedAfterVisibilityOnlySave, /^SUB2API_API_KEY="sub-key"$/m);
    assert.match(persistedAfterVisibilityOnlySave, /^DEEPSEEK_API_KEY="deepseek-key"$/m);
    assert.match(persistedAfterVisibilityOnlySave, /^DEEPSEEK_QUOTA_VISIBLE="false"$/m);

    await new Promise((resolve) => provider.close(resolve));
    provider = null;
    const savedWhileOffline = await fetch(`${baseUrl}/api/sub-quota-config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sources: [
          { provider: 'cpa-codex', baseUrl: providerBaseUrl, apiKey: 'offline-cpa-key' },
          { provider: 'sub2api', baseUrl: providerBaseUrl, apiKey: 'offline-sub-key' },
          { provider: 'deepseek', baseUrl: providerBaseUrl, apiKey: 'offline-deepseek-key' },
        ],
      }),
    });
    assert.equal(savedWhileOffline.status, 200);
    const offlinePayload = await savedWhileOffline.json();
    assert.equal(offlinePayload.saved, true);
    assert.equal(offlinePayload.configuredCount, 3);
    assert.match(offlinePayload.detectDetail, /检测结果不会阻止保存/);
    const persistedOffline = await readFile(envFile, 'utf8');
    assert.match(persistedOffline, /^CPA_QUOTA_API_KEY="offline-cpa-key"$/m);
    assert.match(persistedOffline, /^SUB2API_API_KEY="offline-sub-key"$/m);
    assert.match(persistedOffline, /^DEEPSEEK_API_KEY="offline-deepseek-key"$/m);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    if (provider) await new Promise((resolve) => provider.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('persists dynamic quota sources by id without leaking credentials', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-dynamic-quota-'));
  const runtime = path.join(temporary, 'runtime');
  const codexHome = path.join(temporary, 'codex-home');
  const envFile = path.join(temporary, 'web.env');
  const fakeCodex = path.join(temporary, 'fake-codex.mjs');
  const sourcesFile = path.join(runtime, 'sub-quota-sources.json');
  const providerRequests = [];
  let provider;
  let child;
  try {
    await mkdir(runtime, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), 'model = "test"\n');
    await writeFile(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('codex-cli test');
  process.exit(0);
}
if (process.argv[2] === 'app-server') {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (Object.hasOwn(message, 'id')) process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
    }
  });
  setInterval(() => {}, 1000);
}
`);
    await chmod(fakeCodex, 0o755);

    provider = createServer(async (req, res) => {
      for await (const _chunk of req) {}
      const authorization = String(req.headers.authorization || '');
      providerRequests.push({ url: req.url, authorization });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/usage') {
        const source = authorization === 'Bearer sub-main-secret'
          ? { planName: 'Main Sub Plan', remaining: 81 }
          : authorization === 'Bearer sub-backup-secret'
            ? { planName: 'Backup Sub Plan', remaining: 37 }
            : null;
        if (!source) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res.end(JSON.stringify({
          isValid: true,
          mode: 'quota_limited',
          planName: source.planName,
          remaining: source.remaining,
          unit: 'USD',
          quota: { used: 100 - source.remaining, limit: 100, remaining: source.remaining, unit: 'USD' },
          rate_limits: [{ window: '5h', used: 1, limit: 10, remaining: 9 }],
        }));
        return;
      }
      if (req.url === '/v1/models') {
        if (authorization !== 'Bearer compat-secret') {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'compatible-model', object: 'model' }],
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise((resolve, reject) => {
      provider.once('error', reject);
      provider.listen(0, '127.0.0.1', resolve);
    });
    const providerBaseUrl = `http://127.0.0.1:${provider.address().port}`;
    const serverEnv = {
      ...process.env,
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: '',
      APP_NAME: 'Dynamic quota test',
      CODEX_WEB_PASSWORD: 'test-password',
      SESSION_SECRET: 'dynamic-quota-test-session-secret',
      HOST: '127.0.0.1',
      PORT: '0',
      PORT_MIN: '44000',
      PORT_MAX: '44999',
      CODEX_BIN: fakeCodex,
      CODEX_HOME: codexHome,
      CODEX_PROCESS_HOME: temporary,
      CODEX_WEB_ENV_FILE: envFile,
      CODEX_WEB_RUNTIME_DIR: runtime,
      CODEX_DESKTOP_IPC_ENABLED: 'false',
      IMAGE_PROMPT_AUTO_SYNC: 'false',
      CPA_QUOTA_BASE_URL: '',
      CPA_QUOTA_API_KEY: '',
      SUB2API_BASE_URL: '',
      SUB2API_API_KEY: '',
      GROK2API_BASE_URL: '',
      GROK2API_ADMIN_PASSWORD: '',
      GROK2API_API_KEY: '',
      DEEPSEEK_BASE_URL: '',
      DEEPSEEK_API_KEY: '',
      SUB_QUOTA_ORDER: '',
      SUB_QUOTA_PROVIDER: '',
      SUB_QUOTA_SOURCES: '',
    };
    const startServer = async () => {
      child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
        cwd: ROOT,
        env: serverEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const port = await waitForPort(child, runtime);
      return `http://127.0.0.1:${port}`;
    };
    const stopServer = async () => {
      if (!child || child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
      child = null;
    };
    const login = async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'test-password' }),
      });
      assert.equal(response.status, 200);
      return response.headers.get('set-cookie').split(';', 1)[0];
    };

    let baseUrl = await startServer();
    let cookie = await login(baseUrl);
    const initialSave = await fetch(`${baseUrl}/api/sub-quota-config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codexAppVisible: false,
        sources: [
          {
            id: 'sub-main',
            name: '主 Sub',
            provider: 'sub2api',
            baseUrl: providerBaseUrl,
            apiKey: 'sub-main-secret',
            visible: true,
            builtin: false,
            removable: true,
          },
          {
            id: 'sub-backup',
            name: '备用 Sub',
            provider: 'sub2api',
            baseUrl: providerBaseUrl,
            apiKey: 'sub-backup-secret',
            visible: false,
            builtin: false,
            removable: true,
          },
          {
            id: 'compat-main',
            name: '兼容渠道',
            provider: 'openai-compatible',
            baseUrl: `${providerBaseUrl}/v1`,
            apiKey: 'compat-secret',
            visible: true,
            builtin: false,
            removable: true,
          },
        ],
        order: ['compat-main', 'sub-backup', 'sub-main'],
      }),
    });
    assert.equal(initialSave.status, 200);
    const initialPayload = await initialSave.json();
    assert.equal(initialPayload.configuredCount, 3);
    assert.equal(initialPayload.codexApp.visible, false);
    assert.deepEqual(
      initialPayload.sources.slice(0, 3).map((source) => ({
        id: source.id,
        name: source.name,
        provider: source.provider,
        visible: source.visible,
        builtin: source.builtin,
        removable: source.removable,
      })),
      [
        {
          id: 'compat-main',
          name: '兼容渠道',
          provider: 'openai-compatible',
          visible: true,
          builtin: false,
          removable: true,
        },
        {
          id: 'sub-backup',
          name: '备用 Sub',
          provider: 'sub2api',
          visible: false,
          builtin: false,
          removable: true,
        },
        {
          id: 'sub-main',
          name: '主 Sub',
          provider: 'sub2api',
          visible: true,
          builtin: false,
          removable: true,
        },
      ],
    );
    assert.ok(
      initialPayload.sources
        .filter((source) => ['cpa-codex', 'sub2api', 'grok2api', 'deepseek'].includes(source.id))
        .every((source) => source.builtin === true && source.removable === false),
    );
    assert.doesNotMatch(
      JSON.stringify(initialPayload),
      /sub-main-secret|sub-backup-secret|compat-secret/,
    );

    const initialConfig = await fetch(`${baseUrl}/api/sub-quota-config`, {
      headers: { Cookie: cookie },
    });
    assert.equal(initialConfig.status, 200);
    const initialConfigPayload = await initialConfig.json();
    assert.equal(initialConfigPayload.maxSources, 12);
    assert.ok(
      initialConfigPayload.providerOptions.some((option) => (
        option.provider === 'openai-compatible' && option.label === 'OpenAI 兼容'
      )),
    );
    assert.deepEqual(
      initialConfigPayload.sources.slice(0, 3).map((source) => source.id),
      ['compat-main', 'sub-backup', 'sub-main'],
    );
    assert.doesNotMatch(
      JSON.stringify(initialConfigPayload),
      /sub-main-secret|sub-backup-secret|compat-secret/,
    );

    const initialQuotas = await fetch(`${baseUrl}/api/sub-quotas?refresh=1`, {
      headers: { Cookie: cookie },
    });
    assert.equal(initialQuotas.status, 200);
    const initialQuotaPayload = await initialQuotas.json();
    assert.deepEqual(
      initialQuotaPayload.quotas.map((quota) => quota.sourceId),
      ['compat-main', 'sub-backup', 'sub-main'],
    );
    assert.equal(initialQuotaPayload.quotas[0].mode, 'openai_compatible');
    assert.equal(initialQuotaPayload.quotas[0].balance, null);
    assert.equal(initialQuotaPayload.quotas[1].planName, 'Backup Sub Plan');
    assert.equal(initialQuotaPayload.quotas[2].planName, 'Main Sub Plan');
    assert.equal(initialQuotaPayload.visibility['compat-main'], true);
    assert.equal(initialQuotaPayload.visibility['sub-backup'], false);
    assert.equal(initialQuotaPayload.visibility['sub-main'], true);
    assert.equal(initialQuotaPayload.codexApp.visible, false);
    assert.doesNotMatch(
      JSON.stringify(initialQuotaPayload),
      /sub-main-secret|sub-backup-secret|compat-secret/,
    );
    assert.deepEqual(
      providerRequests
        .filter((request) => request.url === '/v1/usage')
        .map((request) => request.authorization)
        .sort(),
      ['Bearer sub-backup-secret', 'Bearer sub-main-secret'],
    );
    assert.deepEqual(
      providerRequests
        .filter((request) => request.url === '/v1/models')
        .map((request) => request.authorization),
      ['Bearer compat-secret'],
    );

    const storedInitial = JSON.parse(await readFile(sourcesFile, 'utf8'));
    assert.equal(
      storedInitial.sources.find((source) => source.id === 'sub-main').apiKey,
      'sub-main-secret',
    );
    assert.equal(
      storedInitial.sources.find((source) => source.id === 'sub-backup').apiKey,
      'sub-backup-secret',
    );
    assert.equal(
      storedInitial.sources.find((source) => source.id === 'compat-main').apiKey,
      'compat-secret',
    );

    const retainedSave = await fetch(`${baseUrl}/api/sub-quota-config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codexAppVisible: false,
        sources: [
          ...initialConfigPayload.sources.map((source) => ({
            ...source,
            apiKey: '',
          })),
          {
            id: 'sub-empty',
            name: '空 Key Sub',
            provider: 'sub2api',
            baseUrl: providerBaseUrl,
            apiKey: '',
            visible: true,
            builtin: false,
            removable: true,
          },
        ],
        order: ['compat-main', 'sub-empty', 'sub-main', 'sub-backup'],
      }),
    });
    assert.equal(retainedSave.status, 200);
    const retainedPayload = await retainedSave.json();
    assert.equal(retainedPayload.configuredCount, 3);
    assert.deepEqual(
      retainedPayload.sources.slice(0, 4).map((source) => source.id),
      ['compat-main', 'sub-empty', 'sub-main', 'sub-backup'],
    );
    assert.equal(retainedPayload.sources.find((source) => source.id === 'compat-main').keyConfigured, true);
    assert.equal(retainedPayload.sources.find((source) => source.id === 'sub-main').keyConfigured, true);
    assert.equal(retainedPayload.sources.find((source) => source.id === 'sub-backup').keyConfigured, true);
    assert.equal(retainedPayload.sources.find((source) => source.id === 'sub-empty').keyConfigured, false);
    assert.doesNotMatch(
      JSON.stringify(retainedPayload),
      /sub-main-secret|sub-backup-secret|compat-secret/,
    );
    const storedRetained = JSON.parse(await readFile(sourcesFile, 'utf8'));
    assert.equal(
      storedRetained.sources.find((source) => source.id === 'sub-main').apiKey,
      'sub-main-secret',
    );
    assert.equal(
      storedRetained.sources.find((source) => source.id === 'sub-backup').apiKey,
      'sub-backup-secret',
    );
    assert.equal(
      storedRetained.sources.find((source) => source.id === 'compat-main').apiKey,
      'compat-secret',
    );
    assert.equal(
      storedRetained.sources.find((source) => source.id === 'sub-empty').apiKey,
      '',
    );

    const deleteBackup = await fetch(`${baseUrl}/api/sub-quota-config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        codexAppVisible: false,
        sources: retainedPayload.sources.map((source) => ({
          ...source,
          apiKey: '',
          remove: source.id === 'sub-backup',
        })),
        order: ['compat-main', 'sub-empty', 'sub-main'],
      }),
    });
    assert.equal(deleteBackup.status, 200);
    const deletePayload = await deleteBackup.json();
    assert.equal(deletePayload.configuredCount, 2);
    assert.equal(deletePayload.sources.some((source) => source.id === 'sub-backup'), false);
    assert.deepEqual(
      deletePayload.sources.slice(0, 3).map((source) => source.id),
      ['compat-main', 'sub-empty', 'sub-main'],
    );
    assert.doesNotMatch(
      JSON.stringify(deletePayload),
      /sub-main-secret|sub-backup-secret|compat-secret/,
    );
    const storedAfterDelete = JSON.parse(await readFile(sourcesFile, 'utf8'));
    assert.equal(storedAfterDelete.sources.some((source) => source.id === 'sub-backup'), false);

    await stopServer();
    await rm(path.join(runtime, 'port'), { force: true });
    baseUrl = await startServer();
    cookie = await login(baseUrl);
    const restoredConfig = await fetch(`${baseUrl}/api/sub-quota-config`, {
      headers: { Cookie: cookie },
    });
    assert.equal(restoredConfig.status, 200);
    const restoredConfigPayload = await restoredConfig.json();
    assert.equal(restoredConfigPayload.codexApp.visible, false);
    assert.equal(restoredConfigPayload.sources.some((source) => source.id === 'sub-backup'), false);
    assert.deepEqual(
      restoredConfigPayload.sources.slice(0, 3).map((source) => source.id),
      ['compat-main', 'sub-empty', 'sub-main'],
    );
    assert.equal(restoredConfigPayload.sources.find((source) => source.id === 'compat-main').keyConfigured, true);
    assert.equal(restoredConfigPayload.sources.find((source) => source.id === 'sub-main').keyConfigured, true);
    assert.equal(restoredConfigPayload.sources.find((source) => source.id === 'sub-empty').keyConfigured, false);
    assert.doesNotMatch(
      JSON.stringify(restoredConfigPayload),
      /sub-main-secret|sub-backup-secret|compat-secret/,
    );

    providerRequests.length = 0;
    const restoredQuotas = await fetch(`${baseUrl}/api/sub-quotas?refresh=1`, {
      headers: { Cookie: cookie },
    });
    assert.equal(restoredQuotas.status, 200);
    const restoredQuotaPayload = await restoredQuotas.json();
    assert.deepEqual(
      restoredQuotaPayload.quotas.map((quota) => quota.sourceId),
      ['compat-main', 'sub-main'],
    );
    assert.equal(
      providerRequests.some((request) => request.authorization === 'Bearer sub-backup-secret'),
      false,
    );
    assert.equal(
      providerRequests.some((request) => request.authorization === 'Bearer sub-main-secret'),
      true,
    );
    assert.equal(
      providerRequests.some((request) => request.authorization === 'Bearer compat-secret'),
      true,
    );
    assert.doesNotMatch(
      JSON.stringify(restoredQuotaPayload),
      /sub-main-secret|sub-backup-secret|compat-secret/,
    );
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    if (provider) await new Promise((resolve) => provider.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});

async function waitForPort(child, runtime) {
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      const port = Number((await readFile(path.join(runtime, 'port'), 'utf8')).trim());
      if (port > 0) return port;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start: ${stderr}`);
}
