import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = fs.readFileSync(path.join(root, 'server.mjs'), 'utf8');
const css = fs.readFileSync(path.join(root, 'ui.css'), 'utf8');

function runtimeSourceFromTemplate(source) {
  // server.mjs embeds the browser script in a template literal, so regex escapes are doubled.
  return String(source || '').replaceAll('\\\\', '\\');
}

test('composer speech dictation helpers are present', () => {
  for (const needle of [
    'function toggleComposerSpeech',
    'function ensureComposerSpeechRecognition',
    'function stopComposerSpeech',
    'function ensureComposerMicrophoneAccess',
    'function joinComposerSpeechText',
    'SpeechRecognition||window.webkitSpeechRecognition',
    "composerMicBtn.classList.add('listening')",
    'toggleComposerSpeech()',
    '.composerMicBtn,.send,.cancelButton',
    'showComposerSpeechToast',
  ]) {
    assert.ok(server.includes(needle), needle);
  }
  assert.ok(css.includes('.composerMicBtn.listening'), 'listening css');
  assert.ok(css.includes('.composerSpeechToast'), 'toast css');
});

test('composer speech joins final and interim text without the broken /s$/ regex', () => {
  const start = server.indexOf('function joinComposerSpeechText');
  const end = server.indexOf('function stopComposerSpeech', start);
  assert.ok(start >= 0 && end > start, 'join helper missing');
  const helperSource = runtimeSourceFromTemplate(server.slice(start, end));
  const { joinComposerSpeechText } = new Function(`${helperSource}; return { joinComposerSpeechText };`)();
  assert.equal(joinComposerSpeechText('', '你好'), '你好');
  assert.equal(joinComposerSpeechText('你好', '世界'), '你好世界');
  assert.equal(joinComposerSpeechText('hello', 'world'), 'hello world');
  assert.equal(joinComposerSpeechText('hello ', 'world'), 'hello world');
  assert.equal(joinComposerSpeechText('hello', ', world'), 'hello, world');
  assert.ok(!server.slice(start, end).includes('/s$/'));
  assert.match(server.slice(start, end), /\\\\s\$/);
});

test('collapsed composer expand guard does not swallow mic clicks', () => {
  assert.match(server, /composerMicBtn,\.send,\.cancelButton/);
  assert.match(server, /Prevent the collapsed-composer expand guard from eating the mic click/);
  assert.match(server, /await ensureComposerMicrophoneAccess\(\)/);
  assert.match(server, /showComposerSpeechToast/);
});
