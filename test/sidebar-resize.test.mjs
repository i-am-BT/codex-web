import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [serverSource, uiStyles] = await Promise.all([
  readFile(new URL('../server.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../ui.css', import.meta.url), 'utf8'),
]);
const rawInlineScript = serverSource.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
const inlineScript = rawInlineScript.replaceAll('\\\\', '\\');

function sourceLine(name) {
  const source = inlineScript.match(new RegExp(`function ${name}\\([^\\n]+`))?.[0];
  assert.ok(source, `missing function source: ${name}`);
  return source;
}

const configSource = inlineScript.match(
  /const SIDEBAR_WIDTH_STORAGE_KEY=[\s\S]*?let sidebarResizePointerId=null;/,
)?.[0];
assert.ok(configSource, 'missing sidebar width configuration');

const functionNames = [
  'sidebarWidthLimit',
  'clampSidebarWidth',
  'sidebarWidthPreference',
  'storeSidebarWidth',
  'sidebarResizeEnabled',
  'syncSidebarResizeHandle',
  'renderSidebarWidth',
  'setSidebarWidth',
  'resetSidebarWidth',
  'beginSidebarResize',
  'updateSidebarResize',
  'finishSidebarResize',
  'handleSidebarResizeKey',
];
const functionSource = functionNames.map(sourceLine).join('\n');

function createClassList(initial = []) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
  };
}

function createHarness({ viewportWidth = 1280, storedWidth = null } = {}) {
  const storage = new Map();
  if (storedWidth !== null) storage.set('codexWeb.sidebarWidth.v1', String(storedWidth));
  const storageCalls = [];
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => {
      storage.set(key, String(value));
      storageCalls.push(['set', key, String(value)]);
    },
    removeItem: (key) => {
      storage.delete(key);
      storageCalls.push(['remove', key]);
    },
  };
  const styleValues = new Map();
  const document = {
    documentElement: {
      style: {
        setProperty: (key, value) => styleValues.set(key, value),
      },
    },
  };
  const app = {
    classList: createClassList(),
    getBoundingClientRect: () => ({ left: 20 }),
  };
  const attributes = new Map();
  const captured = new Set();
  const handle = {
    tabIndex: 0,
    setAttribute: (key, value) => attributes.set(key, String(value)),
    focusCalled: false,
    focus() { this.focusCalled = true; },
    setPointerCapture: (id) => captured.add(id),
    hasPointerCapture: (id) => captured.has(id),
    releasePointerCapture: (id) => captured.delete(id),
  };
  const desktopSidebarMedia = { matches: true };
  const window = { innerWidth: viewportWidth };
  const api = new Function(
    'window',
    'localStorage',
    'document',
    'desktopSidebarMedia',
    'app',
    'handle',
    'hideHistoryProjectPreview',
    'closeHistoryProjectMenu',
    `${configSource}\n${functionSource}\nsidebarResizeHandle=handle;return{
      sidebarWidthLimit,clampSidebarWidth,sidebarWidthPreference,storeSidebarWidth,
      renderSidebarWidth,setSidebarWidth,resetSidebarWidth,beginSidebarResize,
      updateSidebarResize,finishSidebarResize,handleSidebarResizeKey,
      state:()=>({sidebarPreferredWidth,sidebarRenderedWidth,sidebarResizePointerId})
    }`,
  )(
    window,
    localStorage,
    document,
    desktopSidebarMedia,
    app,
    handle,
    () => {},
    () => {},
  );
  return { api, app, attributes, captured, desktopSidebarMedia, handle, storage, storageCalls, styleValues, window };
}

test('sidebar width stays inside the desktop range and preserves the main canvas', () => {
  const wide = createHarness({ viewportWidth: 1280 });
  assert.equal(wide.api.sidebarWidthLimit(), 480);
  assert.equal(wide.api.clampSidebarWidth(Number.NaN), 316);
  assert.equal(wide.api.clampSidebarWidth(120), 240);
  assert.equal(wide.api.clampSidebarWidth(333.6), 334);
  assert.equal(wide.api.clampSidebarWidth(900), 480);

  const narrow = createHarness({ viewportWidth: 821 });
  assert.equal(narrow.api.sidebarWidthLimit(), 341);
  assert.equal(narrow.api.clampSidebarWidth(480), 341);
  assert.equal(narrow.api.sidebarWidthLimit(700), 240);
});

test('stored width restores safely and updates the separator accessibility state', () => {
  const valid = createHarness({ storedWidth: 420 });
  assert.equal(valid.api.sidebarWidthPreference(), 420);
  valid.api.setSidebarWidth(valid.api.sidebarWidthPreference());
  assert.equal(valid.styleValues.get('--sidebar-width'), '420px');
  assert.equal(valid.attributes.get('aria-valuenow'), '420');
  assert.equal(valid.attributes.get('aria-valuetext'), '420 像素');
  assert.equal(valid.attributes.get('aria-valuemax'), '480');

  assert.equal(createHarness({ storedWidth: 'broken' }).api.sidebarWidthPreference(), 316);
  assert.equal(createHarness({ storedWidth: 999 }).api.sidebarWidthPreference(), 480);
  assert.equal(createHarness({ storedWidth: 100 }).api.sidebarWidthPreference(), 240);
});

test('pointer dragging clamps live width and persists only when the drag ends', () => {
  const harness = createHarness();
  harness.api.setSidebarWidth(316);
  let prevented = false;
  harness.api.beginSidebarResize({ button: 0, isPrimary: true, pointerId: 7, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(harness.handle.focusCalled, true);
  assert.equal(harness.app.classList.contains('sidebarResizing'), true);
  assert.equal(harness.storageCalls.length, 0);

  harness.api.updateSidebarResize({ pointerId: 7, clientX: 900 });
  assert.equal(harness.api.state().sidebarRenderedWidth, 480);
  assert.equal(harness.storageCalls.length, 0);

  harness.api.finishSidebarResize({ pointerId: 7 });
  assert.equal(harness.app.classList.contains('sidebarResizing'), false);
  assert.deepEqual(harness.storageCalls.at(-1), ['set', 'codexWeb.sidebarWidth.v1', '480']);
  assert.equal(harness.captured.size, 0);
});

test('keyboard resizing, reset, collapse, and mobile states remain bounded', () => {
  const harness = createHarness({ storedWidth: 400 });
  harness.api.setSidebarWidth(400);
  const key = (keyName, shiftKey = false) => {
    let prevented = false;
    harness.api.handleSidebarResizeKey({ key: keyName, shiftKey, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(key('ArrowRight'), true);
  assert.equal(harness.api.state().sidebarRenderedWidth, 408);
  assert.equal(key('ArrowLeft', true), true);
  assert.equal(harness.api.state().sidebarRenderedWidth, 376);
  assert.equal(key('Home'), true);
  assert.equal(harness.api.state().sidebarRenderedWidth, 240);
  assert.equal(key('End'), true);
  assert.equal(harness.api.state().sidebarRenderedWidth, 480);
  harness.api.resetSidebarWidth();
  assert.equal(harness.api.state().sidebarRenderedWidth, 316);
  assert.deepEqual(harness.storageCalls.at(-1), ['remove', 'codexWeb.sidebarWidth.v1']);

  harness.app.classList.add('sideCollapsed');
  assert.equal(key('ArrowRight'), false);
  assert.equal(harness.api.state().sidebarRenderedWidth, 316);
  harness.desktopSidebarMedia.matches = false;
  harness.app.classList.remove('sideCollapsed');
  assert.equal(key('ArrowRight'), false);
});

test('the separator contract exposes a desktop hit area without changing mobile layout', () => {
  assert.match(inlineScript, /sidebarResizeHandle\.id='sidebarResizeHandle'/);
  assert.match(inlineScript, /setAttribute\('role','separator'\)/);
  assert.match(inlineScript, /setAttribute\('aria-orientation','vertical'\)/);
  assert.match(inlineScript, /addEventListener\('pointercancel',finishSidebarResize\)/);
  assert.match(inlineScript, /addEventListener\('lostpointercapture',finishSidebarResize\)/);
  assert.match(inlineScript, /addEventListener\('dblclick',[\s\S]*?resetSidebarWidth\(\)/);

  assert.match(uiStyles, /\.sidebarResizeHandle\s*\{\s*display:\s*none;/);
  assert.match(uiStyles, /@media \(min-width: 821px\)[\s\S]*?\.sidebarResizeHandle\s*\{[\s\S]*?cursor:\s*col-resize;[\s\S]*?touch-action:\s*none;/);
  assert.match(uiStyles, /grid-template-columns:\s*clamp\(240px, var\(--sidebar-width\), min\(480px, calc\(100vw - 480px\)\)\)/);
  assert.match(uiStyles, /\.app\.sidebarResizing\s*\{[\s\S]*?transition:\s*none;/);
  assert.match(uiStyles, /\.app\.sideCollapsed \.sidebarResizeHandle\s*\{\s*display:\s*none;/);
});
