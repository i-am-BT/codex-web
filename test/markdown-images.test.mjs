import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('assistant markdown can inline local image paths', () => {
  const server = fs.readFileSync(path.join(root, 'server.mjs'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'ui.css'), 'utf8');
  for (const needle of [
    "app.get('/api/local-image'",
    'function enhanceMarkdownImages',
    'function createMarkdownImage',
    'function localImageProxyUrl',
    "'img'",
    'try{enhanceMarkdownImages(body)}catch(e){}',
  ]) {
    assert.ok(server.includes(needle), needle);
  }
  assert.ok(css.includes('.markdownImage'), 'markdownImage css');
  assert.ok(css.includes('.markdownImageRow'), 'markdownImageRow css');
});
