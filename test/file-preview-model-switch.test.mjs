import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
function between(start, end) {
  const offset = source.indexOf(start);
  assert.ok(offset >= 0);
  const last = source.indexOf(end, offset + start.length);
  assert.ok(last > offset);
  return source.slice(offset, last);
}
function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    type(value) { this.headers['Content-Type'] = value; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    sendFile(file) { this.body = readFileSync(file, 'utf8'); return this; },
  };
}

test('HTML file links render an interactive document in an isolated origin; other files stay escaped', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'web-file-preview-'));
  try {
    const html = path.join(dir, 'index.html');
    const text = path.join(dir, 'example.md');
    const document = '<!doctype html><button>Pause</button><script>window.example=1</script>';
    writeFileSync(html, document);
    writeFileSync(text, '<script>alert(1)</script>');
    const context = vm.createContext({
      path, realpathSync, statSync, readFileSync,
      LOCAL_FILE_ROOTS: [dir], LOCAL_FILE_MAX_BYTES: 1024,
      escapeHtml: (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    });
    vm.runInContext(between('function isPathWithinRoot(', '\nfunction decorateNativeConversation('), context);
    const res = response();
    context.sendAllowedLocalFile(res, html, { html: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, document);
    const policy = res.headers['Content-Security-Policy'];
    assert.match(policy, /sandbox allow-scripts;/);
    assert.doesNotMatch(policy, /allow-same-origin|allow-forms|allow-top-navigation/);
    assert.match(policy, /connect-src 'none'/);
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    const escaped = response();
    context.sendAllowedLocalFile(escaped, text, { html: true });
    assert.match(escaped.body, /&lt;script&gt;/);
    assert.equal(escaped.headers['Content-Security-Policy'], "default-src 'none'");
    const sibling = path.join(dir, 'sibling.html');
    writeFileSync(sibling, document);
    context.LOCAL_FILE_ROOTS = [html];
    const denied = response();
    context.sendAllowedLocalFile(denied, sibling, { html: true });
    assert.equal(denied.statusCode, 404, 'authorizing one file must not authorize its directory');
    const link = path.join(dir, 'escape.html');
    symlinkSync(new URL('../server.mjs', import.meta.url).pathname, link);
    context.LOCAL_FILE_ROOTS = [dir];
    assert.equal(context.resolveAllowedLocalFile(link), '', 'symlinks cannot escape allowed roots');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function settingsHarness(defaultProvider = '') {
  const calls = [];
  let handler;
  const context = vm.createContext({
    app: { patch(_path, _auth, fn) { handler = fn; } }, requireAuth() {},
    cleanNativeThreadId: (value) => value, cleanProviderName: (value) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) ? value : '',
    readCodexDefaults: () => ({ provider: defaultProvider }), DEFAULT_PROVIDER: '',
    readProviders: () => ['custom'], cleanThreadSettingsModel: (value) => value,
    CODEX_EXISTING_THREAD_APP_SERVER_FALLBACK: true, parseBoolean: (value, fallback) => value ?? fallback,
    nativeSessions: { get: () => ({ metadata: {} }), applyThreadSettings: (value) => calls.push(['persist', value]), scheduleRefresh() {} },
    activeNativeTurns: new Map(),
    requestLoadedAppServerThread: async (method, params) => { calls.push([method, params]); return {}; },
    requestThreadAppServer: async (method, params) => { calls.push([method, params]); return {}; },
    releaseAppServerThreadAfterTurn: async () => calls.push(['release']),
    nativeAppErrorStatus: () => 500, isNativeActiveWriterConflict: () => false,
  });
  vm.runInContext(between("app.patch('/api/native-sessions/:id',", "\napp.patch('/api/native-sessions/:id/goal'"), context);
  return { calls, handler };
}

test('model-only changes reach settings/update and persist without a provider switch', async () => {
  const { calls, handler } = settingsHarness();
  const res = response();
  await handler({ params: { id: 'thread' }, body: { model: 'gpt-6-sol' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.model, 'gpt-6-sol');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['thread/resume', { threadId: 'thread' }]);
  assert.equal(calls[1][0], 'thread/settings/update');
  assert.equal(calls[1][1].model, 'gpt-6-sol');
  assert.equal(calls[2][1].model, 'gpt-6-sol');
  assert.equal(calls.at(-1)[0], 'release');
});

test('selecting the default provider resolves the configured provider or the built-in OpenAI provider', async () => {
  for (const [configured, expected] of [['', 'openai'], ['custom', 'custom']]) {
    const { calls, handler } = settingsHarness(configured);
    const res = response();
    await handler({ params: { id: 'thread' }, body: { provider: null, model: 'gpt-6-sol' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.provider, expected);
    assert.equal(calls[0][1].modelProvider, expected);
  }
});

test('model-only composer writes omit provider and preserve the requested model', async () => {
  let request;
  const context = vm.createContext({
    currentConversationSource: 'codex', currentConversationId: 'thread', nativeComposerSettingsWriteId: 0,
    nativeComposerSettingsQueue: Promise.resolve(), nativeComposerOverride: null,
    rememberNativeComposerOverride() {},
    fetch: async (url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({}) }; },
  });
  vm.runInContext(between('function syncNativeComposerSettings(', '\nfunction newChat('), context);
  assert.equal(await context.syncNativeComposerSettings({ model: 'gpt-6-astra' }), true);
  assert.deepEqual(request, { model: 'gpt-6-astra' });
});

test('the default model catalog uses the signed-in Codex catalog without demanding an API URL or key', async () => {
  let handler;
  const context = vm.createContext({
    app: { post(_path, _auth, fn) { handler = fn; } }, requireAuth() {},
    cleanProviderName: () => '',
    readNativeModelCapabilities: async () => [
      { id: 'gpt-6-sol', model: 'gpt-6-sol' }, { id: 'gpt-6-astra' },
    ],
  });
  vm.runInContext(between("app.post('/api/models',", "\napp.post('/api/providers'"), context);
  const res = response();
  await handler({ body: { provider: '' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Array.from(res.body.models), ['gpt-6-sol', 'gpt-6-astra']);
});

test('refreshing an OpenAI task restores its model even when the provider picker uses the default alias', async () => {
  const selected = [];
  const context = vm.createContext({
    currentNativeWorkspaceKind: '', forceFullAccess: true,
    provider: { options: [{ value: '' }, { value: 'custom' }], value: 'custom' },
    modelOptionsProvider: '', modelLoadInFlight: null, modelLoadRevision: 1,
    defaultComposerServiceTier: null, composerPermissionMode: '', sandbox: {}, approval: {},
    selectComposerModel: (value) => selected.push(value),
    normalizeComposerServiceTier: (value) => value, reconcileComposerFastSupport() {}, updateSafetyHint() {},
  });
  vm.runInContext(between('async function applyNativeConversationMetadata(', '\nasync function rollbackConversation('), context);
  await context.applyNativeConversationMetadata({ modelProvider: 'openai', model: 'gpt-6-astra' });
  assert.equal(context.provider.value, '');
  assert.deepEqual(selected, ['gpt-6-astra']);
});
