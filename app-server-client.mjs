import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 15000;

export class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bin = options.bin || 'codex';
    this.cwd = options.cwd || process.cwd();
    this.envOverrides = { ...(options.env || {}) };
    this.clientInfo = {
      name: options.clientName || 'codex-web',
      title: options.clientTitle || 'Codex Web',
      version: options.clientVersion || '1.0.0',
    };
    this.capabilities = {
      experimentalApi: true,
      ...(options.capabilities || {}),
    };
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.initializeTimeoutMs = positiveTimeout(options.initializeTimeoutMs, DEFAULT_INITIALIZE_TIMEOUT_MS);
    this.child = null;
    this.startPromise = null;
    this.initialized = false;
    this.closing = false;
    this.stdoutBuffer = '';
    this.nextRequestId = 1;
    this.pending = new Map();
  }

  async start() {
    if (this.child && this.initialized) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.spawnAndInitialize()
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  async request(method, params = {}, options = {}) {
    await this.start();
    return this.sendRequest(method, params, options.timeoutMs);
  }

  async notify(method, params) {
    await this.start();
    this.writeMessage(params === undefined ? { method } : { method, params });
  }

  respond(id, result) {
    this.writeMessage({ id, result });
  }

  respondError(id, code, message, data) {
    const error = { code, message: String(message || 'Request failed') };
    if (data !== undefined) error.data = data;
    this.writeMessage({ id, error });
  }

  close() {
    this.closing = true;
    const child = this.child;
    this.child = null;
    this.initialized = false;
    this.startPromise = null;
    this.rejectPending(new Error('Codex app-server 已关闭'));
    if (!child || child.killed) return;
    try {
      child.kill('SIGTERM');
    } catch {}
    setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill('SIGKILL');
      } catch {}
    }, 3000).unref();
  }

  buildEnv() {
    return { ...process.env, ...this.envOverrides };
  }

  async spawnAndInitialize() {
    this.closing = false;
    this.stdoutBuffer = '';
    const child = spawn(this.bin, ['app-server', '--stdio'], {
      cwd: this.cwd,
      env: this.buildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout.on('data', (chunk) => this.consumeStdout(child, chunk));
    child.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString()));
    child.on('error', (error) => this.handleChildFailure(child, error));
    child.on('close', (code, signal) => {
      const suffix = signal ? ` signal=${signal}` : ` code=${code}`;
      this.handleChildFailure(child, new Error(`Codex app-server 已退出:${suffix}`));
    });

    try {
      await this.sendRequest('initialize', {
        clientInfo: this.clientInfo,
        capabilities: this.capabilities,
      }, this.initializeTimeoutMs);
      this.writeMessage({ method: 'initialized' });
      if (this.child !== child) throw new Error('Codex app-server 初始化期间已退出');
      this.initialized = true;
      this.emit('ready');
    } catch (error) {
      if (this.child === child) {
        this.child = null;
        try {
          child.kill('SIGTERM');
        } catch {}
      }
      this.initialized = false;
      throw error;
    }
  }

  sendRequest(method, params, timeoutMs = this.requestTimeoutMs) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      return Promise.reject(new Error('Codex app-server 未连接'));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server 请求超时: ${method}`));
      }, positiveTimeout(timeoutMs, this.requestTimeoutMs));
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.writeMessage({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  writeMessage(message) {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) throw new Error('Codex app-server 未连接');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  consumeStdout(child, chunk) {
    if (this.child !== child) return;
    this.stdoutBuffer += chunk.toString();
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) this.handleLine(line);
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit('protocolError', new Error(`Codex app-server 返回无效 JSON: ${error.message}`), line);
      return;
    }

    if (message && Object.hasOwn(message, 'id') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || `${pending.method} 请求失败`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message?.method && Object.hasOwn(message, 'id')) {
      let answered = false;
      const respond = (result) => {
        if (answered) return false;
        answered = true;
        this.respond(message.id, result);
        return true;
      };
      const reject = (code, text, data) => {
        if (answered) return false;
        answered = true;
        this.respondError(message.id, code, text, data);
        return true;
      };
      this.emit('request', {
        id: message.id,
        method: message.method,
        params: message.params || {},
        respond,
        reject,
      });
      return;
    }

    if (message?.method) {
      const event = { method: message.method, params: message.params || {} };
      this.emit('notification', event);
      if (message.method === 'error') this.emit('appServerError', event.params);
      else this.emit(message.method, event.params);
    }
  }

  handleChildFailure(child, error) {
    if (this.child !== child) return;
    this.child = null;
    this.initialized = false;
    this.stdoutBuffer = '';
    this.rejectPending(error);
    if (!this.closing) this.emit('exit', error);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function positiveTimeout(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
