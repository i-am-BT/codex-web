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
    /body \.composer:has\(> \.composerProjectPicker:not\(\.hidden\)\)\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*padding:\s*0;[^}]*box-shadow:\s*none/s,
  );
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
    /body \.composer > \.box,[^}]*body \.composer > \.box:focus-within\s*\{[^}]*background:\s*var\(--surface\);[^}]*box-shadow:\s*none/s,
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
  assert.match(serverSource, /let composerReasoningInline = null/);
  assert.match(serverSource, /composerReasoningInline\.className='composerReasoningInline'/);
  assert.match(
    serverSource,
    /renderComposerReasoningSlider\(composerReasoningSelect,composerReasoningInline,\{focus:false,compact:true\}\)/,
  );
  assert.match(
    serverSource,
    /function openComposerModelSubmenu\(kind\)[\s\S]*composerModelMainMenu\?\.classList\.add\('hidden'\);[\s\S]*composerModelSubmenu\.classList\.remove\('hidden'\)/,
  );
  assert.match(serverSource, /function renderComposerReasoningSlider\(source,target=/);
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
  assert.match(
    uiStyles,
    /\.composerModelSubmenu\s*\{[^}]*position:\s*static;[^}]*width:\s*auto;[^}]*border:\s*0;[^}]*box-shadow:\s*none/s,
  );
  assert.match(
    uiStyles,
    /\.composerModelPanel\[data-submenu\] \.composerModelMainMenu\s*\{[^}]*display:\s*none/s,
  );
  assert.match(
    uiStyles,
    /\.composerReasoningInline \.composerReasoningSlider\s*\{[^}]*gap:\s*1px;[^}]*padding:\s*0 8px 7px/s,
  );
});

test('permission picker mirrors native approval profiles and preserves custom config semantics', () => {
  const helperStart = serverSource.indexOf('function cleanSandbox(value)');
  const helperEnd = serverSource.indexOf('function nativeSandboxPolicy(value, cwd)');
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helperSource = serverSource.slice(helperStart, helperEnd);
  const createPermissionSettings = new Function(
    'FORCE_FULL_ACCESS',
    'DEFAULT_SANDBOX',
    'DEFAULT_APPROVAL',
    `${helperSource}; return permissionSettingsFromRequest;`,
  );
  const permissionSettings = createPermissionSettings(false, 'read-only', 'never');
  assert.deepEqual(permissionSettings({ permissionMode: 'ask' }), {
    permissionMode: 'ask', sandbox: 'workspace-write', approval: 'on-request', approvalsReviewer: 'user',
  });
  assert.deepEqual(permissionSettings({ permissionMode: 'auto' }), {
    permissionMode: 'auto', sandbox: 'workspace-write', approval: 'on-request', approvalsReviewer: 'guardian_subagent',
  });
  assert.deepEqual(permissionSettings({ permissionMode: 'full' }), {
    permissionMode: 'full', sandbox: 'danger-full-access', approval: 'never', approvalsReviewer: 'user',
  });
  assert.deepEqual(permissionSettings({ permissionMode: 'custom' }), {
    permissionMode: 'custom', sandbox: undefined, approval: undefined, approvalsReviewer: undefined,
  });
  assert.deepEqual(createPermissionSettings(true, 'read-only', 'untrusted')({ permissionMode: 'custom' }), {
    permissionMode: 'full', sandbox: 'danger-full-access', approval: 'never', approvalsReviewer: 'user',
  });

  assert.match(
    serverSource,
    /requestedMode === 'ask'[\s\S]*permissionMode: 'ask', sandbox: 'workspace-write', approval: 'on-request', approvalsReviewer: 'user'/,
  );
  assert.match(
    serverSource,
    /requestedMode === 'auto'[\s\S]*permissionMode: 'auto', sandbox: 'workspace-write', approval: 'on-request', approvalsReviewer: 'guardian_subagent'/,
  );
  assert.match(
    serverSource,
    /requestedMode === 'full'[\s\S]*permissionMode: 'full', sandbox: 'danger-full-access', approval: 'never', approvalsReviewer: 'user'/,
  );
  assert.match(
    serverSource,
    /requestedMode === 'custom'[\s\S]*permissionMode: 'custom', sandbox: undefined, approval: undefined, approvalsReviewer: undefined/,
  );
  assert.match(serverSource, /useAppServerPermissionDefault: turn\.permissionMode === 'custom' \? true : undefined/);
  assert.match(serverSource, /options\.setAttribute\('role','radiogroup'\)/);
  assert.match(serverSource, /option\.setAttribute\('role','radio'\)/);
  assert.match(serverSource, /option\.setAttribute\('aria-checked',String\(selected\)\)/);
  assert.match(serverSource, /option\.tabIndex=selected\?0:-1/);
  assert.match(serverSource, /event\.key==='ArrowDown'\|\|event\.key==='ArrowRight'/);
  assert.match(serverSource, /else if\(event\.key==='Home'\)next=0/);
  assert.match(serverSource, /if\(event\.key==='Escape'\)/);
  assert.match(serverSource, /permissionMode:\s*composerPermissionMode/);
  assert.match(serverSource, /\.\.\.composerPermissionPayload\(item\.permissionMode,item\.sandbox,item\.approval\)/);
  assert.match(serverSource, /\.\.\.composerPermissionPayload\(\)/);

  assert.match(
    uiStyles,
    /\.composerPermissionPanel\s*\{[^}]*width:\s*min\(360px, calc\(100vw - 24px\)\);[^}]*max-height:\s*min\(410px, calc\(100dvh - 96px\)\)/s,
  );
  assert.match(
    uiStyles,
    /\.composerPermissionOption\s*\{[^}]*min-height:\s*58px;[^}]*grid-template-columns:\s*24px minmax\(0, 1fr\) 20px/s,
  );
  assert.match(uiStyles, /\.composerPermissionOption\[aria-checked="true"\] \.composerPermissionCheck\s*\{[^}]*opacity:\s*1/s);
  assert.match(uiStyles, /\.composerPermissionOption\[data-permission-mode="full"\]\[aria-checked="true"\][^}]*#f2773d/s);
  assert.match(uiStyles, /@media \(max-width: 520px\)[\s\S]*\.composerPermissionPanel\s*\{[^}]*width:\s*min\(360px, calc\(100vw - 20px\)\)/s);
});
