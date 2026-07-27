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
