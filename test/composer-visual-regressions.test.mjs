import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiStyles = readFileSync(path.join(ROOT, 'ui.css'), 'utf8');
const serverSource = readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');

test('new-task composer treats project selection as optional', () => {
  assert.match(serverSource, /composerProjectPanel\.className='composerProjectPanel hidden'/);
  assert.match(serverSource, /projectTitle\.textContent='项目路径（可选）'/);
  assert.match(serverSource, /noProjectName\.textContent='无项目'/);
  assert.match(serverSource, /noProjectDetail\.textContent='使用默认工作目录'/);
  assert.match(serverSource, /projectName=projectPath\?historyProjectName\(projectPath\):'选择项目（可选）'/);
  assert.match(serverSource, /function resetNewTaskComposerCwd\(\)\{\s*cwd\.value=''/);
  assert.match(serverSource, /直接输入任务；项目路径可选。/);
});

test('running output can jump back to the latest item without joining the composer layout', () => {
  assert.match(serverSource, /jumpToLatest\.id='jumpToLatest'/);
  assert.match(serverSource, /jumpToLatest\.setAttribute\('aria-controls','chat'\)/);
  assert.match(serverSource, /jumpToLatestDots\.className='jumpToLatestDots'/);
  assert.match(serverSource, /jumpToLatestDots\.setAttribute\('aria-hidden','true'\)/);
  assert.match(serverSource, /for\(let index=0;index<3;index\+=1\)\{[\s\S]*?jumpToLatestDot\.className='jumpToLatestDot'/);
  assert.match(serverSource, /jumpToLatest\?\.addEventListener\('click',scrollToLatestOutput\)/);
  assert.match(serverSource, /function updateJumpToLatestButton\(\)[\s\S]*?activeMainView==='chat'[\s\S]*?currentConversationSource==='codex'[\s\S]*?webRunActive[\s\S]*?!nativeLiveFollowBottom/s);
  assert.match(serverSource, /function scrollToLatestOutput\(\)[\s\S]*?chat\.scrollTo\(\{top:chat\.scrollHeight,behavior:reducedMotion\?'auto':'smooth'\}\)/);
  assert.match(uiStyles, /body \.main > \.jumpToLatest\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*9;[^}]*bottom:\s*calc\(var\(--composer-overlay-height, 132px\) \+ 16px\);[^}]*width:\s*40px;[^}]*height:\s*40px;[^}]*box-shadow:\s*none/s);
  assert.match(uiStyles, /body \.main > \.jumpToLatest \.jumpToLatestDot\s*\{[^}]*width:\s*4px;[^}]*height:\s*4px;[^}]*background:\s*currentColor/s);
  assert.match(uiStyles, /body \.main > \.jumpToLatest:not\(\.hidden\) \.jumpToLatestDot\s*\{[^}]*animation:\s*jumpToLatestDotFloat 720ms/s);
  assert.match(uiStyles, /@keyframes jumpToLatestDotFloat\s*\{[\s\S]*?transform:\s*translateY\(-2px\)/);
  assert.match(uiStyles, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?body \.main > \.jumpToLatest \.jumpToLatestDot\s*\{[^}]*animation:\s*none;[^}]*transform:\s*none/s);
  assert.match(uiStyles, /@media\(max-width:820px\)\s*\{[\s\S]*?body \.main > \.jumpToLatest\s*\{[^}]*bottom:\s*calc\(var\(--composer-overlay-height, 132px\) \+ 12px\);[^}]*width:\s*44px;[^}]*height:\s*44px/s);
  assert.doesNotMatch(uiStyles.match(/body \.main > \.jumpToLatest\s*\{[^}]*\}/)?.[0] || '', /keyboard-inset|safe-area-inset/);
});

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
    /\.promptQueue\s*\{[^}]*Above the input capsule/s,
  );
  assert.match(
    uiStyles,
    /body\[data-theme="dark"\] \.promptQueue\s*\{[^}]*background:/s,
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
    /body\[data-chat-bg="skin"\] \.promptQueue\s*\{[^}]*border-color:/s,
  );
  assert.match(
    uiStyles,
    /body \.composer > \.box,[^}]*body \.composer > \.box:focus-within\s*\{[^}]*background:\s*var\(--surface\);[^}]*box-shadow:\s*none/s,
  );
  assert.match(
    uiStyles,
    /body\[data-theme="light"\] \.composer:has\(> \.composerProjectPicker\.hidden\) > \.box\s*\{[^}]*background:\s*#ffffff;[^}]*box-shadow:\s*none/s,
  );
  assert.match(
    uiStyles,
    /body\[data-theme="dark"\] \.composer:has\(> \.composerProjectPicker\.hidden\) > \.box\s*\{[^}]*background:\s*var\(--surface\);[^}]*box-shadow:\s*none/s,
  );
  assert.match(
    uiStyles,
    /@media \(min-width: 821px\)[\s\S]*?body \.main\s*\{[^}]*position:\s*relative;[^}]*height:\s*100dvh/s,
  );
  assert.match(
    uiStyles,
    /@media \(min-width: 821px\)[\s\S]*?body \.chat\s*\{[^}]*padding-bottom:\s*max\(132px, calc\(var\(--composer-overlay-height, 132px\) \+ 12px\)\);[^}]*scroll-padding-bottom:\s*max\(132px, calc\(var\(--composer-overlay-height, 132px\) \+ 12px\)\)/s,
  );
  assert.match(
    uiStyles,
    /body \.main:has\(> \.composer > \.editedFilesResult\.live\.withPlan\) > \.chat\s*\{[^}]*padding-bottom:\s*max\(202px, calc\(var\(--composer-overlay-height, 190px\) \+ 12px\)\);[^}]*scroll-padding-bottom:\s*max\(202px, calc\(var\(--composer-overlay-height, 190px\) \+ 12px\)\)/s,
  );
  assert.match(
    uiStyles,
    /@media \(min-width: 821px\)[\s\S]*?body \.composer\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*auto 0 0;[^}]*background:\s*transparent;[^}]*pointer-events:\s*none/s,
  );
  assert.match(uiStyles, /body \.composer > \*\s*\{[^}]*pointer-events:\s*auto/s);
  assert.match(
    uiStyles,
    /\.activityClusterText\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*justify-self:\s*stretch;[^}]*text-overflow:\s*ellipsis/s,
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
    /\.histRunning\s*\{[^}]*position:\s*absolute;[^}]*left:\s*-7px;[^}]*pointer-events:\s*none/s,
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
    /\.composerReasoningRange::-webkit-slider-thumb\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;[^}]*border:\s*0;[^}]*background:\s*#ffffff/s,
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
    /\.composerReasoningInline \.composerReasoningSlider\s*\{[^}]*gap:\s*0;[^}]*padding:\s*0/s,
  );
  assert.match(
    serverSource,
    /composerEffortName\.classList\.toggle\('maximum',Boolean\(reasoningEffort\.value\)&&reasoningEffort\.value===composerMaximumEffortValue\(reasoningEffort\)\)/,
  );
  assert.match(
    uiStyles,
    /\.composerEffortName\.maximum\s*\{[^}]*color:\s*var\(--primary\);[^}]*font-weight:\s*600/s,
  );
});

test('Fast mode is an accessible model capability beside the reasoning slider', () => {
  assert.match(serverSource, /let composerServiceTier = null/);
  assert.match(serverSource, /let composerFastToggle = null/);
  assert.match(serverSource, /let nativeModelServiceTiers = new Map\(\)/);
  assert.match(serverSource, /function loadNativeModelCapabilities\(/);
  assert.match(serverSource, /fetch\('\/api\/native-model-capabilities'/);

  const renderStart = serverSource.indexOf('function renderComposerFastToggle(');
  const renderEnd = serverSource.indexOf('\nfunction ', renderStart + 1);
  assert.ok(renderStart >= 0 && renderEnd > renderStart, 'missing Fast toggle renderer');
  const renderSource = serverSource.slice(renderStart, renderEnd);
  assert.match(renderSource, /composerFastSupported/);
  assert.match(renderSource, /composerFastToggle/);
  assert.match(renderSource, /priority/);
  assert.match(renderSource, /aria-pressed/);
  assert.match(renderSource, /hidden|disabled/);

  const supportStart = serverSource.indexOf('function composerFastSupported(');
  const supportEnd = serverSource.indexOf('\nfunction ', supportStart + 1);
  assert.ok(supportStart >= 0 && supportEnd > supportStart, 'missing Fast capability check');
  const supportSource = serverSource.slice(supportStart, supportEnd);
  assert.match(supportSource, /nativeModelServiceTiers/);
  assert.match(supportSource, /priority/);

  assert.match(serverSource, /composerFastToggle\.className='composerFastToggle(?: hidden)?'/);
  assert.match(serverSource, /setIconLabel\(composerFastToggle,'zap','Fast',true\)/);
  assert.match(serverSource, /function syncNativeComposerServiceTier/);
  assert.match(serverSource, /thread\/settings\/update/);
  assert.match(serverSource, /syncNative=true/);
  assert.match(serverSource, /body:JSON\.stringify\(\{serviceTier:requested\}\)/);
  assert.match(
    uiStyles,
    /\.composerReasoningInline\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto/s,
  );
  assert.match(uiStyles, /\.composerFastToggle\s*\{/);
  assert.match(uiStyles, /\.composerFastToggle(?:\.active|\[aria-pressed="true"\])\s*\{/);
});

test('composer context window uses real session data with an accessible progress detail', () => {
  assert.match(serverSource, /let currentContextUsedTokens = null/);
  assert.match(serverSource, /let currentContextWindowTokens = null/);
  assert.match(
    serverSource,
    /function syncComposerContextWindow\(contextWindow\)[\s\S]*contextWindow\?\.usedTokens[\s\S]*contextWindow\?\.maxTokens/,
  );
  assert.match(serverSource, /composerContextToggle\.setAttribute\('aria-controls','composerContextPanel'\)/);
  assert.match(serverSource, /composerContextToggle\.setAttribute\('aria-haspopup','dialog'\)/);
  assert.match(serverSource, /composerContextPanel\.setAttribute\('role','dialog'\)/);
  assert.match(serverSource, /composerContextToggle\.addEventListener\('mouseenter'/);
  assert.match(serverSource, /showComposerContextDetails\(\{pinned:true\}\)/);
  assert.match(serverSource, /syncComposerContextWindow\(conversation\.contextWindow\|\|null\)/);
  assert.match(
    uiStyles,
    /\.composerContextToggle\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px/s,
  );
  assert.match(
    uiStyles,
    /\.composerContextRing\s*\{[^}]*width:\s*15px;[^}]*height:\s*15px;[^}]*conic-gradient/s,
  );
  assert.match(
    uiStyles,
    /body \.composerContextPanel\s*\{[^}]*width:\s*min\(176px,[^}]*border-radius:\s*11px;[^}]*text-align:\s*center/s,
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
    permissionMode: 'auto', sandbox: 'workspace-write', approval: 'on-request', approvalsReviewer: 'auto_review',
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
    /requestedMode === 'auto'[\s\S]*permissionMode: 'auto', sandbox: 'workspace-write', approval: 'on-request', approvalsReviewer: 'auto_review'/,
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
  assert.match(serverSource, /function isAutoApprovalsReviewer\(value\)/);
  assert.match(serverSource, /isAutoApprovalsReviewer\(metadata\.approvalsReviewer\)/);
  assert.match(serverSource, /\['auto_review', 'guardian_subagent'\]/);
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
    /\.composerPermissionPanel\s*\{[^}]*width:\s*min\(320px, calc\(100vw - 24px\)\);[^}]*max-height:\s*min\(410px, calc\(100dvh - 96px\)\)/s,
  );
  assert.match(
    uiStyles,
    /\.composerPermissionOption\s*\{[^}]*min-height:\s*50px;[^}]*grid-template-columns:\s*22px minmax\(0, 1fr\) 18px/s,
  );
  assert.match(uiStyles, /\.composerPermissionOption\[aria-checked="true"\] \.composerPermissionCheck\s*\{[^}]*opacity:\s*1/s);
  assert.match(uiStyles, /\.composerPermissionOption\[data-permission-mode="full"\]\[aria-checked="true"\][^}]*#f2773d/s);
  assert.match(uiStyles, /@media \(max-width: 520px\)[\s\S]*\.composerPermissionPanel\s*\{[^}]*width:\s*min\(360px, calc\(100vw - 20px\)\)/s);
});
