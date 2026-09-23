import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 15000;
const DEFAULT_INITIALIZE_RETRY_COUNT = 1;
const DEFAULT_INITIALIZE_RETRY_DELAY_MS = 150;
const DEFAULT_STOP_TIMEOUT_MS = 3000;
const DEFAULT_APP_SERVER_ARGS = [];

export class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.bin = options.bin || 'codex';
    this.cwd = options.cwd || process.cwd();
    this.appServerArgs = options.appServerArgs === undefined
      ? [...DEFAULT_APP_SERVER_ARGS]
      : normalizeArgs(options.appServerArgs);
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
    this.initializeRetryCount = nonNegativeInteger(options.initializeRetryCount, DEFAULT_INITIALIZE_RETRY_COUNT);
    this.initializeRetryDelayMs = positiveTimeout(options.initializeRetryDelayMs, DEFAULT_INITIALIZE_RETRY_DELAY_MS);
    this.stopTimeoutMs = positiveTimeout(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS);
    this.child = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.postRestartStopPromise = null;
    this.restartPromise = null;
    this.restartRevision = 0;
    this.appliedRestartRevision = 0;
    this.restartEnvironments = new Map();
    this.operationCount = 0;
    this.operationIdleWaiters = new Set();
    this.connectionGeneration = 0;
    this.stopFailure = null;
    this.initialized = false;
    this.closing = false;
    this.closed = false;
    this.stdoutBuffer = '';
    this.nextRequestId = 1;
    this.pending = new Map();
  }

  async start() {
    while (true) {
      if (this.closed) throw new Error('Codex app-server 已关闭');
      const lifecyclePromise = this.postRestartStopPromise || this.restartPromise;
      if (!lifecyclePromise) break;
      await lifecyclePromise;
    }
    if (this.stopFailure) throw this.stopFailure;
    return this.startAfterStop();
  }

  async startAfterStop() {
    while (this.stopPromise) await this.stopPromise;
    if (this.closed) throw new Error('Codex app-server 已关闭');
    if (this.stopFailure) throw this.stopFailure;
    if (this.child && this.initialized) return;
    if (this.startPromise) return this.startPromise;

    let trackedStart;
    trackedStart = this.startWithInitializeRetry()
      .finally(() => {
        if (this.startPromise === trackedStart) this.startPromise = null;
      });
    this.startPromise = trackedStart;
    return trackedStart;
  }

  async startWithInitializeRetry() {
    let lastError;
    for (let attempt = 0; attempt <= this.initializeRetryCount; attempt += 1) {
      if (this.closing || this.closed) throw new Error('Codex app-server 已停止');
      try {
        return await this.spawnAndInitialize();
      } catch (error) {
        lastError = error;
        if (
          this.closing
          || this.closed
          || !isInitializeTimeout(error)
          || attempt >= this.initializeRetryCount
        ) {
          throw error;
        }
        // The requested RPC has not been written yet, so this retry cannot duplicate it.
        await new Promise((resolve) => setTimeout(resolve, this.initializeRetryDelayMs));
      }
    }
    throw lastError;
  }

  request(method, params = {}, options = {}) {
    return this.runOperation(async () => {
      await this.start();
      if (this.closed) throw new Error('Codex app-server 已关闭');
      return this.sendRequest(method, params, options.timeoutMs);
    });
  }

  requestWithConnection(method, params = {}, options = {}) {
    return this.runOperation(async () => {
      await this.start();
      if (this.closed) throw new Error('Codex app-server 已关闭');
      const child = this.child;
      const result = await this.sendRequest(method, params, options.timeoutMs);
      return { result, child };
    });
  }

  notify(method, params) {
    return this.runOperation(async () => {
      await this.start();
      if (this.closed) throw new Error('Codex app-server 已关闭');
      this.writeMessage(params === undefined ? { method } : { method, params });
    });
  }

  runOperation(operation) {
    let lease;
    try {
      lease = this.acquireOperationLease();
    } catch (error) {
      return Promise.reject(error);
    }
    if (typeof lease === 'function') return this.executeOperation(lease, operation);
    return Promise.resolve(lease).then((release) => this.executeOperation(release, operation));
  }

  executeOperation(release, operation) {
    let result;
    try {
      result = operation();
    } catch (error) {
      release();
      return Promise.reject(error);
    }
    return Promise.resolve(result).finally(release);
  }

  acquireOperationLease() {
    if (this.closed) throw new Error('Codex app-server 已关闭');
    const lifecyclePromise = this.postRestartStopPromise || this.restartPromise || this.stopPromise;
    if (lifecyclePromise) {
      return Promise.resolve(lifecyclePromise).then(() => this.acquireOperationLease());
    }
    if (this.stopFailure) throw this.stopFailure;

    this.operationCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.operationCount = Math.max(0, this.operationCount - 1);
      if (this.operationCount > 0) return;
      const waiters = [...this.operationIdleWaiters];
      this.operationIdleWaiters.clear();
      for (const resolve of waiters) resolve();
    };
  }

  waitForOperationsIdle() {
    if (this.operationCount === 0) return Promise.resolve();
    return new Promise((resolve) => this.operationIdleWaiters.add(resolve));
  }

  restart(options = {}) {
    if (this.closed) return Promise.reject(new Error('Codex app-server 已关闭'));
    if (Object.hasOwn(options, 'env')) this.envOverrides = { ...(options.env || {}) };
    this.restartRevision += 1;
    this.restartEnvironments.set(this.restartRevision, { ...this.envOverrides });
    if (this.restartPromise) return this.restartPromise;

    let trackedRestart;
    trackedRestart = this.restartUntilCurrent()
      .finally(() => {
        if (this.restartPromise === trackedRestart) this.restartPromise = null;
      });
    this.restartPromise = trackedRestart;
    return trackedRestart;
  }

  respond(id, result) {
    this.writeMessage({ id, result });
  }

  respondError(id, code, message, data) {
    const error = { code, message: String(message || 'Request failed') };
    if (data !== undefined) error.data = data;
    this.writeMessage({ id, error });
  }

  stop() {
    if (this.postRestartStopPromise) return this.postRestartStopPromise;
    if (!this.restartPromise) return this.stopCurrent();

    const restartPromise = this.restartPromise;
    let queuedStop;
    queuedStop = restartPromise
      .catch(() => {})
      .then(() => this.stopCurrent())
      .finally(() => {
        if (this.postRestartStopPromise === queuedStop) this.postRestartStopPromise = null;
      });
    this.postRestartStopPromise = queuedStop;
    return queuedStop;
  }

  close() {
    this.closed = true;
    this.closing = true;
    const stopPromise = this.stopCurrent(
      new Error('Codex app-server 已关闭'),
      { waitForOperations: false },
    );
    void stopPromise.catch(() => {});
    return stopPromise;
  }

  stopCurrent(
    error = new Error('Codex app-server 已停止'),
    { waitForOperations = true } = {},
  ) {
    if (this.stopPromise) return this.stopPromise;

    this.closing = true;

    let trackedStop;
    trackedStop = Promise.resolve()
      .then(() => (waitForOperations ? this.waitForOperationsIdle() : undefined))
      .then(async () => {
        const child = this.child;
        const startPromise = this.startPromise;
        this.initialized = false;
        this.stdoutBuffer = '';
        const terminationPromise = this.terminateChild(child);
        this.rejectPending(error);
        if (startPromise) await startPromise.catch(() => {});
        await terminationPromise;
        if (child && this.child === child) this.child = null;
        this.stopFailure = null;
      })
      .catch((cause) => {
        this.stopFailure = cause;
        throw cause;
      })
      .finally(() => {
        if (this.stopPromise === trackedStop) this.stopPromise = null;
        if (!this.closed) this.closing = Boolean(this.stopFailure);
      });
    this.stopPromise = trackedStop;
    return trackedStop;
  }

  terminateChild(child) {
    if (!child) return Promise.resolve();

    return new Promise((resolve, reject) => {
      let forceTimer = null;
      let forceWaitTimer = null;
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        if (forceWaitTimer) clearTimeout(forceWaitTimer);
        child.off('close', handleClose);
        if (error) reject(error);
        else resolve();
      };
      const handleClose = () => finish();
      const stopError = (message, cause = null) => {
        const error = new Error(`Codex app-server 停止失败: ${message}`);
        error.code = 'CODEX_APP_SERVER_STOP_FAILED';
        if (cause) error.cause = cause;
        return error;
      };
      const signalChild = (signal) => {
        try {
          const sent = child.kill(signal);
          if (sent === false && child.exitCode === null && child.signalCode === null) {
            finish(stopError(`无法发送 ${signal}`));
            return false;
          }
          return true;
        } catch (cause) {
          finish(stopError(`发送 ${signal} 失败`, cause));
          return false;
        }
      };

      child.once('close', handleClose);
      const forceWaitMs = Math.max(100, Math.min(this.stopTimeoutMs, 1000));
      if (child.exitCode !== null || child.signalCode !== null) {
        forceWaitTimer = setTimeout(() => {
          finish(stopError('进程已退出但未收到 close'));
        }, forceWaitMs);
        return;
      }
      if (!signalChild('SIGTERM') || settled) return;

      forceTimer = setTimeout(() => {
        if (
          child.exitCode === null
          && child.signalCode === null
          && (!signalChild('SIGKILL') || settled)
        ) {
          return;
        }
        forceWaitTimer = setTimeout(() => {
          finish(stopError('SIGKILL 后未收到 close'));
        }, forceWaitMs);
      }, this.stopTimeoutMs);
    });
  }

  buildEnv() {
    const env = { ...process.env };
    for (const [key, value] of Object.entries(this.envOverrides)) {
      if (value === undefined || value === null) delete env[key];
      else env[key] = value;
    }
    return env;
  }

  async restartUntilCurrent() {
    let lastError = null;
    while (this.appliedRestartRevision < this.restartRevision) {
      const revision = this.appliedRestartRevision + 1;
      const environment = this.restartEnvironments.get(revision);
      await this.stopCurrent();
      try {
        if (this.closed) throw new Error('Codex app-server 已关闭');
        if (environment) this.envOverrides = { ...environment };
        await this.startAfterStop();
        lastError = null;
      } catch (error) {
        lastError = error;
      } finally {
        this.appliedRestartRevision = revision;
        this.restartEnvironments.delete(revision);
      }
      if (lastError && this.appliedRestartRevision >= this.restartRevision) throw lastError;
    }
  }

  async spawnAndInitialize() {
    if (this.closed) throw new Error('Codex app-server 已关闭');
    this.closing = false;
    this.stdoutBuffer = '';
    const child = spawn(this.bin, ['app-server', ...this.appServerArgs, '--stdio'], {
      cwd: this.cwd,
      env: this.buildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const generation = this.connectionGeneration + 1;
    this.connectionGeneration = generation;
    this.child = child;

    child.stdout.on('data', (chunk) => this.consumeStdout(child, generation, chunk));
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
    return this.writeMessageForConnection(child, this.connectionGeneration, message);
  }

  writeMessageForConnection(child, generation, message) {
    if (child !== this.child || generation !== this.connectionGeneration) {
      const error = new Error('Codex app-server 连接已变更');
      error.code = 'CODEX_APP_SERVER_CONNECTION_CHANGED';
      throw error;
    }
    if (!child || child.killed || !child.stdin.writable) throw new Error('Codex app-server 未连接');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  consumeStdout(child, generation, chunk) {
    if (this.child !== child || this.connectionGeneration !== generation) return;
    this.stdoutBuffer += chunk.toString();
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) this.handleLine(line, child, generation);
  }

  handleLine(line, child = this.child, generation = this.connectionGeneration) {
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
        this.writeMessageForConnection(child, generation, { id: message.id, result });
        answered = true;
        return true;
      };
      const reject = (code, text, data) => {
        if (answered) return false;
        const error = { code, message: String(text || 'Request failed') };
        if (data !== undefined) error.data = data;
        this.writeMessageForConnection(child, generation, { id: message.id, error });
        answered = true;
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
    this.stopFailure = null;
    if (!this.closed && !this.stopPromise) this.closing = false;
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

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function normalizeArgs(value) {
  if (!Array.isArray(value)) throw new TypeError('appServerArgs must be an array');
  return value.map((arg) => String(arg));
}

function isInitializeTimeout(error) {
  return /Codex app-server \u8bf7\u6c42\u8d85\u65f6:\s*initialize\b/i.test(String(error?.message || ''));
}
