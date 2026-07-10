import express from 'express';
import { spawn } from 'child_process';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { homedir } from 'os';
import path from 'path';
import net from 'net';

const ROOT = '/opt/codex-web';
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const CONVERSATIONS_FILE = path.join(RUNTIME_DIR, 'conversations.json');
const APPEARANCE_FILE = path.join(RUNTIME_DIR, 'appearance.json');
const IMAGE_DIR = path.join(RUNTIME_DIR, 'images');
const FILE_DIR = path.join(RUNTIME_DIR, 'files');
const BACKGROUND_DIR = path.join(RUNTIME_DIR, 'backgrounds');
const ENV_FILE = path.join(ROOT, '.env');
const CODEX_ENV_FILE = '/root/.codex/.env';

loadEnv(ENV_FILE);
loadEnv(CODEX_ENV_FILE, false);

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 0);
const PORT_MIN = Number(process.env.PORT_MIN || 30000);
const PORT_MAX = Number(process.env.PORT_MAX || 39999);
const PASSWORD = process.env.CODEX_WEB_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 168) * 60 * 60 * 1000;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'gpt-5.5';
const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || '';
const DEFAULT_CWD = process.env.DEFAULT_CWD || '/root';
const DEFAULT_SANDBOX = process.env.DEFAULT_SANDBOX || 'read-only';
const DEFAULT_APPROVAL = process.env.DEFAULT_APPROVAL || 'never';

if (!PASSWORD) {
  console.error('CODEX_WEB_PASSWORD is required in /opt/codex-web/.env');
  process.exit(1);
}

mkdirSync(RUNTIME_DIR, { recursive: true });
mkdirSync(IMAGE_DIR, { recursive: true });
mkdirSync(FILE_DIR, { recursive: true });
mkdirSync(BACKGROUND_DIR, { recursive: true });

const app = express();
const sessions = new Map();
const conversations = loadConversations();
let activeProcess = null;
let activeConversationId = '';

app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, port: server.address()?.port || null });
});

app.get('/favicon.svg', (req, res) => {
  res.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse"><stop stop-color="#6aa8ff"/><stop offset="1" stop-color="#37c871"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="#080b10"/><path d="M20 22 10 32l10 10" fill="none" stroke="url(#g)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M44 22 54 32 44 42" fill="none" stroke="url(#g)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 16 28 48" fill="none" stroke="#e6edf3" stroke-width="5" stroke-linecap="round"/></svg>`);
});

app.post('/api/login', (req, res) => {
  const password = String(req.body?.password || '');
  if (!safeEqual(password, PASSWORD)) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = randomBytes(32).toString('hex');
  sessions.set(hashToken(token), Date.now() + SESSION_TTL_MS);
  res.setHeader('Set-Cookie', `codex_web_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  res.json({ ok: true });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = getCookie(req, 'codex_web_session');
  if (token) sessions.delete(hashToken(token));
  res.setHeader('Set-Cookie', 'codex_web_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({ authenticated: Boolean(validateSession(req)) });
});

app.use('/assets/images', requireAuth, express.static(IMAGE_DIR, { fallthrough: false }));
app.use('/assets/files', requireAuth, express.static(FILE_DIR, { fallthrough: false }));
app.use('/assets/backgrounds', requireAuth, express.static(BACKGROUND_DIR, { fallthrough: false }));

app.post('/api/uploads/image', requireAuth, (req, res) => {
  try {
    const upload = saveUploadedAttachment(req.body || {}, { imagesOnly: true });
    res.json({ ok: true, image: upload });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/uploads/file', requireAuth, (req, res) => {
  try {
    const upload = saveUploadedAttachment(req.body || {});
    res.json({ ok: true, attachment: upload });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/appearance', requireAuth, (req, res) => {
  try {
    const appearance = saveAppearance(req.body || {});
    res.json({ ok: true, appearance });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/appearance/background', requireAuth, (req, res) => {
  try {
    const background = saveUploadedBackground(req.body || {});
    const current = readAppearance();
    const customBackgrounds = [...current.customBackgrounds.filter((item) => item.value !== background.value), background];
    const appearance = saveAppearance({ chatBackground: background.value, customBackgrounds });
    res.json({ ok: true, appearance, background });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/appearance/background', requireAuth, (req, res) => {
  try {
    const appearance = deleteCustomBackground(req.body?.value);
    res.json({ ok: true, appearance });
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

app.get('/api/config', requireAuth, (req, res) => {
  const defaults = readCodexDefaults();
  res.json({
    defaults: {
      model: defaults.model || DEFAULT_MODEL,
      provider: defaults.provider || DEFAULT_PROVIDER,
      cwd: DEFAULT_CWD,
      sandbox: DEFAULT_SANDBOX,
      approval: DEFAULT_APPROVAL,
    },
    providers: readProviders(),
    conversations: conversations.map(({ id, title, createdAt, status }) => ({ id, title, createdAt, status })),
    appearance: readAppearance(),
  });
});

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const conversation = conversations.find((item) => item.id === req.params.id);
  if (!conversation) return res.status(404).json({ error: '会话不存在' });
  res.json({ conversation });
});

app.patch('/api/conversations/:id', requireAuth, (req, res) => {
  const conversation = conversations.find((item) => item.id === req.params.id);
  if (!conversation) return res.status(404).json({ error: '会话不存在' });

  const title = String(req.body?.title || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!title) return res.status(400).json({ error: '标题不能为空' });

  conversation.title = title;
  conversation.updatedAt = new Date().toISOString();
  saveConversations();
  res.json({ ok: true, conversation: { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt } });
});

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  const index = conversations.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: '会话不存在' });
  const [deleted] = conversations.splice(index, 1);
  saveConversations();
  res.json({ ok: true, id: deleted.id });
});

app.post('/api/conversations/:id/rollback', requireAuth, (req, res) => {
  if (activeProcess) {
    return res.status(409).json({ error: '已有 Codex 任务正在运行，请等待完成后再回退' });
  }

  const conversation = conversations.find((item) => item.id === req.params.id);
  if (!conversation) return res.status(404).json({ error: '会话不存在' });
  if (conversation.status === 'running') return res.status(409).json({ error: '会话正在运行，不能回退' });

  const messageIndex = Number(req.body?.messageIndex);
  if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= (conversation.messages || []).length) {
    return res.status(400).json({ error: '消息索引无效' });
  }

  const target = conversation.messages[messageIndex];
  if (!target || target.role !== 'user') return res.status(400).json({ error: '只能回退到用户消息' });

  conversation.messages = conversation.messages.slice(0, messageIndex + 1);
  conversation.status = 'done';
  conversation.updatedAt = new Date().toISOString();
  conversations.splice(conversations.indexOf(conversation), 1);
  conversations.unshift(conversation);
  saveConversations();
  res.json({ ok: true, conversation });
});

app.post('/api/cancel', requireAuth, (req, res) => {
  if (!activeProcess) return res.json({ ok: true, cancelled: false });
  const pid = activeProcess.pid;
  terminateProcess(activeProcess);
  activeProcess = null;
  activeConversationId = '';
  res.json({ ok: true, cancelled: true, pid });
});

app.post('/api/models', requireAuth, async (req, res) => {
  const providerName = cleanProviderName(req.body?.provider || '');
  const explicitBaseUrl = String(req.body?.baseUrl || '').trim().replace(/\/+$/, '');
  const explicitApiKey = String(req.body?.apiKey || '').trim();
  let baseUrl = explicitBaseUrl;
  let apiKey = explicitApiKey;

  if (!baseUrl && providerName) {
    const provider = readProviderDetails().find((item) => item.name === providerName);
    if (!provider) return res.status(404).json({ error: '服务商不存在' });
    baseUrl = provider.baseUrl;
    apiKey = process.env[provider.envKey] || readEnvVar(CODEX_ENV_FILE, provider.envKey);
  }

  if (!isHttpUrl(baseUrl)) return res.status(400).json({ error: 'Base URL 无效' });
  if (!apiKey) return res.status(400).json({ error: 'API Key 不能为空' });

  try {
    const models = await fetchModels(baseUrl, apiKey);
    res.json({ ok: true, models });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/providers', requireAuth, (req, res) => {
  const name = cleanProviderName(req.body?.name);
  const baseUrl = String(req.body?.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(req.body?.apiKey || '').trim();
  const model = cleanValue(req.body?.model) || DEFAULT_MODEL;
  const wireApi = ['responses', 'chat'].includes(req.body?.wireApi) ? req.body.wireApi : 'responses';

  if (!name) return res.status(400).json({ error: '服务商名称只能包含字母、数字、下划线和短横线' });
  if (!isHttpUrl(baseUrl)) return res.status(400).json({ error: 'Base URL 必须是 http/https URL' });
  if (!apiKey) return res.status(400).json({ error: 'API Key 不能为空' });

  try {
    const envKey = `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
    upsertProvider({ name, baseUrl, envKey, wireApi, model });
    updateEnvVar(CODEX_ENV_FILE, envKey, apiKey);
    updateEnvVar(ENV_FILE, 'DEFAULT_PROVIDER', name);
    updateEnvVar(ENV_FILE, 'DEFAULT_MODEL', model);
    process.env[envKey] = apiKey;
    process.env.DEFAULT_PROVIDER = name;
    process.env.DEFAULT_MODEL = model;
    res.json({ ok: true, provider: name, model, providers: readProviders() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/providers/:name', requireAuth, (req, res) => {
  const name = cleanProviderName(req.params.name);
  if (!name) return res.status(400).json({ error: '服务商名称无效' });

  try {
    const result = deleteProvider(name);
    res.json({ ok: true, ...result, providers: readProviders() });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/defaults', requireAuth, (req, res) => {
  const provider = cleanProviderName(req.body?.provider || '');
  const model = cleanValue(req.body?.model) || '';

  if (!provider) return res.status(400).json({ error: '请选择服务商' });
  if (!readProviders().includes(provider)) return res.status(404).json({ error: '服务商不存在' });
  if (!model) return res.status(400).json({ error: '请选择模型' });

  try {
    setCodexDefaults(provider, model);
    updateEnvVar(ENV_FILE, 'DEFAULT_PROVIDER', provider);
    updateEnvVar(ENV_FILE, 'DEFAULT_MODEL', model);
    process.env.DEFAULT_PROVIDER = provider;
    process.env.DEFAULT_MODEL = model;
    res.json({ ok: true, provider, model });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat', requireAuth, (req, res) => {
  if (activeProcess) {
    return res.status(409).json({ error: '已有 Codex 任务正在运行，请等待完成' });
  }

  const message = String(req.body?.message || '').trim();
  const uploadedAttachments = normalizeUploadedAttachments(req.body?.attachments, req.body?.images);
  const promptMessage = appendAttachmentPrompt(message, uploadedAttachments);
  const model = cleanValue(req.body?.model) || DEFAULT_MODEL;
  const provider = cleanValue(req.body?.provider) || DEFAULT_PROVIDER;
  const cwd = normalizeCwd(req.body?.cwd || DEFAULT_CWD);
  const sandbox = cleanSandbox(req.body?.sandbox || DEFAULT_SANDBOX);
  const approval = cleanApproval(req.body?.approval || DEFAULT_APPROVAL);

  if (!message && !uploadedAttachments.length) return res.status(400).json({ error: 'message is required' });
  if (!cwd) return res.status(400).json({ error: '工作目录不存在' });

  const requestedId = String(req.body?.conversationId || '').trim();
  let convo = conversations.find((item) => item.id === requestedId);
  if (convo) {
    convo.status = 'running';
    convo.updatedAt = new Date().toISOString();
    convo.messages.push({ role: 'user', content: promptMessage, at: new Date().toISOString() });
    conversations.splice(conversations.indexOf(convo), 1);
    conversations.unshift(convo);
  } else {
    convo = { id: randomBytes(8).toString('hex'), title: (message || '附件分析').slice(0, 48), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'running', messages: [{ role: 'user', content: promptMessage, at: new Date().toISOString() }] };
    conversations.unshift(convo);
    conversations.splice(100);
  }
  saveConversations();

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  if (shouldUseDirectImage(model, message)) {
    writeEvent(res, { type: 'start', id: convo.id, conversationId: convo.id, cwd, model, provider, sandbox, approval });
    generateImageDirect({ providerName: provider, model, prompt: message, convo, res })
      .then((image) => {
        appendMessage(convo, 'image', image.url, 'image');
        appendMessage(convo, 'assistant', '图片已生成。', 'text');
        convo.status = 'done';
        convo.updatedAt = new Date().toISOString();
        saveConversations();
        writeEvent(res, { type: 'image', url: image.url, prompt: image.prompt });
        writeEvent(res, { type: 'done', code: 0, content: '图片已生成。' });
        endStream(res);
      })
      .catch((err) => {
        convo.status = 'error';
        appendMessage(convo, 'assistant', err.message, 'error');
        writeEvent(res, { type: 'error', error: err.message });
        endStream(res);
      });
    return;
  }

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--color', 'never',
    '--json',
    '-C', cwd,
    '-s', sandbox,
    '-m', model,
  ];
  if (provider) args.push('-c', `model_provider="${provider}"`);
  args.push('-');

  const startContent = `任务开始\nprovider=${provider || 'default'} model=${model} sandbox=${sandbox} cwd=${cwd}`;
  appendMessage(convo, 'process', startContent, 'task_started');
  appendMessage(convo, 'tool', `执行 codex\n${redactArgs(args).join(' ')}`, 'codex_exec');
  writeEvent(res, { type: 'start', id: convo.id, conversationId: convo.id, args: redactArgs(args), cwd, model, provider, sandbox, approval });
  writeEvent(res, { type: 'process', content: startContent, kind: 'task_started' });
  writeEvent(res, { type: 'tool', content: `执行 codex\n${redactArgs(args).join(' ')}`, kind: 'codex_exec' });

  const child = spawn('codex', args, {
    cwd,
    env: { ...process.env, HOME: '/root', CODEX_HOME: '/root/.codex' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeProcess = child;
  activeConversationId = convo.id;
  let finished = false;
  res.on('close', () => {
    if (!finished && activeProcess === child) {
      appendMessage(convo, 'log', '客户端连接已断开，任务继续在后台运行。', 'client_disconnected');
      convo.updatedAt = new Date().toISOString();
      saveConversations();
    }
  });

  let finalText = '';
  let lastText = '';
  let rawBuffer = '';
  let stderr = '';
  const startedAt = Date.now();

  child.stdin.end(buildConversationPrompt(convo, model));

  child.stdout.on('data', (chunk) => {
    rawBuffer += chunk.toString();
    const lines = rawBuffer.split('\n');
    rawBuffer = lines.pop() || '';
    for (const line of lines) parseCodexEvent(line, res, convo, (text) => {
      finalText = text;
      if (text !== lastText) {
        lastText = text;
        appendMessage(convo, 'assistant', text, 'text');
      }
    });
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    appendMessage(convo, 'log', chunk.toString(), 'stderr');
    writeEvent(res, { type: 'stderr', content: chunk.toString() });
  });

  child.on('error', (err) => {
    finished = true;
    activeProcess = null;
    activeConversationId = '';
    convo.status = 'error';
    appendMessage(convo, 'assistant', err.message, 'error');
    writeEvent(res, { type: 'error', error: err.message });
    endStream(res);
  });

  child.on('close', (code) => {
    finished = true;
    if (rawBuffer.trim()) parseCodexEvent(rawBuffer, res, convo, (text) => {
      finalText = text;
      if (text !== lastText) appendMessage(convo, 'assistant', text, 'text');
    });
    activeProcess = null;
    activeConversationId = '';
    convo.status = code === 0 ? 'done' : 'error';
    const content = finalText || stderr.trim() || (code === 0 ? '完成，但没有文本输出。' : `Codex 退出码 ${code}`);
    if (content !== lastText) appendMessage(convo, 'assistant', content, code === 0 ? 'final' : 'error');
    const completeContent = `任务${code === 0 ? '完成' : '失败'}，退出码 ${code}，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    appendMessage(convo, 'process', completeContent, code === 0 ? 'task_complete' : 'task_error');
    convo.updatedAt = new Date().toISOString();
    saveConversations();
    writeEvent(res, { type: 'process', content: completeContent, kind: code === 0 ? 'task_complete' : 'task_error' });
    writeEvent(res, { type: code === 0 ? 'done' : 'error', code, content });
    endStream(res);
  });
});

app.get('/', (req, res) => {
  res.type('html').send(pageHtml(Boolean(validateSession(req))));
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const server = createServer(app);
const listenPort = PORT || await pickPort(PORT_MIN, PORT_MAX);
server.listen(listenPort, HOST, () => {
  const actual = server.address().port;
  writeFileSync(path.join(RUNTIME_DIR, 'port'), String(actual));
  console.log(`Codex Web UI: http://${getLanAddress()}:${actual}`);
});

function requireAuth(req, res, next) {
  if (validateSession(req)) return next();
  res.status(401).json({ error: '未登录' });
}

function validateSession(req) {
  const token = getCookie(req, 'codex_web_session');
  if (!token) return false;
  const key = hashToken(token);
  const expires = sessions.get(key);
  if (!expires || expires < Date.now()) {
    sessions.delete(key);
    return false;
  }
  sessions.set(key, Date.now() + SESSION_TTL_MS);
  return true;
}

function parseCodexEvent(line, res, convo, setFinalText) {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    const type = event.type || event.msg?.type || 'event';
    const processEvent = extractProcessEvent(event);
    if (processEvent) {
      appendMessage(convo, processEvent.role, processEvent.content, processEvent.type);
      writeEvent(res, { type: processEvent.role, content: processEvent.content, kind: processEvent.type });
      return;
    }
    const image = extractImage(event, convo.id);
    if (image) {
      appendMessage(convo, 'image', image.url, 'image');
      writeEvent(res, { type: 'image', url: image.url, prompt: image.prompt });
      return;
    }
    const text = extractText(event);
    if (text) {
      setFinalText(text);
      writeEvent(res, { type: 'text', content: text });
      return;
    }
    if (type.includes('error')) writeEvent(res, { type: 'event', event: type, content: JSON.stringify(event) });
  } catch {
    writeEvent(res, { type: 'log', content: line });
  }
}

function extractProcessEvent(event) {
  const payload = event.payload || event.item || event.msg || event;
  const type = payload?.type || event.type || '';
  if (event.type === 'session_meta') {
    return { role: 'process', type: 'session_meta', content: `Codex 会话 ${payload.id || ''}\nprovider=${payload.model_provider || '-'} cli=${payload.cli_version || '-'} cwd=${payload.cwd || '-'}` };
  }
  if (event.type === 'turn_context') {
    return { role: 'process', type: 'turn_context', content: `运行环境\nsandbox=${payload.sandbox_policy?.type || '-'} approval=${payload.approval_policy || '-'} network=${payload.network || '-'} cwd=${payload.cwd || '-'}` };
  }
  if (type === 'task_started') return { role: 'process', type: 'task_started', content: `任务开始\nturn=${payload.turn_id || '-'} context=${payload.model_context_window || '-'} mode=${payload.collaboration_mode_kind || '-'}` };
  if (type === 'task_complete') {
    const ms = payload.duration_ms ? `，耗时 ${(payload.duration_ms / 1000).toFixed(1)}s` : '';
    const ttf = payload.time_to_first_token_ms ? `，首 token ${(payload.time_to_first_token_ms / 1000).toFixed(1)}s` : '';
    return { role: 'process', type: 'task_complete', content: `任务完成${ms}${ttf}` };
  }
  if (type === 'token_count' && payload.info?.total_token_usage) {
    const u = payload.info.total_token_usage;
    const cached = u.cached_input_tokens != null ? `, cached ${u.cached_input_tokens}` : '';
    return { role: 'process', type: 'token_count', content: `Token 用量\ninput ${u.input_tokens ?? '-'}${cached}\noutput ${u.output_tokens ?? '-'}\nreasoning ${u.reasoning_output_tokens ?? '-'}\ntotal ${u.total_tokens ?? '-'}` };
  }
  if (type === 'agent_message' && payload.phase && payload.phase !== 'final_answer') {
    return { role: 'process', type: `agent_${payload.phase}`, content: `Codex ${payload.phase}\n${payload.message || ''}` };
  }
  if (type === 'reasoning') {
    const summary = Array.isArray(payload.summary) ? payload.summary.map((x) => x.text || x.content || '').filter(Boolean).join('\n') : '';
    const encrypted = payload.encrypted_content ? '\n已收到加密 reasoning 内容，CLI 不暴露完整思维链。' : '';
    return { role: 'thinking', type: 'reasoning', content: summary ? `思考摘要\n${summary}` : `模型思考事件${encrypted}` };
  }
  if (type === 'function_call') {
    const args = typeof payload.arguments === 'string' ? payload.arguments : JSON.stringify(payload.arguments || {});
    let brief = args;
    try {
      const parsed = JSON.parse(args);
      brief = parsed.cmd || parsed.command || JSON.stringify(parsed);
    } catch {}
    return { role: 'tool', type: 'function_call', content: `调用工具: ${payload.name || 'tool'}\ncall_id=${payload.call_id || '-'}\n${brief}` };
  }
  if (type === 'function_call_output') {
    const output = String(payload.output || '').trim();
    return { role: 'tool', type: 'function_call_output', content: `工具返回\ncall_id=${payload.call_id || '-'}\n${output.slice(0, 6000)}` };
  }
  if (type === 'tool_search_call') return { role: 'tool', type: 'tool_search_call', content: `搜索工具\nquery=${payload.arguments?.query || ''}\nlimit=${payload.arguments?.limit || '-'}` };
  if (type === 'tool_search_output') return { role: 'tool', type: 'tool_search_output', content: `搜索结果\n${(payload.tools || []).map((tool) => tool.name || tool.id || JSON.stringify(tool)).join('\n') || '无可用工具'}` };
  return null;
}

function appendMessage(convo, role, content, type = role) {
  const text = String(content || '').trimEnd();
  if (!text) return;
  convo.messages.push({ role, type, content: text, at: new Date().toISOString() });
  convo.updatedAt = new Date().toISOString();
  saveConversations();
}

function saveUploadedAttachment(body, options = {}) {
  const rawName = String(body.name || 'attachment').slice(0, 160);
  const safeName = rawName.replace(/[^\w.\-\u4e00-\u9fa5 ]/g, '').trim() || 'attachment';
  const data = String(body.data || '');
  const match = data.match(/^data:([^;,]*);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw new Error('上传内容格式无效');
  const type = String(body.type || match[1] || 'application/octet-stream').toLowerCase();
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) throw new Error('文件内容为空');

  const isImage = /^image\/(?:png|jpeg|webp|gif)$/.test(type);
  if (options.imagesOnly && !isImage) throw new Error('只支持 PNG、JPG、WEBP 或 GIF 图片');
  const ext = uploadExtension(safeName, type);
  if (!ext) throw new Error('不支持此文件类型');
  if (buffer.length > (isImage ? 10 : 25) * 1024 * 1024) throw new Error(isImage ? '图片不能超过 10MB' : '文件不能超过 25MB');

  const filename = `upload-${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`;
  const dir = isImage ? IMAGE_DIR : FILE_DIR;
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, buffer, { mode: 0o600 });
  return {
    name: safeName,
    type,
    kind: isImage ? 'image' : 'file',
    size: buffer.length,
    url: `${isImage ? '/assets/images' : '/assets/files'}/${filename}`,
    filePath,
  };
}

function readAppearance() {
  const fallback = { theme: 'light', chatBackground: 'default', customBackgrounds: [] };
  try {
    if (!existsSync(APPEARANCE_FILE)) return fallback;
    const data = JSON.parse(readFileSync(APPEARANCE_FILE, 'utf8'));
    const customBackgrounds = normalizeCustomBackgrounds(data.customBackgrounds);
    if (isBackgroundAssetUrl(data.customBackgroundUrl)) {
      const value = backgroundValueFromUrl(data.customBackgroundUrl);
      if (value && !customBackgrounds.some((item) => item.value === value)) {
        customBackgrounds.push({ name: '自定义背景', value, url: data.customBackgroundUrl });
      }
    }
    const legacyCustom = data.chatBackground === 'custom' && isBackgroundAssetUrl(data.customBackgroundUrl)
      ? backgroundValueFromUrl(data.customBackgroundUrl)
      : '';
    return {
      theme: data.theme === 'dark' ? 'dark' : 'light',
      chatBackground: cleanChatBackground(legacyCustom || data.chatBackground, customBackgrounds),
      customBackgrounds,
    };
  } catch {
    return fallback;
  }
}

function saveAppearance(next) {
  const current = readAppearance();
  const appearance = {
    theme: next.theme === undefined ? current.theme : next.theme === 'dark' ? 'dark' : 'light',
    customBackgrounds: next.customBackgrounds === undefined ? current.customBackgrounds : normalizeCustomBackgrounds(next.customBackgrounds),
  };
  appearance.chatBackground = next.chatBackground === undefined
    ? cleanChatBackground(current.chatBackground, appearance.customBackgrounds)
    : cleanChatBackground(next.chatBackground, appearance.customBackgrounds);
  writeFileSync(APPEARANCE_FILE, JSON.stringify(appearance, null, 2), { mode: 0o600 });
  return appearance;
}

function saveUploadedBackground(body) {
  const data = String(body.data || '');
  const match = data.match(/^data:([^;,]*);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw new Error('上传内容格式无效');
  const type = String(body.type || match[1] || '').toLowerCase();
  if (!/^image\/(?:png|jpeg|webp|gif)$/.test(type)) throw new Error('只支持 PNG、JPG、WEBP 或 GIF 图片');
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) throw new Error('图片内容为空');
  if (buffer.length > 10 * 1024 * 1024) throw new Error('背景图片不能超过 10MB');
  const ext = uploadExtension(String(body.name || 'background'), type);
  if (!['png', 'jpg', 'webp', 'gif'].includes(ext)) throw new Error('不支持此图片类型');
  const filename = `background-${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`;
  const filePath = path.join(BACKGROUND_DIR, filename);
  writeFileSync(filePath, buffer, { mode: 0o600 });
  return {
    name: cleanBackgroundName(body.name || 'background'),
    type,
    size: buffer.length,
    value: `bg:${filename}`,
    url: `/assets/backgrounds/${filename}`,
  };
}

function deleteCustomBackground(value) {
  const current = readAppearance();
  const target = current.customBackgrounds.find((item) => item.value === String(value || ''));
  if (!target) {
    const err = new Error('自定义背景不存在');
    err.statusCode = 404;
    throw err;
  }

  const filename = target.value.replace(/^bg:/, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(filename)) throw new Error('背景文件无效');
  const filePath = path.join(BACKGROUND_DIR, filename);
  if (path.resolve(filePath).startsWith(path.resolve(BACKGROUND_DIR) + path.sep) && existsSync(filePath)) {
    unlinkSync(filePath);
  }

  const customBackgrounds = current.customBackgrounds.filter((item) => item.value !== target.value);
  const chatBackground = current.chatBackground === target.value ? 'default' : current.chatBackground;
  return saveAppearance({ chatBackground, customBackgrounds });
}

function cleanChatBackground(value, customBackgrounds = []) {
  const text = String(value || '');
  if (['default', 'plain', 'paper', 'grid'].includes(text)) return text;
  if (customBackgrounds.some((item) => item.value === text)) return text;
  return 'default';
}

function isBackgroundAssetUrl(value) {
  return /^\/assets\/backgrounds\/[A-Za-z0-9_.-]+$/.test(String(value || ''));
}

function backgroundValueFromUrl(url) {
  const match = String(url || '').match(/^\/assets\/backgrounds\/([A-Za-z0-9_.-]+)$/);
  return match ? `bg:${match[1]}` : '';
}

function backgroundUrlFromValue(value) {
  const match = String(value || '').match(/^bg:([A-Za-z0-9_.-]+)$/);
  return match ? `/assets/backgrounds/${match[1]}` : '';
}

function normalizeCustomBackgrounds(items) {
  const seen = new Set();
  const list = [];
  for (const item of Array.isArray(items) ? items : []) {
    const url = isBackgroundAssetUrl(item?.url) ? item.url : backgroundUrlFromValue(item?.value);
    const value = backgroundValueFromUrl(url);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    list.push({
      name: cleanBackgroundName(item?.name),
      value,
      url,
    });
  }
  return list.slice(-20);
}

function cleanBackgroundName(name) {
  const text = String(name || '').replace(/[\r\n\t]/g, ' ').trim();
  return text ? text.slice(0, 80) : '自定义背景';
}

function uploadExtension(name, type) {
  const fromName = path.extname(name).replace(/^\./, '').toLowerCase();
  const mimeExt = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
    'application/json': 'json',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'text/html': 'html',
    'text/css': 'css',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'application/javascript': 'js',
    'text/javascript': 'js',
    'application/x-yaml': 'yaml',
    'text/yaml': 'yaml',
  };
  const allowed = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'txt', 'md', 'json', 'jsonl', 'csv', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'html', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'zsh', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'rb', 'sql']);
  const ext = allowed.has(fromName) ? fromName : mimeExt[type];
  if (!ext || !allowed.has(ext)) return '';
  return ext === 'jpeg' ? 'jpg' : ext;
}

function normalizeUploadedAttachments(attachments, legacyImages) {
  const source = Array.isArray(attachments) ? attachments : Array.isArray(legacyImages) ? legacyImages : [];
  return source.slice(0, 12).map((item) => {
    const filePath = path.resolve(String(item?.filePath || ''));
    const imageRoot = path.resolve(IMAGE_DIR);
    const fileRoot = path.resolve(FILE_DIR);
    const inImageRoot = filePath.startsWith(imageRoot + path.sep);
    const inFileRoot = filePath.startsWith(fileRoot + path.sep);
    if ((!inImageRoot && !inFileRoot) || !existsSync(filePath)) return null;
    const name = String(item?.name || path.basename(filePath)).slice(0, 160);
    const url = String(item?.url || '');
    const kind = inImageRoot ? 'image' : 'file';
    return { name, filePath, url, kind, type: String(item?.type || '') };
  }).filter(Boolean);
}

function appendAttachmentPrompt(message, attachments) {
  const text = String(message || '').trim();
  if (!attachments.length) return text;
  const imageCount = attachments.filter((item) => item.kind === 'image').length;
  const fileCount = attachments.length - imageCount;
  const fallback = imageCount && !fileCount ? '请识别并分析上传的图片。' : '请分析上传的附件。';
  const lines = [
    text || fallback,
    '',
    `用户上传了 ${attachments.length} 个附件（图片 ${imageCount} 个，文件 ${fileCount} 个）。请根据用户问题分析这些附件；如需查看内容，请读取下面的本机文件路径。`,
    ...attachments.map((item, index) => `${index + 1}. [${item.kind === 'image' ? '图片' : '文件'}] ${item.name}: ${item.filePath}`),
  ];
  return lines.join('\n').trim();
}

function extractImage(event, conversationId) {
  const payload = event.payload || event.item || event.msg || event;
  const type = payload?.type || event.type || '';
  const b64 = payload?.result || payload?.image || payload?.b64_json || payload?.base64;
  if (!b64 || typeof b64 !== 'string') return null;
  if (!String(type).includes('image')) return null;
  const clean = b64.replace(/^data:image\/\w+;base64,/, '');
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(clean.slice(0, 200))) return null;
  const id = randomBytes(8).toString('hex');
  const filename = `${conversationId}-${id}.png`;
  const filePath = path.join(IMAGE_DIR, filename);
  writeFileSync(filePath, Buffer.from(clean, 'base64'), { mode: 0o600 });
  return {
    url: `/assets/images/${filename}`,
    prompt: payload.revised_prompt || payload.prompt || '',
  };
}

function shouldUseDirectImage(model, message) {
  return /^gpt-image/i.test(model) && /生成|画|图片|照片|出图|生图|image/i.test(message);
}

async function generateImageDirect({ providerName, model, prompt, convo }) {
  const provider = readProviderDetails().find((item) => item.name === providerName) || readProviderDetails()[0];
  if (!provider) throw new Error('未找到可用服务商');
  const apiKey = process.env[provider.envKey] || readEnvVar(CODEX_ENV_FILE, provider.envKey);
  if (!apiKey) throw new Error(`缺少 ${provider.envKey}`);
  const endpoint = `${provider.baseUrl.replace(/\/+$/, '')}/images/generations`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, prompt, n: 1, size: '1024x1024', response_format: 'b64_json' }),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) throw new Error(`生图失败: HTTP ${response.status} ${bodyText.slice(0, 300)}`);
    const data = JSON.parse(bodyText);
    const first = data.data?.[0];
    if (!first) throw new Error('生图接口没有返回 data[0]');
    let buffer;
    if (first.b64_json) {
      buffer = Buffer.from(first.b64_json.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    } else if (first.url) {
      const imageRes = await fetch(first.url, { signal: controller.signal });
      if (!imageRes.ok) throw new Error(`下载图片失败: HTTP ${imageRes.status}`);
      buffer = Buffer.from(await imageRes.arrayBuffer());
    } else {
      throw new Error('生图接口没有返回 b64_json 或 url');
    }
    const filename = `${convo.id}-${randomBytes(8).toString('hex')}.png`;
    writeFileSync(path.join(IMAGE_DIR, filename), buffer, { mode: 0o600 });
    return { url: `/assets/images/${filename}`, prompt: first.revised_prompt || prompt };
  } finally {
    clearTimeout(timeout);
  }
}

function buildConversationPrompt(convo, model = '') {
  const usable = (convo.messages || [])
    .filter((msg) => ['user', 'assistant'].includes(msg.role) && String(msg.content || '').trim())
    .slice(-100);
  const latest = usable[usable.length - 1]?.content || '';
  const imageIntent = /^gpt-image/i.test(model) || /生成.*(图|图片|照片|image)|画.*(图|图片)|出图|生图/i.test(latest);
  const imageHint = imageIntent ? '如果用户请求生成图片，必须调用图像生成能力并返回图片结果，不要只用文字说明“已生成”。\n\n' : '';
  if (usable.length <= 1) return imageHint + (usable[0]?.content || '');
  const lines = [
    imageHint.trim(),
    '下面是当前 Web 会话的历史上下文。请基于这些上下文继续回答最后一个用户消息，不要把历史当成新的任务重复执行。',
    '',
  ].filter(Boolean);
  usable.forEach((msg, index) => {
    const role = msg.role === 'user' ? '用户' : '助手';
    const label = index === usable.length - 1 && msg.role === 'user' ? '当前用户消息' : role;
    lines.push(`### ${label}`);
    lines.push(String(msg.content).trim());
    lines.push('');
  });
  return lines.join('\n').trim();
}

function terminateProcess(child) {
  if (!child || child.killed) return;
  try {
    if (child.pid) process.kill(child.pid, 'SIGTERM');
  } catch {}
  setTimeout(() => {
    try {
      if (!child.killed && child.pid) process.kill(child.pid, 'SIGKILL');
    } catch {}
  }, 3000).unref();
}

function extractText(event) {
  const payload = event.payload || {};
  if (payload.type === 'agent_message' && (!payload.phase || payload.phase === 'final_answer') && typeof payload.message === 'string') return payload.message;
  if (payload.type === 'message' && payload.role === 'assistant') return flattenContent(payload.content);
  if (typeof event.message === 'string') return event.message;
  if (typeof event.content === 'string') return event.content;
  if (typeof event.item?.text === 'string') return event.item.text;
  if (typeof event.item?.content === 'string') return event.item.content;
  if (Array.isArray(event.item?.content)) {
    return event.item.content.map((part) => part.text || part.content || '').filter(Boolean).join('\n');
  }
  if (event.msg?.message?.content) return flattenContent(event.msg.message.content);
  if (event.msg?.item?.content) return flattenContent(event.msg.item.content);
  if (event.msg?.content) return flattenContent(event.msg.content);
  return '';
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text || part.content || '').filter(Boolean).join('\n');
  return '';
}

function writeEvent(res, data) {
  if (!res || res.destroyed || res.writableEnded) return;
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // The browser can close the stream while the background task continues.
  }
}

function endStream(res) {
  if (!res || res.destroyed || res.writableEnded) return;
  try {
    res.write('data: [DONE]\n\n');
    res.end();
  } catch {
    // The result is still persisted in the conversation history.
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function hashToken(token) {
  return createHash('sha256').update(SESSION_SECRET).update(token).digest('hex');
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || '';
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

function cleanValue(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9._:-]+$/.test(text) ? text : '';
}

function cleanProviderName(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(text) ? text : '';
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function cleanSandbox(value) {
  return ['read-only', 'workspace-write', 'danger-full-access'].includes(value) ? value : 'workspace-write';
}

function cleanApproval(value) {
  return ['untrusted', 'on-request', 'never'].includes(value) ? value : 'never';
}

function normalizeCwd(value) {
  const resolved = path.resolve(String(value || DEFAULT_CWD).replace(/^~/, homedir()));
  return existsSync(resolved) ? resolved : '';
}

function loadEnv(file, override = true) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}

function readEnvVar(file, key) {
  if (!existsSync(file)) return '';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${key}=`)) continue;
    let value = trimmed.slice(key.length + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return value;
  }
  return '';
}

async function fetchModels(baseUrl, apiKey) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) throw new Error(`获取模型失败: HTTP ${response.status} ${bodyText.slice(0, 200)}`);
    const data = JSON.parse(bodyText);
    const raw = Array.isArray(data) ? data : data.data;
    if (!Array.isArray(raw)) throw new Error('模型接口返回格式不是 OpenAI /models 结构');
    return raw.map((item) => typeof item === 'string' ? item : item.id).filter(Boolean).sort((a, b) => a.localeCompare(b));
  } finally {
    clearTimeout(timeout);
  }
}

function readProviders() {
  const config = '/root/.codex/config.toml';
  if (!existsSync(config)) return [];
  const providers = [];
  const content = readFileSync(config, 'utf8');
  for (const match of content.matchAll(/^\[model_providers\.([^\]]+)\]/gm)) providers.push(match[1]);
  return providers;
}

function readCodexDefaults() {
  const config = '/root/.codex/config.toml';
  if (!existsSync(config)) return {};
  const content = readFileSync(config, 'utf8');
  return {
    provider: content.match(/^model_provider\s*=\s*"([^"]+)"/m)?.[1] || '',
    model: content.match(/^model\s*=\s*"([^"]+)"/m)?.[1] || '',
  };
}

function readProviderDetails() {
  const config = '/root/.codex/config.toml';
  if (!existsSync(config)) return [];
  const content = readFileSync(config, 'utf8');
  const details = [];
  const blocks = content.split(/\n(?=\[model_providers\.)/g);
  for (const block of blocks) {
    const name = block.match(/^\[model_providers\.([^\]]+)\]/m)?.[1];
    if (!name) continue;
    details.push({
      name,
      displayName: block.match(/^name\s*=\s*"([^"]+)"/m)?.[1] || name,
      baseUrl: block.match(/^base_url\s*=\s*"([^"]+)"/m)?.[1] || '',
      envKey: block.match(/^env_key\s*=\s*"([^"]+)"/m)?.[1] || `${name.toUpperCase()}_API_KEY`,
      wireApi: block.match(/^wire_api\s*=\s*"([^"]+)"/m)?.[1] || 'responses',
      requiresOpenAIAuth: block.match(/^requires_openai_auth\s*=\s*(true|false)/m)?.[1] === 'true',
    });
  }
  return details;
}

function upsertProvider(next) {
  const providers = readProviderDetails().filter((provider) => provider.name !== next.name);
  providers.push({
    name: next.name,
    displayName: next.name,
    baseUrl: next.baseUrl,
    envKey: next.envKey,
    wireApi: next.wireApi,
    requiresOpenAIAuth: false,
  });

  writeCodexConfig(providers, next.name, next.model);
}

function writeCodexConfig(providers, defaultProvider, defaultModel) {
  if (!providers.length) throw new Error('至少保留一个服务商');
  backupCodexConfig();
  const providerBlocks = providers.map((provider) => `\n[model_providers.${provider.name}]\nname = "${tomlEscape(provider.displayName)}"\nbase_url = "${tomlEscape(provider.baseUrl)}"\nenv_key = "${tomlEscape(provider.envKey)}"\nwire_api = "${tomlEscape(provider.wireApi)}"\nrequires_openai_auth = ${provider.requiresOpenAIAuth ? 'true' : 'false'}\n`).join('');
  const content = `model_provider = "${tomlEscape(defaultProvider || providers[0].name)}"\nmodel = "${tomlEscape(defaultModel || DEFAULT_MODEL)}"\nreview_model = "${tomlEscape(defaultModel || DEFAULT_MODEL)}"\ndisable_response_storage = true\nnetwork_access = "enabled"\nwindows_wsl_setup_acknowledged = true\npersonality = "pragmatic"\n${providerBlocks}\n[projects."/"]\ntrust_level = "trusted"\n\n[projects."/opt/codex-web"]\ntrust_level = "trusted"\n\n[projects."/tmp"]\ntrust_level = "trusted"\n\n[projects."/root"]\ntrust_level = "trusted"\n`;
  validateCodexConfigText(content);
  writeFileSync('/root/.codex/config.toml', content, { mode: 0o600 });
}

function backupCodexConfig() {
  const config = '/root/.codex/config.toml';
  if (!existsSync(config)) return;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  writeFileSync(`/root/.codex/config.toml.bak.${stamp}`, readFileSync(config, 'utf8'), { mode: 0o600 });
}

function validateCodexConfigText(content) {
  for (const block of content.split(/\n(?=\[model_providers\.)/g)) {
    const name = block.match(/^\[model_providers\.([^\]]+)\]/m)?.[1];
    if (!name) continue;
    const providerBlock = block.split(/\n(?=\[[^\]]+\])/)[0];
    const keys = new Set();
    for (const match of providerBlock.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) {
      if (keys.has(match[1])) throw new Error(`Codex config provider ${name} 存在重复字段 ${match[1]}`);
      keys.add(match[1]);
    }
  }
}

function deleteProvider(name) {
  const config = '/root/.codex/config.toml';
  if (!existsSync(config)) throw new Error('Codex config 不存在');
  const providers = readProviderDetails();
  const target = providers.find((provider) => provider.name === name);
  if (!target) {
    const err = new Error('服务商不存在');
    err.statusCode = 404;
    throw err;
  }
  if (providers.length <= 1) {
    const err = new Error('至少保留一个服务商');
    err.statusCode = 400;
    throw err;
  }

  const remaining = providers.filter((provider) => provider.name !== name);
  const fallbackProvider = remaining[0]?.name || '';
  const defaults = readCodexDefaults();
  const deletedDefault = defaults.provider === name || process.env.DEFAULT_PROVIDER === name;
  const nextProvider = deletedDefault ? fallbackProvider : defaults.provider;
  const nextModel = defaults.model || DEFAULT_MODEL;
  if (deletedDefault && fallbackProvider) {
    updateEnvVar(ENV_FILE, 'DEFAULT_PROVIDER', fallbackProvider);
    process.env.DEFAULT_PROVIDER = fallbackProvider;
  }

  writeCodexConfig(remaining, nextProvider, nextModel);
  deleteEnvVar(CODEX_ENV_FILE, target.envKey);
  delete process.env[target.envKey];
  return { deleted: name, provider: nextProvider, model: nextModel };
}

function setCodexDefaults(provider, model) {
  const config = '/root/.codex/config.toml';
  if (!existsSync(config)) throw new Error('Codex config 不存在');
  let content = readFileSync(config, 'utf8');
  content = replaceTopLevelTomlValue(content, 'model_provider', provider);
  content = replaceTopLevelTomlValue(content, 'model', model);
  content = replaceTopLevelTomlValue(content, 'review_model', model);
  writeFileSync(config, content, { mode: 0o600 });
}

function replaceTopLevelTomlValue(content, key, value) {
  const line = `${key} = "${tomlEscape(value)}"`;
  const pattern = new RegExp(`^${key}\\s*=\\s*"[^"]*"`, 'm');
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${line}\n${content}`;
}

function updateEnvVar(file, key, value) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const nextLine = `${key}="${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return nextLine;
    }
    return line;
  });
  if (!found) next.push(nextLine);
  writeFileSync(file, next.filter((line, index, arr) => line || index < arr.length - 1).join('\n') + '\n', { mode: 0o600 });
}

function deleteEnvVar(file, key) {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const next = lines.filter((line) => !line.startsWith(`${key}=`));
  writeFileSync(file, next.filter((line, index, arr) => line || index < arr.length - 1).join('\n') + '\n', { mode: 0o600 });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tomlEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function redactArgs(args) {
  return args.map((arg) => arg.replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***'));
}

async function pickPort(min, max) {
  for (let i = 0; i < 100; i++) {
    const port = min + Math.floor(Math.random() * (max - min + 1));
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in ${min}-${max}`);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, HOST);
  });
}

function getLanAddress() {
  return process.env.PUBLIC_HOST || '192.168.10.10';
}

function loadConversations() {
  try {
    if (!existsSync(CONVERSATIONS_FILE)) return [];
    const data = JSON.parse(readFileSync(CONVERSATIONS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveConversations() {
  writeFileSync(CONVERSATIONS_FILE, JSON.stringify(conversations.slice(0, 100), null, 2), { mode: 0o600 });
}

function pageHtml(authenticated) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Codex Web</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{color-scheme:dark;--bg:#080b10;--panel:#0f141d;--panel2:#121926;--line:#253142;--text:#e6edf3;--muted:#8b98a8;--blue:#6aa8ff;--green:#37c871;--red:#ff6b6b;--user:#175ddc}
body[data-theme="light"]{color-scheme:light;--bg:#f6f8fb;--panel:#ffffff;--panel2:#eef3f8;--line:#d6deea;--text:#172033;--muted:#627084;--blue:#2563eb;--green:#16a34a;--red:#dc2626;--user:#2563eb}
*{box-sizing:border-box}body{margin:0;height:100vh;background:radial-gradient(circle at top left,#172033,#080b10 46%);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.hidden{display:none!important}
button,input,textarea,select{font:inherit}button{border:0;cursor:pointer}.login{height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(420px,100%);background:rgba(15,20,29,.88);border:1px solid var(--line);border-radius:22px;padding:28px;box-shadow:0 24px 90px rgba(0,0,0,.42);backdrop-filter:blur(18px)}.brand{font-size:28px;font-weight:780;letter-spacing:-.04em}.sub{margin:8px 0 24px;color:var(--muted)}.field{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}.field label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.field input,.field textarea,.field select{width:100%;background:#090d14;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:12px 13px;outline:none}.field input:focus,.field textarea:focus,.field select:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(106,168,255,.12)}.primary{width:100%;padding:12px 16px;border-radius:12px;background:linear-gradient(135deg,#2f81f7,#7c5cff);color:white;font-weight:700}.errorText{color:var(--red);font-size:13px;min-height:18px;margin-top:12px}
.app{height:100vh;display:grid;grid-template-columns:292px 1fr}.side{background:rgba(8,12,18,.82);border-right:1px solid var(--line);padding:18px;display:flex;flex-direction:column;gap:16px;overflow:auto}.brandRow{display:flex;align-items:center;justify-content:space-between;gap:10px}.logo{font-weight:800;font-size:22px;letter-spacing:-.04em}.pill{display:inline-flex;align-items:center;gap:6px;background:#122017;color:#94f0b1;border:1px solid #214c2c;border-radius:999px;padding:4px 9px;font-size:12px}.sideActions{display:grid;gap:10px;align-items:center}.themeToggle{display:grid;place-items:center;flex:0 0 auto;width:34px;height:34px;border-radius:11px;background:#172033;color:var(--text);border:1px solid var(--line);font-size:17px;font-weight:800}.themeToggle:hover{border-color:var(--blue);background:#1b2533}.settings{display:grid;gap:11px}.settings .field{margin:0}.smallrow{display:grid;grid-template-columns:1fr 1fr;gap:9px}.backgroundControls{display:grid;gap:8px;align-items:end}.backgroundRow{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end}.backgroundControls .field{margin:0}.providerBox{background:rgba(18,25,38,.74);border:1px solid var(--line);border-radius:14px;padding:10px}.providerBox summary{cursor:pointer;color:var(--text);font-weight:700;font-size:13px}.providerBox form{margin-top:12px}.miniPrimary{width:100%;padding:10px;border-radius:11px;background:var(--blue);color:#06101f;font-weight:800}.miniSecondary{align-self:end;width:100%;padding:10px;border-radius:11px;background:#1b2533;color:var(--text);border:1px solid var(--line);font-weight:700}.miniDanger{width:100%;padding:10px;border-radius:11px;background:#221114;color:#ff9da5;border:1px solid #613039;font-weight:800}.miniDanger:hover{background:#3a161c}.backgroundDelete{width:auto;min-width:56px;align-self:end}.history{flex:1.35;overflow:auto;display:flex;flex-direction:column;gap:10px;min-height:220px}.hist{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:13px 12px;color:var(--muted);font-size:13px;min-height:54px;cursor:pointer}.hist:hover{border-color:var(--blue);color:var(--text);background:#151d2b}.hist.active{border-color:var(--blue);color:var(--text);background:rgba(106,168,255,.14);box-shadow:inset 3px 0 0 var(--blue)}.histOpen{background:transparent;color:inherit;border:0;text-align:left;padding:0;overflow:hidden;text-overflow:ellipsis;white-space:normal;line-height:1.35;cursor:pointer}.histRename{background:#172033;color:var(--text);border:1px solid var(--line);border-radius:9px;padding:6px 8px;font-size:12px}.histRename:hover{border-color:var(--blue);background:#1b2533}.histDelete{background:#221114;color:#ff9da5;border:1px solid #613039;border-radius:9px;padding:6px 8px;font-size:12px}.histDelete:hover{background:#3a161c}.logout{background:transparent;color:var(--muted);border:1px solid var(--line);border-radius:11px;padding:10px}
.main{display:flex;flex-direction:column;min-width:0}.top{height:62px;border-bottom:1px solid var(--line);background:rgba(15,20,29,.75);display:flex;align-items:center;justify-content:space-between;padding:0 22px}.title{font-weight:720}.meta{color:var(--muted);font-size:13px}.chat{flex:1;overflow:auto;padding:26px;display:flex;flex-direction:column;gap:18px}.empty{margin:auto;text-align:center;color:var(--muted)}.empty b{display:block;color:var(--text);font-size:30px;letter-spacing:-.05em;margin-bottom:8px}.msg{max-width:min(880px,88%);border-radius:18px;padding:14px 16px;line-height:1.65;word-break:break-word}.msg.user{align-self:flex-end;background:linear-gradient(135deg,var(--user),#7147e8);color:white}.msg.assistant{align-self:flex-start;background:rgba(18,25,38,.86);border:1px solid var(--line)}.msg.log{align-self:flex-start;background:#0b1119;border:1px dashed var(--line);color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.msgActions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin:8px -4px -4px 0}.msgActions .tag{margin:0;margin-right:auto}.copyMsg,.rollbackMsg{display:grid;place-items:center;flex:0 0 auto;width:26px;height:24px;border:1px solid rgba(139,152,168,.28);border-radius:8px;background:rgba(8,12,18,.38);color:var(--muted);padding:0;font-size:13px;line-height:1}.copyMsg:hover,.rollbackMsg:hover{border-color:var(--blue);color:var(--text);background:rgba(106,168,255,.12)}.msg.user .copyMsg,.msg.user .rollbackMsg{border-color:rgba(255,255,255,.22);background:rgba(255,255,255,.1);color:rgba(255,255,255,.76)}.msg.user .copyMsg:hover,.msg.user .rollbackMsg:hover{color:#fff;background:rgba(255,255,255,.18)}.msgBody{white-space:pre-wrap}.composer{border-top:1px solid var(--line);background:rgba(15,20,29,.9);padding:16px 22px}.box{display:flex;gap:12px;align-items:flex-end}.box textarea{flex:1;min-height:52px;max-height:180px;resize:none;background:#090d14;border:1px solid var(--line);color:var(--text);border-radius:16px;padding:14px;outline:none}.box.drag textarea{border-color:var(--blue);box-shadow:0 0 0 3px rgba(106,168,255,.14)}.attachBtn{width:52px;height:52px;border-radius:16px;background:#172033;color:var(--text);border:1px solid var(--line);font-size:24px;line-height:1}.attachBtn:hover{border-color:var(--blue);background:#1b2533}.attachmentTray{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.attachmentChip{display:flex;align-items:center;gap:8px;max-width:280px;background:#0b1119;border:1px solid var(--line);border-radius:12px;padding:6px 8px;color:var(--muted);font-size:12px}.attachmentChip img,.attachmentIcon{width:42px;height:42px;flex:0 0 42px;border-radius:8px}.attachmentChip img{object-fit:cover}.attachmentIcon{display:grid;place-items:center;background:#172033;border:1px solid var(--line);color:var(--blue);font-weight:800;font-size:11px;text-transform:uppercase}.attachmentText{min-width:0;display:flex;flex-direction:column;gap:2px}.attachmentText span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.attachmentMeta{color:#627084;font-size:11px}.attachmentChip button{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:#221114;color:#ff9da5;border:1px solid #613039}.composerControls{display:flex;align-items:end;flex-wrap:wrap;gap:8px;margin-top:10px}.composerControls .field{width:96px;margin:0;gap:5px}.composerControls .field label{font-size:10px}.composerControls .field select{padding:6px 7px;border-radius:9px;font-size:12px}.send{width:92px;height:52px;border-radius:16px;background:var(--green);color:#07100a;font-weight:800}.send:disabled{opacity:.55;cursor:not-allowed}.hint{margin-top:8px;color:var(--muted);font-size:12px}.safety{flex:1 1 360px;min-width:260px;border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:12px;line-height:1.35;background:#0b1119;color:var(--muted)}.safety.safe{border-color:#254a33;color:#9ee8b5}.safety.warn{border-color:#6f5522;color:#ffd98a}.safety.danger{border-color:#743232;color:#ffabab;background:#190d0d}.spinner{display:inline-block;width:10px;height:10px;border:2px solid #405064;border-top-color:var(--blue);border-radius:50%;animation:spin .9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:820px){.app{grid-template-columns:1fr}.side{display:none}.chat{padding:16px}.msg{max-width:100%}.composerControls .field{width:calc(50% - 4px)}.safety{flex-basis:100%;min-width:0}}
.menuBtn{display:none}.scrim{display:none}@media(max-width:820px){html,body{height:100%;overflow:hidden}.app{display:block;height:100dvh;overflow:hidden}.main{height:100dvh;display:flex;flex-direction:column;overflow:hidden}.menuBtn{display:grid;place-items:center;flex:0 0 42px;width:42px;height:42px;border-radius:13px;background:#101722;border:1px solid var(--line);color:var(--text);font-size:24px;line-height:1}.side{display:flex;position:fixed;z-index:30;left:0;top:0;bottom:0;width:min(86vw,330px);transform:translateX(-105%);transition:transform .22s ease;background:rgba(8,12,18,.96);box-shadow:26px 0 80px rgba(0,0,0,.45)}.app.menuOpen .side{transform:translateX(0)}.scrim{display:block;position:fixed;z-index:20;inset:0;background:rgba(0,0,0,.48);opacity:0;pointer-events:none;transition:opacity .2s}.app.menuOpen .scrim{opacity:1;pointer-events:auto}.top{flex:0 0 auto;min-height:58px;height:auto;padding:calc(env(safe-area-inset-top,0px) + 8px) 14px 8px;gap:12px;justify-content:flex-start}.top .meta:last-child{margin-left:auto}.chat{flex:1 1 auto;min-height:0;overflow:auto;padding:14px}.composer{flex:0 0 auto;padding:12px 12px calc(env(safe-area-inset-bottom,0px) + 12px)}.box{gap:8px}.send{width:72px}.msg{max-width:100%}}
.msg.image{padding:8px;background:rgba(18,25,38,.86);border:1px solid var(--line)}.msg.image img{display:block;max-width:min(520px,100%);border-radius:14px}.msg.image a{display:inline-block;margin-top:8px;color:var(--blue);font-size:13px;text-decoration:none}
.msg{font-size:13px}.msg.user,.msg.assistant{font-size:13px}.msg.process,.msg.tool,.msg.thinking{align-self:flex-start;max-width:min(780px,92%);padding:8px 10px;border-radius:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.45;color:#8f9bad;background:#091018;border:1px dashed #263244}.msg.thinking{color:#b8a8ff;border-color:#3e3568;background:#100d1b}.msg.tool{color:#8fd7ff;border-color:#244a60;background:#08141d}.msg.process{color:#9ee8b5;border-color:#254a33;background:#0b1510}
.msg .tag{display:block;margin-bottom:4px;opacity:.75;font-weight:800;letter-spacing:.08em;font-size:10px}
.settingsToggle{width:100%;padding:10px;border-radius:11px;background:#172033;color:var(--text);border:1px solid var(--line);font-weight:800}.settingsToggle:hover{border-color:var(--blue)}.settingsPanel{display:none;gap:12px}.settingsPanel.open{display:grid}
body[data-theme="light"]{background:linear-gradient(135deg,#f8fbff,#edf2f7)}body[data-theme="light"] .card{background:rgba(255,255,255,.9);box-shadow:0 24px 70px rgba(31,41,55,.16)}body[data-theme="light"] .side{background:rgba(247,250,252,.92)}body[data-theme="light"] .top,body[data-theme="light"] .composer{background:rgba(255,255,255,.9)}body[data-theme="light"] .field input,body[data-theme="light"] .field textarea,body[data-theme="light"] .field select,body[data-theme="light"] .box textarea{background:#fff}body[data-theme="light"] .providerBox,body[data-theme="light"] .hist,body[data-theme="light"] .msg.assistant,body[data-theme="light"] .msg.image{background:rgba(255,255,255,.86)}body[data-theme="light"] .hist:hover{background:#eef4ff}body[data-theme="light"] .hist.active{background:rgba(37,99,235,.1)}body[data-theme="light"] .miniSecondary,body[data-theme="light"] .settingsToggle,body[data-theme="light"] .themeToggle,body[data-theme="light"] .histRename,body[data-theme="light"] .attachBtn,body[data-theme="light"] .menuBtn{background:#eef3f8}body[data-theme="light"] .msg.log,body[data-theme="light"] .attachmentChip,body[data-theme="light"] .safety{background:#f8fafc}body[data-theme="light"] .msg.process{background:#edfdf2}body[data-theme="light"] .msg.tool{background:#eef7ff}body[data-theme="light"] .msg.thinking{background:#f5f1ff}
body[data-chat-bg="default"] .chat{background:transparent}body[data-chat-bg="plain"] .chat{background:var(--bg)}body[data-chat-bg="paper"] .chat{background:#f4ecd8;color:#1f2937}body[data-chat-bg="paper"] .chat .empty,body[data-chat-bg="paper"] .chat .meta{color:#725f43}body[data-chat-bg="grid"] .chat{background-color:var(--bg);background-image:linear-gradient(rgba(106,168,255,.11) 1px,transparent 1px),linear-gradient(90deg,rgba(106,168,255,.11) 1px,transparent 1px);background-size:28px 28px}body[data-chat-bg="custom"] .chat{background-color:var(--bg);background-image:var(--custom-chat-bg);background-size:cover;background-position:center;background-repeat:no-repeat}body[data-theme="light"][data-chat-bg="grid"] .chat{background-image:linear-gradient(rgba(37,99,235,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(37,99,235,.12) 1px,transparent 1px)}body[data-theme="light"][data-chat-bg="paper"] .chat{background:#f7efd9}
@media(min-width:821px){.app{display:block;height:100vh;overflow:hidden}.side{position:fixed;left:0;top:0;bottom:0;width:292px;height:100vh;z-index:10}.main{margin-left:292px;height:100vh}}
</style>
</head>
<body>
<section id="login" class="login ${authenticated ? 'hidden' : ''}"><div class="card"><div class="brand">Codex Web</div><div class="sub">输入访问密码后使用本机 Codex CLI。</div><form id="loginForm"><div class="field"><label>密码</label><input id="password" type="password" autocomplete="current-password" autofocus></div><button class="primary">登录</button><div id="loginError" class="errorText"></div></form></div></section>
<section id="app" class="app ${authenticated ? '' : 'hidden'}"><div id="scrim" class="scrim"></div><aside class="side"><div><div class="brandRow"><div class="logo">Codex Web</div><button id="themeToggle" class="themeToggle" type="button" title="切换黑暗模式" aria-label="切换黑暗模式">☾</button></div><div style="margin-top:8px"><span class="pill"><span></span>Protected</span></div></div><div class="sideActions"><button id="newChat" class="miniPrimary">新建会话</button></div><button id="settingsToggle" class="settingsToggle">设置</button><div id="settingsPanel" class="settingsPanel"><div class="settings"><div class="backgroundControls"><div class="backgroundRow"><div class="field"><label>会话背景</label><select id="chatBackground"><option value="default">默认</option><option value="plain">纯净</option><option value="paper">纸张</option><option value="grid">网格</option><option value="custom">自定义</option></select></div><button id="deleteBackground" class="miniDanger backgroundDelete hidden" type="button">删除</button></div><input id="chatBackgroundFile" class="hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></div><div class="field"><label>Provider</label><select id="provider"><option value="">默认</option></select></div><div class="field"><label>Model</label><select id="model"></select></div><button id="refreshProviderModels" class="miniSecondary" type="button">更新模型</button><button id="saveDefault" class="miniSecondary">设为默认模型</button><button id="deleteProvider" class="miniDanger" type="button">删除服务商</button><div id="defaultMsg" class="errorText"></div><div class="field"><label>工作目录</label><input id="cwd" value="/root"></div></div><details class="providerBox"><summary>添加服务商</summary><form id="providerForm"><div class="field"><label>名称</label><input id="newProviderName" placeholder="例如 Chy"></div><div class="field"><label>Base URL</label><input id="newProviderUrl" placeholder="https://example.com/v1"></div><div class="field"><label>API Key</label><input id="newProviderKey" type="password" placeholder="sk-..."></div><div class="field"><label>模型</label><select id="newProviderModel"><option value="">先获取模型</option></select></div><div class="smallrow"><button type="button" id="fetchNewModels" class="miniSecondary">获取模型</button><div class="field"><label>API</label><select id="newProviderWire"><option value="responses">responses</option><option value="chat">chat</option></select></div></div><button class="miniPrimary">保存并设为默认</button><div id="providerMsg" class="errorText"></div></form></details></div><div class="meta">最近会话</div><div id="history" class="history"></div><button id="logout" class="logout">退出登录</button></aside><main class="main"><div class="top"><button id="menuBtn" class="menuBtn" aria-label="打开设置">☰</button><div><div class="title">Chat</div><div id="status" class="meta">Ready</div></div><div class="meta">codex exec</div></div><div id="chat" class="chat"><div class="empty"><b>Ask Codex</b><span>选择目录和模型，然后发送任务。</span></div></div><div class="composer"><div id="dropZone" class="box"><textarea id="input" rows="1" placeholder="输入任务，Shift+Enter 换行；可拖入图片或文件"></textarea><button id="attachFile" class="attachBtn" type="button" title="上传附件" aria-label="上传附件">＋</button><input id="fileInput" class="hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/csv,application/json,.txt,.md,.json,.jsonl,.csv,.log,.pdf,.xml,.yaml,.yml,.toml,.ini,.html,.css,.js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.sh,.bash,.zsh,.go,.rs,.java,.c,.h,.cpp,.hpp,.cs,.php,.rb,.sql" multiple><button id="send" class="send">发送</button><button id="cancelRun" class="send hidden" style="background:#ff6b6b;color:#1b0909">取消</button></div><div id="attachmentTray" class="attachmentTray hidden"></div><div class="composerControls"><div class="field"><label>权限模式</label><select id="sandbox"><option value="read-only">只读</option><option value="workspace-write">工作区写入</option><option value="danger-full-access">高危全权限</option></select></div><div class="field"><label>确认策略</label><select id="approval"><option value="never">从不询问</option><option value="on-request">按需询问</option><option value="untrusted">不可信时询问</option></select></div><div id="safetyHint" class="safety safe"></div></div><div class="hint">权限按“整次任务”生效，不会逐条命令弹窗确认。</div></div></main></section>
<script>
const login = document.getElementById('login'), app = document.getElementById('app'), loginForm = document.getElementById('loginForm'), loginError = document.getElementById('loginError');
const chat = document.getElementById('chat'), input = document.getElementById('input'), sendBtn = document.getElementById('send'), cancelBtn = document.getElementById('cancelRun'), statusEl = document.getElementById('status');
const dropZone = document.getElementById('dropZone'), attachFile = document.getElementById('attachFile'), fileInput = document.getElementById('fileInput'), attachmentTray = document.getElementById('attachmentTray');
const provider = document.getElementById('provider'), model = document.getElementById('model'), cwd = document.getElementById('cwd'), sandbox = document.getElementById('sandbox'), approval = document.getElementById('approval'), history = document.getElementById('history'), providerForm = document.getElementById('providerForm'), providerMsg = document.getElementById('providerMsg'), newProviderModel = document.getElementById('newProviderModel'), defaultMsg = document.getElementById('defaultMsg'), safetyHint = document.getElementById('safetyHint');
const settingsToggle = document.getElementById('settingsToggle'), settingsPanel = document.getElementById('settingsPanel');
const themeToggle = document.getElementById('themeToggle'), chatBackground = document.getElementById('chatBackground'), chatBackgroundFile = document.getElementById('chatBackgroundFile'), deleteBackground = document.getElementById('deleteBackground');
let currentConversationId = '';
let conversationLoadSeq = 0;
let dangerConfirmed = false;
let pendingAttachments = [];
let appearance = {theme:'light',chatBackground:'default',customBackgrounds:[]};
applyAppearance();
loginForm?.addEventListener('submit', async (e)=>{e.preventDefault();loginError.textContent='';const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('password').value})});if(res.ok){login.classList.add('hidden');app.classList.remove('hidden');await boot();input.focus()}else{loginError.textContent=(await res.json()).error||'登录失败'}});
document.getElementById('logout')?.addEventListener('click', async()=>{await fetch('/api/logout',{method:'POST'});location.reload()});
document.getElementById('newChat')?.addEventListener('click', newChat);
document.getElementById('refreshProviderModels')?.addEventListener('click', refreshProviderModels);
document.getElementById('saveDefault')?.addEventListener('click', saveDefaultModel);
document.getElementById('deleteProvider')?.addEventListener('click', deleteSelectedProvider);
settingsToggle?.addEventListener('click', toggleSettings);
document.getElementById('menuBtn')?.addEventListener('click', toggleMenu);
document.getElementById('scrim')?.addEventListener('click', closeMenu);
providerForm?.addEventListener('submit', async(e)=>{e.preventDefault();providerMsg.textContent='保存中...';const payload={name:document.getElementById('newProviderName').value,baseUrl:document.getElementById('newProviderUrl').value,apiKey:document.getElementById('newProviderKey').value,model:newProviderModel.value,wireApi:document.getElementById('newProviderWire').value};const res=await fetch('/api/providers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await res.json();if(!res.ok){providerMsg.textContent=data.error||'保存失败';return}providerMsg.textContent='已保存';document.getElementById('newProviderKey').value='';await boot();provider.value=data.provider;await loadModels(data.provider,data.model);});
document.getElementById('fetchNewModels')?.addEventListener('click', async()=>{providerMsg.textContent='获取模型中...';const data=await requestModels({baseUrl:document.getElementById('newProviderUrl').value,apiKey:document.getElementById('newProviderKey').value});if(data.error){providerMsg.textContent=data.error;return}fillSelect(newProviderModel,data.models,data.models[0]||'');providerMsg.textContent=data.models.length?'已获取 '+data.models.length+' 个模型':'没有返回模型';});
provider?.addEventListener('change',()=>loadModels(provider.value));
sandbox?.addEventListener('change',()=>{dangerConfirmed=false;updateSafetyHint()});
themeToggle?.addEventListener('click',toggleTheme);
chatBackground?.addEventListener('change',handleChatBackgroundChange);
chatBackgroundFile?.addEventListener('change',()=>handleCustomBackground(chatBackgroundFile.files?.[0]));
deleteBackground?.addEventListener('click',deleteSelectedBackground);
sendBtn?.addEventListener('click', send);input?.addEventListener('keydown',(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});input?.addEventListener('input',()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,180)+'px'});
attachFile?.addEventListener('click',()=>fileInput?.click());
fileInput?.addEventListener('change',()=>{handleAttachmentFiles(fileInput.files);fileInput.value=''});
dropZone?.addEventListener('dragover',(e)=>{if(hasFileDrag(e)){e.preventDefault();dropZone.classList.add('drag')}});
dropZone?.addEventListener('dragleave',()=>dropZone.classList.remove('drag'));
dropZone?.addEventListener('drop',(e)=>{dropZone.classList.remove('drag');const files=[...(e.dataTransfer?.files||[])];if(!files.length)return;e.preventDefault();handleAttachmentFiles(files)});
dropZone?.addEventListener('paste',handleAttachmentPaste);
input?.addEventListener('paste',handleAttachmentPaste);
cancelBtn?.addEventListener('click', cancelRun);
if (${authenticated ? 'true' : 'false'}) boot();
async function toggleTheme(){const next=appearance.theme==='dark'?'light':'dark';await saveAppearance({theme:next})}
function applyAppearance(){const theme=appearance.theme==='dark'?'dark':'light';const selected=cleanBackgroundValue(appearance.chatBackground);const custom=selected.startsWith('bg:')?findCustomBackground(selected):null;const bg=custom?'custom':selected;document.body.dataset.theme=theme;document.body.dataset.chatBg=bg;document.body.style.setProperty('--custom-chat-bg',custom?'url("'+custom.url+'")':'none');if(themeToggle){themeToggle.textContent=theme==='dark'?'☀':'☾';themeToggle.title=theme==='dark'?'切换明亮模式':'切换黑暗模式';themeToggle.setAttribute('aria-label',themeToggle.title)}renderBackgroundOptions(selected);updateDeleteBackgroundButton(selected)}
async function saveAppearance(patch){const res=await fetch('/api/appearance',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});const data=await res.json();if(!res.ok){statusEl.textContent=data.error||'外观保存失败';applyAppearance();return null}appearance=data.appearance;applyAppearance();return appearance}
function renderBackgroundOptions(selected){if(!chatBackground)return;const options=[['default','默认'],['plain','纯净'],['paper','纸张'],['grid','网格']];for(const item of appearance.customBackgrounds||[])options.push([item.value,item.name]);options.push(['custom','自定义']);chatBackground.innerHTML='';for(const [value,label] of options){const opt=document.createElement('option');opt.value=value;opt.textContent=label;chatBackground.appendChild(opt)}chatBackground.value=options.some(([value])=>value===selected)?selected:'default'}
function cleanBackgroundValue(value){const text=String(value||'');if(['default','plain','paper','grid'].includes(text))return text;return findCustomBackground(text)?text:'default'}
function findCustomBackground(value){return (appearance.customBackgrounds||[]).find((item)=>item.value===value&&item.url)}
function updateDeleteBackgroundButton(selected){if(!deleteBackground)return;deleteBackground.classList.toggle('hidden',!findCustomBackground(selected));deleteBackground.disabled=!findCustomBackground(selected)}
async function handleChatBackgroundChange(){const value=chatBackground.value;if(value==='custom'){const reset=saveAppearance({chatBackground:'default'});chatBackgroundFile?.click();await reset;return}await saveAppearance({chatBackground:value});statusEl.textContent='会话背景已更新'}
async function handleCustomBackground(file){if(!file){await saveAppearance({chatBackground:'default'});statusEl.textContent='已恢复默认背景';return}if(!file.type.startsWith('image/')){statusEl.textContent='请选择图片文件';await saveAppearance({chatBackground:'default'});return}try{statusEl.textContent='上传背景...';const data=await readFileDataUrl(file);const res=await fetch('/api/appearance/background',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name,type:file.type,data})});const body=await res.json();if(!res.ok)throw new Error(body.error||'背景上传失败');appearance=body.appearance;applyAppearance();statusEl.textContent='自定义背景已应用'}catch(e){statusEl.textContent=e.message;await saveAppearance({chatBackground:'default'})}finally{chatBackgroundFile.value=''}}
async function deleteSelectedBackground(){const selected=cleanBackgroundValue(appearance.chatBackground);const custom=findCustomBackground(selected);if(!custom)return;if(!confirm('删除自定义背景 '+custom.name+'？'))return;statusEl.textContent='删除背景...';const res=await fetch('/api/appearance/background',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:selected})});const data=await res.json();if(!res.ok){statusEl.textContent=data.error||'背景删除失败';return}appearance=data.appearance;applyAppearance();statusEl.textContent='自定义背景已删除'}
async function boot(){const res=await fetch('/api/config');if(!res.ok)return;const data=await res.json();appearance=data.appearance||appearance;applyAppearance();cwd.value=data.defaults.cwd;sandbox.value=data.defaults.sandbox;approval.value=data.defaults.approval;provider.innerHTML='<option value="">默认</option>';for(const p of data.providers){const opt=document.createElement('option');opt.value=p;opt.textContent=p;provider.appendChild(opt)}provider.value=data.defaults.provider||'';await loadModels(provider.value,data.defaults.model);renderHistory(data.conversations);updateSafetyHint()}
async function refreshHistory(){const res=await fetch('/api/config');if(!res.ok)return;const data=await res.json();renderHistory(data.conversations)}
async function loadModels(providerName,selected){model.innerHTML='<option value="">获取模型中...</option>';const data=await requestModels({provider:providerName});if(data.error){fillSelect(model,[selected||'gpt-5.5'],selected||'gpt-5.5');statusEl.textContent=data.error;return}fillSelect(model,data.models,selected||data.models[0]||'')}
async function refreshProviderModels(){const providerName=provider.value;if(!providerName){defaultMsg.textContent='请选择要更新模型的服务商';return}const selected=model.value;defaultMsg.textContent='更新模型中...';const data=await requestModels({provider:providerName});if(data.error){defaultMsg.textContent=data.error;return}fillSelect(model,data.models,selected);defaultMsg.textContent=data.models.length?'模型列表已更新，共 '+data.models.length+' 个':'没有返回模型'}
async function saveDefaultModel(){defaultMsg.textContent='保存中...';const res=await fetch('/api/defaults',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:provider.value,model:model.value})});const data=await res.json();if(!res.ok){defaultMsg.textContent=data.error||'保存失败';return}defaultMsg.textContent='默认模型已设为 '+data.model;statusEl.textContent='Default: '+data.provider+' / '+data.model}
async function deleteSelectedProvider(){const name=provider.value;if(!name){defaultMsg.textContent='请选择要删除的具体服务商';return}if(!confirm('删除服务商 '+name+'？该操作会移除对应配置和 API Key。'))return;defaultMsg.textContent='删除中...';const res=await fetch('/api/providers/'+encodeURIComponent(name),{method:'DELETE'});const data=await res.json();if(!res.ok){defaultMsg.textContent=data.error||'删除失败';return}defaultMsg.textContent='已删除服务商 '+name;await boot();if(data.provider){provider.value=data.provider;await loadModels(data.provider,data.model)}statusEl.textContent='Provider deleted'}
async function requestModels(payload){try{const res=await fetch('/api/models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await res.json();return res.ok?data:{error:data.error||'获取模型失败'}}catch(e){return{error:e.message}}}
function fillSelect(select,items,selected){select.innerHTML='';const list=[...new Set((items||[]).filter(Boolean))];if(!list.length)list.push(selected||'gpt-5.5');for(const item of list){const opt=document.createElement('option');opt.value=item;opt.textContent=item;select.appendChild(opt)}select.value=list.includes(selected)?selected:list[0]}
function renderHistory(items){history.innerHTML='';for(const item of items){const row=document.createElement('div');row.className='hist';row.dataset.id=item.id;if(item.id===currentConversationId)row.classList.add('active');row.title=item.title;row.addEventListener('click',()=>loadConversation(item.id));const open=document.createElement('button');open.type='button';open.className='histOpen';open.textContent=(item.status==='running'?'● ':'')+item.title;open.title=item.title;open.addEventListener('click',(e)=>{e.stopPropagation();loadConversation(item.id)});const rename=document.createElement('button');rename.type='button';rename.className='histRename';rename.textContent='改名';rename.addEventListener('click',(e)=>{e.stopPropagation();renameConversation(item.id,item.title)});const del=document.createElement('button');del.type='button';del.className='histDelete';del.textContent='删除';del.addEventListener('click',(e)=>{e.stopPropagation();deleteConversation(item.id,item.title)});row.appendChild(open);row.appendChild(rename);row.appendChild(del);history.appendChild(row)}}
function updateActiveHistory(){history.querySelectorAll('.hist').forEach((row)=>row.classList.toggle('active',row.dataset.id===currentConversationId))}
async function renameConversation(id,title){const next=prompt('修改会话标题',title||'');if(next===null)return;const clean=next.trim().replace(/\s+/g,' ').slice(0,80);if(!clean){statusEl.textContent='标题不能为空';return}const res=await fetch('/api/conversations/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:clean})});const data=await res.json();if(!res.ok){statusEl.textContent=data.error||'改名失败';return}await refreshHistory();statusEl.textContent='标题已更新'}
async function deleteConversation(id,title){if(!confirm('删除会话：'+title+'？'))return;const res=await fetch('/api/conversations/'+encodeURIComponent(id),{method:'DELETE'});if(!res.ok){statusEl.textContent='删除失败';return}if(currentConversationId===id)newChat();await refreshHistory();statusEl.textContent='Deleted'}
function toggleMenu(){app.classList.toggle('menuOpen')}
function closeMenu(){app.classList.remove('menuOpen')}
function toggleSettings(){settingsPanel.classList.toggle('open');settingsToggle.textContent=settingsPanel.classList.contains('open')?'收起设置':'设置'}
function newChat(){conversationLoadSeq++;currentConversationId='';updateActiveHistory();chat.innerHTML='<div class="empty"><b>Ask Codex</b><span>选择目录和模型，然后发送任务。</span></div>';statusEl.textContent='New chat';input.value='';input.style.height='auto';clearPendingAttachments();closeMenu();input.focus()}
function scrollChatToLatest(){requestAnimationFrame(()=>{chat.scrollTop=chat.scrollHeight})}
async function loadConversation(id){const seq=++conversationLoadSeq;currentConversationId=id;updateActiveHistory();statusEl.textContent='Loading...';const res=await fetch('/api/conversations/'+encodeURIComponent(id));if(seq!==conversationLoadSeq)return;if(!res.ok){statusEl.textContent='加载失败';return}const data=await res.json();if(seq!==conversationLoadSeq)return;currentConversationId=data.conversation.id;updateActiveHistory();chat.innerHTML='';(data.conversation.messages||[]).forEach((msg,index)=>addMsg(msg.role==='log'?'log':msg.role,msg.content,{messageIndex:index}));statusEl.textContent='Loaded '+new Date(data.conversation.updatedAt||data.conversation.createdAt).toLocaleString();closeMenu();scrollChatToLatest()}
async function rollbackConversation(messageIndex){if(!currentConversationId)return;if(sendBtn.disabled){statusEl.textContent='任务运行中，不能回退';return}if(!confirm('回退到这条用户消息？它之后的所有消息都会被删除。'))return;statusEl.textContent='回退中...';const res=await fetch('/api/conversations/'+encodeURIComponent(currentConversationId)+'/rollback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messageIndex})});const data=await res.json();if(!res.ok){statusEl.textContent=data.error||'回退失败';return}clearPendingAttachments();await loadConversation(data.conversation.id);await refreshHistory();statusEl.textContent='已回退到所选消息'}
function addMsg(role,text,options={}){const empty=chat.querySelector('.empty');if(empty)empty.remove();const el=document.createElement('div');el.className='msg '+role;if(role==='image'){const img=document.createElement('img');img.src=text;img.alt='generated image';const a=document.createElement('a');a.href=text;a.target='_blank';a.rel='noopener';a.textContent='打开图片';el.appendChild(img);el.appendChild(a)}else{const body=document.createElement('div');body.className='msgBody';body.textContent=text;const actions=document.createElement('div');actions.className='msgActions';if(['process','thinking','tool','log'].includes(role)){const tag=document.createElement('span');tag.className='tag';tag.textContent=role==='process'?'过程':role==='thinking'?'思考':role==='tool'?'工具':'日志';actions.appendChild(tag)}if(role==='user'&&Number.isInteger(options.messageIndex)){const rollback=document.createElement('button');rollback.type='button';rollback.className='rollbackMsg';rollback.textContent='↩';rollback.title='回退到这条消息';rollback.setAttribute('aria-label','回退到这条消息');rollback.addEventListener('click',(e)=>{e.stopPropagation();rollbackConversation(options.messageIndex)});actions.appendChild(rollback)}const copy=document.createElement('button');copy.type='button';copy.className='copyMsg';copy.textContent='⧉';copy.title='复制此消息';copy.setAttribute('aria-label','复制此消息');copy.addEventListener('click',(e)=>{e.stopPropagation();copyText(text,copy)});actions.appendChild(copy);el.appendChild(body);el.appendChild(actions)}chat.appendChild(el);scrollChatToLatest();return el}
async function copyText(text,button){try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text)}else{const tmp=document.createElement('textarea');tmp.value=text;tmp.setAttribute('readonly','');tmp.style.position='fixed';tmp.style.left='-9999px';document.body.appendChild(tmp);tmp.select();document.execCommand('copy');tmp.remove()}button.textContent='✓';setTimeout(()=>{button.textContent='⧉'},1200)}catch(e){button.textContent='!';setTimeout(()=>{button.textContent='⧉'},1200)}}
function hasFileDrag(e){return [...(e.dataTransfer?.items||[])].some((item)=>item.kind==='file')}
function handleAttachmentPaste(e){const files=[...(e.clipboardData?.items||[])].filter((item)=>item.kind==='file'&&item.type.startsWith('image/')).map((item)=>item.getAsFile()).filter(Boolean);if(!files.length)return;e.preventDefault();e.stopPropagation();handleAttachmentFiles(files)}
async function handleAttachmentFiles(fileList){const files=[...(fileList||[])];if(!files.length)return;for(const file of files){if(pendingAttachments.length>=12){statusEl.textContent='最多一次上传 12 个附件';break}try{statusEl.textContent='上传附件...';const data=await readFileDataUrl(file);const res=await fetch('/api/uploads/file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name,type:file.type,data})});const body=await res.json();if(!res.ok)throw new Error(body.error||'上传失败');pendingAttachments.push(body.attachment);renderAttachmentTray();statusEl.textContent='已添加附件'}catch(e){statusEl.textContent=e.message}}input.focus()}
function readFileDataUrl(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('读取文件失败'));reader.readAsDataURL(file)})}
function formatBytes(size){if(!Number.isFinite(size))return '';if(size<1024)return size+' B';if(size<1024*1024)return (size/1024).toFixed(1)+' KB';return (size/1024/1024).toFixed(1)+' MB'}
function fileLabel(attachment){const ext=(attachment.name||'file').split('.').pop()||'file';return ext.slice(0,4)}
function renderAttachmentTray(){attachmentTray.innerHTML='';attachmentTray.classList.toggle('hidden',pendingAttachments.length===0);pendingAttachments.forEach((attachment,index)=>{const chip=document.createElement('div');chip.className='attachmentChip';if(attachment.kind==='image'){const img=document.createElement('img');img.src=attachment.url;img.alt=attachment.name||'uploaded image';chip.appendChild(img)}else{const icon=document.createElement('div');icon.className='attachmentIcon';icon.textContent=fileLabel(attachment);chip.appendChild(icon)}const text=document.createElement('div');text.className='attachmentText';const name=document.createElement('span');name.textContent=attachment.name||'attachment';const meta=document.createElement('span');meta.className='attachmentMeta';meta.textContent=(attachment.kind==='image'?'图片':'文件')+(attachment.size?' · '+formatBytes(attachment.size):'');text.appendChild(name);text.appendChild(meta);const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.title='移除附件';remove.setAttribute('aria-label','移除附件');remove.addEventListener('click',()=>{pendingAttachments.splice(index,1);renderAttachmentTray();input.focus()});chip.appendChild(text);chip.appendChild(remove);attachmentTray.appendChild(chip)})}
function clearPendingAttachments(){pendingAttachments=[];renderAttachmentTray()}
function updateSafetyHint(){const mode=sandbox.value;safetyHint.className='safety '+(mode==='read-only'?'safe':mode==='workspace-write'?'warn':'danger');safetyHint.textContent=mode==='read-only'?'只读模式：Codex 不能写文件，适合查看、分析和问答。':mode==='workspace-write'?'工作区写入：本次任务默认允许修改当前工作目录，请确认目录正确。':'高危全权限：本次任务将尽量放开沙箱限制，本会话首次发送前会确认一次。'}
let completeAudioCtx;
function playTaskCompleteSound(){try{const AudioContext=window.AudioContext||window.webkitAudioContext;if(!AudioContext)return;if(!completeAudioCtx)completeAudioCtx=new AudioContext();completeAudioCtx.resume?.();const now=completeAudioCtx.currentTime;const master=completeAudioCtx.createGain();master.gain.setValueAtTime(1.15,now);master.connect(completeAudioCtx.destination);[[660,0,.12],[880,.13,.22]].forEach(([freq,offset,duration])=>{const osc=completeAudioCtx.createOscillator();const gain=completeAudioCtx.createGain();osc.type='triangle';osc.frequency.value=freq;gain.gain.setValueAtTime(0.0001,now+offset);gain.gain.exponentialRampToValueAtTime(0.55,now+offset+0.006);gain.gain.exponentialRampToValueAtTime(0.0001,now+offset+duration);osc.connect(gain);gain.connect(master);osc.start(now+offset);osc.stop(now+offset+duration+.02)})}catch(e){}}
async function cancelRun(){cancelBtn.disabled=true;await fetch('/api/cancel',{method:'POST'});addMsg('log','已请求取消当前任务。');sendBtn.disabled=false;cancelBtn.classList.add('hidden');statusEl.textContent='Cancelled';refreshHistory()}
async function send(){const text=input.value.trim();const attachments=[...pendingAttachments];if((!text&&!attachments.length)||sendBtn.disabled)return;if(sandbox.value==='danger-full-access'&&!dangerConfirmed){if(!confirm('当前是高危全权限。本任务可能修改系统文件、运行高危命令或跨目录操作。本会话确认一次后，除非切换权限模式，否则不再提示。确认继续？'))return;dangerConfirmed=true}input.value='';input.style.height='auto';clearPendingAttachments();addMsg('user',text||'请分析上传的附件。');for(const attachment of attachments){if(attachment.kind==='image')addMsg('image',attachment.url);else addMsg('log','已上传文件: '+(attachment.name||'attachment')+'\\n'+attachment.filePath)}const running=addMsg('assistant','');running.innerHTML='<span class="spinner"></span> Codex 正在运行...';sendBtn.disabled=true;cancelBtn.disabled=false;cancelBtn.classList.remove('hidden');statusEl.textContent='Running';let finalText='',lastText='';try{const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conversationId:currentConversationId,message:text,attachments,provider:provider.value,model:model.value,cwd:cwd.value,sandbox:sandbox.value,approval:approval.value})});if(!res.ok){const err=await res.json();throw new Error(err.error||res.statusText)}const reader=res.body.getReader();const decoder=new TextDecoder();let buffer='';while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const parts=buffer.split('\\n\\n');buffer=parts.pop()||'';for(const part of parts){const line=part.split('\\n').find(l=>l.startsWith('data: '));if(!line||line.includes('[DONE]'))continue;const evt=JSON.parse(line.slice(6));if(evt.type==='start'){currentConversationId=evt.conversationId||evt.id||currentConversationId;updateActiveHistory()}else if(evt.type==='image'){if(running.parentNode)running.remove();addMsg('image',evt.url)}else if(evt.type==='thinking'||evt.type==='tool'||evt.type==='process'){addMsg(evt.type,evt.content||'')}else if(evt.type==='text'){if(running.parentNode)running.remove();finalText=evt.content||finalText;if(finalText!==lastText){addMsg('assistant',finalText);lastText=finalText}}else if(evt.type==='done'){if(running.parentNode)running.remove();finalText=evt.content||finalText;if(finalText&&finalText!==lastText)addMsg('assistant',finalText)}else if(evt.type==='stderr'||evt.type==='log'){if(running.parentNode)running.remove();addMsg('log',evt.content||'')}else if(evt.type==='error'){throw new Error(evt.error||evt.content||('Codex 退出码 '+evt.code))}}}}catch(e){if(running.parentNode)running.remove();addMsg('assistant','错误: '+e.message)}finally{sendBtn.disabled=false;cancelBtn.classList.add('hidden');statusEl.textContent='Ready';playTaskCompleteSound();input.focus();refreshHistory()}}
</script>
</body>
</html>`;
}
