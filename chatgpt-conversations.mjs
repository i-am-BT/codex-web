import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const MODULE_FILE = fileURLToPath(import.meta.url);
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 1200;
const REQUEST_TIMEOUT_MS = 12_000;
const HELPER_TIMEOUT_MS = 16_000;
const MAX_PIPE_CANDIDATES = 24;
const PROCESS_LIST_TIMEOUT_MS = 800;

export async function listLocalChatGPTConversations(options = {}) {
  const threadId = cleanThreadId(options.threadId);
  if (!threadId) throw new Error('ChatGPT 会话列表需要一个本机 Codex 任务作为只读上下文');
  const limit = clampLimit(options.limit);
  const nodePath = resolveCodexMcpNodePath(options);
  const helperCwd = resolveCodexAppToolsCwd(options, nodePath);
  const runtimeProcess = typeof process === 'undefined' ? null : process;
  const env = {
    ...(options.env || runtimeProcess?.env || {}),
    CODEX_WEB_CHATGPT_THREAD_ID: threadId,
    CODEX_WEB_CHATGPT_LIMIT: String(limit),
    CODEX_WEB_CHATGPT_OPERATION: '',
  };
  if (options.pipePath) env.CODEX_APP_TOOLS_PIPE_PATH = String(options.pipePath);
  let stdout;
  try {
    ({ stdout } = await execFileAsync(nodePath, [MODULE_FILE, '--helper'], {
      cwd: helperCwd,
      env,
      timeout: positiveTimeout(options.timeoutMs, HELPER_TIMEOUT_MS),
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    if (options.disableNodeReplFallback === true) throw error;
    return listViaSignedNodeRepl({ ...options, threadId, limit, nodePath, appToolsCwd: helperCwd });
  }
  const parsed = JSON.parse(String(stdout || '').trim() || '{}');
  if (options.operation === 'read' || options.operation === 'send') return parsed;
  if (!Array.isArray(parsed.conversations)) throw new Error('Codex App 未返回有效的 ChatGPT 会话列表');
  return {
    conversations: parsed.conversations.map(sanitizeChatGPTConversation).filter(Boolean),
    unavailable: Array.isArray(parsed.unavailable) ? parsed.unavailable.map(cleanText).filter(Boolean) : [],
  };
}

/**
 * Read one ChatGPT conversation through the Codex App bridge. The bridge
 * returns a JSON payload wrapped in an MCP content item; keep that envelope
 * intact here so the server can validate and normalize it before returning it
 * to the browser.
 */
export async function readLocalChatGPTConversation(options = {}) {
  return callLocalChatGPTOperation({ ...options, operation: 'read' });
}

/**
 * Send a follow-up message to a local ChatGPT conversation through the Codex
 * App bridge. This is intentionally a separate operation from read/list so a
 * caller cannot accidentally turn a read request into a write.
 */
export async function sendLocalChatGPTMessage(options = {}) {
  return callLocalChatGPTOperation({ ...options, operation: 'send' });
}

async function callLocalChatGPTOperation(options = {}) {
  const threadId = cleanThreadId(options.threadId);
  const chatGPTId = cleanThreadId(options.chatGPTId);
  if (!threadId) throw new Error('ChatGPT 会话需要一个本机 Codex 任务作为只读上下文');
  if (!chatGPTId) throw new Error('ChatGPT 会话 ID 无效');
  const nodePath = resolveCodexMcpNodePath(options);
  const helperCwd = resolveCodexAppToolsCwd(options, nodePath);
  const runtimeProcess = typeof process === 'undefined' ? null : process;
  const env = {
    ...(options.env || runtimeProcess?.env || {}),
    CODEX_WEB_CHATGPT_THREAD_ID: threadId,
    CODEX_WEB_CHATGPT_LIMIT: String(clampLimit(options.limit)),
    CODEX_WEB_CHATGPT_OPERATION: String(options.operation || ''),
    CODEX_WEB_CHATGPT_ID: chatGPTId,
    CODEX_WEB_CHATGPT_CURSOR: String(options.cursor || ''),
    CODEX_WEB_CHATGPT_PROMPT: String(options.prompt || ''),
  };
  let stdout;
  try {
    ({ stdout } = await execFileAsync(nodePath, [MODULE_FILE, '--helper'], {
      cwd: helperCwd,
      env,
      timeout: positiveTimeout(options.timeoutMs, HELPER_TIMEOUT_MS),
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    if (options.disableNodeReplFallback === true) throw error;
    return callOperationViaSignedNodeRepl({ ...options, threadId, limit: clampLimit(options.limit), nodePath, appToolsCwd: helperCwd });
  }
  const parsed = JSON.parse(String(stdout || '').trim() || '{}');
  if (!parsed || typeof parsed !== 'object') throw new Error('Codex App 未返回有效的 ChatGPT 会话结果');
  return parsed;
}

async function callOperationViaSignedNodeRepl(options) {
  return runSignedNodeRepl(options);
}

export function resolveCodexAppToolsCwd(options = {}, nodePath = '') {
  const runtimeProcess = typeof process === 'undefined' ? null : process;
  const codexBin = String(options.codexBin || runtimeProcess?.env?.CODEX_BIN || '').trim();
  const resourcesPath = String(options.resourcesPath || runtimeProcess?.env?.CODEX_ELECTRON_RESOURCES_PATH || '').trim();
  const nodeResourcesPath = String(nodePath || '').includes(`${path.sep}cua_node${path.sep}`)
    ? path.resolve(path.dirname(nodePath), '..', '..')
    : '';
  const candidates = [
    options.appToolsCwd,
    resourcesPath && path.join(resourcesPath, 'plugins', 'openai-bundled', 'plugins', 'codex-app-tools'),
    codexBin && path.join(path.dirname(codexBin), 'plugins', 'openai-bundled', 'plugins', 'codex-app-tools'),
    nodeResourcesPath && path.join(nodeResourcesPath, 'plugins', 'openai-bundled', 'plugins', 'codex-app-tools'),
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || runtimeProcess?.cwd?.() || path.dirname(MODULE_FILE);
}

export function sanitizeChatGPTThreads(payload, limit = 30) {
  const pinned = Array.isArray(payload?.pinnedThreads) ? payload.pinnedThreads : [];
  const recent = Array.isArray(payload?.threads) ? payload.threads : [];
  const conversations = [];
  const seen = new Set();
  for (const item of [...pinned, ...recent]) {
    if (String(item?.kind || '').toLowerCase() !== 'chatgpt') continue;
    const conversation = sanitizeChatGPTConversation(item);
    if (!conversation || seen.has(conversation.id)) continue;
    seen.add(conversation.id);
    conversations.push(conversation);
    if (conversations.length >= clampLimit(limit)) break;
  }
  const unavailable = Array.isArray(payload?.unavailableSources)
    ? payload.unavailableSources.map((item) => cleanText(item?.source || item?.kind || item)).filter(Boolean)
    : [];
  return { conversations, unavailable };
}

/** Normalize the untrusted read_thread response into the small shape used by
 * the Web chat renderer. Tool output and attachments are intentionally omitted
 * here; only user/assistant text is copied into the page.
 */
export function sanitizeChatGPTConversationPayload(result, options = {}) {
  const rawText = result?.contentItems?.find((item) => item?.type === 'inputText')?.text;
  let payload = rawText;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }
  if (!payload || typeof payload !== 'object') throw new Error('ChatGPT 会话返回格式无效');
  const thread = payload.thread && typeof payload.thread === 'object' ? payload.thread : {};
  const id = cleanThreadId(thread.id || options.chatGPTId);
  if (!id) throw new Error('ChatGPT 会话返回的 ID 无效');
  const model = sanitizeChatGPTModel(thread) || sanitizeChatGPTModel(payload);
  const turns = Array.isArray(payload.turns) ? [...payload.turns].reverse() : [];
  const messages = [];
  for (const turn of turns) {
    const turnId = cleanThreadId(turn?.id) || '';
    const at = toIsoTimestamp(turn?.completedAt || turn?.startedAt);
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      const type = String(item?.type || '');
      if (type === 'userMessage') {
        const text = (Array.isArray(item.content) ? item.content : [])
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n').trim();
        if (text) messages.push({ role: 'user', content: text, at, turnId });
      } else if (type === 'agentMessage' || type === 'assistantMessage') {
        const text = String(item.text || item.content || '').trim();
        if (text) messages.push({ role: 'assistant', content: text, at, turnId });
      }
    }
  }
  const statusType = String(thread.status?.type || thread.status || '').toLowerCase();
  const status = ['running', 'in_progress', 'started'].includes(statusType)
    ? 'running'
    : ['error', 'failed'].includes(statusType) ? 'error' : 'done';
  return {
    id,
    source: 'chatgpt',
    kind: 'chatgpt',
    title: cleanText(thread.title || '未命名聊天').slice(0, 160) || '未命名聊天',
    preview: cleanText(thread.preview || '').slice(0, 240),
    ...(model?.id ? { model: model.id } : {}),
    ...(model?.displayName ? { modelDisplayName: model.displayName } : {}),
    createdAt: toIsoTimestamp(thread.createdAt),
    updatedAt: toIsoTimestamp(thread.updatedAt),
    status,
    messages,
    cursor: String(payload.page?.nextCursor || ''),
    hasMore: Boolean(payload.page?.hasMore),
  };
}

function toIsoTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const date = new Date(number > 1e12 ? number : number * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function resolveCodexMcpNodePath(options = {}) {
  const runtimeProcess = typeof process === 'undefined' ? null : process;
  const platform = String(options.platform || runtimeProcess?.platform || 'darwin');
  const codexBin = String(options.codexBin || runtimeProcess?.env?.CODEX_BIN || '').trim();
  const resourcesPath = String(options.resourcesPath || runtimeProcess?.env?.CODEX_ELECTRON_RESOURCES_PATH || '').trim();
  const candidates = [
    options.nodePath,
    runtimeProcess?.env?.CODEX_MCP_NODE_PATH,
    resourcesPath && path.join(resourcesPath, 'cua_node', 'bin', platform === 'win32' ? 'node.exe' : 'node'),
    codexBin && path.join(path.dirname(codexBin), 'cua_node', 'bin', platform === 'win32' ? 'node.exe' : 'node'),
    platform === 'darwin' && '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node',
    runtimeProcess?.execPath?.includes(`${path.sep}cua_node${path.sep}`) && runtimeProcess.execPath,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('未找到 Codex App 本地会话桥接运行时');
  return found;
}

async function listViaSignedNodeRepl(options) {
  const parsed = await runSignedNodeRepl(options);
  if (!Array.isArray(parsed.conversations)) throw new Error('Codex App 未返回有效的 ChatGPT 会话列表');
  return parsed;
}

async function runSignedNodeRepl(options) {
  const runtimeProcess = typeof process === 'undefined' ? null : process;
  const platform = String(options.platform || runtimeProcess?.platform || 'darwin');
  const nodeReplPath = String(
    options.nodeReplPath
      || path.join(path.dirname(options.nodePath), platform === 'win32' ? 'node_repl.exe' : 'node_repl'),
  );
  if (!existsSync(nodeReplPath)) throw new Error('未找到 Codex App 本地会话桥接');
  const helper = {
    nodePath: options.nodePath,
    scriptPath: MODULE_FILE,
    cwd: options.appToolsCwd,
    threadId: options.threadId,
    limit: options.limit,
    pipePath: String(options.pipePath || ''),
    operation: String(options.operation || ''),
    chatGPTId: String(options.chatGPTId || ''),
    cursor: String(options.cursor || ''),
    prompt: String(options.prompt || ''),
  };
  const code = [
    "const childProcess=await import('node:child_process');",
    `const helper=${JSON.stringify(helper)};`,
    "const output=await new Promise((resolve,reject)=>{",
    "const env={CODEX_WEB_CHATGPT_THREAD_ID:helper.threadId,CODEX_WEB_CHATGPT_LIMIT:String(helper.limit),CODEX_WEB_CHATGPT_OPERATION:helper.operation,CODEX_WEB_CHATGPT_ID:helper.chatGPTId,CODEX_WEB_CHATGPT_CURSOR:helper.cursor,CODEX_WEB_CHATGPT_PROMPT:helper.prompt};",
    "if(helper.pipePath)env.CODEX_APP_TOOLS_PIPE_PATH=helper.pipePath;",
    "const child=childProcess.spawn(helper.nodePath,[helper.scriptPath,'--helper'],{cwd:helper.cwd,env});",
    "let stdout='',stderr='';",
    "const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('helper timed out'));},16000);",
    "child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');",
    "child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>8388608){child.kill('SIGTERM');reject(new Error('helper output too large'));}});",
    "child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});",
    "child.on('error',error=>{clearTimeout(timer);reject(error);});",
    "child.on('exit',code=>{clearTimeout(timer);code===0?resolve(stdout):reject(new Error(stderr||'helper exited '+code));});",
    '});',
    'nodeRepl.write(output);',
  ].join('');
  return callViaSignedNodeRepl(nodeReplPath, code, {
    timeoutMs: positiveTimeout(options.timeoutMs, HELPER_TIMEOUT_MS) + 5_000,
    env: options.env || runtimeProcess?.env || {},
  });
}

async function callViaSignedNodeRepl(nodeReplPath, code, options = {}) {
  const text = await callNodeRepl(nodeReplPath, code, options);
  const parsed = JSON.parse(String(text || '').trim() || '{}');
  if (!parsed || typeof parsed !== 'object') throw new Error('Codex App 未返回有效的 ChatGPT 会话结果');
  return parsed;
}

function callNodeRepl(executable, code, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--disable-sandbox'], {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let nextId = 1;
    let settled = false;
    const pending = new Map();
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(value);
    };
    const request = (method, params) => new Promise((requestResolve, requestReject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve: requestResolve, reject: requestReject });
      child.stdin.write(`${JSON.stringify({ id, jsonrpc: '2.0', method, params })}\n`);
    });
    timer = setTimeout(() => finish(new Error('Codex App 本地会话桥接超时')), options.timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      while (true) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const waiter = pending.get(Number(message.id));
        if (!waiter) continue;
        pending.delete(Number(message.id));
        if (message.error) waiter.reject(new Error(String(message.error.message || 'node_repl request failed')));
        else waiter.resolve(message.result);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuffer = `${stderrBuffer}${chunk}`.slice(-4000);
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (codeValue) => {
      if (!settled) finish(new Error(stderrBuffer.trim() || `Codex App 本地会话桥接已退出 (${codeValue})`));
    });
    void (async () => {
      try {
        await request('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'codex-web-chatgpt-sidebar', version: '1.0.0' },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        const response = await request('tools/call', {
          name: 'js',
          arguments: { code, timeout_ms: Math.max(1, options.timeoutMs - 1000) },
        });
        if (response?.isError) {
          const message = response?.content?.find((item) => item?.type === 'text')?.text;
          throw new Error(String(message || 'Codex App 本地会话桥接执行失败'));
        }
        const text = response?.content?.find((item) => item?.type === 'text')?.text;
        finish(null, text);
      } catch (error) {
        finish(error);
      }
    })();
  });
}

async function runHelper() {
  const threadId = cleanThreadId(process.env.CODEX_WEB_CHATGPT_THREAD_ID);
  if (!threadId) throw new Error('missing Codex thread context');
  const limit = clampLimit(process.env.CODEX_WEB_CHATGPT_LIMIT);
  const result = await readChatGPTConversationsFromPipes({
    threadId,
    limit,
    operation: process.env.CODEX_WEB_CHATGPT_OPERATION || '',
    chatGPTId: process.env.CODEX_WEB_CHATGPT_ID || '',
    cursor: process.env.CODEX_WEB_CHATGPT_CURSOR || '',
    prompt: process.env.CODEX_WEB_CHATGPT_PROMPT || '',
    pipePaths: discoverPipePaths(),
  });
  process.stdout.write(JSON.stringify(result));
}

export async function readChatGPTConversationsFromPipes(options = {}) {
  const threadId = cleanThreadId(options.threadId);
  if (!threadId) throw new Error('missing Codex thread context');
  const limit = clampLimit(options.limit);
  const errors = [];
  for (const pipePath of Array.isArray(options.pipePaths) ? options.pipePaths : []) {
    const client = new NativeAppToolsClient(pipePath);
    try {
      const tools = await client.request('tools/list', { threadStartKind: 'all' });
      if (options.operation === 'read' || options.operation === 'send') {
        const toolName = options.operation === 'read' ? 'read_thread' : 'send_message_to_thread';
        const tool = tools?.tools?.find((item) => item?.name === toolName);
        if (!tool?.namespace) throw new Error(`${toolName} unavailable`);
        const argumentsValue = options.operation === 'read'
          ? {
            threadId: cleanThreadId(options.chatGPTId),
            cursor: String(options.cursor || '').trim() || undefined,
            turnLimit: clampLimit(options.limit || 10),
            includeOutputs: false,
            maxOutputCharsPerItem: 20_000,
          }
          : { threadId: cleanThreadId(options.chatGPTId), prompt: cleanPrompt(options.prompt) };
        if (options.operation === 'read') {
          if (!argumentsValue.cursor) delete argumentsValue.cursor;
        }
        const result = await client.request('tools/call', {
          tool: tool.name,
          namespace: tool.namespace,
          arguments: argumentsValue,
          threadId,
          turnId: `codex-web-chatgpt-${Date.now()}`,
          callId: `codex-web-chatgpt-${Date.now()}`,
        });
        if (result?.success !== true) {
          const text = result?.contentItems?.find((item) => item?.type === 'inputText')?.text;
          throw new Error(String(text || `${toolName} failed`));
        }
        return result;
      }
      const tool = tools?.tools?.find((item) => item?.name === 'list_threads');
      if (!tool?.namespace) throw new Error('list_threads unavailable');
      const result = await client.request('tools/call', {
        tool: tool.name,
        namespace: tool.namespace,
        arguments: { limit: Math.max(limit, 20) },
        threadId,
        turnId: `codex-web-chatgpt-${Date.now()}`,
        callId: `codex-web-chatgpt-${Date.now()}`,
      });
      if (result?.success !== true) throw new Error('list_threads failed');
      const text = result?.contentItems?.find((item) => item?.type === 'inputText')?.text;
      const payload = JSON.parse(String(text || '{}'));
      return sanitizeChatGPTThreads(payload, limit);
    } catch (error) {
      errors.push(`${path.basename(pipePath)}: ${error?.message || error}`);
    } finally {
      client.close();
    }
  }
  throw new Error(errors.at(-1) || 'Codex App local bridge unavailable');
}

class NativeAppToolsClient {
  constructor(pipePath) {
    this.pipePath = pipePath;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
  }

  async request(method, params) {
    await this.connect();
    const id = this.nextId;
    this.nextId += 1;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    const payload = Buffer.from(JSON.stringify({ id, jsonrpc: '2.0', method, params }), 'utf8');
    if (payload.length > MAX_FRAME_BYTES) throw new Error('request too large');
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    this.socket.write(frame);
    return result;
  }

  connect() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('connect timed out'));
      }, CONNECT_TIMEOUT_MS);
      timer.unref?.();
      const fail = (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', fail);
        this.socket = socket;
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('error', (error) => this.onDisconnect(error));
        socket.on('close', () => this.onDisconnect(new Error('bridge closed')));
        resolve();
      });
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        this.onDisconnect(new Error('response too large'));
        this.socket?.destroy();
        return;
      }
      if (this.buffer.length < length + 4) return;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let message;
      try {
        message = JSON.parse(payload.toString('utf8'));
      } catch {
        this.onDisconnect(new Error('invalid bridge response'));
        this.socket?.destroy();
        return;
      }
      const pending = this.pending.get(Number(message.id));
      if (!pending) continue;
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(String(message.error.message || 'bridge request failed')));
      else pending.resolve(message.result);
    }
  }

  onDisconnect(error) {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
  }
}

export function extractPipePathsFromProcessList(output) {
  const paths = [];
  const text = String(output || '');
  for (const match of text.matchAll(/(?:^|\s)CODEX_APP_TOOLS_PIPE_PATH=([^\s]+)/g)) {
    const pipePath = String(match[1] || '').trim();
    if (pipePath.endsWith('.sock')) paths.push(pipePath);
  }
  return [...new Set(paths)];
}

function discoverProcessPipePaths() {
  try {
    const output = execFileSync('ps', ['eww', '-ax'], {
      encoding: 'utf8',
      timeout: PROCESS_LIST_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return extractPipePathsFromProcessList(output);
  } catch {
    return [];
  }
}

function discoverPipePaths() {
  const paths = [];
  const configured = String(process.env.CODEX_APP_TOOLS_PIPE_PATH || '').trim();
  if (configured) paths.push(configured);
  // The web service is launched by launchd and does not inherit the pipe path
  // that Codex App gives its MCP server. Read active app-tool processes first
  // so a stale socket cannot win merely because it has a newer mtime.
  paths.push(...discoverProcessPipePaths());
  const pipeDir = path.join(tmpdir(), 'codex-browser-use');
  try {
    const entries = readdirSync(pipeDir)
      .filter((name) => name.endsWith('.sock'))
      .map((name) => {
        const file = path.join(pipeDir, name);
        let modifiedAt = 0;
        try { modifiedAt = statSync(file).mtimeMs; } catch {}
        return { file, modifiedAt };
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(0, MAX_PIPE_CANDIDATES)
      .map((item) => item.file);
    paths.push(...entries);
  } catch {}
  return [...new Set(paths)].filter((file) => existsSync(file));
}

function sanitizeChatGPTConversation(item) {
  const id = String(item?.id || '').trim().slice(0, 160);
  if (!id) return null;
  const title = cleanText(item?.title || '未命名聊天').slice(0, 160) || '未命名聊天';
  const seconds = Number(item?.updatedAt);
  const updatedAt = Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : null;
  const pinnedIndex = item?.pinnedIndex == null ? NaN : Number(item.pinnedIndex);
  const model = sanitizeChatGPTModel(item);
  return {
    id,
    title,
    updatedAt,
    pinned: Number.isFinite(pinnedIndex),
    ...(model?.id ? { model: model.id } : {}),
    ...(model?.displayName ? { modelDisplayName: model.displayName } : {}),
  };
}

function sanitizeChatGPTModel(value) {
  if (!value || typeof value !== 'object') return null;
  const raw = [
    value.model,
    value.modelId,
    value.model_id,
    value.modelName,
    value.model_name,
    value.modelSlug,
    value.model_slug,
  ].find((candidate) => candidate != null && candidate !== '');
  if (raw && typeof raw === 'object') {
    const id = String(raw.id || raw.model || raw.value || raw.slug || '').trim();
    const displayName = String(raw.displayName || raw.display_name || raw.name || '').trim();
    if (id || displayName) return { id, displayName };
  }
  if (typeof raw !== 'string') return null;
  const id = raw.trim().slice(0, 160);
  if (!id) return null;
  const displayName = String(
    value.modelDisplayName || value.model_display_name || value.modelLabel || value.model_label || '',
  ).trim().slice(0, 160);
  return { id, displayName };
}

function cleanThreadId(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,159}$/.test(text) ? text : '';
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanPrompt(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('消息不能为空');
  if (text.length > 50_000) throw new Error('消息过长');
  return text;
}

function clampLimit(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.trunc(parsed))) : 30;
}

function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

if (typeof process !== 'undefined' && process.argv[1] && path.resolve(process.argv[1]) === MODULE_FILE && process.argv.includes('--helper')) {
  runHelper().catch((error) => {
    process.stderr.write(String(error?.message || error));
    process.exitCode = 1;
  });
}
