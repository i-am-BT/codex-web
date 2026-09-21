import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
};

class CapturedResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
  }
  _write(chunk, _encoding, callback) { this.chunks.push(chunk); callback(); }
  status(code) { this.statusCode = code; return this; }
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  getHeader(key) { return this.headers[key.toLowerCase()]; }
  set(headers) { for (const [key, value] of Object.entries(headers)) this.setHeader(key, value); return this; }
  type(value) { this.setHeader('Content-Type', value); return this; }
  send(body) { this.end(body); return this; }
  json(body) { this.type('application/json'); return this.send(JSON.stringify(body)); }
  flushHeaders() { this.headersSent = true; }
  get body() { return Buffer.concat(this.chunks); }
}

test('local image route trusts persisted session roots and rejects traversal and symlink escapes', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-web-image-boundary-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const roots = Object.fromEntries(['cwd', 'default', 'outside', 'uploads', 'temp', 'allowed'].map((name) => {
    const root = path.join(temporary, name);
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'image.png'), Buffer.from('fixture-image'));
    return [name, root];
  }));
  fs.symlinkSync(path.join(roots.outside, 'image.png'), path.join(roots.cwd, 'escape.png'));
  const threadId = '11111111-1111-1111-1111-111111111111';
  let route;
  const context = vm.createContext({
    ...fs, path, Buffer, tmpdir: () => roots.temp,
    DEFAULT_CWD: roots.default, IMAGE_DIR: roots.uploads, LOCAL_IMAGE_ROOTS: [roots.allowed],
    TOOL_IMAGE_TYPES: new Map([['.png', 'image/png']]), TOOL_IMAGE_MAX_BYTES: 1024,
    nativeSessions: { get: (id) => id === threadId ? { metadata: { cwd: roots.cwd } } : null },
    canonicalizeNativeCwd: (value) => value,
    requireAuth: () => {},
    app: { get: (_path, _auth, handler) => { route = handler; } },
  });
  vm.runInContext(source.match(/^const NATIVE_THREAD_ID_PATTERN = .+;$/m)[0], context);
  vm.runInContext(between('function cleanNativeThreadId(', '\nfunction '), context);
  vm.runInContext(between('function readNativeToolImage(', 'function resolveAllowedLocalFile('), context);
  vm.runInContext(between("app.get('/api/local-image'", '\napp.get(/^'), context);
  const request = (query) => {
    const res = new CapturedResponse();
    route({ query }, res);
    return res;
  };

  for (const file of ['image.png', path.join(roots.cwd, 'image.png')]) {
    const res = request({ path: file, threadId });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.toString(), 'fixture-image');
  }
  for (const file of [path.join(roots.outside, 'image.png'), '../outside/image.png', 'escape.png']) {
    assert.equal(request({ path: file, threadId, cwd: roots.outside }).statusCode, 404, file);
  }
  assert.equal(request({ path: path.join(roots.outside, 'image.png'), cwd: '/' }).statusCode, 404);
  assert.equal(request({ path: path.join(roots.outside, 'image.png'), cwd: roots.outside }).statusCode, 404);
  assert.equal(request({ path: 'image.png', threadId: 'bad-id' }).statusCode, 400);
  assert.equal(request({ path: 'image.png', threadId: '22222222-2222-2222-2222-222222222222' }).statusCode, 404);
  for (const root of [roots.default, roots.uploads, roots.temp, roots.allowed]) {
    assert.equal(request({ path: path.join(root, 'image.png') }).statusCode, 200, root);
  }
});

test('markdown local image URLs identify the conversation instead of supplying a trusted cwd', () => {
  const helper = between('function localImageProxyUrl(', 'function createMarkdownImage(');
  const create = (id, sourceType) => new Function(
    'URLSearchParams', 'normalizeLocalImagePath', 'currentConversationId', 'currentConversationSource',
    `${helper}; return localImageProxyUrl;`,
  )(URLSearchParams, (value) => value, id, sourceType);
  const nativeUrl = new URL(create('thread-1', 'codex')('image.png'), 'http://localhost');
  assert.equal(nativeUrl.searchParams.get('threadId'), 'thread-1');
  assert.equal(nativeUrl.searchParams.has('cwd'), false);
  const webUrl = new URL(create('web-1', 'web')('image.png'), 'http://localhost');
  assert.equal(webUrl.searchParams.has('threadId'), false);
});

test('playground proxy rejects executable upstream documents, including error responses', async () => {
  const proxySource = between('async function proxyPlaygroundRequest(', 'function resolvePlaygroundProxyTarget(');
  const run = async (type, body, status = 200) => {
    const context = vm.createContext({
      Buffer, Readable, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
      PLAYGROUND_PROXY_TIMEOUT_MS: 1000, PLAYGROUND_PROXY_HEARTBEAT_MS: 1000,
      resolvePlaygroundProxyTarget: () => ({ url: 'http://provider.invalid/v1/responses' }),
      playgroundProxyRequestHeaders: () => ({}),
      fetch: async () => new Response(body, { status, headers: { 'Content-Type': type } }),
    });
    vm.runInContext(proxySource, context);
    const res = new CapturedResponse();
    await context.proxyPlaygroundRequest({ method: 'GET' }, res);
    assert.equal(res.getHeader('content-security-policy'), "sandbox; default-src 'none'");
    assert.equal(res.getHeader('x-content-type-options'), 'nosniff');
    return res;
  };
  for (const type of ['text/html; charset=utf-8', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml']) {
    for (const status of [200, 404]) {
      const res = await run(type, '<script>globalThis.injected = true</script>', status);
      assert.equal(res.statusCode, 502, `${type} ${status}`);
      assert.equal(res.getHeader('content-type'), 'application/json');
      assert.doesNotMatch(res.body.toString(), /<script>/);
    }
  }
  for (const [type, body] of [
    ['application/json', '{"ok":true}'],
    ['text/event-stream', 'data: {"ok":true}\n\n'],
    ['image/png', 'fixture-image'],
  ]) {
    const res = await run(type, body);
    assert.equal(res.statusCode, 200, type);
    assert.equal(res.getHeader('content-type'), type);
    assert.equal(res.body.toString(), body);
  }
});
