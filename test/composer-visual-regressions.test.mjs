import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiStyles = readFileSync(path.join(ROOT, 'ui.css'), 'utf8');
const serverSource = readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');

test('composer project row and queued prompts share the native visual surface', () => {
  assert.match(
    uiStyles,
    /body\[data-theme="light"\] \.composerProjectToggle\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*#f6f6f6;[^}]*box-shadow:\s*none/s,
  );
  assert.match(
    uiStyles,
    /body\[data-theme="light"\] \.composerProjectToggle:hover,[^}]*\{[^}]*background:\s*#f6f6f6/s,
  );
  assert.match(
    uiStyles,
    /body\[data-theme="light"\] \.box,[^}]*\{[^}]*border-color:\s*#e2e2e2/s,
  );
  assert.match(
    uiStyles,
    /\.promptQueue\s*\{[^}]*border-bottom-color:\s*transparent;[^}]*background:\s*transparent/s,
  );
  assert.match(
    uiStyles,
    /body\[data-theme="dark"\] \.promptQueue\s*\{[^}]*border-bottom-color:\s*transparent;[^}]*background:\s*transparent/s,
  );
  assert.match(
    uiStyles,
    /\.promptQueueRow:hover\s*\{[^}]*background:\s*transparent/s,
  );
  assert.match(
    uiStyles,
    /\.promptQueueRow\.sending\s*\{[^}]*background:\s*transparent/s,
  );
  assert.match(
    uiStyles,
    /\.promptQueueRow\.failed\s*\{[^}]*background:\s*transparent/s,
  );
  assert.match(
    uiStyles,
    /body\[data-chat-bg="skin"\] \.promptQueue\s*\{[^}]*background:\s*transparent;[^}]*backdrop-filter:\s*none/s,
  );
  assert.match(
    uiStyles,
    /body \.composer > \.box,[^}]*body \.composer > \.box:focus-within\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s,
  );
  assert.match(
    uiStyles,
    /body\[data-theme="light"\] \.composer:has\(> \.composerProjectPicker\.hidden\) > \.box\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s,
  );
  assert.match(
    uiStyles,
    /body\[data-theme="dark"\] \.composer:has\(> \.composerProjectPicker\.hidden\) > \.box\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s,
  );
  assert.match(
    uiStyles,
    /\.activityClusterText\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;[^}]*justify-self:\s*start/s,
  );
});

test('running history dots stay before App without changing the row grid', () => {
  assert.match(uiStyles, /body \.hist\s*\{[^}]*position:\s*relative/s);
  assert.match(
    uiStyles,
    /body \.hist\.native\.running\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto/s,
  );
  assert.match(
    uiStyles,
    /\.histRunning\s*\{[^}]*position:\s*absolute;[^}]*left:\s*-4px;[^}]*pointer-events:\s*none/s,
  );
  assert.match(
    serverSource,
    /if\(source==='codex'\)\{\s*if\(running\)row\.appendChild\(running\);[\s\S]*row\.appendChild\(badge\);\s*}\s*row\.appendChild\(open\)/,
  );
});

test('reasoning effort uses an accessible six-step slider and keeps select synchronization', () => {
  assert.match(serverSource, /function renderComposerReasoningSlider\(source\)/);
  assert.match(
    serverSource,
    /range\.type='range';\s*range\.className='composerReasoningRange';\s*range\.min='0';\s*range\.max=String\(levels\.length-1\);\s*range\.step='1'/,
  );
  assert.match(serverSource, /range\.setAttribute\('aria-label','推理强度'\)/);
  assert.match(serverSource, /range\.setAttribute\('aria-valuetext',label\)/);
  assert.match(
    serverSource,
    /if\(kind==='reasoning'\)\{\s*renderComposerReasoningSlider\(source\);\s*return;/,
  );
  assert.match(
    serverSource,
    /range\.addEventListener\('input',\(\)=>\{[\s\S]*selectValue\(levels\[sliderIndex\]\.value\)/,
  );
  assert.match(serverSource, /source\.dispatchEvent\(new Event\('change',\{bubbles:true\}\)\)/);
  assert.match(
    uiStyles,
    /\.composerReasoningRange\s*\{[^}]*appearance:\s*none;[^}]*cursor:\s*pointer/s,
  );
  assert.match(
    uiStyles,
    /\.composerReasoningRange::-webkit-slider-thumb\s*\{[^}]*width:\s*15px;[^}]*border:\s*2px solid var\(--text\)/s,
  );
  assert.match(uiStyles, /\.composerReasoningRange:focus-visible\s*\{[^}]*box-shadow:\s*none/s);
  assert.match(
    uiStyles,
    /\.composerReasoningMarks\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--reasoning-step-count\), 1fr\)/s,
  );
});
