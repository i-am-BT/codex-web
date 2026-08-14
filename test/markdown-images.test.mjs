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

  const helperSource = server.match(/function stripLocalImagePathWrappers[\s\S]*?(?=function localImageProxyUrl)/)?.[0];
  assert.ok(helperSource, 'local image path helpers');
  const normalizeLocalImagePath = new Function(`${helperSource}; return normalizeLocalImagePath;`)();
  assert.equal(
    normalizeLocalImagePath('/Volumes/ikirito/hermes-portrait-gallery/data/references/xiaohongshu/outfit_ref.jpg'),
    '/Volumes/ikirito/hermes-portrait-gallery/data/references/xiaohongshu/outfit_ref.jpg',
  );
  assert.equal(normalizeLocalImagePath('/tmp/grok-output/first.svg'), '/tmp/grok-output/first.svg');
  assert.equal(normalizeLocalImagePath('./second.SVG'), './second.SVG');
  assert.equal(normalizeLocalImagePath('/local-refs/xiaohongshu/outfit_ref.jpg'), '');
  assert.match(server, /if\(!standaloneLi&&!standaloneParagraph\)continue/);
  assert.match(server, /if\(codes\.length<2\)continue/);
  assert.match(server, /if\(!pathOnly\)continue/);
  assert.match(server, /if\(figures\.length!==codes\.length\)continue/);
  assert.match(server, /if\(run\.length<2\)return/);
  assert.match(server, /row\.className='markdownImageRow'/);
  assert.match(server, /for\(const fig of run\)row\.appendChild\(fig\)/);
});

test('queued screenshots prefer embedded image data over a stale local path', () => {
  const server = fs.readFileSync(path.join(root, 'server.mjs'), 'utf8');
  const helperSource = server.match(/function appQueueImageInput[\s\S]*?(?=\nfunction isAppQueueBrowserComment)/)?.[0];
  assert.ok(helperSource, 'app queue image helper');
  const appQueueImageInput = new Function(`${helperSource}; return appQueueImageInput;`)();
  const dataUrl = 'data:image/png;base64,aGVsbG8=';

  assert.deepEqual(appQueueImageInput(dataUrl, '/private/tmp/deleted.png'), {
    type: 'image',
    url: dataUrl,
  });
  assert.deepEqual(appQueueImageInput('', '/private/tmp/existing.png'), {
    type: 'localImage',
    path: '/private/tmp/existing.png',
  });
});
