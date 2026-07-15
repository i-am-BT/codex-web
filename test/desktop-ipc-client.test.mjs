import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CodexDesktopIpcClient,
  isCodexDesktopIpcUnavailableError,
} from '../desktop-ipc-client.mjs';

test('routes a turn through the Codex Desktop owner IPC client', async () => {
  const fixture = await createRouterFixture();
  let discoveryResponse;
  const discoveryHandled = new Promise((resolve) => {
    discoveryResponse = resolve;
  });

  fixture.onMessage = (socket, message) => {
    if (message.method === 'initialize') {
      sendFrame(socket, {
        type: 'response',
        requestId: message.requestId,
        resultType: 'success',
        method: 'initialize',
        result: { clientId: 'web-client-id' },
      });
      sendFrame(socket, {
        type: 'client-discovery-request',
        requestId: 'discovery-1',
        request: { method: 'unknown-method', version: 1, params: {} },
      });
      return;
    }

    if (message.type === 'client-discovery-response') {
      discoveryResponse(message);
      return;
    }

    assert.equal(message.method, 'thread-follower-start-turn');
    assert.equal(message.version, 1);
    assert.equal(message.sourceClientId, 'web-client-id');
    assert.equal(message.params.conversationId, 'thread-1');
    assert.equal(message.params.turnStartParams.input[0].text, '同步测试');
    sendFrame(socket, {
      type: 'response',
      requestId: message.requestId,
      resultType: 'success',
      method: message.method,
      handledByClientId: 'desktop-owner-id',
      result: { result: { turn: { id: 'turn-1', status: 'inProgress' } } },
    });
  };

  const client = new CodexDesktopIpcClient({
    socketPath: fixture.socketPath,
    requestTimeoutMs: 1000,
  });

  try {
    const result = await client.startTurn('thread-1', {
      input: [{ type: 'text', text: '同步测试', text_elements: [] }],
    });
    assert.equal(result.turn.id, 'turn-1');
    assert.deepEqual(await discoveryHandled, {
      type: 'client-discovery-response',
      requestId: 'discovery-1',
      response: { canHandle: false },
    });
  } finally {
    client.close();
    await fixture.close();
  }
});

test('marks a missing Desktop owner as a safe app-server fallback', async () => {
  const fixture = await createRouterFixture();
  fixture.onMessage = (socket, message) => {
    if (message.method === 'initialize') {
      sendFrame(socket, {
        type: 'response',
        requestId: message.requestId,
        resultType: 'success',
        method: 'initialize',
        result: { clientId: 'web-client-id' },
      });
      return;
    }
    sendFrame(socket, {
      type: 'response',
      requestId: message.requestId,
      resultType: 'error',
      error: 'no-client-found',
    });
  };

  const client = new CodexDesktopIpcClient({
    socketPath: fixture.socketPath,
    requestTimeoutMs: 1000,
  });

  try {
    await assert.rejects(
      client.startTurn('thread-2', { input: [{ type: 'text', text: 'fallback', text_elements: [] }] }),
      (error) => isCodexDesktopIpcUnavailableError(error) && error.reason === 'no-client-found',
    );
  } finally {
    client.close();
    await fixture.close();
  }
});

async function createRouterFixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-desktop-ipc-test-'));
  const socketPath = path.join(temporary, 'router.sock');
  const sockets = new Set();
  const fixture = {
    socketPath,
    onMessage: () => {},
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await rm(temporary, { recursive: true, force: true });
    },
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    attachFrameReader(socket, (message) => fixture.onMessage(socket, message));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return fixture;
}

function attachFrameReader(socket, onMessage) {
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0);
      if (buffer.length < size + 4) return;
      const payload = buffer.subarray(4, size + 4);
      buffer = buffer.subarray(size + 4);
      onMessage(JSON.parse(payload.toString('utf8')));
    }
  });
}

function sendFrame(socket, message) {
  const payload = Buffer.from(JSON.stringify(message));
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  socket.write(frame);
}
