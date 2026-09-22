import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const server = await readFile(new URL('server.mjs', root), 'utf8');
const css = await readFile(new URL('ui.css', root), 'utf8');

test('新建任务提供聊天和工作模式选择', () => {
  assert.match(server, /id="newTaskModeOverlay"/);
  assert.match(server, /id="newTaskChatTab"[^>]*>聊天/);
  assert.match(server, /id="newTaskWorkTab"[^>]*>工作/);
  assert.match(server, /id="newTaskChatModel"[^>]*aria-label="聊天模型"/);
  assert.match(server, /CHATGPT_DEFAULT_MODEL = Object\.freeze\(\{ id: 'gpt-6-pro', displayName: '6 Pro' \}\)/);
  assert.match(server, /function syncChatGPTComposerModelSelect\(\)/);
  assert.match(server, /currentConversationSource==='chatgpt'/);
  assert.match(server, /function syncNewTaskChatModelOptions\(\)/);
  assert.match(server, /newTaskModeChatSettings\?\.toggleAttribute\('hidden',!chatSelected\)/);
  assert.match(server, /document\.getElementById\('newChat'\)\?\.addEventListener\('click', openNewTaskModePicker\)/);
  assert.match(server, /newTaskModeConfirm\?\.addEventListener\('click',confirmNewTaskMode\)/);
  assert.match(server, /function startNewChatMode\(mode='work',selectedModel=''\)/);
  assert.match(server, /startNewChatMode\('chat',selectedModel\)/);
  assert.match(server, /selectComposerModel\(chatModel\)/);
  assert.match(server, /currentConversationSource='web'/);
  assert.match(server, /async function sendLegacyChatMessage/);
  assert.match(server, /fetch\('\/api\/chat'/);
  assert.match(css, /\.newTaskModeOverlay/);
  assert.match(css, /\.newTaskModeChatSettings/);
});
