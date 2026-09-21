import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('sidebar expands local ChatGPT conversations without opening the external site', async () => {
  const [server, css] = await Promise.all([
    readFile(path.join(root, 'server.mjs'), 'utf8'),
    readFile(path.join(root, 'ui.css'), 'utf8'),
  ]);

  assert.match(server, /function ensureChatGPTSidebarEntry\(\)/);
  assert.match(server, /app\.get\('\/api\/chatgpt-conversations', requireAuth,/);
  assert.match(server, /app\.get\('\/api\/chatgpt-conversations\/:id', requireAuth,/);
  assert.match(server, /app\.post\('\/api\/chatgpt-conversations\/:id\/messages', requireAuth,/);
  assert.match(server, /readLocalChatGPTConversation\(/);
  assert.match(server, /sendLocalChatGPTMessage\(/);
  assert.match(server, /listLocalChatGPTConversations\(/);
  assert.match(server, /res\.status\(503\)\.json\(\{ error: '本机 ChatGPT 会话暂时不可用/);
  assert.match(server, /entry\.type='button'/);
  assert.doesNotMatch(server, /entry\.href='https:\/\/chatgpt\.com\/'/);
  assert.match(server, /const CHATGPT_SIDEBAR_COLLAPSED_STORAGE_KEY='codexWeb\.chatgptSidebarCollapsed'/);
  assert.match(server, /let chatGPTSidebarCollapsed=readChatGPTSidebarCollapsed\(\)/);
  assert.match(server, /entry\.setAttribute\('aria-expanded',String\(!chatGPTSidebarCollapsed\)\)/);
  assert.match(server, /conversations\.hidden=chatGPTSidebarCollapsed/);
  assert.match(server, /chatGPTSidebarCollapsed=expanded/);
  assert.match(server, /storeChatGPTSidebarCollapsed\(\)/);
  assert.match(server, /function readChatGPTSidebarCollapsed\(\)/);
  assert.match(server, /function storeChatGPTSidebarCollapsed\(\)/);
  assert.match(server, /fetch\('\/api\/chatgpt-conversations'/);
  assert.match(server, /history\.parentElement\.insertBefore\(section,history\)/);
  assert.match(server, /ensureChatGPTSidebarEntry\(\);/);
  assert.match(server, /function loadChatGPTSidebarConversations\(options=\{\}\)/);
  assert.match(server, /row\.addEventListener\('click',\(\)=>void loadChatGPTConversation/);
  assert.match(server, /function loadChatGPTConversation\(id, options\s*=\s*\{\}\)/);
  assert.match(server, /fetch\('\/api\/chatgpt-conversations\/'\s*\+\s*encodeURIComponent\((?:id|chatGPTId)\)/);
  assert.match(server, /function sendChatGPTMessage\(message\)/);
  assert.match(css, /\.chatgptSidebarEntry\s*\{/);
  assert.match(css, /\.chatgptSidebarEntry:focus-visible\s*\{/);
  assert.match(css, /\.chatgptSidebarConversations\s*\{/);
  assert.match(css, /\.chatgptSidebarConversation\s*\{/);
  assert.match(css, /\.conversationRestorePlaceholder\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.conversationRestorePlaceholder b\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
});
