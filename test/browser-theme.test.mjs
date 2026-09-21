import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('browser chrome follows initial, changed and custom theme colors', () => {
  const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(source, /<meta name="theme-color"/);
  assert.match(source, /applyDreamSkinTheme\(skin,theme\);syncBrowserTheme\(\)/);
  const code = source.slice(source.indexOf('function syncBrowserTheme(){'), source.indexOf('\nsyncBrowserTheme();'));
  const meta = { setAttribute(_name, value) { this.content = value; } };
  const document = { body: { dataset: {} }, documentElement: { style: {} }, querySelector: () => meta };
  let canvas = '';
  const sync = new Function('document', 'getComputedStyle', code + ';return syncBrowserTheme;')(document, () => ({ getPropertyValue: () => canvas }));
  for (const [theme, custom, expected] of [['dark', '', '#0b0d10'], ['light', '', '#f3f5f7'], ['dark', '#182028', '#182028']]) {
    document.body.dataset.theme = theme;
    canvas = custom;
    sync();
    assert.equal(meta.content, expected);
    assert.equal(document.documentElement.style.backgroundColor, expected);
    assert.equal(document.documentElement.style.colorScheme, theme);
  }
});
