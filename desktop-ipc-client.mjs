import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const INITIAL_CLIENT_ID = 'initializing-client';
const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 1500;
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_HISTORY_REQUEST_TIMEOUT_MS = 305000;
const METHOD_VERSIONS = new Map([
  ['initialize', 0],
  ['thread-follower-start-turn', 1],
  ['thread-follower-load-complete-history', 1],
  ['thread-follower-steer-turn', 1],
  ['thread-follower-interrupt-turn', 2],
  ['thread-follower-command-approval-decision', 1],
  ['thread-follower-file-approval-decision', 1],
  ['thread-follower-permissions-request-approval-response', 1],
  ['thread-follower-submit-user-input', 1],
  ['thread-follower-submit-mcp-server-elicitation-response', 1],
]);
const BROADCAST_VERSIONS = new Map([
  ['thread-archived', 2],
]);
const SAFE_FALLBACK_ERRORS = new Set([
  'disabled',
  'no-client-found',
  'request-version-mismatch',
  'socket-not-found',
]);

export class CodexDesktopIpcUnavailableError extends Error {
  constructor(message, reason = 'unavailable', options = {}) {
    super(message, options);
    this.name = 'CodexDesktopIpcUnavailableError';
    this.code = 'CODEX_DESKTOP_IPC_UNAVAILABLE';
    this.reason = reason;
  }
}

export function isCodexDesktopIpcUnavailableError(error) {
  return error instanceof CodexDesktopIpcUnavailableError
    || error?.code === 'CODEX_DESKTOP_IPC_UNAVAILABLE';
}

export function defaultCodexDesktopIpcSocketPath() {
  if (process.platform === 'win32') return String.raw`\\.\pipe\codex-ipc`;
  const uid = process.getuid?.();
  return path.join(os.tmpdir(), 'codex-ipc', uid === undefined ? 'ipc.sock' : `ipc-${uid}.sock`);
}

export class CodexDesktopIpcClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.enabled = options.enabled !== false;
    this.socketPath = options.socketPath || defaultCodexDesktopIpcSocketPath();
    this.clientType = options.clientType || 'codex-web';
    this.connectTimeoutMs = positiveTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.socket = null;
    this.startPromise = null;
    this.clientId = INITIAL_CLIENT_ID;
    this.readBuffer = Buffer.alloc(0);
    this.pending = new Map();
    this.closing = false;
  }

  get connected() {
    return Boolean(this.socket?.writable && this.clientId !== INITIAL_CLIENT_ID);
  }

  async start() {
    if (!this.enabled) {
      throw new CodexDesktopIpcUnavailableError('Codex Desktop IPC 已禁用', 'disabled');
    }
    if (this.connected) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.connectAndInitialize().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async request(method, params = {}, options = {}) {
    await this.start();
    const version = options.version ?? METHOD_VERSIONS.get(method);
    if (!Number.isInteger(version)) throw new Error(`Codex Desktop IPC 方法版本未知: ${method}`);
    return this.sendRequest(method, params, {
      version,
      timeoutMs: positiveTimeout(options.timeoutMs, this.requestTimeoutMs),
      targetClientId: String(options.targetClientId || ''),
    });
  }

  async broadcast(method, params = {}) {
    await this.start();
    const version = BROADCAST_VERSIONS.get(method);
    if (!Number.isInteger(version)) throw new Error(`Codex Desktop IPC 广播版本未知: ${method}`);
    this.writeMessage({
      type: 'broadcast',
      method,
      sourceClientId: this.clientId,
      version,
      params,
    });
  }

  async startTurn(conversationId, turnStartParams, options = {}) {
    const response = await this.request('thread-follower-start-turn', {
      conversationId,
      turnStartParams,
    }, options);
    const result = response?.result;
    if (!result?.turn?.id) throw new Error('Codex Desktop IPC 未返回有效 turn id');
    return result;
  }

  async loadCompleteHistory(conversationId, options = {}) {
    return this.request('thread-follower-load-complete-history', { conversationId }, {
      ...options,
      timeoutMs: positiveTimeout(
        options.timeoutMs,
        Math.max(this.requestTimeoutMs, DEFAULT_HISTORY_REQUEST_TIMEOUT_MS),
      ),
    });
  }

  async steerTurn(conversationId, params, options = {}) {
    const response = await this.request('thread-follower-steer-turn', {
      conversationId,
      ...params,
    }, options);
    const result = response?.result;
    if (!result?.turnId) throw new Error('Codex Desktop IPC 未返回有效 steer turn id');
    return result;
  }

  async interruptTurn(conversationId, options = {}) {
    return this.request('thread-follower-interrupt-turn', { conversationId }, options);
  }

  async threadArchived(conversationId, cwd) {
    return this.broadcast('thread-archived', {
      hostId: 'local',
      conversationId,
      cwd: String(cwd || ''),
    });
  }

  async commandApprovalDecision(conversationId, requestId, decision, options = {}) {
    return this.request('thread-follower-command-approval-decision', {
      conversationId,
      requestId,
      decision,
    }, options);
  }

  async fileApprovalDecision(conversationId, requestId, decision, options = {}) {
    return this.request('thread-follower-file-approval-decision', {
      conversationId,
      requestId,
      decision,
    }, options);
  }

  async permissionsApprovalResponse(conversationId, requestId, response, options = {}) {
    return this.request('thread-follower-permissions-request-approval-response', {
      conversationId,
      requestId,
      response,
    }, options);
  }

  async submitUserInput(conversationId, requestId, response, options = {}) {
    return this.request('thread-follower-submit-user-input', {
      conversationId,
      requestId,
      response,
    }, options);
  }

  async submitMcpElicitationResponse(conversationId, requestId, response, options = {}) {
    return this.request('thread-follower-submit-mcp-server-elicitation-response', {
      conversationId,
      requestId,
      response,
    }, options);
  }

  close() {
    this.closing = true;
    const socket = this.socket;
    this.socket = null;
    this.clientId = INITIAL_CLIENT_ID;
    this.readBuffer = Buffer.alloc(0);
    this.startPromise = null;
    this.rejectPending(new Error('Codex Desktop IPC 已关闭'));
    socket?.destroy();
  }

  async connectAndInitialize() {
    this.closing = false;
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    this.readBuffer = Buffer.alloc(0);
    socket.on('data', (chunk) => this.consumeData(socket, chunk));
    socket.on('close', () => this.handleSocketFailure(socket, new Error('Codex Desktop IPC 连接已关闭')));
    socket.on('error', (error) => this.handleSocketFailure(socket, error));

    try {
      await waitForConnect(socket, this.connectTimeoutMs);
      const response = await this.sendRequest('initialize', { clientType: this.clientType }, {
        version: METHOD_VERSIONS.get('initialize'),
        timeoutMs: this.connectTimeoutMs,
      });
      const clientId = String(response?.clientId || '');
      if (!clientId) throw new Error('Codex Desktop IPC 初始化未返回 client id');
      this.clientId = clientId;
      this.emit('connected', { clientId, socketPath: this.socketPath });
    } catch (error) {
      if (this.socket === socket) this.socket = null;
      socket.destroy();
      this.clientId = INITIAL_CLIENT_ID;
      const reason = error?.code === 'ENOENT' ? 'socket-not-found' : 'connect-failed';
      throw new CodexDesktopIpcUnavailableError(`Codex Desktop IPC 不可用: ${error.message}`, reason, { cause: error });
    }
  }

  sendRequest(method, params, { version, timeoutMs, targetClientId = '' }) {
    const socket = this.socket;
    if (!socket?.writable) {
      return Promise.reject(new CodexDesktopIpcUnavailableError('Codex Desktop IPC 未连接', 'not-connected'));
    }

    const requestId = randomUUID();
    const message = {
      type: 'request',
      requestId,
      sourceClientId: this.clientId,
      version,
      method,
      params,
      timeoutMs,
      ...(targetClientId ? { targetClientId } : {}),
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error(`Codex Desktop IPC 请求超时: ${method}`);
        error.code = 'CODEX_DESKTOP_IPC_TIMEOUT';
        reject(error);
      }, timeoutMs + 250);
      timer.unref?.();
      this.pending.set(requestId, { method, resolve, reject, timer });
      try {
        this.writeMessage(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  writeMessage(message) {
    const socket = this.socket;
    if (!socket?.writable) throw new CodexDesktopIpcUnavailableError('Codex Desktop IPC 未连接', 'not-connected');
    socket.write(encodeFrame(message));
  }

  consumeData(socket, chunk) {
    if (this.socket !== socket || !chunk.length) return;
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);

    while (this.readBuffer.length >= 4) {
      const frameBytes = this.readBuffer.readUInt32LE(0);
      if (frameBytes === 0 || frameBytes > MAX_FRAME_BYTES) {
        this.handleSocketFailure(socket, new Error(`Codex Desktop IPC 帧长度无效: ${frameBytes}`));
        return;
      }
      if (this.readBuffer.length < frameBytes + 4) return;
      const payload = this.readBuffer.subarray(4, frameBytes + 4);
      this.readBuffer = this.readBuffer.subarray(frameBytes + 4);
      try {
        this.handleMessage(JSON.parse(payload.toString('utf8')));
      } catch (error) {
        this.handleSocketFailure(socket, error);
        return;
      }
    }
  }

  handleMessage(message) {
    if (message?.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.resultType === 'success') {
        pending.resolve(message.result);
        return;
      }
      const reason = String(message.error || 'request-failed');
      if (SAFE_FALLBACK_ERRORS.has(reason)) {
        pending.reject(new CodexDesktopIpcUnavailableError(`Codex Desktop IPC 无可用 App owner: ${reason}`, reason));
        return;
      }
      const error = new Error(`Codex Desktop IPC 请求失败: ${reason}`);
      error.code = reason;
      pending.reject(error);
      return;
    }

    if (message?.type === 'client-discovery-request') {
      this.writeMessage({
        type: 'client-discovery-response',
        requestId: message.requestId,
        response: { canHandle: false },
      });
      return;
    }

    if (message?.type === 'request') {
      this.writeMessage({
        type: 'response',
        requestId: message.requestId,
        resultType: 'error',
        error: 'no-handler-for-request',
      });
      return;
    }

    if (message?.type === 'broadcast') this.emit('broadcast', message);
  }

  handleSocketFailure(socket, error) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.clientId = INITIAL_CLIENT_ID;
    this.readBuffer = Buffer.alloc(0);
    this.rejectPending(error);
    if (!this.closing) this.emit('disconnect', error);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (!payload.length || payload.length > MAX_FRAME_BYTES) throw new Error('Codex Desktop IPC 消息大小无效');
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function waitForConnect(socket, timeoutMs) {
  if (socket.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      const error = new Error('Codex Desktop IPC 连接超时');
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);
    timer.unref?.();
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function positiveTimeout(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
