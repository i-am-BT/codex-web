import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('composer speech dictation helpers are present', () => {
  const server = fs.readFileSync(path.join(root, 'server.mjs'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'ui.css'), 'utf8');
  for (const needle of [
    'function toggleComposerSpeech',
    'function ensureComposerSpeechRecognition',
    'function stopComposerSpeech',
    'SpeechRecognition||window.webkitSpeechRecognition',
    "composerMicBtn.classList.add('listening')",
    'toggleComposerSpeech()',
  ]) {
    assert.ok(server.includes(needle), needle);
  }
  assert.ok(css.includes('.composerMicBtn.listening'), 'listening css');
});
