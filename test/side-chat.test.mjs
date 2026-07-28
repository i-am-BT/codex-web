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
    "className='msg sideChatMsg '",
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
    'renderAssistantMarkdown(body,text)',
    'toolActivityPresentations',
    'createActivityBatch',
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
