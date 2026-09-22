import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractPipePathsFromProcessList,
  resolveCodexAppToolsCwd,
  resolveCodexMcpNodePath,
  sanitizeChatGPTConversationPayload,
  sanitizeChatGPTThreads,
} from '../chatgpt-conversations.mjs';

test('sanitizes and deduplicates only ChatGPT conversations', () => {
  const result = sanitizeChatGPTThreads({
    pinnedThreads: [
      { id: 'chat-pinned', kind: 'chatgpt', title: '  置顶   聊天  ', updatedAt: 123, pinnedIndex: 2 },
    ],
    threads: [
      { id: 'chat-pinned', kind: 'chatgpt', title: '重复项', updatedAt: 122 },
      { id: 'codex-task', kind: 'codex', title: '任务', updatedAt: 121 },
      { id: 'chat-recent', kind: 'chatgpt', title: '最近聊天', updatedAt: 120 },
    ],
    unavailableSources: [{ source: 'chatgpt' }],
  });

  assert.deepEqual(result, {
    conversations: [
      {
        id: 'chat-pinned',
        title: '置顶 聊天',
        updatedAt: '1970-01-01T00:02:03.000Z',
        pinned: true,
      },
      {
        id: 'chat-recent',
        title: '最近聊天',
        updatedAt: '1970-01-01T00:02:00.000Z',
        pinned: false,
      },
    ],
    unavailable: ['chatgpt'],
  });
});

test('resolves explicitly configured Codex bridge paths', () => {
  assert.equal(resolveCodexMcpNodePath({ nodePath: process.execPath }), process.execPath);
  assert.equal(
    resolveCodexAppToolsCwd({ appToolsCwd: process.cwd() }, process.execPath),
    process.cwd(),
  );
});

test('extracts active Codex App tool pipes from process environments', () => {
  assert.deepEqual(
    extractPipePathsFromProcessList([
      'node server.mjs CODEX_APP_TOOLS_PIPE_PATH=/tmp/codex-browser-use/active.sock',
      'node server.mjs CODEX_APP_TOOLS_PIPE_PATH=/tmp/codex-browser-use/active.sock',
      'unrelated CODEX_APP_TOOLS_PIPE_PATH=/tmp/ignored.txt',
    ].join('\n')),
    ['/tmp/codex-browser-use/active.sock'],
  );
});

test('normalizes read_thread content into chronological chat messages', () => {
  const result = sanitizeChatGPTConversationPayload({
    success: true,
    contentItems: [{
      type: 'inputText',
      text: JSON.stringify({
        thread: {
          id: '6aa9483a-5480-83ea-9fee-9dd8790a09db',
          kind: 'chatgpt',
          title: '本地聊天',
          status: { type: 'idle' },
          createdAt: 100,
          updatedAt: 200,
        },
        page: { order: 'newest_first', nextCursor: 'cursor-1', hasMore: true },
        turns: [
          { id: '6b000001-0000-4000-8000-000000000001', completedAt: 200, items: [{ type: 'agentMessage', text: '答复' }] },
          { id: '6b000001-0000-4000-8000-000000000000', startedAt: 100, items: [{ type: 'userMessage', content: [{ type: 'text', text: '问题' }] }] },
        ],
      }),
    }],
  });

  assert.equal(result.source, 'chatgpt');
  assert.equal(result.status, 'done');
  assert.equal(result.cursor, 'cursor-1');
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '答复' },
  ]);
});

test('preserves ChatGPT model metadata for composer mapping', () => {
  const result = sanitizeChatGPTConversationPayload({
    contentItems: [{
      type: 'inputText',
      text: JSON.stringify({
        thread: {
          id: '6aa9483a-5480-83ea-9fee-9dd8790a09db',
          title: '本地聊天',
          model: { id: 'gpt-6-pro', displayName: '6 Pro' },
        },
        turns: [],
      }),
    }],
  });

  assert.equal(result.model, 'gpt-6-pro');
  assert.equal(result.modelDisplayName, '6 Pro');
});
