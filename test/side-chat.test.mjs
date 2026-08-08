import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('side chat queue menu and pane helpers are present', () => {
  const server = fs.readFileSync(path.join(root, 'server.mjs'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'ui.css'), 'utf8');
  for (const needle of [
    'function openQueuedPromptInSideChat',
    'function ensureSideChatPane',
    'function ensureSideChatTabs',
    'function upsertSideChatTab',
    'function activateSideChatTab',
    'function closeSideChatTab',
    'let sideChatOpenTabs = []',
    "SIDE_CHAT_STORAGE_KEY='codexWeb.sideChat.v1'",
    "textContent='主会话'",
    'function createConversationMessageElement',
    'Open in side chat',
    'promptQueueMenu',
    'restoreSideChatIfNeeded',
    'SIDE_CHAT_WIDTH_STORAGE_KEY',
    'function enhanceSideChatResize',
    'function renderSideChatWidth',
    'sideChat:true',
    'markSideChatThread',
    'isSideChatThread',
    'async function steerQueuedPrompt',
    'applyServerPromptQueue(threadId,data.queue)',
    'renderAssistantMarkdown(body,text,options.turnId)',
    'toolActivityPresentations',
    'createActivityBatch',
    'createActivityCluster',
    'appendActivityBatchToCluster',
    'organizeTurnArtifactsForCompletion',
    'createCompletionMessage',
    'sideChatRenderUnfinishedTurn',
    'progressCommentary',
    "/steer",
    '运行中可发送引导',
    'composer.insertBefore(promptQueuePanel,queueAnchor)',
    "const showPane=sideChatView==='side'",
    "pane.style.display='none'",
  ]) {
    assert.ok(server.includes(needle), needle);
  }
  for (const needle of [
    '.sideChatPane',
    '.sideChatResizeHandle',
    '--side-chat-width',
    'sideChatResizing',
    '.sideChatTabs',
    '.sideChatTab',
    '.promptQueueMenu',
    '.main.sideChatOpen',
    'white-space: normal !important',
    'Above the input capsule, not inside it.',
    '.sideChatComposerBox',
    '.sideChatMeta',
    '.sideChatHeadActions',
    '.sideChatStatusDot',
    'sideChatMessages > .msg.user',
    'background: transparent',
    '.main.sideChatOpen.sideChatViewMain',
    '.main.sideChatOpen:has(> .sideChatPane.hidden)',
  ]) {
    assert.ok(css.includes(needle), needle);
  }
  for (const needle of [
    "box.className='sideChatComposerBox'",
    "sideChatInput.placeholder='向 Codex 提问'",
  ]) {
    assert.ok(server.includes(needle), needle);
  }
});

test('side chat projects tools through the same folded timeline components as the main chat', () => {
  const server = fs.readFileSync(path.join(root, 'server.mjs'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'ui.css'), 'utf8');
  const renderStart = server.indexOf('function renderSideChatMessages(messages,context={})');
  const renderEnd = server.indexOf('async function syncSideChatConversation()', renderStart);
  const renderer = server.slice(renderStart, renderEnd);
  const toolStart = server.indexOf('function sideChatAppendToolBatch(');
  const toolEnd = server.indexOf('function sideChatAppendToolMessage(', toolStart);
  const toolProjection = server.slice(toolStart, toolEnd);
  const completionStart = server.indexOf('function sideChatFinalizeTurn(');
  const completionEnd = server.indexOf('function sideChatRenderUnfinishedTurn(', completionStart);
  const completionProjection = server.slice(completionStart, completionEnd);

  assert.ok(renderStart >= 0 && renderEnd > renderStart, 'side chat renderer');
  assert.match(renderer, /createConversationMessageElement\(role,text,/);
  assert.match(renderer, /sideChatAppendToolMessage\(turn,message,renderContext\)/);
  assert.doesNotMatch(renderer, /sideChatMessages\.appendChild\(createActivityBatch/);
  assert.match(toolProjection, /state\.currentCluster=createActivityCluster\('tools',state\.pendingReasoning\)/);
  assert.match(toolProjection, /appendActivityBatchToCluster\(state\.currentCluster,batch\)/);
  assert.match(completionProjection, /organizeTurnArtifactsForCompletion\(state\.artifacts,anchor\)/);
  assert.match(completionProjection, /createCompletionMessage\(text,organized\.processElements,state\.turnId/);
  assert.match(server, /panel\.className='liveProcessPanel'/);
  assert.match(server, /timeline\.className='completionTimeline liveProcessTimeline'/);
  assert.match(css, /\.sideChatMessages > :is\([\s\S]*?\.activityCluster,[\s\S]*?\.liveProcessPanel,[\s\S]*?\.turnResultArtifacts[\s\S]*?\)\s*\{[^}]*width:\s*min\(var\(--composer-width\), 100%\);[^}]*max-width:\s*var\(--composer-width\)/s);
  assert.match(css, /\.sideChatMessages > \.msg\.user,[^}]*max-width:\s*min\(var\(--conversation-width\), 77%\)/s);
});

test('mobile navigation drawer fully covers side chat without hiding its close control', () => {
  const css = fs.readFileSync(path.join(root, 'ui.css'), 'utf8');

  assert.match(css, /body \.side \{\s*z-index: 50;/);
  assert.match(css, /body \.scrim \{\s*z-index: 40;/);
  assert.match(
    css,
    /body \.app\.menuOpen \.side,[\s\S]*?padding-top: calc\(env\(safe-area-inset-top, 0px\) \+ 68px\);[\s\S]*?background: var\(--surface\);/,
  );
  assert.match(
    css,
    /body \.app\.menuOpen \.main > \.top \{[\s\S]*?z-index: 60;[\s\S]*?background: transparent !important;[\s\S]*?backdrop-filter: none;[\s\S]*?pointer-events: none;/,
  );
  assert.match(css, /body \.app\.menuOpen \.main > \.top \.menuBtn \{\s*pointer-events: auto;/);
  assert.match(
    css,
    /body \.app\.menuOpen \.main > \.sideChatTabs \{[\s\S]*?visibility: hidden;[\s\S]*?pointer-events: none;/,
  );
  assert.match(
    css,
    /\.main\.sideChatOpen\.sideChatViewMain > \.composer,\s*\.main\.sideChatOpen:has\(> \.sideChatPane\.hidden\) > \.composer\s*\{[^}]*overflow:\s*visible;/s,
  );
});

test('side chat follow-up service tier stays isolated per tab', () => {
  const server = fs.readFileSync(path.join(root, 'server.mjs'), 'utf8');
  const sendStart = server.indexOf('async function sendSideChatMessage()');
  const sendEnd = server.indexOf('async function restoreSideChatIfNeeded()', sendStart);
  const queueOpenStart = server.indexOf('async function openQueuedPromptInSideChat(');
  assert.ok(sendStart >= 0 && sendEnd > sendStart, 'sendSideChatMessage source');
  assert.ok(queueOpenStart >= 0 && sendStart > queueOpenStart, 'openQueuedPromptInSideChat source');
  const sendSource = server.slice(sendStart, sendEnd);
  const queueOpenSource = server.slice(queueOpenStart, sendStart);

  assert.match(server, /const hasServiceTier=Object\.hasOwn\(options,'serviceTier'\)/);
  assert.match(server, /serviceTier:normalizeComposerServiceTier\(tab\.serviceTier\)/);
  assert.match(server, /if\(tab&&Object\.hasOwn\(metadata,'serviceTier'\)\)tab\.serviceTier=normalizeComposerServiceTier\(metadata\.serviceTier\)/);
  assert.match(queueOpenSource, /title:queuedPromptLabel\(item\)[\s\S]*serviceTier:item\.serviceTier/);
  assert.match(sendSource, /const sideChatServiceTier=normalizeComposerServiceTier\(tab\?\.serviceTier\)/);
  assert.match(sendSource, /serviceTier:sideChatServiceTier/);
  assert.doesNotMatch(sendSource, /serviceTier:composerServiceTier/);

  // Both explicit states must survive persistence; null represents Standard and priority represents Fast.
  assert.match(server, /serviceTier:hasServiceTier\?normalizeComposerServiceTier\(options\.serviceTier\):null/);
  assert.match(server, /serviceTier:normalizeComposerServiceTier\(tab\?\.serviceTier\)/);

  const normalizeSource = server.match(/function normalizeComposerServiceTier\(value\)\{[^}]+\}/)?.[0];
  const upsertStart = server.indexOf('function upsertSideChatTab(options={})');
  const upsertEnd = server.indexOf('function removeSideChatTab(', upsertStart);
  assert.ok(normalizeSource && upsertStart >= 0 && upsertEnd > upsertStart, 'side chat tier helpers');
  const upsertSource = server.slice(upsertStart, upsertEnd);
  const storedTiers = Function(`
    let sideChatOpenTabs=[];
    ${normalizeSource}
    ${upsertSource}
    upsertSideChatTab({threadId:'standard-tab',serviceTier:null});
    upsertSideChatTab({threadId:'fast-tab',serviceTier:'priority'});
    return sideChatOpenTabs.map((tab)=>tab.serviceTier);
  `)();
  assert.deepEqual(storedTiers, [null, 'priority']);
});
