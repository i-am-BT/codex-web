import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as createHttpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function waitForUrl(url, attempts = 80) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 401) return;
      lastError = new Error(`status ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastError || new Error('timeout waiting for url');
}

test('playground proxy returns clean 502 for truncated JSON and streams SSE', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-proxy-'));
  const runtime = path.join(temporary, 'runtime');
  const codexHome = path.join(temporary, 'codex-home');
  await mkdir(runtime, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  const webEnv = path.join(temporary, 'web.env');
  await writeFile(webEnv, 'CODEX_WEB_PASSWORD=test-password\nSESSION_SECRET=test-session-secret-with-enough-entropy\n');

  const providerRequests = [];
  const providerServer = createHttpServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    providerRequests.push({ url: req.url, body });
    if (req.url?.startsWith('/v1/images/generations')) {
      if (body.includes('forceTruncatedJson')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
        res.write('{"data":[{"b64_json":"abc"');
        setTimeout(() => res.destroy(), 10);
        return;
      }
      if (body.includes('forceEventStream') || body.includes('"stream":true') || body.includes('"stream": true')) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write('data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"cGFydGlhbA=="}\n\n');
        await new Promise((r) => setTimeout(r, 40));
        res.write('data: {"object":"image.generation.result","data":[{"b64_json":"ZmluYWw="}]}\n\n');
        res.end();
        return;
      }
      if (body.includes('heartbeat smoke test')) {
        await new Promise((r) => setTimeout(r, 80));
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('proxy-image').toString('base64') }] }));
      return;
    }
    if (req.url?.startsWith('/v1/responses')) {
      if (body.includes('forceStreamFailure')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
        res.write('{"id":"partial"');
        setTimeout(() => res.destroy(), 10);
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'response-fixture', output: [] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => providerServer.listen(0, '127.0.0.1', resolve));
  const providerBaseUrl = `http://127.0.0.1:${providerServer.address().port}`;

  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: '',
      APP_NAME: 'Codex Web Proxy Test',
      CODEX_WEB_PASSWORD: 'test-password',
      SESSION_SECRET: 'test-session-secret-with-enough-entropy',
      HOST: '127.0.0.1',
      PORT: '0',
      PORT_MIN: '42000',
      PORT_MAX: '42999',
      CODEX_HOME: codexHome,
      CODEX_PROCESS_HOME: temporary,
      CODEX_WEB_ENV_FILE: webEnv,
      CODEX_WEB_RUNTIME_DIR: runtime,
      PLAYGROUND_PROXY_ALLOWED_ORIGINS: providerBaseUrl,
      PLAYGROUND_PROXY_HEARTBEAT_MS: '20',
      IMAGE_PROMPT_AUTO_SYNC: 'false',
      DEFAULT_CWD: temporary,
      FORCE_FULL_ACCESS: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stdout += chunk; });

  try {
    await waitForUrl('http://127.0.0.1:42000/').catch(() => {});
    // discover actual port from runtime or stdout
    let baseUrl = '';
    for (let i = 0; i < 80 && !baseUrl; i += 1) {
      const match = stdout.match(/https?:\/\/[^\s:]+:(\d+)/);
      if (match) {
        baseUrl = 'http://127.0.0.1:' + match[1];
        break;
      }
      try {
        const portText = await import('node:fs/promises').then((fsMod) => fsMod.readFile(path.join(runtime, 'port'), 'utf8'));
        const port = Number(String(portText).trim());
        if (Number.isFinite(port) && port > 0) {
          baseUrl = 'http://127.0.0.1:' + port;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!baseUrl) {
      const runtimeFiles = await import('node:fs').then((fsMod) => fsMod.readdirSync(runtime));
      throw new Error('server did not start. stdout=' + stdout.slice(0,500) + ' runtime=' + runtimeFiles.join(','));
    }
    await waitForUrl(baseUrl);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];

    const ok = await fetch(`${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(providerBaseUrl)}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'ok' }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).data.length, 1);

    const truncated = await fetch(`${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(providerBaseUrl)}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'forceTruncatedJson' }),
    });
    assert.equal(truncated.status, 502);
    const truncatedBody = await truncated.json();
    assert.match(truncatedBody.error, /truncated or invalid JSON|Playground proxy request failed/);

    const responsesTruncated = await fetch(`${baseUrl}/api-proxy/responses?codex_upstream=${encodeURIComponent(providerBaseUrl)}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceStreamFailure: true }),
    });
    assert.equal(responsesTruncated.status, 502);
    assert.match((await responsesTruncated.json()).error, /truncated or invalid JSON|Playground proxy request failed/);

    const stream = await fetch(`${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(providerBaseUrl)}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt: 'forceEventStream', stream: true }),
    });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type') || '', /text\/event-stream/);
    const streamBody = await stream.text();
    assert.match(streamBody, /image\.generation\.result|partial_image/);

    // heartbeat 102 still works for slow buffered requests
    const heartbeatStatuses = [];
    const heartbeatResult = await new Promise((resolve, reject) => {
      const target = new URL(`${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(providerBaseUrl)}`);
      const body = JSON.stringify({ model: 'gpt-image-2', prompt: 'heartbeat smoke test' });
      const request = createHttpRequest({
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { responseBody += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: responseBody }));
      });
      request.on('information', (information) => heartbeatStatuses.push(information.statusCode));
      request.on('error', reject);
      request.end(body);
    });
    assert.equal(heartbeatResult.status, 200);
    assert.equal(JSON.parse(heartbeatResult.body).data.length, 1);
    assert.ok(heartbeatStatuses.includes(102));
  } finally {
    child.kill('SIGTERM');
    providerServer.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
