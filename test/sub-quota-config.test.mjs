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
        ],
      }),
    });
    assert.equal(saved.status, 200);
    const savedPayload = await saved.json();
    assert.equal(savedPayload.provider, 'multi');
    assert.equal(savedPayload.configuredCount, 2);
    assert.equal(savedPayload.sources.filter((source) => source.configured).length, 2);
    assert.doesNotMatch(JSON.stringify(savedPayload), /cpa-key|sub-key/);

    const quotas = await fetch(`${baseUrl}/api/sub-quotas?refresh=1`, { headers: { Cookie: cookie } });
    assert.equal(quotas.status, 200);
    const quotaPayload = await quotas.json();
    assert.equal(quotaPayload.count, 2);
    assert.deepEqual(new Set(quotaPayload.quotas.map((quota) => quota.provider)), new Set(['cpa-codex', 'sub2api']));
    assert.doesNotMatch(JSON.stringify(quotaPayload), /cpa-key|sub-key/);

    const persisted = await readFile(envFile, 'utf8');
    assert.match(persisted, /^SUB_QUOTA_PROVIDER="multi"$/m);
    assert.match(persisted, /^CPA_QUOTA_API_KEY="cpa-key"$/m);
    assert.match(persisted, /^SUB2API_API_KEY="sub-key"$/m);

    await new Promise((resolve) => provider.close(resolve));
    provider = null;
    const savedWhileOffline = await fetch(`${baseUrl}/api/sub-quota-config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sources: [
          { provider: 'cpa-codex', baseUrl: providerBaseUrl, apiKey: 'offline-cpa-key' },
          { provider: 'sub2api', baseUrl: providerBaseUrl, apiKey: 'offline-sub-key' },
        ],
      }),
    });
    assert.equal(savedWhileOffline.status, 200);
    const offlinePayload = await savedWhileOffline.json();
    assert.equal(offlinePayload.saved, true);
    assert.equal(offlinePayload.configuredCount, 2);
    assert.match(offlinePayload.detectDetail, /检测结果不会阻止保存/);
    const persistedOffline = await readFile(envFile, 'utf8');
    assert.match(persistedOffline, /^CPA_QUOTA_API_KEY="offline-cpa-key"$/m);
    assert.match(persistedOffline, /^SUB2API_API_KEY="offline-sub-key"$/m);
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
