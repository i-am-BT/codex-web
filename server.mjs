import express from 'express';
import { spawn } from 'child_process';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { createServer } from 'http';
import { homedir, networkInterfaces } from 'os';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';
import { CodexAppServerClient } from './app-server-client.mjs';
import {
  CodexDesktopIpcClient,
  isCodexDesktopIpcUnavailableError,
} from './desktop-ipc-client.mjs';
import { NativeSessionStore } from './native-sessions.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV_FILE = path.join(ROOT, '.env');
const MARKED_BROWSER_FILE = path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js');
const DOMPURIFY_BROWSER_FILE = path.join(ROOT, 'node_modules', 'dompurify', 'dist', 'purify.min.js');
const LUCIDE_BROWSER_FILE = path.join(ROOT, 'node_modules', 'lucide', 'dist', 'umd', 'lucide.min.js');
const UI_CSS_FILE = path.join(ROOT, 'ui.css');
const IMAGE_PROMPT_CSS_FILE = path.join(ROOT, 'image-prompt.css');
const IMAGE_PROMPT_JS_FILE = path.join(ROOT, 'image-prompt.js');
const DREAM_SKIN_DIR = path.join(ROOT, 'vendor', 'codex-dream-skin');
const DREAM_SKIN_SKILL_FILE = path.join(DREAM_SKIN_DIR, 'SKILL.md');
const GPT_IMAGE_PLAYGROUND_DIR = path.join(ROOT, 'vendor', 'gpt-image-playground', 'app');
const IMAGE_PROMPT_CASES_FILE = path.join(ROOT, 'vendor', 'image-prompts', 'awesome-gpt-image-2-cases.json');
const IMAGE_PROMPT_STYLES_FILE = path.join(ROOT, 'vendor', 'image-prompts', 'awesome-gpt-image-2-style-library.json');
const IMAGE_PROMPT_IMAGE_BASE = 'https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/60b6e1d3ddaf1c982426d6c8181827764c6b2012/data';

loadEnv(DEFAULT_ENV_FILE, false);

const ENV_FILE = resolveLocalPath(process.env.CODEX_WEB_ENV_FILE || DEFAULT_ENV_FILE, ROOT);
if (ENV_FILE !== DEFAULT_ENV_FILE) loadEnv(ENV_FILE, false);
const RUNTIME_DIR = resolveLocalPath(process.env.CODEX_WEB_RUNTIME_DIR || path.join(ROOT, 'runtime'), ROOT);
const CONVERSATIONS_FILE = path.join(RUNTIME_DIR, 'conversations.json');
const APPEARANCE_FILE = path.join(RUNTIME_DIR, 'appearance.json');
const SESSIONS_FILE = path.join(RUNTIME_DIR, 'sessions.json');
const PID_FILE = path.join(RUNTIME_DIR, 'server.pid');
const IMAGE_DIR = path.join(RUNTIME_DIR, 'images');
const FILE_DIR = path.join(RUNTIME_DIR, 'files');
const BACKGROUND_DIR = path.join(RUNTIME_DIR, 'backgrounds');
const CODEX_HOME = resolveLocalPath(process.env.CODEX_HOME || path.join(homedir(), '.codex'), homedir());
const CODEX_CONFIG_FILE = resolveLocalPath(process.env.CODEX_CONFIG_FILE || path.join(CODEX_HOME, 'config.toml'), CODEX_HOME);
const CODEX_ENV_FILE = resolveLocalPath(process.env.CODEX_ENV_FILE || path.join(CODEX_HOME, '.env'), CODEX_HOME);
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CODEX_PROCESS_HOME = resolveLocalPath(process.env.CODEX_PROCESS_HOME || homedir(), homedir());

loadEnv(CODEX_ENV_FILE, false);

const APP_NAME = String(process.env.APP_NAME || 'Codex Web').trim().slice(0, 48) || 'Codex Web';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 0);
const PORT_MIN = Number(process.env.PORT_MIN || 30000);
const PORT_MAX = Number(process.env.PORT_MAX || 39999);
let webPassword = process.env.CODEX_WEB_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 168) * 60 * 60 * 1000;
const COOKIE_SECURE = parseBoolean(process.env.COOKIE_SECURE, false);
const CODEX_CONFIG_WRITABLE = parseBoolean(process.env.CODEX_CONFIG_WRITABLE, false);
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'gpt-5.5';
const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || '';
const DEFAULT_CWD = process.env.DEFAULT_CWD || homedir();
const DEFAULT_SANDBOX = process.env.DEFAULT_SANDBOX || 'read-only';
const DEFAULT_APPROVAL = process.env.DEFAULT_APPROVAL || 'never';
const FORCE_FULL_ACCESS = parseBoolean(process.env.FORCE_FULL_ACCESS, false);
const NATIVE_SESSION_MAX_READ_MB = Number(process.env.NATIVE_SESSION_MAX_READ_MB || 32);
const NATIVE_SESSION_MAX_MESSAGES = Number(process.env.NATIVE_SESSION_MAX_MESSAGES || 700);
const NATIVE_SESSION_MAX_ITEMS = Number(process.env.NATIVE_SESSION_MAX_ITEMS || 100);
const NATIVE_SESSION_POLL_MS = Number(process.env.NATIVE_SESSION_POLL_MS || 3000);
const APP_SERVER_REQUEST_TIMEOUT_MS = Number(process.env.APP_SERVER_REQUEST_TIMEOUT_MS || 30000);
const CODEX_DESKTOP_IPC_ENABLED = parseBoolean(
  process.env.CODEX_DESKTOP_IPC_ENABLED,
  process.platform === 'darwin' || process.platform === 'win32',
);
const CODEX_DESKTOP_IPC_SOCKET = String(process.env.CODEX_DESKTOP_IPC_SOCKET || '').trim();
const CODEX_DESKTOP_IPC_TIMEOUT_MS = Number(process.env.CODEX_DESKTOP_IPC_TIMEOUT_MS || 20000);
const HOMEPAGE_API_TOKEN = process.env.HOMEPAGE_API_TOKEN || '';
const homepageModelCacheSeconds = Number(process.env.HOMEPAGE_MODEL_CACHE_SECONDS || 60);
const HOMEPAGE_MODEL_CACHE_MS = (Number.isFinite(homepageModelCacheSeconds) ? Math.max(0, homepageModelCacheSeconds) : 60) * 1000;
const NATIVE_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const TOOL_IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.avif', 'image/avif'],
]);
const DESKTOP_PENDING_PREFIX = 'desktop:';
const DESKTOP_INTERACTIVE_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
]);

if (!webPassword) {
  console.error(`CODEX_WEB_PASSWORD is required in ${ENV_FILE}`);
  process.exit(1);
}

mkdirSync(RUNTIME_DIR, { recursive: true });
mkdirSync(IMAGE_DIR, { recursive: true });
mkdirSync(FILE_DIR, { recursive: true });
mkdirSync(BACKGROUND_DIR, { recursive: true });

const app = express();
const sessions = loadSessions();
const conversations = loadConversations();
const nativeSessions = new NativeSessionStore(CODEX_HOME, {
  maxReadBytes: NATIVE_SESSION_MAX_READ_MB * 1024 * 1024,
  maxMessages: NATIVE_SESSION_MAX_MESSAGES,
  maxSessions: NATIVE_SESSION_MAX_ITEMS,
  pollIntervalMs: NATIVE_SESSION_POLL_MS,
});
const appServerClient = new CodexAppServerClient({
  bin: CODEX_BIN,
  cwd: CODEX_PROCESS_HOME,
  env: { HOME: CODEX_PROCESS_HOME, CODEX_HOME },
  clientName: 'codex-web',
  clientTitle: APP_NAME,
  clientVersion: '1.0.0',
  requestTimeoutMs: APP_SERVER_REQUEST_TIMEOUT_MS,
});
const desktopIpcClient = new CodexDesktopIpcClient({
  enabled: CODEX_DESKTOP_IPC_ENABLED,
  socketPath: CODEX_DESKTOP_IPC_SOCKET || undefined,
  clientType: 'codex-web',
  requestTimeoutMs: CODEX_DESKTOP_IPC_TIMEOUT_MS,
});
const sessionEventClients = new Set();
const activeNativeTurns = new Map();
const pendingNativeRequests = new Map();
const desktopThreadStates = new Map();
const desktopResolvedRequestKeys = new Map();
const desktopSnapshotRequestTimes = new Map();
const desktopSnapshotRequests = new Map();
let activeProcess = null;
let activeConversationId = '';
let homepageModelCache = { provider: '', count: 0, expiresAt: 0 };
let imagePromptLibraryCache = null;

nativeSessions.on('change', handleNativeSessionChange);
nativeSessions.start();
appServerClient.on('notification', handleAppServerNotification);
appServerClient.on('request', handleAppServerRequest);
appServerClient.on('appServerError', handleAppServerError);
appServerClient.on('stderr', (content) => {
  const text = String(content || '').trim();
  if (text) console.error(`codex app-server: ${text}`);
});
appServerClient.on('protocolError', (error) => console.error(error.message));
appServerClient.on('exit', (error) => {
  clearAppServerNativeTurns(error.message);
  clearAppServerPendingRequests(error.message);
  broadcastNativeRuntime({ type: 'disconnected', error: error.message });
  nativeSessions.scheduleRefresh();
});
desktopIpcClient.on('disconnect', (error) => {
  clearDesktopThreadStates(error?.message || 'Codex Desktop IPC 已断开');
  const text = String(error?.message || '').trim();
  if (text) console.warn(`Codex Desktop IPC: ${text}`);
});
desktopIpcClient.on('broadcast', handleDesktopIpcBroadcast);

app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, port: server.address()?.port || null });
});

app.get('/api/homepage/stats', requireHomepageToken, async (req, res) => {
  try {
    const providers = readProviderDetails();
    const provider = providers.find((item) => item.name === DEFAULT_PROVIDER) || providers[0];
    const nativeSessionList = nativeSessionSummaries();
    let models = 0;
    if (provider) {
      const now = Date.now();
      if (homepageModelCache.provider === provider.name && homepageModelCache.expiresAt > now) {
        models = homepageModelCache.count;
      } else {
        const apiKey = providerCredential(provider);
        models = (await fetchModels(provider.baseUrl, apiKey)).length;
        homepageModelCache = { provider: provider.name, count: models, expiresAt: now + HOMEPAGE_MODEL_CACHE_MS };
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      conversations: nativeSessionList.length,
      providers: providers.length,
      models,
      running: nativeSessionList.filter((session) => session.status === 'running').length + (activeProcess ? 1 : 0),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/favicon.svg', (req, res) => {
  res.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse"><stop stop-color="#6aa8ff"/><stop offset="1" stop-color="#37c871"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="#080b10"/><path d="M20 22 10 32l10 10" fill="none" stroke="url(#g)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M44 22 54 32 44 42" fill="none" stroke="url(#g)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M36 16 28 48" fill="none" stroke="#e6edf3" stroke-width="5" stroke-linecap="round"/></svg>`);
});

app.get('/vendor/marked.js', (_req, res) => {
  res.type('text/javascript').sendFile(MARKED_BROWSER_FILE);
});

app.get('/vendor/purify.js', (_req, res) => {
  res.type('text/javascript').sendFile(DOMPURIFY_BROWSER_FILE);
});

app.get('/vendor/lucide.js', (_req, res) => {
  res.type('text/javascript').sendFile(LUCIDE_BROWSER_FILE);
});

app.get('/ui.css', (_req, res) => {
  res.type('text/css').sendFile(UI_CSS_FILE);
});

app.get('/image-prompt.css', (_req, res) => {
  res.type('text/css').sendFile(IMAGE_PROMPT_CSS_FILE);
});

app.get('/image-prompt.js', (_req, res) => {
  res.type('text/javascript').sendFile(IMAGE_PROMPT_JS_FILE);
});

app.post('/api/login', (req, res) => {
  const password = String(req.body?.password || '');
  if (!safeEqual(password, webPassword)) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = randomBytes(32).toString('hex');
  sessions.set(hashToken(token), Date.now() + SESSION_TTL_MS);
  saveSessions();
  res.setHeader('Set-Cookie', sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000)));
  res.json({ ok: true });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = getCookie(req, 'codex_web_session');
  if (token) sessions.delete(hashToken(token));
  saveSessions();
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  res.json({ ok: true });
});

app.post('/api/password', requireAuth, (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  const confirmPassword = String(req.body?.confirmPassword || '');
  if (!safeEqual(currentPassword, webPassword)) return res.status(401).json({ error: '当前密码错误' });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: '两次输入的新密码不一致' });
  if (newPassword.length < 8) return res.status(400).json({ error: '新密码至少需要 8 个字符' });
  if (newPassword.length > 256) return res.status(400).json({ error: '新密码不能超过 256 个字符' });
  if (!newPassword.trim() || /[\r\n\0]/.test(newPassword)) return res.status(400).json({ error: '新密码包含无效字符' });
  if (safeEqual(newPassword, webPassword)) return res.status(400).json({ error: '新密码不能与当前密码相同' });

  try {
    updateEnvVar(ENV_FILE, 'CODEX_WEB_PASSWORD', newPassword);
    webPassword = newPassword;
    process.env.CODEX_WEB_PASSWORD = newPassword;
    const token = getCookie(req, 'codex_web_session');
    const currentKey = token ? hashToken(token) : '';
    const currentExpiry = currentKey ? sessions.get(currentKey) : 0;
    sessions.clear();
    if (currentKey) sessions.set(currentKey, currentExpiry > Date.now() ? currentExpiry : Date.now() + SESSION_TTL_MS);
    saveSessions();
    for (const client of sessionEventClients) client.end();
    sessionEventClients.clear();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `保存 Web 密码失败: ${err.message}` });
  }
});

app.get('/api/session', (req, res) => {
  res.json({ authenticated: Boolean(validateSession(req)) });
});

app.use('/assets/images', requireAuth, express.static(IMAGE_DIR, { fallthrough: false }));
app.use('/assets/files', requireAuth, express.static(FILE_DIR, { fallthrough: false }));
app.use('/assets/backgrounds', requireAuth, express.static(BACKGROUND_DIR, { fallthrough: false }));
app.use('/assets/dream-skin', requireAuth, express.static(DREAM_SKIN_DIR, { fallthrough: false }));
app.use('/playground', requireAuth, express.static(GPT_IMAGE_PLAYGROUND_DIR, {
  fallthrough: false,
  setHeaders: (res, filePath) => {
    const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
    res.setHeader('Cache-Control', immutable
      ? 'private, max-age=31536000, immutable'
      : 'private, no-store');
  },
}));

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

app.post('/api/dream-skin/prompt', requireAuth, (req, res) => {
  try {
    res.json({ ok: true, ...buildDreamSkinTask(req.body || {}) });
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
      reasoningEffort: defaults.reasoningEffort || '',
      cwd: DEFAULT_CWD,
      sandbox: FORCE_FULL_ACCESS ? 'danger-full-access' : DEFAULT_SANDBOX,
      approval: FORCE_FULL_ACCESS ? 'never' : DEFAULT_APPROVAL,
    },
    providers: readProviders(),
    conversations: conversationSummaries(),
    appearance: readAppearance(),
    capabilities: {
      manageProviders: CODEX_CONFIG_WRITABLE,
      forceFullAccess: FORCE_FULL_ACCESS,
    },
  });
});

app.get('/api/playground-config', requireAuth, (_req, res) => {
  const defaults = readCodexDefaults();
  const providers = readProviderDetails();
  const provider = providers.find((item) => item.name === (defaults.provider || DEFAULT_PROVIDER)) || providers[0];
  if (!provider) return res.status(404).json({ error: 'Codex 服务商配置不存在' });

  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    profile: {
      id: 'codex-web-default',
      name: `Codex · ${provider.displayName}`,
      provider: 'openai',
      baseUrl: provider.baseUrl,
      apiKey: providerCredential(provider),
      model: 'gpt-image-2',
      apiMode: 'images',
      codexCli: true,
    },
  });
});

app.get('/api/image-prompts', requireAuth, (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json(readImagePromptLibrary());
  } catch (err) {
    res.status(500).json({ error: `读取提示词库失败: ${err.message}` });
  }
});

app.get('/api/native-sessions', requireAuth, (_req, res) => {
  res.json({ sessions: nativeSessionSummaries(), version: nativeSessions.version });
});

app.get('/api/native-sessions/:id', requireAuth, (req, res) => {
  try {
    const conversation = nativeSessions.get(cleanNativeThreadId(req.params.id), {
      after: req.query.after,
      generation: req.query.generation,
    });
    if (!conversation) return res.status(404).json({ error: 'Codex App 会话不存在' });
    requestDesktopThreadSnapshot(conversation.id);
    res.json({ conversation: decorateNativeConversation(conversation) });
  } catch (err) {
    res.status(500).json({ error: `读取 Codex App 会话失败: ${err.message}` });
  }
});

app.get('/api/native-sessions/:id/tool-images/:seq/:index', requireAuth, (req, res) => {
  try {
    const threadId = cleanNativeThreadId(req.params.id);
    const sequence = Number(req.params.seq);
    const imageIndex = Number(req.params.index);
    if (!threadId || !Number.isInteger(sequence) || sequence < 1 || !Number.isInteger(imageIndex) || imageIndex < 1) {
      return res.status(400).json({ error: '工具图片参数无效' });
    }

    const conversation = nativeSessions.get(threadId);
    if (!conversation) return res.status(404).json({ error: 'Codex App 会话不存在' });
    const requestedGeneration = Number(req.query.generation);
    if (
      Number.isInteger(requestedGeneration)
      && requestedGeneration > 0
      && requestedGeneration !== conversation.generation
    ) {
      return res.status(404).json({ error: '工具图片记录已更新' });
    }

    const message = conversation.messages.find((item) => item.seq === sequence);
    const imagePath = extractNativeToolImagePaths(message)[imageIndex - 1];
    const image = readNativeToolImage(imagePath, conversation.metadata?.cwd);
    if (!image) return res.status(404).json({ error: '工具图片不存在或不受支持' });
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type(image.type).send(image.data);
  } catch (err) {
    res.status(500).json({ error: `读取工具图片失败: ${err.message}` });
  }
});

app.post('/api/native-sessions/:id/fork', requireAuth, async (req, res) => {
  const threadId = cleanNativeThreadId(req.params.id);
  if (!threadId) return res.status(400).json({ error: 'Codex App 会话 ID 无效' });
  if (activeNativeTurns.get(threadId)?.status === 'running') {
    return res.status(409).json({ error: '会话任务正在运行，不能创建历史分支' });
  }

  const messageSeq = Number(req.body?.messageSeq);
  if (!Number.isInteger(messageSeq) || messageSeq < 1) {
    return res.status(400).json({ error: '消息序号无效' });
  }

  try {
    const source = nativeSessions.get(threadId);
    if (!source) return res.status(404).json({ error: 'Codex App 会话不存在' });
    const target = source.messages.find((message) => (
      message.seq === messageSeq
      && ['user', 'assistant'].includes(message.role)
      && message.turnId
    ));
    if (!target) return res.status(400).json({ error: '只能从带有 turn ID 的用户或助手消息创建分支' });
    const forkedThroughTurnId = target.role === 'assistant' ? target.turnId : target.previousTurnId;
    if (target.role === 'user' && !forkedThroughTurnId && source.truncated) {
      return res.status(409).json({ error: '会话历史已截断，无法确定这条消息之前的 turn' });
    }

    const settings = parseNativeThreadSettings(req.body || {});
    const result = forkedThroughTurnId
      ? await appServerClient.request('thread/fork', compactObject({
        threadId,
        lastTurnId: forkedThroughTurnId,
        cwd: settings.cwd,
        model: settings.model,
        modelProvider: settings.provider,
        sandbox: settings.sandbox,
        approvalPolicy: settings.approval,
        threadSource: 'user',
      }))
      : await appServerClient.request('thread/start', compactObject({
        cwd: settings.cwd,
        model: settings.model,
        modelProvider: settings.provider,
        sandbox: settings.sandbox,
        approvalPolicy: settings.approval,
        threadSource: 'user',
      }));
    const forkedThreadId = cleanNativeThreadId(result?.thread?.id);
    if (!forkedThreadId) throw new Error('Codex app-server 未返回有效分支 thread id');

    nativeSessions.refresh();
    const persisted = nativeSessions.get(forkedThreadId);
    const conversation = persisted
      ? decorateNativeConversation(persisted)
      : nativeConversationFromThread(result.thread, '');
    res.status(201).json({
      ok: true,
      threadId: forkedThreadId,
      sourceThreadId: threadId,
      forkedThroughTurnId: forkedThroughTurnId || '',
      draft: target.role === 'user' ? extractUserDraft(target.content) : '',
      conversation,
    });
  } catch (err) {
    res.status(nativeAppErrorStatus(err)).json({ error: `创建 Codex App 历史分支失败: ${err.message}` });
  }
});

app.post('/api/native-sessions', requireAuth, async (req, res) => {
  try {
    const turn = parseNativeTurnPayload(req.body || {});
    const started = await appServerClient.request('thread/start', compactObject({
      cwd: turn.cwd,
      model: turn.model,
      modelProvider: turn.provider,
      sandbox: turn.sandbox,
      approvalPolicy: turn.approval,
      threadSource: 'user',
    }));
    const threadId = cleanNativeThreadId(started?.thread?.id);
    if (!threadId) throw new Error('Codex app-server 未返回有效 thread id');
    const turnStarted = await startNativeTurn(threadId, turn);
    nativeSessions.scheduleRefresh();
    res.status(202).json({
      ok: true,
      threadId,
      turnId: turnStarted.turnId,
      conversation: nativeConversationFromThread(started.thread, turnStarted.turnId),
    });
  } catch (err) {
    res.status(nativeAppErrorStatus(err)).json({ error: `创建 Codex App 会话失败: ${err.message}` });
  }
});

app.post('/api/native-sessions/:id/turns', requireAuth, async (req, res) => {
  const threadId = cleanNativeThreadId(req.params.id);
  if (!threadId) return res.status(400).json({ error: 'Codex App 会话 ID 无效' });
  if (activeNativeTurns.get(threadId)?.status === 'running') {
    return res.status(409).json({ error: '该 Codex App 会话已有任务正在运行' });
  }

  try {
    const turn = parseNativeTurnPayload(req.body || {});
    const turnStarted = await continueNativeTurn(threadId, turn);
    nativeSessions.scheduleRefresh();
    res.status(202).json({ ok: true, threadId, turnId: turnStarted.turnId });
  } catch (err) {
    res.status(nativeAppErrorStatus(err)).json({ error: `继续 Codex App 会话失败: ${err.message}` });
  }
});

app.post('/api/native-sessions/:id/steer', requireAuth, async (req, res) => {
  const threadId = cleanNativeThreadId(req.params.id);
  if (!threadId) return res.status(400).json({ error: 'Codex App 会话 ID 无效' });

  try {
    const steer = parseNativeSteerPayload(req.body || {});
    const expectedTurnId = String(req.body?.turnId || activeNativeTurns.get(threadId)?.turnId || '').trim();
    const result = await steerNativeTurn(threadId, steer, expectedTurnId);
    const turnId = String(result?.turnId || expectedTurnId);
    if (!turnId) return res.status(409).json({ error: '该会话没有可引导的运行中任务' });
    setNativeTurnState(threadId, { turnId, status: 'running', transport: result.transport });
    nativeSessions.scheduleRefresh();
    res.status(202).json({ ok: true, threadId, turnId });
  } catch (err) {
    res.status(nativeAppErrorStatus(err)).json({ error: `引导 Codex App 任务失败: ${err.message}` });
  }
});

app.post('/api/native-sessions/:id/interrupt', requireAuth, async (req, res) => {
  const threadId = cleanNativeThreadId(req.params.id);
  if (!threadId) return res.status(400).json({ error: 'Codex App 会话 ID 无效' });
  const requestedTurnId = String(req.body?.turnId || '').trim();
  const currentTurnId = currentNativeTurnId(threadId);
  if (!requestedTurnId || !currentTurnId) {
    return res.status(409).json({ error: '当前任务状态已变化，请刷新后重试' });
  }
  if (requestedTurnId !== currentTurnId) {
    return res.status(409).json({ error: '页面中的任务已过期，未取消当前新任务' });
  }

  try {
    let turnId = requestedTurnId;
    const result = await interruptNativeTurn(threadId, turnId);
    turnId = String(result?.interruptedTurnId || turnId);
    if (!turnId) return res.status(409).json({ error: '该会话没有可取消的任务' });
    setNativeTurnState(threadId, { turnId, status: 'interrupted', transport: result.transport });
    res.json({ ok: true, threadId, turnId });
  } catch (err) {
    res.status(nativeAppErrorStatus(err)).json({ error: `取消 Codex App 任务失败: ${err.message}` });
  }
});

app.patch('/api/native-sessions/:id', requireAuth, async (req, res) => {
  const threadId = cleanNativeThreadId(req.params.id);
  const title = String(req.body?.title || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!threadId) return res.status(400).json({ error: 'Codex App 会话 ID 无效' });
  if (!title) return res.status(400).json({ error: '标题不能为空' });

  try {
    await appServerClient.request('thread/name/set', { threadId, name: title });
    nativeSessions.scheduleRefresh();
    res.json({ ok: true, id: threadId, title });
  } catch (err) {
    res.status(nativeAppErrorStatus(err)).json({ error: `修改 Codex App 会话标题失败: ${err.message}` });
  }
});

app.delete('/api/native-sessions/:id', requireAuth, async (req, res) => {
  const threadId = cleanNativeThreadId(req.params.id);
  if (!threadId) return res.status(400).json({ error: 'Codex App 会话 ID 无效' });
  if (activeNativeTurns.get(threadId)?.status === 'running') {
    return res.status(409).json({ error: '会话任务正在运行，请先取消' });
  }

  try {
    await appServerClient.request('thread/archive', { threadId });
    nativeSessions.scheduleRefresh();
    res.json({ ok: true, id: threadId });
  } catch (err) {
    res.status(nativeAppErrorStatus(err)).json({ error: `归档 Codex App 会话失败: ${err.message}` });
  }
});

app.post('/api/native-projects/archive', requireAuth, async (req, res) => {
  const projectPath = normalizeNativeProjectPath(req.body?.cwd);
  if (!projectPath) return res.status(400).json({ error: '项目路径无效' });

  const targets = nativeSessionSummaries().filter((session) => (
    normalizeNativeProjectPath(session.cwd) === projectPath
  ));
  if (!targets.length) return res.status(404).json({ error: '该项目没有可归档任务' });

  const running = targets.filter((session) => {
    const active = activeNativeTurns.get(session.id);
    return active ? active.status === 'running' : session.status === 'running';
  });
  if (running.length) {
    return res.status(409).json({
      error: `项目中有 ${running.length} 个任务正在运行，请先停止后再归档`,
      running: running.map((session) => session.id),
    });
  }

  const archived = [];
  const failed = [];
  for (const session of targets) {
    try {
      await appServerClient.request('thread/archive', { threadId: session.id });
      archived.push(session.id);
    } catch (err) {
      failed.push({ id: session.id, error: err.message });
    }
  }
  nativeSessions.scheduleRefresh();

  if (failed.length) {
    return res.status(502).json({
      error: `已归档 ${archived.length} 个任务，${failed.length} 个失败`,
      archived,
      failed,
    });
  }
  res.json({ ok: true, cwd: projectPath, archived });
});

app.get('/api/native-requests', requireAuth, (_req, res) => {
  res.json({ requests: listPendingNativeRequests() });
});

app.post('/api/native-requests/:id/respond', requireAuth, async (req, res) => {
  const key = String(req.params.id || '');
  const pending = pendingNativeRequests.get(key);
  if (!pending) return res.status(404).json({ error: '该确认请求已处理或不存在' });

  try {
    const result = buildNativeRequestResponse(pending, req.body || {});
    await respondToNativeRequest(pending, result);
    pendingNativeRequests.delete(key);
    if (pending.transport === 'desktop-ipc') {
      desktopResolvedRequestKeys.set(key, Date.now() + 30000);
      removeDesktopRequestFromState(pending.threadId, pending.requestId);
    }
    broadcastNativeRequest({ type: 'resolved', id: key, threadId: pending.threadId });
    if (pending.transport !== 'desktop-ipc' && req.body?.decision === 'cancel' && pending.threadId && pending.turnId) {
      appServerClient.request('turn/interrupt', {
        threadId: pending.threadId,
        turnId: pending.turnId,
      }).catch(() => {});
    }
    res.json({ ok: true, id: key });
  } catch (err) {
    res.status(pending.transport === 'desktop-ipc' ? 502 : 400).json({ error: err.message });
  }
});

app.get('/api/session-events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sessionEventClients.add(res);
  writeNamedEvent(res, 'sessions', { version: nativeSessions.version, changedIds: [] });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  heartbeat.unref?.();

  req.on('close', () => {
    clearInterval(heartbeat);
    sessionEventClients.delete(res);
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

  const draft = extractUserDraft(target.content);
  conversation.messages = conversation.messages.slice(0, messageIndex);
  conversation.status = 'done';
  conversation.updatedAt = new Date().toISOString();
  conversations.splice(conversations.indexOf(conversation), 1);
  conversations.unshift(conversation);
  saveConversations();
  res.json({ ok: true, conversation, draft });
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
    apiKey = providerCredential(provider);
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

app.post('/api/providers', requireAuth, requireConfigWrite, (req, res) => {
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

app.delete('/api/providers/:name', requireAuth, requireConfigWrite, (req, res) => {
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

app.post('/api/defaults', requireAuth, requireConfigWrite, (req, res) => {
  const provider = cleanProviderName(req.body?.provider || '');
  const model = cleanValue(req.body?.model) || '';
  const reasoningEffort = cleanReasoningEffort(req.body?.reasoningEffort);

  if (!provider) return res.status(400).json({ error: '请选择服务商' });
  if (!readProviders().includes(provider)) return res.status(404).json({ error: '服务商不存在' });
  if (!model) return res.status(400).json({ error: '请选择模型' });

  try {
    setCodexDefaults(provider, model, reasoningEffort);
    updateEnvVar(ENV_FILE, 'DEFAULT_PROVIDER', provider);
    updateEnvVar(ENV_FILE, 'DEFAULT_MODEL', model);
    process.env.DEFAULT_PROVIDER = provider;
    process.env.DEFAULT_MODEL = model;
    res.json({ ok: true, provider, model, reasoningEffort });
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
  const reasoningEffort = cleanReasoningEffort(req.body?.reasoningEffort);

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
    '-a', approval,
    'exec',
    '--skip-git-repo-check',
    '--color', 'never',
    '--json',
    '-C', cwd,
    '-s', sandbox,
    '-m', model,
  ];
  if (provider) args.push('-c', `model_provider="${provider}"`);
  if (reasoningEffort) args.push('-c', `model_reasoning_effort="${reasoningEffort}"`);
  args.push('-');

  const startContent = `任务开始\nprovider=${provider || 'default'} model=${model} reasoning=${reasoningEffort || 'default'} sandbox=${sandbox} approval=${approval} cwd=${cwd}`;
  appendMessage(convo, 'process', startContent, 'task_started');
  appendMessage(convo, 'tool', `执行 codex\n${redactArgs(args).join(' ')}`, 'codex_exec');
  writeEvent(res, { type: 'start', id: convo.id, conversationId: convo.id, args: redactArgs(args), cwd, model, provider, sandbox, approval });
  writeEvent(res, { type: 'process', content: startContent, kind: 'task_started' });
  writeEvent(res, { type: 'tool', content: `执行 codex\n${redactArgs(args).join(' ')}`, kind: 'codex_exec' });

  const child = spawn(CODEX_BIN, args, {
    cwd,
    env: { ...process.env, HOME: CODEX_PROCESS_HOME, CODEX_HOME },
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
  writeFileSync(PID_FILE, String(process.pid));
  console.log(`${APP_NAME}: http://${getLanAddress()}:${actual}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

function shutdown(signal) {
  console.log(`${APP_NAME}: stopping on ${signal}`);
  if (activeProcess) terminateProcess(activeProcess);
  desktopIpcClient.close();
  appServerClient.close();
  nativeSessions.stop();
  for (const client of sessionEventClients) client.end();
  sessionEventClients.clear();
  server.close(() => {
    try {
      unlinkSync(PID_FILE);
    } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

function requireAuth(req, res, next) {
  if (validateSession(req)) return next();
  res.status(401).json({ error: '未登录' });
}

function requireHomepageToken(req, res, next) {
  if (!HOMEPAGE_API_TOKEN) return res.status(503).json({ error: 'Homepage API 未配置' });
  const token = String(req.get('X-API-Token') || '');
  if (!safeEqual(token, HOMEPAGE_API_TOKEN)) return res.status(401).json({ error: '无效的 API Token' });
  next();
}

function requireConfigWrite(req, res, next) {
  if (CODEX_CONFIG_WRITABLE) return next();
  res.status(403).json({ error: '当前使用只读 Codex 配置；如需从 Web 修改，请设置 CODEX_CONFIG_WRITABLE=true 后重启' });
}

function validateSession(req) {
  const token = getCookie(req, 'codex_web_session');
  if (!token) return false;
  const key = hashToken(token);
  const expires = sessions.get(key);
  if (!expires || expires < Date.now()) {
    sessions.delete(key);
    saveSessions();
    return false;
  }
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
  if (type === 'reasoning') return null;
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

function buildDreamSkinTask(body) {
  if (!existsSync(DREAM_SKIN_SKILL_FILE)) throw new Error('Dream Skin 技能文件不存在');
  const description = String(body.description || '')
    .trim()
    .replace(/\r\n?/g, '\n')
    .slice(0, 2000) || '生成一张安静、高级、适合长时间使用的 Codex Web 背景。';
  const mode = ['no-person', 'fictional-adult', 'reference'].includes(body.mode)
    ? body.mode
    : 'no-person';
  const referenceCount = Math.min(3, Math.max(0, Number(body.referenceCount) || 0));
  if (mode === 'reference' && !referenceCount) throw new Error('参考图模式至少需要添加 1 张图片');
  const skill = path.relative(ROOT, DREAM_SKIN_SKILL_FILE).split(path.sep).join('/');
  const modeInstruction = {
    'no-person': '无人物：只生成连续环境、抽象艺术、建筑、自然或材质背景。',
    'fictional-adult': '原创人物：最多一位明确成年的原创虚构人物，不模仿任何真实人物或受版权保护角色。',
    reference: '参考图：严格按技能中的 Image 1/2/3 合约使用附件；参考图不是擦除 UI 的修图底稿。',
  }[mode];
  const attachmentInstruction = referenceCount
    ? `本任务附带 ${referenceCount} 张参考图，编号按实际附件顺序排列。`
    : '本任务没有参考图，不要自行推断或寻找人物身份。';
  const prompt = [
    'Dream Skin 背景生成任务',
    '',
    `先完整读取并遵循项目内置技能：${skill}`,
    modeInstruction,
    attachmentInstruction,
    '',
    '用户视觉需求：',
    description,
    '',
    '必须实际调用 $imagegen 生成最终位图，不要只返回提示词或教程。',
    '返回一张 2560x1440、16:9、无 UI、无文字、可直接作为 Codex Web 背景的最终图片。',
    '不要修改项目代码、配置或现有图片。',
  ].join('\n');
  return { prompt, cwd: ROOT, skill, mode };
}

function cleanChatBackground(value, customBackgrounds = []) {
  const text = String(value || '');
  if (text === 'default') return text;
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

function extractUserDraft(content) {
  return String(content || '').split(/\n\n用户上传了\s+\d+\s+个附件（/u, 1)[0].trim();
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
  const apiKey = providerCredential(provider);
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

function writeNamedEvent(res, eventName, data) {
  if (!res || res.destroyed || res.writableEnded) return;
  try {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    sessionEventClients.delete(res);
  }
}

function broadcastNativeSessionChange(change) {
  for (const client of sessionEventClients) writeNamedEvent(client, 'sessions', change);
}

function handleNativeSessionChange(change) {
  for (const threadId of change.changedIds || []) {
    const active = activeNativeTurns.get(threadId);
    if (active?.transport !== 'desktop-ipc' || active.status !== 'running') continue;
    const conversation = nativeSessions.get(threadId);
    if (!conversation || conversation.status === 'running') continue;
    activeNativeTurns.delete(threadId);
    broadcastNativeRuntime({
      type: 'turn-cleared',
      threadId,
      turnId: active.turnId,
      status: conversation.status,
    });
  }
  broadcastNativeSessionChange(change);
}

function broadcastNativeRuntime(event) {
  for (const client of sessionEventClients) writeNamedEvent(client, 'native-runtime', event);
}

function broadcastNativeRequest(event) {
  for (const client of sessionEventClients) writeNamedEvent(client, 'native-request', event);
}

function handleDesktopIpcBroadcast(message) {
  if (message?.method !== 'thread-stream-state-changed') return;
  const params = message.params || {};
  const change = params.change || {};
  const threadId = cleanNativeThreadId(params.conversationId);
  const ownerClientId = String(message.sourceClientId || '');
  if (!threadId || !ownerClientId) return;

  if (change.type === 'snapshot') {
    const state = {
      ownerClientId,
      revision: Number(change.revision) || 0,
      requests: normalizeDesktopRequests(change.conversationState?.requests),
    };
    desktopThreadStates.set(threadId, state);
    syncDesktopPendingRequests(threadId, state);
    return;
  }

  if (change.type !== 'patches') return;
  const state = desktopThreadStates.get(threadId);
  if (
    !state
    || state.ownerClientId !== ownerClientId
    || state.revision !== Number(change.baseRevision)
  ) {
    requestDesktopThreadSnapshot(threadId, { force: true });
    return;
  }
  const requests = applyDesktopRequestPatches(state.requests, change.patches);
  if (requests === null) {
    requestDesktopThreadSnapshot(threadId, { force: true });
    return;
  }
  state.requests = requests;
  state.revision = Number(change.revision) || state.revision;
  syncDesktopPendingRequests(threadId, state);
}

function normalizeDesktopRequests(requests) {
  return Array.isArray(requests)
    ? requests.filter((request) => request && typeof request === 'object').slice(0, 100)
    : [];
}

function applyDesktopRequestPatches(requests, patches) {
  if (!Array.isArray(patches)) return null;
  const state = { requests: normalizeDesktopRequests(requests) };
  let requestPatchCount = 0;
  for (const patch of patches) {
    const patchPath = Array.isArray(patch?.path) ? patch.path : [];
    if (!patchPath.length) {
      if (patch?.op === 'remove') state.requests = [];
      else if (patch?.value && typeof patch.value === 'object') {
        state.requests = normalizeDesktopRequests(patch.value.requests);
      }
      continue;
    }
    if (patchPath[0] !== 'requests' || patchPath.length > 32) continue;
    requestPatchCount += 1;
    if (requestPatchCount > 2000) return null;
    applyDesktopRequestPatch(state, patch, patchPath);
  }
  return normalizeDesktopRequests(state.requests);
}

function applyDesktopRequestPatch(root, patch, patchPath) {
  let target = root;
  for (const segment of patchPath.slice(0, -1)) {
    if (!target || typeof target !== 'object') return;
    target = target[segment];
  }
  if (!target || typeof target !== 'object') return;
  const key = patchPath.at(-1);
  if (Array.isArray(target)) {
    const index = key === '-' ? target.length : Number(key);
    if (!Number.isInteger(index) || index < 0 || index > target.length) return;
    if (patch.op === 'remove') target.splice(index, 1);
    else if (patch.op === 'add') target.splice(index, 0, patch.value);
    else if (patch.op === 'replace' && index < target.length) target[index] = patch.value;
    return;
  }
  if (patch.op === 'remove') delete target[key];
  else if (patch.op === 'add' || patch.op === 'replace') target[key] = patch.value;
}

function desktopPendingKey(threadId, requestId) {
  return `${DESKTOP_PENDING_PREFIX}${threadId}:${encodeURIComponent(requestId)}`;
}

function syncDesktopPendingRequests(threadId, state) {
  const now = Date.now();
  for (const [key, expiresAt] of desktopResolvedRequestKeys) {
    if (expiresAt <= now) desktopResolvedRequestKeys.delete(key);
  }

  const seen = new Set();
  for (const request of state.requests) {
    const requestId = String(request.id ?? '');
    const method = String(request.method || '');
    if (!requestId || !DESKTOP_INTERACTIVE_METHODS.has(method)) continue;
    const key = desktopPendingKey(threadId, requestId);
    seen.add(key);
    if (desktopResolvedRequestKeys.get(key) > now) continue;
    const existing = pendingNativeRequests.get(key);
    const pending = {
      key,
      requestId,
      method,
      params: request.params || {},
      threadId,
      turnId: String(request.params?.turnId || ''),
      createdAt: existing?.createdAt || new Date().toISOString(),
      transport: 'desktop-ipc',
      ownerClientId: state.ownerClientId,
    };
    pendingNativeRequests.set(key, pending);
    if (!existing) broadcastNativeRequest({ type: 'pending', request: publicNativeRequest(pending) });
  }

  for (const [key, pending] of pendingNativeRequests) {
    if (pending.transport !== 'desktop-ipc' || pending.threadId !== threadId || seen.has(key)) continue;
    pendingNativeRequests.delete(key);
    broadcastNativeRequest({ type: 'resolved', id: key, threadId });
  }
}

function removeDesktopRequestFromState(threadId, requestId) {
  const state = desktopThreadStates.get(threadId);
  if (!state) return;
  state.requests = state.requests.filter((request) => String(request.id ?? '') !== String(requestId));
}

function clearDesktopThreadStates(reason = '') {
  desktopThreadStates.clear();
  desktopResolvedRequestKeys.clear();
  desktopSnapshotRequestTimes.clear();
  desktopSnapshotRequests.clear();
  for (const [key, pending] of pendingNativeRequests) {
    if (pending.transport !== 'desktop-ipc') continue;
    pendingNativeRequests.delete(key);
    broadcastNativeRequest({ type: 'resolved', id: key, threadId: pending.threadId, error: reason });
  }
}

function requestDesktopThreadSnapshot(threadId, { force = false } = {}) {
  if (desktopSnapshotRequests.has(threadId)) return desktopSnapshotRequests.get(threadId);
  const now = Date.now();
  if (!force && now - (desktopSnapshotRequestTimes.get(threadId) || 0) < 15000) return null;
  desktopSnapshotRequestTimes.set(threadId, now);
  const request = desktopIpcClient.loadCompleteHistory(threadId)
    .catch(() => {})
    .finally(() => {
      if (desktopSnapshotRequests.get(threadId) === request) desktopSnapshotRequests.delete(threadId);
    });
  desktopSnapshotRequests.set(threadId, request);
  return request;
}

async function respondToNativeRequest(pending, response) {
  if (pending.transport !== 'desktop-ipc') {
    pending.respond(response);
    return;
  }
  const options = { targetClientId: pending.ownerClientId };
  switch (pending.method) {
    case 'item/commandExecution/requestApproval':
      await desktopIpcClient.commandApprovalDecision(
        pending.threadId,
        pending.requestId,
        response.decision,
        options,
      );
      return;
    case 'item/fileChange/requestApproval':
      await desktopIpcClient.fileApprovalDecision(
        pending.threadId,
        pending.requestId,
        response.decision,
        options,
      );
      return;
    case 'item/permissions/requestApproval':
      await desktopIpcClient.permissionsApprovalResponse(
        pending.threadId,
        pending.requestId,
        response,
        options,
      );
      return;
    case 'item/tool/requestUserInput':
      await desktopIpcClient.submitUserInput(pending.threadId, pending.requestId, response, options);
      return;
    case 'mcpServer/elicitation/request':
      await desktopIpcClient.submitMcpElicitationResponse(
        pending.threadId,
        pending.requestId,
        response,
        options,
      );
      return;
    default:
      throw new Error(`Codex Desktop 不支持处理 ${pending.method}`);
  }
}

function handleAppServerError(params = {}) {
  const threadId = cleanNativeThreadId(params.threadId);
  const current = threadId ? activeNativeTurns.get(threadId) : null;
  const turnId = String(params.turnId || current?.turnId || '');
  const willRetry = params.willRetry === true;
  const message = String(params.error?.message || 'Codex App 请求异常').trim().slice(0, 180);
  console.warn(`codex app-server ${willRetry ? 'retrying' : 'error'}: ${message}`);
  if (!threadId) return;
  if (willRetry) setNativeTurnState(threadId, { turnId, status: 'running' });
  broadcastNativeRuntime({
    type: 'connection-error',
    threadId,
    turnId,
    willRetry,
    message,
    updatedAt: new Date().toISOString(),
  });
}

function handleAppServerNotification(event) {
  const method = event.method;
  const params = event.params || {};
  const threadId = cleanNativeThreadId(params.threadId || params.thread?.id);

  if (method === 'item/agentMessage/delta' && threadId) {
    broadcastNativeRuntime({
      type: 'delta',
      role: 'assistant',
      threadId,
      turnId: String(params.turnId || ''),
      itemId: String(params.itemId || ''),
      delta: String(params.delta || ''),
    });
  } else if (method === 'item/started' && threadId) {
    broadcastNativeRuntime({
      type: 'item-started',
      threadId,
      turnId: String(params.turnId || ''),
      itemId: String(params.item?.id || ''),
      itemType: String(params.item?.type || ''),
    });
  } else if (method === 'item/completed' && threadId) {
    broadcastNativeRuntime({
      type: 'item-completed',
      threadId,
      turnId: String(params.turnId || ''),
      itemId: String(params.item?.id || ''),
      itemType: String(params.item?.type || ''),
    });
  } else if (method === 'turn/started' && threadId) {
    setNativeTurnState(threadId, {
      turnId: String(params.turn?.id || ''),
      status: 'running',
    });
  } else if (method === 'turn/completed' && threadId) {
    const turnId = String(params.turn?.id || activeNativeTurns.get(threadId)?.turnId || '');
    const status = nativeTurnStatus(params.turn?.status);
    setNativeTurnState(threadId, { turnId, status });
    setTimeout(() => {
      const current = activeNativeTurns.get(threadId);
      if (current?.turnId === turnId && current.status !== 'running') {
        activeNativeTurns.delete(threadId);
        broadcastNativeRuntime({ type: 'turn-cleared', threadId, turnId });
      }
    }, 1800).unref?.();
  } else if (method === 'thread/status/changed' && threadId) {
    const type = String(params.status?.type || '');
    if (type === 'idle' && activeNativeTurns.get(threadId)?.status === 'running') {
      const current = activeNativeTurns.get(threadId);
      setNativeTurnState(threadId, { ...current, status: 'done' });
    }
  } else if (method === 'serverRequest/resolved') {
    const key = String(params.requestId ?? '');
    const pending = pendingNativeRequests.get(key);
    if (pending) {
      pendingNativeRequests.delete(key);
      broadcastNativeRequest({ type: 'resolved', id: key, threadId: pending.threadId });
    }
  }

  if (
    threadId
    || method === 'thread/started'
    || method === 'thread/name/updated'
    || method === 'thread/archived'
    || method === 'thread/deleted'
  ) {
    nativeSessions.scheduleRefresh();
  }
}

function handleAppServerRequest(request) {
  if (request.method === 'currentTime/read') {
    request.respond({ currentTimeAt: Math.floor(Date.now() / 1000) });
    return;
  }
  if (request.method === 'item/tool/call') {
    request.respond({
      success: false,
      contentItems: [{ type: 'inputText', text: 'Codex Web 未注册动态工具。' }],
    });
    return;
  }

  const interactiveMethods = new Set([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/tool/requestUserInput',
    'item/permissions/requestApproval',
    'mcpServer/elicitation/request',
    'applyPatchApproval',
    'execCommandApproval',
  ]);
  if (!interactiveMethods.has(request.method)) {
    request.reject(-32601, `Codex Web 不支持 app-server 请求: ${request.method}`);
    return;
  }

  const key = String(request.id);
  const params = request.params || {};
  const entry = {
    ...request,
    key,
    createdAt: new Date().toISOString(),
    threadId: cleanNativeThreadId(params.threadId || params.conversationId),
    turnId: String(params.turnId || ''),
  };
  pendingNativeRequests.set(key, entry);
  broadcastNativeRequest({ type: 'pending', request: publicNativeRequest(entry) });
}

function clearAppServerPendingRequests(reason = '') {
  for (const [key, request] of pendingNativeRequests) {
    if (request.transport === 'desktop-ipc') continue;
    pendingNativeRequests.delete(key);
    broadcastNativeRequest({
      type: 'resolved',
      id: request.key,
      threadId: request.threadId,
      error: reason,
    });
  }
}

function clearAppServerNativeTurns(reason = '') {
  for (const [threadId, active] of activeNativeTurns) {
    if (active.transport === 'desktop-ipc') continue;
    activeNativeTurns.delete(threadId);
    broadcastNativeRuntime({
      type: 'turn',
      threadId,
      turnId: active.turnId || '',
      status: 'interrupted',
      error: reason,
      updatedAt: new Date().toISOString(),
    });
  }
}

function listPendingNativeRequests() {
  return [...pendingNativeRequests.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map(publicNativeRequest);
}

function publicNativeRequest(request) {
  return {
    id: request.key,
    method: request.method,
    threadId: request.threadId,
    turnId: request.turnId,
    createdAt: request.createdAt,
    params: limitJsonValue(request.params),
  };
}

function limitJsonValue(value, depth = 0) {
  if (depth > 6) return '[内容过深，已省略]';
  if (typeof value === 'string') return value.length > 12000 ? `${value.slice(0, 12000)}\n[已截断]` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => limitJsonValue(item, depth + 1));
  if (!value || typeof value !== 'object') return String(value ?? '');
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, item]) => [key, limitJsonValue(item, depth + 1)]),
  );
}

function buildNativeRequestResponse(request, body) {
  const decision = String(body.decision || '').trim();
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval': {
      if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) {
        throw new Error('确认结果无效');
      }
      return { decision };
    }
    case 'execCommandApproval':
    case 'applyPatchApproval': {
      const mapped = {
        accept: 'approved',
        acceptForSession: 'approved_for_session',
        decline: 'denied',
        cancel: 'abort',
      }[decision];
      if (!mapped) throw new Error('确认结果无效');
      return { decision: mapped };
    }
    case 'item/permissions/requestApproval': {
      if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) {
        throw new Error('权限确认结果无效');
      }
      return {
        permissions: decision === 'accept' || decision === 'acceptForSession'
          ? request.params.permissions || {}
          : {},
        scope: decision === 'acceptForSession' ? 'session' : 'turn',
      };
    }
    case 'item/tool/requestUserInput': {
      const rawAnswers = body.answers;
      if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
        throw new Error('请输入问题答案');
      }
      const answers = {};
      for (const question of request.params.questions || []) {
        const id = String(question?.id || '');
        if (!id) continue;
        const value = rawAnswers[id];
        const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
        answers[id] = { answers: values.map((item) => String(item)) };
      }
      return { answers };
    }
    case 'mcpServer/elicitation/request': {
      const action = String(body.action || decision || '');
      if (!['accept', 'decline', 'cancel'].includes(action)) throw new Error('MCP 确认结果无效');
      return {
        action,
        ...(action === 'accept' ? { content: body.content || {} } : {}),
      };
    }
    default:
      throw new Error(`不支持处理 ${request.method}`);
  }
}

function setNativeTurnState(threadId, state) {
  const cleanId = cleanNativeThreadId(threadId);
  if (!cleanId) return;
  const current = activeNativeTurns.get(cleanId);
  const next = {
    turnId: String(state.turnId || ''),
    status: nativeTurnStatus(state.status),
    transport: String(state.transport || current?.transport || 'app-server'),
    updatedAt: new Date().toISOString(),
  };
  activeNativeTurns.set(cleanId, next);
  if (next.transport === 'desktop-ipc' && next.status === 'running') requestDesktopThreadSnapshot(cleanId);
  broadcastNativeRuntime({ type: 'turn', threadId: cleanId, ...next });
  nativeSessions.scheduleRefresh();
}

function currentNativeTurnId(threadId) {
  const active = activeNativeTurns.get(threadId);
  if (active?.status === 'running' && active.turnId) return String(active.turnId);
  try {
    const conversation = nativeSessions.get(threadId);
    return conversation?.status === 'running' ? String(conversation.latestTurnId || '') : '';
  } catch {
    return '';
  }
}

function nativeTurnStatus(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'inprogress' || value === 'running') return 'running';
  if (value === 'failed' || value === 'error') return 'error';
  if (value === 'interrupted' || value === 'cancelled' || value === 'canceled') return 'interrupted';
  return 'done';
}

function nativeSessionSummaries() {
  return nativeSessions.list().map((session) => {
    const active = activeNativeTurns.get(session.id);
    return {
      ...session,
      status: active?.status === 'running' ? 'running' : session.status,
      readOnly: false,
      activeTurnId: active?.turnId || '',
    };
  });
}

function normalizeNativeProjectPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = path.normalize(raw);
  const root = path.parse(normalized).root;
  return normalized === root ? root : normalized.replace(/[\\/]+$/, '');
}

function executableOrchestratedToolCallOffsets(source, toolName) {
  const text = String(source || '');
  const needle = `tools.${toolName}`;
  const offsets = [];
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (!text.startsWith(needle, index)) continue;
    let cursor = index + needle.length;
    while (/\s/.test(text[cursor] || '')) cursor += 1;
    if (text[cursor] === '(') offsets.push(index);
  }
  return offsets;
}

function extractNativeToolImagePaths(message) {
  if (message?.role !== 'tool') return [];
  const source = String(message.content || '');
  const paths = [];
  const orchestratedPattern = /^tools\.view_image\s*\(\s*\{\s*path\s*:\s*"((?:\\.|[^"\\])*)"/;
  for (const offset of executableOrchestratedToolCallOffsets(source, 'view_image')) {
    const match = source.slice(offset).match(orchestratedPattern);
    if (!match) continue;
    try {
      paths.push(JSON.parse(`"${match[1]}"`));
    } catch {
      // Ignore malformed tool arguments rather than exposing an arbitrary path.
    }
  }
  if (paths.length) return paths;
  if (!source.startsWith('view_image\n')) return [];
  try {
    const input = JSON.parse(source.slice(source.indexOf('\n') + 1));
    return typeof input?.path === 'string' && input.path.trim() ? [input.path.trim()] : [];
  } catch {
    return [];
  }
}

function readNativeToolImage(filePath, cwd) {
  if (!filePath) return null;
  try {
    const candidate = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(String(cwd || DEFAULT_CWD), filePath);
    const resolved = realpathSync(candidate);
    const type = TOOL_IMAGE_TYPES.get(path.extname(resolved).toLowerCase());
    if (!type) return null;
    const stats = statSync(resolved);
    if (!stats.isFile() || stats.size < 1 || stats.size > TOOL_IMAGE_MAX_BYTES) return null;
    return { type, data: readFileSync(resolved) };
  } catch {
    return null;
  }
}

function decorateNativeConversation(conversation) {
  const active = activeNativeTurns.get(conversation.id);
  const activeTurnId = active?.status === 'running' && active.turnId
    ? active.turnId
    : conversation.status === 'running'
      ? conversation.latestTurnId || ''
      : '';
  return {
    ...conversation,
    status: active?.status === 'running' ? 'running' : conversation.status,
    readOnly: false,
    activeTurnId,
  };
}

async function continueNativeTurn(threadId, turn) {
  const baseline = nativeSessions.get(threadId);
  const requestedAt = Date.now();
  const echoController = new AbortController();
  const desktopAttempt = desktopIpcClient.startTurn(threadId, buildDesktopTurnStartParams(turn)).then(
    (result) => ({ type: 'ipc-result', result }),
    (error) => ({ type: 'ipc-error', error }),
  );
  const echoAttempt = waitForNativeTurnEcho(threadId, turn, baseline, requestedAt, echoController.signal).then(
    (conversation) => ({ type: 'native-echo', conversation }),
  );
  const outcome = await Promise.race([desktopAttempt, echoAttempt]);
  echoController.abort();

  if (outcome.type === 'native-echo' && outcome.conversation) {
    return recoverDesktopNativeTurn(threadId, outcome.conversation);
  }

  if (outcome.type === 'ipc-result') {
    const result = outcome.result;
    const turnId = String(result?.turn?.id || '');
    if (!turnId) throw new Error('Codex Desktop IPC 未返回有效 turn id');
    setNativeTurnState(threadId, { turnId, status: 'running', transport: 'desktop-ipc' });
    return { turnId, result, transport: 'desktop-ipc' };
  }

  const error = outcome.error;
  if (!isCodexDesktopIpcUnavailableError(error)) {
    const conversation = findNativeTurnEcho(threadId, turn, baseline, requestedAt);
    if (conversation) return recoverDesktopNativeTurn(threadId, conversation);
    throw error;
  }

  await appServerClient.request('thread/resume', compactObject({
    threadId,
    cwd: turn.cwd,
    model: turn.model,
    modelProvider: turn.provider,
    sandbox: turn.sandbox,
    approvalPolicy: turn.approval,
    excludeTurns: true,
  }));
  return startNativeTurn(threadId, turn);
}

async function waitForNativeTurnEcho(threadId, turn, baseline, requestedAt, signal) {
  const deadline = Date.now() + CODEX_DESKTOP_IPC_TIMEOUT_MS + 2000;
  while (!signal.aborted && Date.now() < deadline) {
    const conversation = findNativeTurnEcho(threadId, turn, baseline, requestedAt);
    if (conversation) return conversation;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return null;
}

function findNativeTurnEcho(threadId, turn, baseline, requestedAt) {
  const conversation = nativeSessions.get(threadId, baseline ? {
    after: baseline.cursor,
    generation: baseline.generation,
  } : {});
  if (!conversation) return null;
  const expected = String(turn.input?.find((item) => item?.type === 'text')?.text || turn.message || '').trim();
  const earliest = requestedAt - 1000;
  const matched = conversation.messages.some((message) => {
    if (message.role !== 'user' || Date.parse(message.at || '') < earliest) return false;
    const content = String(message.content || '').trim();
    if (!expected) return Boolean(content && turn.attachments?.length);
    return content === expected || content.startsWith(`${expected}\n`);
  });
  return matched ? conversation : null;
}

function recoverDesktopNativeTurn(threadId, conversation) {
  const turnId = String(conversation.latestTurnId || `desktop-${randomBytes(8).toString('hex')}`);
  const status = conversation.status === 'running' ? 'running' : 'done';
  setNativeTurnState(threadId, { turnId, status, transport: 'desktop-ipc' });
  if (status !== 'running') {
    setTimeout(() => {
      const current = activeNativeTurns.get(threadId);
      if (current?.turnId === turnId && current.status !== 'running') activeNativeTurns.delete(threadId);
    }, 1800).unref?.();
  }
  return {
    turnId,
    result: { turn: { id: turnId, status: status === 'running' ? 'inProgress' : 'completed' } },
    transport: 'desktop-ipc',
    recovered: true,
  };
}

async function steerNativeTurn(threadId, steer, expectedTurnId) {
  const cwd = nativeSessions.get(threadId)?.metadata?.cwd || DEFAULT_CWD;
  const clientUserMessageId = randomBytes(16).toString('hex');
  try {
    const result = await desktopIpcClient.steerTurn(threadId, {
      input: buildDesktopTurnInput(steer.input),
      restoreMessage: buildDesktopRestoreMessage(steer, cwd, clientUserMessageId),
      serviceTier: null,
      attachments: [],
      clientUserMessageId,
    });
    return { ...result, transport: 'desktop-ipc' };
  } catch (error) {
    if (!isCodexDesktopIpcUnavailableError(error)) throw error;
  }

  let turnId = expectedTurnId;
  if (!turnId) {
    const resumed = await appServerClient.request('thread/resume', { threadId });
    turnId = findInProgressTurnId(resumed?.thread);
  }
  if (!turnId) throw new Error('该会话没有可引导的运行中任务');
  const result = await appServerClient.request('turn/steer', {
    threadId,
    expectedTurnId: turnId,
    input: steer.input,
  });
  return { ...result, transport: 'app-server' };
}

async function interruptNativeTurn(threadId, expectedTurnId) {
  try {
    const result = await desktopIpcClient.interruptTurn(threadId);
    return { ...result, transport: 'desktop-ipc' };
  } catch (error) {
    if (!isCodexDesktopIpcUnavailableError(error)) throw error;
  }

  let turnId = expectedTurnId;
  if (!turnId) {
    const resumed = await appServerClient.request('thread/resume', { threadId });
    turnId = findInProgressTurnId(resumed?.thread);
  }
  if (!turnId) throw new Error('该会话没有可取消的任务');
  await appServerClient.request('turn/interrupt', { threadId, turnId });
  return { interruptedTurnId: turnId, ok: true, transport: 'app-server' };
}

async function startNativeTurn(threadId, turn) {
  const result = await appServerClient.request('turn/start', compactObject({
    threadId,
    input: turn.input,
    cwd: turn.cwd,
    model: turn.model,
    effort: turn.reasoningEffort,
    approvalPolicy: turn.approval,
    sandboxPolicy: nativeSandboxPolicy(turn.sandbox, turn.cwd),
  }));
  const turnId = String(result?.turn?.id || '');
  if (!turnId) throw new Error('Codex app-server 未返回有效 turn id');
  setNativeTurnState(threadId, { turnId, status: 'running' });
  return { turnId, result };
}

function buildDesktopTurnStartParams(turn) {
  const workspaceWrite = turn.sandbox === 'workspace-write';
  return compactObject({
    input: buildDesktopTurnInput(turn.input),
    cwd: turn.cwd,
    model: turn.model,
    effort: turn.reasoningEffort,
    approvalPolicy: turn.approval,
    sandboxPolicy: desktopSandboxPolicy(turn.sandbox, turn.cwd),
    runtimeWorkspaceRoots: workspaceWrite ? [turn.cwd] : undefined,
    attachments: [],
  });
}

function buildDesktopTurnInput(input) {
  return (input || []).map((item) => (
    item?.type === 'text' ? { ...item, text_elements: [] } : { ...item }
  ));
}

function desktopSandboxPolicy(sandbox, cwd) {
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (sandbox === 'workspace-write') {
    return {
      type: 'workspaceWrite',
      writableRoots: [cwd],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return { type: 'readOnly', networkAccess: true };
}

function buildDesktopRestoreMessage(steer, cwd, id) {
  const prompt = String(steer.message || '').trim()
    || String(steer.input?.find((item) => item?.type === 'text')?.text || '').trim()
    || '请分析上传的附件。';
  return {
    id,
    text: prompt,
    context: {
      prompt,
      addedFiles: [],
      fileAttachments: [],
      ideContext: null,
      imageAttachments: [],
      workspaceRoots: [cwd],
    },
    cwd,
    createdAt: Date.now(),
  };
}

function parseNativeTurnPayload(body) {
  const message = String(body.message || '').trim();
  const attachments = normalizeUploadedAttachments(body.attachments, body.images);
  if (!message && !attachments.length) throw new Error('message is required');
  const settings = parseNativeThreadSettings(body);
  return {
    message,
    attachments,
    ...settings,
    input: buildNativeTurnInput(message, attachments),
  };
}

function parseNativeThreadSettings(body) {
  const cwd = normalizeCwd(body.cwd || DEFAULT_CWD);
  if (!cwd) throw new Error('工作目录不存在');
  const model = cleanValue(body.model) || DEFAULT_MODEL;
  const provider = cleanValue(body.provider) || DEFAULT_PROVIDER;
  const sandbox = cleanSandbox(body.sandbox || DEFAULT_SANDBOX);
  const approval = cleanApproval(body.approval || DEFAULT_APPROVAL);
  const reasoningEffort = cleanReasoningEffort(body.reasoningEffort);
  return {
    cwd,
    model,
    provider,
    sandbox,
    approval,
    reasoningEffort,
  };
}

function parseNativeSteerPayload(body) {
  const message = String(body.message || '').trim();
  const attachments = normalizeUploadedAttachments(body.attachments, body.images);
  if (!message && !attachments.length) throw new Error('message is required');
  return {
    message,
    attachments,
    input: buildNativeTurnInput(message, attachments),
  };
}

function buildNativeTurnInput(message, attachments) {
  const images = attachments.filter((item) => item.kind === 'image');
  const files = attachments.filter((item) => item.kind !== 'image');
  let text = appendAttachmentPrompt(message, files);
  if (!text && images.length) text = '请分析上传的图片。';
  const input = text ? [{ type: 'text', text }] : [];
  for (const image of images) input.push({ type: 'localImage', path: image.filePath });
  return input;
}

function nativeConversationFromThread(thread, activeTurnId) {
  const createdAt = unixSecondsToIso(thread?.createdAt) || new Date().toISOString();
  const updatedAt = unixSecondsToIso(thread?.updatedAt) || createdAt;
  return {
    id: cleanNativeThreadId(thread?.id),
    source: 'codex',
    title: String(thread?.name || thread?.preview || '新会话').trim().slice(0, 80),
    createdAt,
    updatedAt,
    status: activeTurnId ? 'running' : 'done',
    readOnly: false,
    activeTurnId,
    messages: [],
    metadata: {
      cwd: String(thread?.cwd || ''),
      modelProvider: String(thread?.modelProvider || ''),
      cliVersion: String(thread?.cliVersion || ''),
    },
  };
}

function unixSecondsToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return new Date(seconds * 1000).toISOString();
}

function findInProgressTurnId(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return String([...turns].reverse().find((turn) => turn?.status === 'inProgress')?.id || '');
}

function cleanNativeThreadId(value) {
  const id = String(value || '').trim().toLowerCase();
  return NATIVE_THREAD_ID_PATTERN.test(id) ? id : '';
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
  );
}

function nativeAppErrorStatus(error) {
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('not found') || message.includes('不存在')) return 404;
  if (message.includes('active') || message.includes('running') || message.includes('in progress')) return 409;
  if (error?.code === -32602) return 400;
  return 502;
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

function sessionCookie(token, maxAge) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  return `codex_web_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
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
  if (FORCE_FULL_ACCESS) return 'danger-full-access';
  return ['read-only', 'workspace-write', 'danger-full-access'].includes(value) ? value : DEFAULT_SANDBOX;
}

function cleanApproval(value) {
  if (FORCE_FULL_ACCESS) return 'never';
  return ['untrusted', 'on-request', 'never'].includes(value) ? value : DEFAULT_APPROVAL;
}

function nativeSandboxPolicy(value, cwd) {
  const sandbox = cleanSandbox(value);
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (sandbox === 'workspace-write') {
    return {
      type: 'workspaceWrite',
      writableRoots: cwd ? [cwd] : [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  return { type: 'readOnly', networkAccess: false };
}

function normalizeCwd(value) {
  const resolved = path.resolve(expandHome(String(value || DEFAULT_CWD)));
  return existsSync(resolved) ? resolved : '';
}

function expandHome(value) {
  const text = String(value || '');
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return path.join(homedir(), text.slice(2));
  return text;
}

function resolveLocalPath(value, base) {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(base, expanded);
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function loadEnv(file, override = true) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const value = parseEnvValue(trimmed.slice(idx + 1));
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}

function readEnvVar(file, key) {
  if (!existsSync(file)) return '';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${key}=`)) continue;
    return parseEnvValue(trimmed.slice(key.length + 1));
  }
  return '';
}

function parseEnvValue(value) {
  const text = String(value || '').trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === 'string' ? parsed : String(parsed ?? '');
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return text;
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
  if (!existsSync(CODEX_CONFIG_FILE)) return [];
  const providers = [];
  const content = readFileSync(CODEX_CONFIG_FILE, 'utf8');
  for (const match of content.matchAll(/^\[model_providers\.([^\]]+)\]/gm)) providers.push(match[1]);
  return providers;
}

function readCodexDefaults() {
  if (!existsSync(CODEX_CONFIG_FILE)) return {};
  const content = readFileSync(CODEX_CONFIG_FILE, 'utf8');
  return {
    provider: content.match(/^model_provider\s*=\s*"([^"]+)"/m)?.[1] || '',
    model: content.match(/^model\s*=\s*"([^"]+)"/m)?.[1] || '',
    reasoningEffort: content.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] || '',
  };
}

function readProviderDetails() {
  if (!existsSync(CODEX_CONFIG_FILE)) return [];
  const content = readFileSync(CODEX_CONFIG_FILE, 'utf8');
  const details = [];
  for (const name of readProviders()) {
    const range = findTomlTableRange(content, `model_providers.${name}`);
    if (!range) continue;
    const block = content.slice(range.start, range.end);
    details.push({
      name,
      displayName: block.match(/^name\s*=\s*"([^"]+)"/m)?.[1] || name,
      baseUrl: block.match(/^base_url\s*=\s*"([^"]+)"/m)?.[1] || '',
      envKey: block.match(/^env_key\s*=\s*"([^"]+)"/m)?.[1] || `${name.toUpperCase()}_API_KEY`,
      wireApi: block.match(/^wire_api\s*=\s*"([^"]+)"/m)?.[1] || 'responses',
      requiresOpenAIAuth: block.match(/^requires_openai_auth\s*=\s*(true|false)/m)?.[1] === 'true',
      bearerToken: block.match(/^experimental_bearer_token\s*=\s*"([^"]+)"/m)?.[1] || '',
    });
  }
  return details;
}

function providerCredential(provider) {
  return process.env[provider.envKey] || readEnvVar(CODEX_ENV_FILE, provider.envKey) || provider.bearerToken || '';
}

function upsertProvider(next) {
  const provider = {
    name: next.name,
    displayName: next.name,
    baseUrl: next.baseUrl,
    envKey: next.envKey,
    wireApi: next.wireApi,
    requiresOpenAIAuth: false,
  };
  const current = existsSync(CODEX_CONFIG_FILE) ? readFileSync(CODEX_CONFIG_FILE, 'utf8') : '';
  let content = replaceTopLevelTomlValue(current, 'model_provider', next.name);
  content = replaceTopLevelTomlValue(content, 'model', next.model || DEFAULT_MODEL);
  content = replaceTopLevelTomlValue(content, 'review_model', next.model || DEFAULT_MODEL);
  content = upsertTomlTable(content, `model_providers.${next.name}`, providerTomlBlock(provider));
  writeCodexConfig(content);
}

function providerTomlBlock(provider) {
  return `[model_providers.${provider.name}]
name = "${tomlEscape(provider.displayName)}"
base_url = "${tomlEscape(provider.baseUrl)}"
env_key = "${tomlEscape(provider.envKey)}"
wire_api = "${tomlEscape(provider.wireApi)}"
requires_openai_auth = ${provider.requiresOpenAIAuth ? 'true' : 'false'}`;
}

function upsertTomlTable(content, tableName, block) {
  const range = findTomlTableRange(content, tableName);
  if (!range) return `${content.trimEnd()}\n\n${block}\n`.replace(/^\n+/, '');
  return `${content.slice(0, range.start).trimEnd()}\n\n${block}\n\n${content.slice(range.end).trimStart()}`.trimEnd() + '\n';
}

function removeTomlTable(content, tableName) {
  const range = findTomlTableRange(content, tableName);
  if (!range) return content;
  return `${content.slice(0, range.start).trimEnd()}\n\n${content.slice(range.end).trimStart()}`.trimEnd() + '\n';
}

function findTomlTableRange(content, tableName) {
  const headerPattern = new RegExp(`^\\[${escapeRegExp(tableName)}\\]\\s*$`, 'm');
  const header = headerPattern.exec(content);
  if (!header) return null;
  const afterHeader = header.index + header[0].length;
  const nextHeader = /^\[[^\]]+\]\s*$/m.exec(content.slice(afterHeader));
  return {
    start: header.index,
    end: nextHeader ? afterHeader + nextHeader.index : content.length,
  };
}

function writeCodexConfig(content) {
  backupCodexConfig();
  validateCodexConfigText(content);
  atomicWriteFile(CODEX_CONFIG_FILE, content.trimEnd() + '\n');
}

function backupCodexConfig() {
  if (!existsSync(CODEX_CONFIG_FILE)) return;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  writeFileSync(`${CODEX_CONFIG_FILE}.bak.${stamp}`, readFileSync(CODEX_CONFIG_FILE, 'utf8'), { mode: 0o600 });
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
  if (!existsSync(CODEX_CONFIG_FILE)) throw new Error('Codex config 不存在');
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

  let content = readFileSync(CODEX_CONFIG_FILE, 'utf8');
  content = removeTomlTable(content, `model_providers.${name}`);
  content = replaceTopLevelTomlValue(content, 'model_provider', nextProvider);
  content = replaceTopLevelTomlValue(content, 'model', nextModel);
  content = replaceTopLevelTomlValue(content, 'review_model', nextModel);
  writeCodexConfig(content);
  deleteEnvVar(CODEX_ENV_FILE, target.envKey);
  delete process.env[target.envKey];
  return { deleted: name, provider: nextProvider, model: nextModel };
}

function setCodexDefaults(provider, model, reasoningEffort) {
  if (!existsSync(CODEX_CONFIG_FILE)) throw new Error('Codex config 不存在');
  let content = readFileSync(CODEX_CONFIG_FILE, 'utf8');
  content = replaceTopLevelTomlValue(content, 'model_provider', provider);
  content = replaceTopLevelTomlValue(content, 'model', model);
  content = replaceTopLevelTomlValue(content, 'review_model', model);
  content = reasoningEffort
    ? replaceTopLevelTomlValue(content, 'model_reasoning_effort', reasoningEffort)
    : removeTopLevelTomlValue(content, 'model_reasoning_effort');
  writeCodexConfig(content);
}

function cleanReasoningEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  if (!effort) return '';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('思考档位无效');
  return effort;
}

function replaceTopLevelTomlValue(content, key, value) {
  const line = `${key} = "${tomlEscape(value)}"`;
  const pattern = new RegExp(`^${key}\\s*=\\s*"[^"]*"`, 'm');
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${line}\n${content}`;
}

function removeTopLevelTomlValue(content, key) {
  return content.replace(new RegExp(`^${key}\\s*=.*(?:\\r?\\n|$)`, 'm'), '');
}

function updateEnvVar(file, key, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const nextLine = `${key}=${JSON.stringify(String(value))}`;
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return nextLine;
    }
    return line;
  });
  if (!found) next.push(nextLine);
  atomicWriteFile(file, next.filter((line, index, arr) => line || index < arr.length - 1).join('\n') + '\n');
}

function deleteEnvVar(file, key) {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const next = lines.filter((line) => !line.startsWith(`${key}=`));
  atomicWriteFile(file, next.filter((line, index, arr) => line || index < arr.length - 1).join('\n') + '\n');
}

function atomicWriteFile(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, file);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tomlEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  if (process.env.PUBLIC_HOST) return process.env.PUBLIC_HOST;
  if (['127.0.0.1', 'localhost', '::1'].includes(HOST)) return HOST === '::1' ? '[::1]' : HOST;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '127.0.0.1';
}

function loadSessions() {
  const map = new Map();
  try {
    if (!existsSync(SESSIONS_FILE)) return map;
    const now = Date.now();
    const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
    for (const [key, expires] of Object.entries(data)) {
      if (typeof expires === 'number' && expires > now) map.set(key, expires);
    }
  } catch {
    return map;
  }
  return map;
}

function saveSessions() {
  const data = Object.fromEntries([...sessions.entries()].slice(-1000));
  atomicWriteFile(SESSIONS_FILE, JSON.stringify(data, null, 2) + '\n');
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

function conversationSummaries() {
  return nativeSessionSummaries()
    .sort((left, right) => Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0))
    .slice(0, 160);
}

function readImagePromptLibrary() {
  if (imagePromptLibraryCache) return imagePromptLibraryCache;
  const caseData = JSON.parse(readFileSync(IMAGE_PROMPT_CASES_FILE, 'utf8'));
  const styleData = JSON.parse(readFileSync(IMAGE_PROMPT_STYLES_FILE, 'utf8'));
  const cases = Array.isArray(caseData?.cases) ? caseData.cases : [];
  const templates = Array.isArray(styleData?.templates) ? styleData.templates : [];
  if (!cases.length || !templates.length) throw new Error('提示词数据为空');
  imagePromptLibraryCache = {
    version: `${styleData.version || 1}:${cases.length}:${templates.length}`,
    imageBaseUrl: IMAGE_PROMPT_IMAGE_BASE,
    totalCases: cases.length,
    totalTemplates: templates.length,
    categories: Array.isArray(styleData.categories) ? styleData.categories : [],
    styles: Array.isArray(styleData.styles) ? styleData.styles : [],
    scenes: Array.isArray(styleData.scenes) ? styleData.scenes : [],
    cases,
    templates,
    sources: [
      {
        name: 'awesome-gpt-image-2',
        url: 'https://github.com/freestylefly/awesome-gpt-image-2',
        license: 'MIT',
        role: '提示词案例与工业模板',
      },
      {
        name: 'gpt_image_playground',
        url: 'https://github.com/CookSleep/gpt_image_playground',
        license: 'MIT',
        role: '完整生图工作台',
      },
    ],
  };
  return imagePromptLibraryCache;
}

function pageHtml(authenticated) {
  const appName = escapeHtml(APP_NAME);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${appName}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{color-scheme:dark;--bg:#080b10;--panel:#0f141d;--panel2:#121926;--line:#253142;--text:#e6edf3;--muted:#8b98a8;--blue:#6aa8ff;--green:#37c871;--red:#ff6b6b;--user:#175ddc}
body[data-theme="light"]{color-scheme:light;--bg:#f6f8fb;--panel:#ffffff;--panel2:#eef3f8;--line:#d6deea;--text:#172033;--muted:#627084;--blue:#2563eb;--green:#16a34a;--red:#dc2626;--user:#2563eb}
*{box-sizing:border-box}body{margin:0;height:100vh;background:radial-gradient(circle at top left,#172033,#080b10 46%);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.hidden{display:none!important}
button,input,textarea,select{font:inherit}button{border:0;cursor:pointer}.login{height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(420px,100%);background:rgba(15,20,29,.88);border:1px solid var(--line);border-radius:22px;padding:28px;box-shadow:0 24px 90px rgba(0,0,0,.42);backdrop-filter:blur(18px)}.brand{font-size:28px;font-weight:780;letter-spacing:-.04em}.sub{margin:8px 0 24px;color:var(--muted)}.field{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}.field label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.field input,.field textarea,.field select{width:100%;background:#090d14;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:12px 13px;outline:none}.field input:focus,.field textarea:focus,.field select:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(106,168,255,.12)}.primary{width:100%;padding:12px 16px;border-radius:12px;background:linear-gradient(135deg,#2f81f7,#7c5cff);color:white;font-weight:700}.errorText{color:var(--red);font-size:13px;min-height:18px;margin-top:12px}
.app{height:100vh;display:grid;grid-template-columns:292px 1fr}.side{background:rgba(8,12,18,.82);border-right:1px solid var(--line);padding:18px;display:flex;flex-direction:column;gap:16px;overflow:auto}.brandRow{display:flex;align-items:center;justify-content:space-between;gap:10px}.logo{font-weight:800;font-size:22px;letter-spacing:-.04em}.pill{display:inline-flex;align-items:center;gap:6px;background:#122017;color:#94f0b1;border:1px solid #214c2c;border-radius:999px;padding:4px 9px;font-size:12px}.sideActions{display:grid;gap:10px;align-items:center}.themeToggle{display:grid;place-items:center;flex:0 0 auto;width:34px;height:34px;border-radius:11px;background:#172033;color:var(--text);border:1px solid var(--line);font-size:17px;font-weight:800}.themeToggle:hover{border-color:var(--blue);background:#1b2533}.settings{display:grid;gap:11px}.settings .field{margin:0}.smallrow{display:grid;grid-template-columns:1fr 1fr;gap:9px}.backgroundControls{display:grid;gap:8px;align-items:end}.backgroundRow{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end}.backgroundControls .field{margin:0}.providerBox{background:rgba(18,25,38,.74);border:1px solid var(--line);border-radius:14px;padding:10px}.providerBox summary{cursor:pointer;color:var(--text);font-weight:700;font-size:13px}.providerBox form{margin-top:12px}.miniPrimary{width:100%;padding:10px;border-radius:11px;background:var(--blue);color:#06101f;font-weight:800}.miniSecondary{align-self:end;width:100%;padding:10px;border-radius:11px;background:#1b2533;color:var(--text);border:1px solid var(--line);font-weight:700}.miniDanger{width:100%;padding:10px;border-radius:11px;background:#221114;color:#ff9da5;border:1px solid #613039;font-weight:800}.miniDanger:hover{background:#3a161c}.backgroundDelete{width:auto;min-width:56px;align-self:end}.history{flex:1.35;overflow:auto;display:flex;flex-direction:column;gap:15px;min-height:220px}.historyProject{display:grid;gap:7px;min-width:0}.historyProjectHead{display:grid;gap:2px;min-width:0;padding:0 2px}.historyProjectTitle{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}.historyProjectName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);font-size:12px;font-weight:800;letter-spacing:0}.historyProjectCount{flex:0 0 auto;color:var(--muted);font-size:10px;font-variant-numeric:tabular-nums}.historyProjectPath{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}.historyProjectItems{display:grid;gap:7px}.hist{display:grid;grid-template-columns:1fr auto auto;gap:6px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px;color:var(--muted);font-size:13px;min-height:48px;cursor:pointer}.hist.native{grid-template-columns:minmax(0,1fr) auto auto auto}.hist:hover{border-color:var(--blue);color:var(--text);background:#151d2b}.hist.active{border-color:var(--blue);color:var(--text);background:rgba(106,168,255,.14);box-shadow:inset 3px 0 0 var(--blue)}.histOpen{background:transparent;color:inherit;border:0;text-align:left;padding:0;overflow:hidden;text-overflow:ellipsis;white-space:normal;line-height:1.35;cursor:pointer}.histSource{display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:24px;border:1px solid #31527a;border-radius:6px;background:#0b1a2a;color:#8fc3ff;font-size:10px;font-weight:800}.histRename{background:#172033;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:5px 7px;font-size:12px}.histRename:hover{border-color:var(--blue);background:#1b2533}.histDelete{background:#221114;color:#ff9da5;border:1px solid #613039;border-radius:6px;padding:5px 7px;font-size:12px}.histDelete:hover{background:#3a161c}.logout{background:transparent;color:var(--muted);border:1px solid var(--line);border-radius:11px;padding:10px}
.main{display:flex;flex-direction:column;min-width:0}.top{height:62px;border-bottom:1px solid var(--line);background:rgba(15,20,29,.75);display:flex;align-items:center;justify-content:space-between;padding:0 22px}.title{font-weight:720}.meta{color:var(--muted);font-size:13px}.chat{flex:1;overflow:auto;padding:26px;display:flex;flex-direction:column;gap:18px}.empty{margin:auto;text-align:center;color:var(--muted)}.empty b{display:block;color:var(--text);font-size:30px;letter-spacing:-.05em;margin-bottom:8px}.msg{max-width:min(880px,88%);border-radius:18px;padding:14px 16px;line-height:1.65;word-break:break-word}.msg.user{align-self:flex-end;background:linear-gradient(135deg,var(--user),#7147e8);color:white}.msg.assistant{align-self:flex-start;background:rgba(18,25,38,.86);border:1px solid var(--line)}.msg.log{align-self:flex-start;background:#0b1119;border:1px dashed var(--line);color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.msgActions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin:8px -4px -4px 0}.msgActions .tag{margin:0;margin-right:auto}.copyMsg,.rollbackMsg{display:grid;place-items:center;flex:0 0 auto;width:26px;height:24px;border:1px solid rgba(139,152,168,.28);border-radius:8px;background:rgba(8,12,18,.38);color:var(--muted);padding:0;font-size:13px;line-height:1}.copyMsg:hover,.rollbackMsg:hover{border-color:var(--blue);color:var(--text);background:rgba(106,168,255,.12)}.msg.user .copyMsg,.msg.user .rollbackMsg{border-color:rgba(255,255,255,.22);background:rgba(255,255,255,.1);color:rgba(255,255,255,.76)}.msg.user .copyMsg:hover,.msg.user .rollbackMsg:hover{color:#fff;background:rgba(255,255,255,.18)}.msgBody{white-space:pre-wrap}.markdownBody{min-width:0;white-space:normal}.markdownBody>:first-child{margin-top:0}.markdownBody>:last-child{margin-bottom:0}.markdownBody p{margin:0 0 10px}.markdownBody h1,.markdownBody h2,.markdownBody h3,.markdownBody h4,.markdownBody h5,.markdownBody h6{margin:16px 0 8px;line-height:1.3;letter-spacing:0}.markdownBody h1{font-size:18px}.markdownBody h2{font-size:16px}.markdownBody h3{font-size:14px}.markdownBody h4,.markdownBody h5,.markdownBody h6{font-size:13px}.markdownBody ul,.markdownBody ol{margin:6px 0 10px;padding-left:22px}.markdownBody li+li{margin-top:3px}.markdownBody li>p{margin-bottom:4px}.markdownBody blockquote{margin:10px 0;padding:2px 0 2px 12px;border-left:3px solid var(--blue);color:var(--muted)}.markdownBody a{color:var(--blue);text-decoration-thickness:1px;text-underline-offset:2px}.markdownBody code{border:1px solid var(--line);border-radius:5px;background:var(--panel2);padding:1px 5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;word-break:break-word}.markdownBody pre{max-width:100%;margin:10px 0;overflow:auto;border:1px solid var(--line);border-radius:7px;background:#080d14;padding:11px 12px;color:#d9e6f2}.markdownBody pre code{border:0;background:transparent;padding:0;color:inherit;word-break:normal}.markdownBody table{display:block;max-width:100%;margin:10px 0;overflow-x:auto;border-collapse:collapse}.markdownBody th,.markdownBody td{min-width:90px;border:1px solid var(--line);padding:6px 9px;text-align:left}.markdownBody th{background:var(--panel2);font-weight:800}.markdownBody hr{height:1px;margin:14px 0;border:0;background:var(--line)}.composer{border-top:1px solid var(--line);background:rgba(15,20,29,.9);padding:16px 22px}.nativeNotice{margin-bottom:10px;border:1px solid #31527a;border-radius:10px;background:#0b1a2a;color:#9bc9ff;padding:9px 11px;font-size:12px;font-weight:700}.box{display:flex;gap:12px;align-items:flex-end}.box textarea{flex:1;min-height:52px;max-height:180px;resize:none;background:#090d14;border:1px solid var(--line);color:var(--text);border-radius:16px;padding:14px;outline:none}.box textarea:disabled{cursor:not-allowed;color:var(--muted);background:#0b1119}.box.drag textarea{border-color:var(--blue);box-shadow:0 0 0 3px rgba(106,168,255,.14)}.attachBtn{width:52px;height:52px;border-radius:16px;background:#172033;color:var(--text);border:1px solid var(--line);font-size:24px;line-height:1}.attachBtn:hover{border-color:var(--blue);background:#1b2533}.attachBtn:disabled{opacity:.45;cursor:not-allowed}.attachmentTray{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.attachmentChip{display:flex;align-items:center;gap:8px;max-width:280px;background:#0b1119;border:1px solid var(--line);border-radius:12px;padding:6px 8px;color:var(--muted);font-size:12px}.attachmentChip img,.attachmentIcon{width:42px;height:42px;flex:0 0 42px;border-radius:8px}.attachmentChip img{object-fit:cover}.attachmentIcon{display:grid;place-items:center;background:#172033;border:1px solid var(--line);color:var(--blue);font-weight:800;font-size:11px;text-transform:uppercase}.attachmentText{min-width:0;display:flex;flex-direction:column;gap:2px}.attachmentText span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.attachmentMeta{color:#627084;font-size:11px}.attachmentChip button{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;background:#221114;color:#ff9da5;border:1px solid #613039}.composerControls{display:flex;align-items:end;flex-wrap:wrap;gap:8px;margin-top:10px}.composerControls .field{width:96px;margin:0;gap:5px}.composerControls .field label{font-size:10px}.composerControls .field select{padding:6px 7px;border-radius:9px;font-size:12px}.send{width:92px;height:52px;border-radius:16px;background:var(--green);color:#07100a;font-weight:800}.send:disabled{opacity:.55;cursor:not-allowed}.hint{margin-top:8px;color:var(--muted);font-size:12px}.safety{flex:1 1 360px;min-width:260px;border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:12px;line-height:1.35;background:#0b1119;color:var(--muted)}.safety.safe{border-color:#254a33;color:#9ee8b5}.safety.warn{border-color:#6f5522;color:#ffd98a}.safety.danger{border-color:#743232;color:#ffabab;background:#190d0d}.spinner{display:inline-block;width:10px;height:10px;border:2px solid #405064;border-top-color:var(--blue);border-radius:50%;animation:spin .9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:820px){.app{grid-template-columns:1fr}.side{display:none}.chat{padding:16px}.msg{max-width:100%}.composerControls .field{width:calc(50% - 4px)}.safety{flex-basis:100%;min-width:0}}
.menuBtn{display:none}.scrim{display:none}@media(max-width:820px){html,body{height:100%;overflow:hidden}.app{display:block;height:100dvh;overflow:hidden}.main{height:100dvh;display:flex;flex-direction:column;overflow:hidden}.menuBtn{display:grid;place-items:center;flex:0 0 42px;width:42px;height:42px;border-radius:13px;background:#101722;border:1px solid var(--line);color:var(--text);font-size:24px;line-height:1}.side{display:flex;position:fixed;z-index:30;left:0;top:0;bottom:0;width:min(86vw,330px);transform:translateX(-105%);transition:transform .22s ease;background:rgba(8,12,18,.96);box-shadow:26px 0 80px rgba(0,0,0,.45)}.app.menuOpen .side{transform:translateX(0)}.scrim{display:block;position:fixed;z-index:20;inset:0;background:rgba(0,0,0,.48);opacity:0;pointer-events:none;transition:opacity .2s}.app.menuOpen .scrim{opacity:1;pointer-events:auto}.top{flex:0 0 auto;min-height:58px;height:auto;padding:calc(env(safe-area-inset-top,0px) + 8px) 14px 8px;gap:12px;justify-content:flex-start}.top .meta:last-child{margin-left:auto}.chat{flex:1 1 auto;min-height:0;overflow:auto;padding:14px}.composer{flex:0 0 auto;padding:12px 12px calc(env(safe-area-inset-bottom,0px) + 12px)}.box{gap:8px}.send{width:72px}.msg{max-width:100%}}
.msg.image{padding:8px;background:rgba(18,25,38,.86);border:1px solid var(--line)}.msg.image img{display:block;max-width:min(520px,100%);border-radius:14px}
.msg{font-size:13px}.msg.user,.msg.assistant{font-size:13px}.msg.process,.msg.tool,.msg.thinking{align-self:flex-start;max-width:min(780px,92%);padding:8px 10px;border-radius:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.45;color:#8f9bad;background:#091018;border:1px dashed #263244}.msg.thinking{color:#b8a8ff;border-color:#3e3568;background:#100d1b}.msg.tool{color:#8fd7ff;border-color:#244a60;background:#08141d}.msg.process{color:#9ee8b5;border-color:#254a33;background:#0b1510}
.msg .tag{display:block;margin-bottom:4px;opacity:.75;font-weight:800;letter-spacing:.08em;font-size:10px}
.msg.tool,.msg.thinking{flex:0 0 auto;min-width:0;padding:0;overflow:hidden}.toolDetails{min-width:0}.toolDetails summary{display:list-item;min-height:34px;padding:8px 10px;cursor:pointer;outline:none}.toolDetails summary::marker{color:currentColor}.toolDetails summary:hover,.toolDetails[open] summary{background:rgba(106,168,255,.08)}.toolDetails summary:focus-visible{box-shadow:inset 0 0 0 2px var(--blue)}.toolSummaryRow{display:inline-flex;align-items:center;gap:8px;width:calc(100% - 18px);min-width:0;vertical-align:middle}.toolSummaryTag{display:inline-flex!important;flex:0 0 auto;margin:0!important}.toolSummaryText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:inherit;font-weight:700}.toolContent{padding:8px 10px 10px;border-top:1px dashed var(--line)}.toolContent .msgBody{max-height:min(52vh,520px);overflow:auto;overscroll-behavior:contain;padding-right:4px}.toolContent .msgActions{margin-bottom:-2px}.msg.thinking.streaming{border-style:solid;box-shadow:0 0 0 1px rgba(184,168,255,.16)}.msg.thinking.streaming .toolSummaryText::after{content:' · 输出中';color:var(--muted);font-weight:500}
.settingsToggle{width:100%;padding:10px;border-radius:11px;background:#172033;color:var(--text);border:1px solid var(--line);font-weight:800}.settingsToggle:hover{border-color:var(--blue)}.settingsPanel{display:none;gap:12px}.settingsPanel.open{display:grid}
.requestOverlay{position:fixed;z-index:100;inset:0;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.62)}.requestPanel{width:min(680px,100%);max-height:min(82vh,760px);overflow:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel);box-shadow:0 26px 90px rgba(0,0,0,.5);padding:20px}.requestHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.requestTitle{font-size:17px;font-weight:800}.requestMeta{margin-top:4px;color:var(--muted);font-size:12px}.requestDetail{max-height:260px;overflow:auto;margin:0 0 14px;padding:12px;border:1px solid var(--line);border-radius:7px;background:#080d14;color:#cbd6e2;white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.requestFields{display:grid;gap:12px}.requestField{display:grid;gap:6px}.requestField label{font-size:12px;color:var(--muted)}.requestField input,.requestField select,.requestField textarea{width:100%;border:1px solid var(--line);border-radius:7px;background:#090d14;color:var(--text);padding:10px}.requestActions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:16px}.requestAction{padding:9px 12px;border:1px solid var(--line);border-radius:7px;background:#172033;color:var(--text);font-weight:700}.requestAction.primary{background:var(--green);color:#07100a;border-color:transparent}.requestAction.danger{background:#3a161c;color:#ffb1b7;border-color:#74353e}.requestAction:disabled{opacity:.5;cursor:not-allowed}.requestLink{color:var(--blue);word-break:break-all}
body[data-theme="light"]{background:linear-gradient(135deg,#f8fbff,#edf2f7)}body[data-theme="light"] .card{background:rgba(255,255,255,.9);box-shadow:0 24px 70px rgba(31,41,55,.16)}body[data-theme="light"] .side{background:rgba(247,250,252,.92)}body[data-theme="light"] .top,body[data-theme="light"] .composer{background:rgba(255,255,255,.9)}body[data-theme="light"] .field input,body[data-theme="light"] .field textarea,body[data-theme="light"] .field select,body[data-theme="light"] .box textarea{background:#fff}body[data-theme="light"] .providerBox,body[data-theme="light"] .hist,body[data-theme="light"] .msg.assistant,body[data-theme="light"] .msg.image{background:rgba(255,255,255,.86)}body[data-theme="light"] .hist:hover{background:#eef4ff}body[data-theme="light"] .hist.active{background:rgba(37,99,235,.1)}body[data-theme="light"] .miniSecondary,body[data-theme="light"] .settingsToggle,body[data-theme="light"] .themeToggle,body[data-theme="light"] .histRename,body[data-theme="light"] .attachBtn,body[data-theme="light"] .menuBtn{background:#eef3f8}body[data-theme="light"] .msg.log,body[data-theme="light"] .attachmentChip,body[data-theme="light"] .safety{background:#f8fafc}body[data-theme="light"] .msg.log{color:#526273}body[data-theme="light"] .msg.process{background:#edfdf2;color:#216a3b;border-color:#8fc6a0}body[data-theme="light"] .msg.tool{background:#eef7ff;color:#175f87;border-color:#8ab9d4}body[data-theme="light"] .msg.thinking{background:#f5f1ff;color:#5d429b;border-color:#b2a3dc}body[data-theme="light"] .nativeNotice{background:#eef7ff;color:#175f87;border-color:#8ab9d4}
body[data-chat-bg="default"] .chat{background:transparent}body[data-chat-bg="plain"] .chat{background:var(--bg)}body[data-chat-bg="paper"] .chat{background:#f4ecd8;color:#1f2937}body[data-chat-bg="paper"] .chat .empty,body[data-chat-bg="paper"] .chat .meta{color:#725f43}body[data-chat-bg="grid"] .chat{background-color:var(--bg);background-image:linear-gradient(rgba(106,168,255,.11) 1px,transparent 1px),linear-gradient(90deg,rgba(106,168,255,.11) 1px,transparent 1px);background-size:28px 28px}body[data-chat-bg="custom"] .chat{background-color:var(--bg);background-image:var(--custom-chat-bg);background-size:cover;background-position:center;background-repeat:no-repeat}body[data-theme="light"][data-chat-bg="grid"] .chat{background-image:linear-gradient(rgba(37,99,235,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(37,99,235,.12) 1px,transparent 1px)}body[data-theme="light"][data-chat-bg="paper"] .chat{background:#f7efd9}
@media(min-width:821px){.app{display:block;height:100vh;overflow:hidden}.side{position:fixed;left:0;top:0;bottom:0;width:292px;height:100vh;z-index:10}.main{margin-left:292px;height:100vh}}
</style>
<link rel="stylesheet" href="/ui.css">
<link rel="stylesheet" href="/image-prompt.css">
</head>
<body><a class="skipLink" href="#chat">跳到对话</a>
<section id="login" class="login ${authenticated ? 'hidden' : ''}"><div class="card"><div class="brand">${appName}</div><div class="sub">输入访问密码后使用本机 Codex App。</div><form id="loginForm"><div class="field"><label>密码</label><input id="password" type="password" autocomplete="current-password" autofocus></div><button class="primary">登录</button><div id="loginError" class="errorText"></div></form></div></section>
<section id="app" class="app ${authenticated ? '' : 'hidden'}"><div id="scrim" class="scrim"></div><aside id="sidePanel" class="side"><div><div class="brandRow"><div class="logo">${appName}</div><button id="themeToggle" class="themeToggle" type="button" title="切换黑暗模式" aria-label="切换黑暗模式">☾</button></div><div style="margin-top:8px"><span class="pill"><span></span>Protected</span></div></div><div class="sideActions"><button id="newChat" class="miniPrimary">新建会话</button></div><button id="settingsToggle" class="settingsToggle">设置</button><div id="settingsPanel" class="settingsPanel"><div class="settings"><div class="backgroundControls"><div class="backgroundRow"><div class="field"><label>会话背景</label><select id="chatBackground"><option value="default">默认</option><option value="dream-skin">Dream Skin</option><option value="custom">自定义</option></select></div><button id="deleteBackground" class="miniDanger backgroundDelete hidden" type="button">删除</button></div><input id="chatBackgroundFile" class="hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></div><div class="field"><label>Provider</label><select id="provider"><option value="">默认</option></select></div><div class="field"><label>Model</label><select id="model"></select></div><div class="field"><label>思考档位</label><select id="reasoningEffort"><option value="">默认</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select></div><button id="refreshProviderModels" class="miniSecondary" type="button">更新模型</button><button id="saveDefault" class="miniSecondary">保存默认设置</button><button id="deleteProvider" class="miniDanger" type="button">删除服务商</button><div id="defaultMsg" class="errorText"></div><div class="field"><label>工作目录</label><input id="cwd" value="${escapeHtml(DEFAULT_CWD)}"></div></div><details id="providerManager" class="providerBox"><summary>添加服务商</summary><form id="providerForm"><div class="field"><label>名称</label><input id="newProviderName" placeholder="例如 Chy"></div><div class="field"><label>Base URL</label><input id="newProviderUrl" placeholder="https://example.com/v1"></div><div class="field"><label>API Key</label><input id="newProviderKey" type="password" placeholder="sk-..."></div><div class="field"><label>模型</label><select id="newProviderModel"><option value="">先获取模型</option></select></div><div class="smallrow"><button type="button" id="fetchNewModels" class="miniSecondary">获取模型</button><div class="field"><label>API</label><select id="newProviderWire"><option value="responses">responses</option><option value="chat">chat</option></select></div></div><button class="miniPrimary">保存并设为默认</button><div id="providerMsg" class="errorText"></div></form></details></div><div class="meta">最近会话</div><div id="history" class="history"></div><button id="logout" class="logout">退出登录</button></aside><main class="main"><div class="top"><button id="menuBtn" class="menuBtn" type="button" aria-controls="sidePanel" aria-expanded="true" aria-label="收起侧栏">☰</button><div><div class="title">Chat</div><div id="status" class="meta">Ready</div></div><div id="modeLabel" class="meta">Codex App</div></div><div id="chat" class="chat"><div class="empty"><b>Ask Codex</b><span>选择目录和模型，然后发送任务。</span></div></div><div class="composer"><div id="nativeNotice" class="nativeNotice">Codex App 会话 · 双向同步</div><div id="dropZone" class="box"><textarea id="input" rows="1" placeholder="输入任务，可拖入附件"></textarea><button id="attachFile" class="attachBtn" type="button" title="上传附件" aria-label="上传附件">＋</button><input id="fileInput" class="hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/csv,application/json,.txt,.md,.json,.jsonl,.csv,.log,.pdf,.xml,.yaml,.yml,.toml,.ini,.html,.css,.js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.sh,.bash,.zsh,.go,.rs,.java,.c,.h,.cpp,.hpp,.cs,.php,.rb,.sql" multiple><button id="send" class="send">发送</button><button id="cancelRun" class="send hidden" style="background:#ff6b6b;color:#1b0909">取消</button></div><div id="attachmentTray" class="attachmentTray hidden"></div><div class="composerControls"><div class="field"><label>权限模式</label><select id="sandbox"><option value="read-only">只读</option><option value="workspace-write">工作区写入</option><option value="danger-full-access">高危全权限</option></select></div><div class="field"><label>确认策略</label><select id="approval"><option value="never">从不询问</option><option value="on-request">按需询问</option><option value="untrusted">不可信时询问</option></select></div><div id="safetyHint" class="safety safe"></div></div><div class="hint">按需确认会直接显示在当前 Web 页面。</div></div></main></section>
<div id="nativeRequestModal" class="requestOverlay hidden" role="presentation"><div class="requestPanel" role="dialog" aria-modal="true" aria-labelledby="nativeRequestTitle"><div class="requestHead"><div><div id="nativeRequestTitle" class="requestTitle">Codex 请求确认</div><div id="nativeRequestMeta" class="requestMeta"></div></div></div><pre id="nativeRequestDetail" class="requestDetail"></pre><form id="nativeRequestForm"><div id="nativeRequestFields" class="requestFields"></div><div id="nativeRequestActions" class="requestActions"></div></form></div></div>
<script src="/vendor/marked.js"></script>
<script src="/vendor/purify.js"></script>
<script src="/vendor/lucide.js"></script>
<script>
const login = document.getElementById('login'), app = document.getElementById('app'), loginForm = document.getElementById('loginForm'), loginError = document.getElementById('loginError');
const chat = document.getElementById('chat'), input = document.getElementById('input'), sendBtn = document.getElementById('send'), cancelBtn = document.getElementById('cancelRun'), statusEl = document.getElementById('status');
const dropZone = document.getElementById('dropZone'), attachFile = document.getElementById('attachFile'), fileInput = document.getElementById('fileInput'), attachmentTray = document.getElementById('attachmentTray');
const provider = document.getElementById('provider'), model = document.getElementById('model'), reasoningEffort = document.getElementById('reasoningEffort'), cwd = document.getElementById('cwd'), sandbox = document.getElementById('sandbox'), approval = document.getElementById('approval'), history = document.getElementById('history'), providerForm = document.getElementById('providerForm'), providerMsg = document.getElementById('providerMsg'), newProviderModel = document.getElementById('newProviderModel'), defaultMsg = document.getElementById('defaultMsg'), safetyHint = document.getElementById('safetyHint');
const settingsToggle = document.getElementById('settingsToggle'), settingsPanel = document.getElementById('settingsPanel');
const menuBtn = document.getElementById('menuBtn');
const providerManager = document.getElementById('providerManager'), saveDefault = document.getElementById('saveDefault'), deleteProviderButton = document.getElementById('deleteProvider');
const themeToggle = document.getElementById('themeToggle'), chatBackground = document.getElementById('chatBackground'), chatBackgroundFile = document.getElementById('chatBackgroundFile'), deleteBackground = document.getElementById('deleteBackground');
const modeLabel = document.getElementById('modeLabel'), nativeNotice = document.getElementById('nativeNotice');
const nativeRequestModal = document.getElementById('nativeRequestModal'), nativeRequestTitle = document.getElementById('nativeRequestTitle'), nativeRequestMeta = document.getElementById('nativeRequestMeta'), nativeRequestDetail = document.getElementById('nativeRequestDetail'), nativeRequestForm = document.getElementById('nativeRequestForm'), nativeRequestFields = document.getElementById('nativeRequestFields'), nativeRequestActions = document.getElementById('nativeRequestActions');
const titleEl = document.querySelector('.top .title');
let currentConversationId = '';
let currentConversationSource = 'codex';
let conversationLoadSeq = 0;
let nativeCursor = 0;
let nativeGeneration = 0;
let sessionEvents = null;
let nativeSyncTimer = null;
let nativeCompletionSync = null;
let nativeCompletionTimer = null;
let webRunActive = false;
let steerSubmitting = false;
let activeNativeTurnId = '';
let forceFullAccess = false;
let nativeRunningElement = null;
let nativeOptimisticElements = [];
let nativeOptimisticSteering = new Map();
let nativeLiveItems = new Map();
let latestToolElement = null;
let latestAssistantElement = null;
let latestFinalAssistantElement = null;
let latestUserElement = null;
let turnProcessElements = [];
let currentActivityCluster = null;
let collectingTurnProcess = false;
let turnProcessHeader = null;
let turnProcessTimeline = null;
let currentNativeRequest = null;
let dangerConfirmed = false;
let pendingAttachments = [];
let historyFilter = null;
let historyItems = [];
let composerPermissionToggle = null;
let composerModelToggle = null;
let composerProjectPicker = null;
let composerProjectToggle = null;
let composerProjectPanel = null;
let composerProjectName = null;
let composerProjectPathInput = null;
let composerProjectOptions = null;
let composerPermissionPanel = null;
let composerModelPanel = null;
let composerProviderSelect = null;
let composerModelSelect = null;
let composerReasoningSelect = null;
let composerModelName = null;
let composerEffortName = null;
let composerModelState = null;
let promptQueuePanel = null;
let promptQueueList = null;
let promptQueues = readPromptQueues();
let queueDispatchingThreads = new Set();
let queueGuidingItems = new Set();
let queueFailures = new Map();
const syncCurrentNativeConversation = createTrailingSingleFlight(syncCurrentNativeConversationOnce);
let settingsOverlay = null;
let settingsDialog = null;
let settingsClose = null;
let passwordForm = null;
let passwordStatus = null;
let dreamSkinPanel = null;
let dreamSkinIdea = null;
let dreamSkinMode = null;
let dreamSkinReferenceInput = null;
let dreamSkinReferenceList = null;
let dreamSkinGenerateButton = null;
let dreamSkinStatus = null;
let dreamSkinReferenceFiles = [];
let imagePreview = null;
let imagePreviewImage = null;
let imagePreviewClose = null;
let imagePreviewReturnFocus = null;
let appearance = {theme:'light',chatBackground:'default',customBackgrounds:[]};
const desktopSidebarMedia=window.matchMedia('(min-width: 821px)');
const SIDEBAR_STORAGE_KEY='codexWeb.sidebarCollapsed';
const HISTORY_PROJECTS_STORAGE_KEY='codexWeb.historyProjectsCollapsed';
const HIDDEN_HISTORY_PROJECTS_STORAGE_KEY='codexWeb.historyProjectsHidden';
const HISTORY_PROJECT_NAMES_STORAGE_KEY='codexWeb.historyProjectNames.v1';
const PROMPT_QUEUE_STORAGE_KEY='codexWeb.promptQueue.v1';
let collapsedHistoryProjects=readCollapsedHistoryProjects();
let hiddenHistoryProjects=readHiddenHistoryProjects();
let renamedHistoryProjects=readRenamedHistoryProjects();
let activeHistoryProjectMenu=null;
function refreshIcons(root=document){if(!window.lucide?.createIcons||!window.lucide?.icons)return;window.lucide.createIcons({icons:window.lucide.icons,root,attrs:{'aria-hidden':'true','stroke-width':'1.8'}})}
function setIconLabel(element,name,label,showLabel=true){if(!element)return;element.replaceChildren();const icon=document.createElement('i');icon.setAttribute('data-lucide',name);icon.setAttribute('aria-hidden','true');element.appendChild(icon);if(showLabel){const text=document.createElement('span');text.className='buttonLabel';text.textContent=label;element.appendChild(text)}if(label&&!element.getAttribute('aria-label'))element.setAttribute('aria-label',label);refreshIcons(element)}
function createComposerMirrorField(panel,labelText,ariaLabel){
  const field=document.createElement('label');
  field.className='composerMenuField';
  const label=document.createElement('span');
  label.textContent=labelText;
  const select=document.createElement('select');
  select.setAttribute('aria-label',ariaLabel);
  field.appendChild(label);
  field.appendChild(select);
  panel.appendChild(field);
  return select;
}
function syncComposerSelect(source,target){
  if(!source||!target)return;
  const value=source.value;
  target.replaceChildren(...[...source.options].map((option)=>{
    const copy=document.createElement('option');
    copy.value=option.value;
    copy.textContent=option.textContent;
    copy.disabled=option.disabled;
    return copy;
  }));
  target.value=value;
  target.disabled=source.disabled;
}
function composerModelLabel(value){
  const clean=String(value||'默认模型').replace(/^gpt-/i,'').replace(/[-_]+/g,' ').trim();
  return(clean||'默认模型').replace(/\\bsol\\b/i,'Sol').replace(/\\bcodex\\b/i,'Codex');
}
function composerEffortLabel(value){return({'':'默认',low:'低',medium:'中',high:'高',xhigh:'极高',max:'最高'})[String(value||'')]||String(value||'默认')}
function createTrailingSingleFlight(task){
  let active=null;
  let rerun=false;
  return function run(){
    if(active){rerun=true;return active}
    active=(async()=>{do{rerun=false;await task()}while(rerun)})().finally(()=>{active=null});
    return active;
  }
}
function readPromptQueues(){
  try{
    const parsed=JSON.parse(localStorage.getItem('codexWeb.promptQueue.v1')||'{}');
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return{};
    const queues={};
    for(const [threadId,items] of Object.entries(parsed)){
      if(!Array.isArray(items))continue;
      const clean=items.slice(0,50).map(normalizeQueuedPrompt).filter(Boolean);
      if(clean.length)queues[String(threadId)]=clean;
    }
    return queues;
  }catch{return{}}
}
function normalizeQueuedPrompt(item){
  if(!item||typeof item!=='object')return null;
  const message=String(item.message||'').trim();
  const attachments=Array.isArray(item.attachments)?item.attachments.slice(0,12).map((attachment)=>({
    kind:attachment?.kind==='image'?'image':'file',
    name:String(attachment?.name||'attachment').slice(0,160),
    type:String(attachment?.type||''),
    size:Number(attachment?.size||0),
    url:String(attachment?.url||''),
    filePath:String(attachment?.filePath||''),
  })).filter((attachment)=>attachment.filePath):[];
  if(!message&&!attachments.length)return null;
  return{
    id:String(item.id||makePromptQueueId()),
    message,
    attachments,
    provider:String(item.provider||''),
    model:String(item.model||''),
    reasoningEffort:String(item.reasoningEffort||''),
    cwd:String(item.cwd||''),
    sandbox:String(item.sandbox||'read-only'),
    approval:String(item.approval||'on-request'),
    createdAt:String(item.createdAt||new Date().toISOString()),
  };
}
function makePromptQueueId(){return window.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10)}
function persistPromptQueues(){try{localStorage.setItem(PROMPT_QUEUE_STORAGE_KEY,JSON.stringify(promptQueues))}catch(e){statusEl.textContent='队列已保留在当前页面，但浏览器无法持久化'}}
function promptQueueFor(threadId=currentConversationId){return Array.isArray(promptQueues[threadId])?promptQueues[threadId]:[]}
function setPromptQueue(threadId,items){
  if(!threadId)return;
  if(items.length)promptQueues[threadId]=items;else delete promptQueues[threadId];
  persistPromptQueues();
  if(currentConversationSource==='codex'&&currentConversationId===threadId)renderPromptQueue();
}
function createQueuedPrompt(message,attachments){return normalizeQueuedPrompt({
  id:makePromptQueueId(),message,attachments,provider:provider.value,model:model.value,
  reasoningEffort:reasoningEffort.value,cwd:cwd.value,sandbox:sandbox.value,
  approval:approval.value,createdAt:new Date().toISOString(),
})}
function queuedPromptPayload(item){return{
  message:item.message,attachments:item.attachments,provider:item.provider,model:item.model,
  reasoningEffort:item.reasoningEffort,cwd:item.cwd,sandbox:item.sandbox,approval:item.approval,
}}
function queuedPromptLabel(item){
  const text=String(item.message||'').replace(/\\s+/g,' ').trim();
  if(text)return text;
  const count=item.attachments?.length||0;
  return count+' 个附件';
}
function composerProjectPaths(){
  const paths=[];
  const seen=new Set();
  for(const value of [cwd.value,...historyItems.map((item)=>item.cwd)]){
    const path=normalizeProjectPath(value);
    const key=historyProjectKey(path);
    if(!path||seen.has(key))continue;
    seen.add(key);
    paths.push(path);
  }
  return paths;
}
function selectComposerProjectPath(value){
  const path=normalizeProjectPath(value);
  if(!path)return;
  cwd.value=path;
  syncComposerChrome();
  closeComposerPopovers();
  statusEl.textContent='新任务项目 · '+historyProjectName(path);
  input.focus();
}
function renderComposerProjectOptions(){
  if(!composerProjectOptions)return;
  composerProjectOptions.replaceChildren();
  const paths=composerProjectPaths();
  for(const path of paths){
    const button=document.createElement('button');
    button.type='button';
    button.className='composerProjectOption';
    button.classList.toggle('active',normalizeProjectPath(cwd.value)===path);
    button.setAttribute('aria-label','使用项目 '+historyProjectName(path));
    const icon=document.createElement('i');
    icon.setAttribute('data-lucide','folder');
    icon.setAttribute('aria-hidden','true');
    const text=document.createElement('span');
    const name=document.createElement('strong');
    name.textContent=historyProjectName(path);
    const detail=document.createElement('small');
    detail.textContent=path;
    text.appendChild(name);
    text.appendChild(detail);
    button.appendChild(icon);
    button.appendChild(text);
    button.addEventListener('click',()=>selectComposerProjectPath(path));
    composerProjectOptions.appendChild(button);
  }
  refreshIcons(composerProjectOptions);
}
function queueActionButton(icon,label,handler,showLabel=false){
  const button=document.createElement('button');
  button.type='button';
  button.className=showLabel?'promptQueueGuide':'promptQueueIconButton';
  button.title=label;
  button.setAttribute('aria-label',label);
  setIconLabel(button,icon,label,showLabel);
  button.addEventListener('click',handler);
  return button;
}
function renderPromptQueue(){
  if(!promptQueuePanel||!promptQueueList)return;
  const threadId=currentConversationSource==='codex'?currentConversationId:'';
  const items=threadId?promptQueueFor(threadId):[];
  promptQueuePanel.classList.toggle('hidden',!threadId||!items.length);
  promptQueueList.replaceChildren();
  if(!threadId||!items.length)return;
  const count=promptQueuePanel.querySelector('.promptQueueCount');
  if(count)count.textContent=String(items.length);
  items.forEach((item,index)=>{
    const row=document.createElement('div');
    const dispatching=index===0&&queueDispatchingThreads.has(threadId);
    const guiding=queueGuidingItems.has(item.id);
    row.className='promptQueueRow'+(dispatching||guiding?' sending':'')+(queueFailures.has(item.id)?' failed':'');
    row.dataset.queueId=item.id;
    const lead=document.createElement('i');
    lead.className='promptQueueLead';
    lead.setAttribute('data-lucide',dispatching||guiding?'loader-circle':'corner-down-right');
    lead.setAttribute('aria-hidden','true');
    const body=document.createElement('button');
    body.type='button';
    body.className='promptQueueBody';
    body.title='编辑队列消息';
    const label=document.createElement('span');
    label.className='promptQueueText';
    label.textContent=queuedPromptLabel(item);
    body.appendChild(label);
    if(item.attachments?.length){
      const meta=document.createElement('span');
      meta.className='promptQueueMeta';
      meta.textContent=item.attachments.length+' 个附件';
      body.appendChild(meta);
    }
    body.addEventListener('click',()=>restoreQueuedPrompt(threadId,item.id));
    const busy=dispatching||guiding||steerSubmitting;
    body.disabled=busy;
    const guide=queueActionButton(queueFailures.has(item.id)?'rotate-cw':'corner-down-left',queueFailures.has(item.id)?'重试':'引导',()=>{
      if(queueFailures.has(item.id))dispatchNextQueuedPrompt(threadId,{force:true});else steerQueuedPrompt(threadId,item.id);
    },true);
    guide.disabled=busy||(!webRunActive&&!queueFailures.has(item.id));
    const edit=queueActionButton('pencil','编辑',()=>restoreQueuedPrompt(threadId,item.id));
    edit.disabled=busy;
    const remove=queueActionButton('trash-2','删除',()=>deleteQueuedPrompt(threadId,item.id));
    remove.disabled=busy;
    row.appendChild(lead);
    row.appendChild(body);
    row.appendChild(guide);
    row.appendChild(edit);
    row.appendChild(remove);
    const error=queueFailures.get(item.id);
    if(error){
      const errorText=document.createElement('div');
      errorText.className='promptQueueError';
      errorText.textContent=error;
      row.appendChild(errorText);
    }
    promptQueueList.appendChild(row);
  });
  refreshIcons(promptQueuePanel);
}
function enqueuePrompt(message,attachments){
  if(currentConversationSource!=='codex'||!currentConversationId)return false;
  const item=createQueuedPrompt(message,attachments);
  if(!item)return false;
  const items=[...promptQueueFor(currentConversationId),item];
  setPromptQueue(currentConversationId,items);
  input.value='';
  input.style.height='auto';
  clearPendingAttachments();
  statusEl.textContent='已加入队列 · '+items.length+' 条待发送';
  applyConversationMode();
  input.focus();
  return true;
}
function deleteQueuedPrompt(threadId,itemId){
  const firstId=promptQueueFor(threadId)[0]?.id;
  queueFailures.delete(itemId);
  setPromptQueue(threadId,promptQueueFor(threadId).filter((item)=>item.id!==itemId));
  statusEl.textContent='已从队列移除';
  if(firstId===itemId&&!webRunActive)schedulePromptQueueDispatch(threadId,100);
}
async function restoreQueuedPrompt(threadId,itemId){
  if(currentConversationSource!=='codex'||currentConversationId!==threadId)return;
  const item=promptQueueFor(threadId).find((entry)=>entry.id===itemId);
  if(!item)return;
  if((input.value.trim()||pendingAttachments.length)&&!confirm('用队列消息替换当前输入内容？'))return;
  queueFailures.delete(itemId);
  setPromptQueue(threadId,promptQueueFor(threadId).filter((entry)=>entry.id!==itemId));
  input.value=item.message;
  input.style.height='auto';
  input.style.height=Math.min(input.scrollHeight,180)+'px';
  pendingAttachments=item.attachments.map((attachment)=>({...attachment}));
  if([...provider.options].some((option)=>option.value===item.provider))provider.value=item.provider;
  await loadModels(provider.value,item.model);
  if(['low','medium','high','xhigh','max',''].includes(item.reasoningEffort))reasoningEffort.value=item.reasoningEffort;
  if(['read-only','workspace-write','danger-full-access'].includes(item.sandbox))sandbox.value=item.sandbox;
  if(['never','on-request','untrusted'].includes(item.approval))approval.value=item.approval;
  if(item.cwd)cwd.value=item.cwd;
  renderAttachmentTray();
  updateSafetyHint();
  applyConversationMode();
  statusEl.textContent='队列消息已恢复，可修改后重新发送';
  input.focus();
}
function schedulePromptQueueDispatch(threadId,delay=120){
  if(!threadId||!promptQueueFor(threadId).length)return;
  setTimeout(()=>dispatchNextQueuedPrompt(threadId),delay);
}
function showNativePromptOptimistically(item){
  clearNativeOptimisticElements();
  nativeOptimisticElements.push(addMsg('user',item.message||'请分析上传的附件。'));
  for(const attachment of item.attachments||[]){
    if(attachment.kind==='image')nativeOptimisticElements.push(addMsg('image',attachment.url,{kind:'input_image'}));
    else nativeOptimisticElements.push(addMsg('log','已上传文件: '+(attachment.name||'attachment')+'\\n'+attachment.filePath));
  }
  nativeRunningElement=addMsg('assistant','');
  nativeRunningElement.innerHTML='<span class="spinner"></span> Codex 正在运行...';
}
function showNativeSteerOptimistically(item){
  if(currentConversationSource!=='codex')return null;
  if(!collectingTurnProcess)beginTurnProcessCollection(item.createdAt);
  const expected=String(item.message||'请分析上传的附件。').trim();
  const existing=[...turnProcessElements].reverse().find((element)=>(
    element?.classList?.contains('steeringUser')
    && String(element.dataset.messageText||'').trim()===expected
  ));
  if(existing)return existing;
  const element=addMsg('user',item.message||'请分析上传的附件。',{
    kind:'steering_user',
    at:new Date().toISOString(),
    optimisticQueueId:item.id,
  });
  if(!element)return null;
  nativeOptimisticSteering.set(item.id,element);
  for(const attachment of item.attachments||[]){
    if(attachment.kind==='image')appendInputImageToUser(element,attachment.url,element.dataset.messageAt);
  }
  return element;
}
async function steerQueuedPrompt(threadId,itemId){
  if(currentConversationSource!=='codex'||currentConversationId!==threadId)return;
  const item=promptQueueFor(threadId).find((entry)=>entry.id===itemId);
  if(!item)return;
  if(!webRunActive){schedulePromptQueueDispatch(threadId,0);return}
  queueGuidingItems.add(itemId);
  steerSubmitting=true;
  renderPromptQueue();
  applyConversationMode();
  statusEl.textContent='正在发送引导...';
  try{
    const res=await fetch('/api/native-sessions/'+encodeURIComponent(threadId)+'/steer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:item.message,attachments:item.attachments,turnId:activeNativeTurnId})});
    const data=await res.json();
    if(!res.ok)throw Object.assign(new Error(data.error||res.statusText),{status:res.status});
    activeNativeTurnId=data.turnId||activeNativeTurnId;
    queueFailures.delete(itemId);
    setPromptQueue(threadId,promptQueueFor(threadId).filter((entry)=>entry.id!==itemId));
    showNativeSteerOptimistically(item);
    statusEl.textContent='Codex App · 已发送引导';
    setTimeout(syncCurrentNativeConversation,180);
    refreshHistory();
  }catch(e){
    statusEl.textContent=e.status===409?'当前任务已结束，消息仍保留在队列':'引导失败: '+e.message;
    if(e.status===409){
      webRunActive=false;
      activeNativeTurnId='';
      schedulePromptQueueDispatch(threadId,160);
    }
  }finally{
    queueGuidingItems.delete(itemId);
    steerSubmitting=false;
    applyConversationMode();
    renderPromptQueue();
    input.focus();
  }
}
async function dispatchNextQueuedPrompt(threadId,{force=false}={}){
  const item=promptQueueFor(threadId)[0];
  if(!item||queueDispatchingThreads.has(threadId))return false;
  const current=currentConversationSource==='codex'&&currentConversationId===threadId;
  if(current&&(webRunActive||steerSubmitting))return false;
  if(queueFailures.has(item.id)&&!force)return false;
  queueFailures.delete(item.id);
  queueDispatchingThreads.add(threadId);
  if(current){
    statusEl.textContent='正在发送队列消息...';
    applyConversationMode();
    renderPromptQueue();
  }
  try{
    const res=await fetch('/api/native-sessions/'+encodeURIComponent(threadId)+'/turns',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(queuedPromptPayload(item))});
    const data=await res.json();
    if(!res.ok){
      if(res.status===409){
        if(currentConversationSource==='codex'&&currentConversationId===threadId){
          webRunActive=true;
          statusEl.textContent='Codex App · 运行中，队列将在完成后继续';
          applyConversationMode();
          setTimeout(syncCurrentNativeConversation,180);
        }
        return false;
      }
      throw new Error(data.error||res.statusText);
    }
    setPromptQueue(threadId,promptQueueFor(threadId).filter((entry)=>entry.id!==item.id));
    if(currentConversationSource==='codex'&&currentConversationId===threadId){
      showNativePromptOptimistically(item);
      activeNativeTurnId=data.turnId||'';
      webRunActive=true;
      statusEl.textContent='Codex App · 正在发送队列消息';
      applyConversationMode();
      setTimeout(syncCurrentNativeConversation,220);
    }
    refreshHistory();
    return true;
  }catch(e){
    queueFailures.set(item.id,e.message||'发送失败');
    if(currentConversationSource==='codex'&&currentConversationId===threadId){
      statusEl.textContent='队列发送失败，消息已保留';
    }
    return false;
  }finally{
    queueDispatchingThreads.delete(threadId);
    if(currentConversationSource==='codex'&&currentConversationId===threadId){
      applyConversationMode();
      renderPromptQueue();
    }
  }
}
function closeComposerPopovers(){
  for(const [panel,button] of [[composerProjectPanel,composerProjectToggle],[composerPermissionPanel,composerPermissionToggle],[composerModelPanel,composerModelToggle]]){
    panel?.classList.add('hidden');
    button?.setAttribute('aria-expanded','false');
  }
}
function toggleComposerPopover(panel,button){
  if(!panel||!button)return;
  const open=panel.classList.contains('hidden');
  closeComposerPopovers();
  if(!open)return;
  if(panel===composerProjectPanel)renderComposerProjectOptions();
  panel.classList.remove('hidden');
  button.setAttribute('aria-expanded','true');
  panel.querySelector('select,input')?.focus();
}
function syncComposerChrome(){
  syncComposerSelect(provider,composerProviderSelect);
  syncComposerSelect(model,composerModelSelect);
  syncComposerSelect(reasoningEffort,composerReasoningSelect);
  if(composerModelName)composerModelName.textContent=composerModelLabel(model.value);
  if(composerEffortName)composerEffortName.textContent=composerEffortLabel(reasoningEffort.value);
  const projectPath=normalizeProjectPath(cwd.value);
  if(composerProjectName)composerProjectName.textContent=historyProjectName(projectPath);
  if(composerProjectPathInput&&document.activeElement!==composerProjectPathInput)composerProjectPathInput.value=projectPath;
  if(composerProjectToggle){
    composerProjectToggle.title=projectPath+(currentConversationId?'\\n当前任务的项目路径不可更改':'');
    composerProjectToggle.setAttribute('aria-label','项目 '+historyProjectName(projectPath)+(currentConversationId?'，当前任务不可更改':'，点击选择'));
    composerProjectToggle.disabled=webRunActive||Boolean(currentConversationId);
  }
  composerModelToggle?.classList.toggle('running',webRunActive);
  if(composerModelToggle)composerModelToggle.disabled=webRunActive;
  for(const control of [composerProviderSelect,composerModelSelect,composerReasoningSelect])if(control)control.disabled=webRunActive;
  const mode=sandbox.value;
  if(composerPermissionToggle){
    const label=mode==='read-only'?'只读权限':mode==='workspace-write'?'工作区写入':'高危全权限';
    const icon=mode==='read-only'?'shield-check':mode==='workspace-write'?'shield-alert':'shield-off';
    setIconLabel(composerPermissionToggle,icon,label,false);
    composerPermissionToggle.dataset.mode=mode;
    composerPermissionToggle.title=label;
    composerPermissionToggle.setAttribute('aria-label',label);
    composerPermissionToggle.disabled=webRunActive;
  }
}
function enhanceComposer(){
  if(!dropZone||!attachFile||!sendBtn)return;
  const composer=dropZone.parentElement;
  composerProjectPicker=document.createElement('div');
  composerProjectPicker.className='composerProjectPicker';
  composerProjectToggle=document.createElement('button');
  composerProjectToggle.type='button';
  composerProjectToggle.className='composerProjectToggle';
  composerProjectToggle.setAttribute('aria-expanded','false');
  composerProjectToggle.setAttribute('aria-controls','composerProjectPanel');
  const projectIcon=document.createElement('i');
  projectIcon.setAttribute('data-lucide','folder');
  projectIcon.setAttribute('aria-hidden','true');
  composerProjectName=document.createElement('span');
  composerProjectName.className='composerProjectName';
  const projectChevron=document.createElement('i');
  projectChevron.className='composerProjectChevron';
  projectChevron.setAttribute('data-lucide','chevron-down');
  projectChevron.setAttribute('aria-hidden','true');
  composerProjectToggle.appendChild(projectIcon);
  composerProjectToggle.appendChild(composerProjectName);
  composerProjectToggle.appendChild(projectChevron);
  composerProjectPanel=document.createElement('div');
  composerProjectPanel.id='composerProjectPanel';
  composerProjectPanel.className='composerProjectPanel hidden';
  const projectTitle=document.createElement('div');
  projectTitle.className='composerPopoverTitle';
  projectTitle.textContent='选择项目路径';
  composerProjectOptions=document.createElement('div');
  composerProjectOptions.className='composerProjectOptions';
  const customProject=document.createElement('div');
  customProject.className='composerProjectCustom';
  composerProjectPathInput=document.createElement('input');
  composerProjectPathInput.type='text';
  composerProjectPathInput.placeholder='/path/to/project';
  composerProjectPathInput.setAttribute('aria-label','自定义项目路径');
  const useProjectPath=document.createElement('button');
  useProjectPath.type='button';
  useProjectPath.className='composerProjectApply';
  useProjectPath.textContent='使用';
  const applyProjectPath=()=>selectComposerProjectPath(composerProjectPathInput.value);
  useProjectPath.addEventListener('click',applyProjectPath);
  composerProjectPathInput.addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();applyProjectPath()}});
  customProject.appendChild(composerProjectPathInput);
  customProject.appendChild(useProjectPath);
  composerProjectPanel.appendChild(projectTitle);
  composerProjectPanel.appendChild(composerProjectOptions);
  composerProjectPanel.appendChild(customProject);
  composerProjectPicker.appendChild(composerProjectToggle);
  composerProjectPicker.appendChild(composerProjectPanel);
  composer.insertBefore(composerProjectPicker,composer.firstChild);
  if(attachmentTray&&composer&&attachmentTray.parentElement===composer)composer.insertBefore(attachmentTray,dropZone);
  promptQueuePanel=document.createElement('section');
  promptQueuePanel.className='promptQueue hidden';
  promptQueuePanel.setAttribute('aria-label','待发送消息');
  promptQueuePanel.setAttribute('aria-live','polite');
  const queueHead=document.createElement('div');
  queueHead.className='promptQueueHead';
  const queueTitle=document.createElement('span');
  queueTitle.textContent='队列';
  const queueCount=document.createElement('span');
  queueCount.className='promptQueueCount';
  queueHead.appendChild(queueTitle);
  queueHead.appendChild(queueCount);
  promptQueueList=document.createElement('div');
  promptQueueList.className='promptQueueList';
  promptQueuePanel.appendChild(queueHead);
  promptQueuePanel.appendChild(promptQueueList);
  composer.insertBefore(promptQueuePanel,attachmentTray||dropZone);
  setIconLabel(attachFile,'plus','上传附件',false);
  setIconLabel(sendBtn,'arrow-up','发送',false);
  setIconLabel(cancelBtn,'square','停止',false);
  cancelBtn?.classList.add('cancelButton');
  composerPermissionToggle=document.createElement('button');
  composerPermissionToggle.type='button';
  composerPermissionToggle.className='composerPermissionToggle';
  composerPermissionToggle.setAttribute('aria-expanded','false');
  composerPermissionToggle.setAttribute('aria-controls','composerPermissionPanel');
  attachFile.after(composerPermissionToggle);
  composerModelToggle=document.createElement('button');
  composerModelToggle.type='button';
  composerModelToggle.className='composerModelToggle';
  composerModelToggle.setAttribute('aria-expanded','false');
  composerModelToggle.setAttribute('aria-controls','composerModelPanel');
  composerModelState=document.createElement('span');
  composerModelState.className='composerModelState';
  composerModelState.setAttribute('aria-hidden','true');
  composerModelName=document.createElement('span');
  composerModelName.className='composerModelName';
  composerEffortName=document.createElement('span');
  composerEffortName.className='composerEffortName';
  const modelChevron=document.createElement('i');
  modelChevron.setAttribute('data-lucide','chevron-down');
  modelChevron.setAttribute('aria-hidden','true');
  composerModelToggle.appendChild(composerModelState);
  composerModelToggle.appendChild(composerModelName);
  composerModelToggle.appendChild(composerEffortName);
  composerModelToggle.appendChild(modelChevron);
  dropZone.insertBefore(composerModelToggle,sendBtn);
  composerPermissionPanel=document.querySelector('.composerControls');
  if(composerPermissionPanel){
    composerPermissionPanel.id='composerPermissionPanel';
    composerPermissionPanel.classList.add('composerPopover','composerPermissionPanel','hidden');
    const title=document.createElement('div');
    title.className='composerPopoverTitle';
    title.textContent='运行权限';
    composerPermissionPanel.prepend(title);
    dropZone.appendChild(composerPermissionPanel);
  }
  composerModelPanel=document.createElement('div');
  composerModelPanel.id='composerModelPanel';
  composerModelPanel.className='composerPopover composerModelPanel hidden';
  const modelTitle=document.createElement('div');
  modelTitle.className='composerPopoverTitle';
  modelTitle.textContent='模型与思考';
  composerModelPanel.appendChild(modelTitle);
  composerProviderSelect=createComposerMirrorField(composerModelPanel,'服务商','服务商');
  composerModelSelect=createComposerMirrorField(composerModelPanel,'模型','模型');
  composerReasoningSelect=createComposerMirrorField(composerModelPanel,'思考档位','思考档位');
  dropZone.appendChild(composerModelPanel);
  composerProjectToggle.addEventListener('click',()=>toggleComposerPopover(composerProjectPanel,composerProjectToggle));
  composerPermissionToggle.addEventListener('click',()=>toggleComposerPopover(composerPermissionPanel,composerPermissionToggle));
  composerModelToggle.addEventListener('click',()=>toggleComposerPopover(composerModelPanel,composerModelToggle));
  composerProviderSelect.addEventListener('change',async()=>{provider.value=composerProviderSelect.value;await loadModels(provider.value);syncComposerChrome()});
  composerModelSelect.addEventListener('change',()=>{model.value=composerModelSelect.value;syncComposerChrome()});
  composerReasoningSelect.addEventListener('change',()=>{reasoningEffort.value=composerReasoningSelect.value;syncComposerChrome()});
  input.addEventListener('focus',closeComposerPopovers);
  document.addEventListener('click',(event)=>{if(!dropZone.contains(event.target)&&!composerProjectPicker.contains(event.target))closeComposerPopovers()});
  syncComposerChrome();
  refreshIcons(dropZone);
}
function settingsSectionTitle(text){
  const title=document.createElement('div');
  title.className='settingsSectionTitle';
  title.textContent=text;
  return title;
}
function createDreamSkinGenerator(general){
  const backgroundControls=general?.querySelector('.backgroundControls');
  if(!backgroundControls||dreamSkinPanel)return;
  dreamSkinPanel=document.createElement('section');
  dreamSkinPanel.className='dreamSkinGenerator hidden';
  dreamSkinPanel.setAttribute('aria-label','Dream Skin 背景生成');
  const head=document.createElement('div');
  head.className='dreamSkinGeneratorHead';
  const identity=document.createElement('div');
  identity.className='dreamSkinIdentity';
  const icon=document.createElement('i');
  icon.setAttribute('data-lucide','sparkles');
  icon.setAttribute('aria-hidden','true');
  const title=document.createElement('span');
  title.textContent='Dream Skin';
  identity.appendChild(icon);
  identity.appendChild(title);
  const close=document.createElement('button');
  close.type='button';
  close.className='dreamSkinClose';
  close.title='关闭背景生成';
  close.setAttribute('aria-label','关闭背景生成');
  setIconLabel(close,'x','关闭背景生成',false);
  close.addEventListener('click',closeDreamSkinGenerator);
  head.appendChild(identity);
  head.appendChild(close);
  const ideaField=document.createElement('label');
  ideaField.className='field dreamSkinIdeaField';
  const ideaLabel=document.createElement('span');
  ideaLabel.textContent='背景需求';
  dreamSkinIdea=document.createElement('textarea');
  dreamSkinIdea.rows=3;
  dreamSkinIdea.maxLength=2000;
  dreamSkinIdea.placeholder='例如：雨夜东京工作室，青绿色霓虹，右侧有窗景，左侧安静留白';
  ideaField.appendChild(ideaLabel);
  ideaField.appendChild(dreamSkinIdea);
  const options=document.createElement('div');
  options.className='dreamSkinOptions';
  const modeField=document.createElement('label');
  modeField.className='field';
  const modeLabel=document.createElement('span');
  modeLabel.textContent='生成模式';
  dreamSkinMode=document.createElement('select');
  [['no-person','无人物'],['fictional-adult','原创人物'],['reference','参考图重绘']].forEach(([value,label])=>{
    const option=document.createElement('option');
    option.value=value;
    option.textContent=label;
    dreamSkinMode.appendChild(option);
  });
  modeField.appendChild(modeLabel);
  modeField.appendChild(dreamSkinMode);
  const referenceField=document.createElement('div');
  referenceField.className='field dreamSkinReferenceField';
  const referenceLabel=document.createElement('span');
  referenceLabel.textContent='参考图';
  const referenceButton=document.createElement('button');
  referenceButton.type='button';
  referenceButton.className='miniSecondary dreamSkinReferenceButton';
  setIconLabel(referenceButton,'image-plus','添加参考图');
  dreamSkinReferenceInput=document.createElement('input');
  dreamSkinReferenceInput.type='file';
  dreamSkinReferenceInput.accept='image/png,image/jpeg,image/webp,image/gif';
  dreamSkinReferenceInput.multiple=true;
  dreamSkinReferenceInput.className='hidden';
  referenceButton.addEventListener('click',()=>dreamSkinReferenceInput.click());
  dreamSkinReferenceInput.addEventListener('change',()=>{
    const candidates=[...(dreamSkinReferenceInput.files||[])].filter((file)=>file.type.startsWith('image/'));
    dreamSkinReferenceFiles=[...dreamSkinReferenceFiles,...candidates].slice(0,3);
    dreamSkinReferenceInput.value='';
    renderDreamSkinReferences();
  });
  referenceField.appendChild(referenceLabel);
  referenceField.appendChild(referenceButton);
  referenceField.appendChild(dreamSkinReferenceInput);
  options.appendChild(modeField);
  options.appendChild(referenceField);
  dreamSkinReferenceList=document.createElement('div');
  dreamSkinReferenceList.className='dreamSkinReferenceList hidden';
  const guide=document.createElement('details');
  guide.className='dreamSkinGuide';
  const guideSummary=document.createElement('summary');
  const guideIcon=document.createElement('i');
  guideIcon.setAttribute('data-lucide','book-open');
  guideIcon.setAttribute('aria-hidden','true');
  const guideLabel=document.createElement('span');
  guideLabel.textContent='背景生成规范';
  guideSummary.appendChild(guideIcon);
  guideSummary.appendChild(guideLabel);
  const guideBody=document.createElement('div');
  guideBody.className='dreamSkinGuideBody';
  const guideList=document.createElement('ul');
  ['2560 x 1440、16:9 纯背景','左侧低信息，主体和细节集中在右侧','不生成窗口、控件、文字、Logo 或水印'].forEach((text)=>{
    const item=document.createElement('li');
    item.textContent=text;
    guideList.appendChild(item);
  });
  const guideLink=document.createElement('a');
  guideLink.href='/assets/dream-skin/SKILL.md';
  guideLink.target='_blank';
  guideLink.rel='noopener noreferrer';
  guideLink.textContent='查看完整 Markdown skill';
  guideBody.appendChild(guideList);
  guideBody.appendChild(guideLink);
  guide.appendChild(guideSummary);
  guide.appendChild(guideBody);
  const actions=document.createElement('div');
  actions.className='dreamSkinActions';
  dreamSkinStatus=document.createElement('div');
  dreamSkinStatus.className='dreamSkinStatus';
  dreamSkinStatus.setAttribute('role','status');
  dreamSkinGenerateButton=document.createElement('button');
  dreamSkinGenerateButton.type='button';
  dreamSkinGenerateButton.className='miniPrimary dreamSkinGenerate';
  setIconLabel(dreamSkinGenerateButton,'sparkles','一键生成背景');
  dreamSkinGenerateButton.addEventListener('click',generateDreamSkinBackground);
  actions.appendChild(dreamSkinStatus);
  actions.appendChild(dreamSkinGenerateButton);
  dreamSkinPanel.appendChild(head);
  dreamSkinPanel.appendChild(ideaField);
  dreamSkinPanel.appendChild(options);
  dreamSkinPanel.appendChild(dreamSkinReferenceList);
  dreamSkinPanel.appendChild(guide);
  dreamSkinPanel.appendChild(actions);
  backgroundControls.insertAdjacentElement('afterend',dreamSkinPanel);
  refreshIcons(dreamSkinPanel);
}
function enhanceSettingsModal(){
  if(!settingsPanel||settingsOverlay)return;
  settingsOverlay=document.createElement('div');
  settingsOverlay.id='settingsOverlay';
  settingsOverlay.className='settingsOverlay hidden';
  settingsOverlay.setAttribute('role','presentation');
  settingsDialog=document.createElement('section');
  settingsDialog.id='settingsDialog';
  settingsDialog.className='settingsDialog';
  settingsDialog.setAttribute('role','dialog');
  settingsDialog.setAttribute('aria-modal','true');
  settingsDialog.setAttribute('aria-labelledby','settingsDialogTitle');
  const head=document.createElement('header');
  head.className='settingsDialogHead';
  const title=document.createElement('h2');
  title.id='settingsDialogTitle';
  title.textContent='设置';
  settingsClose=document.createElement('button');
  settingsClose.type='button';
  settingsClose.className='settingsDialogClose';
  settingsClose.title='关闭设置';
  settingsClose.setAttribute('aria-label','关闭设置');
  setIconLabel(settingsClose,'x','关闭设置',false);
  head.appendChild(title);
  head.appendChild(settingsClose);
  const body=document.createElement('div');
  body.className='settingsDialogBody';
  const general=settingsPanel.querySelector('.settings');
  if(general){
    general.classList.add('settingsSection');
    general.prepend(settingsSectionTitle('默认配置'));
  }
  providerManager?.classList.add('settingsSection','providerSettings');
  const passwordSection=document.createElement('section');
  passwordSection.className='settingsSection passwordSettings';
  passwordSection.appendChild(settingsSectionTitle('Web 密码'));
  passwordForm=document.createElement('form');
  passwordForm.id='passwordForm';
  passwordForm.className='passwordForm';
  const passwordFields=[
    ['currentPassword','当前密码','current-password'],
    ['newPassword','新密码','new-password'],
    ['confirmPassword','确认新密码','new-password'],
  ];
  for(const [id,labelText,autocomplete] of passwordFields){
    const field=document.createElement('label');
    field.className='field';
    const label=document.createElement('span');
    label.textContent=labelText;
    const control=document.createElement('input');
    control.id=id;
    control.name=id;
    control.type='password';
    control.required=true;
    control.autocomplete=autocomplete;
    if(id!=='currentPassword'){control.minLength=8;control.maxLength=256}
    field.appendChild(label);
    field.appendChild(control);
    passwordForm.appendChild(field);
  }
  const savePassword=document.createElement('button');
  savePassword.type='submit';
  savePassword.className='miniPrimary passwordSubmit';
  setIconLabel(savePassword,'key-round','更新密码');
  passwordStatus=document.createElement('div');
  passwordStatus.className='errorText passwordStatus';
  passwordStatus.setAttribute('role','status');
  passwordForm.appendChild(savePassword);
  passwordForm.appendChild(passwordStatus);
  passwordSection.appendChild(passwordForm);
  settingsPanel.classList.remove('open');
  settingsPanel.appendChild(passwordSection);
  body.appendChild(settingsPanel);
  settingsDialog.appendChild(head);
  settingsDialog.appendChild(body);
  settingsOverlay.appendChild(settingsDialog);
  document.body.appendChild(settingsOverlay);
  settingsToggle.setAttribute('aria-controls','settingsDialog');
  settingsClose.addEventListener('click',closeSettings);
  settingsOverlay.addEventListener('click',(event)=>{if(event.target===settingsOverlay)closeSettings()});
  settingsDialog.addEventListener('keydown',trapSettingsFocus);
  passwordForm.addEventListener('submit',submitPasswordChange);
}
function openSettings(){
  if(!settingsOverlay)return;
  closeComposerPopovers();
  settingsOverlay.classList.remove('hidden');
  syncModalOpenState();
  settingsToggle.setAttribute('aria-expanded','true');
  settingsToggle.title='关闭设置';
  requestAnimationFrame(()=>settingsClose?.focus());
}
function closeSettings(){
  if(!settingsOverlay||settingsOverlay.classList.contains('hidden'))return;
  settingsOverlay.classList.add('hidden');
  syncModalOpenState();
  settingsToggle.setAttribute('aria-expanded','false');
  settingsToggle.title='设置';
  passwordForm?.reset();
  if(passwordStatus){passwordStatus.textContent='';passwordStatus.classList.remove('success')}
  settingsToggle.focus();
}
function syncModalOpenState(){
  const settingsOpen=settingsOverlay&&!settingsOverlay.classList.contains('hidden');
  const previewOpen=imagePreview&&!imagePreview.classList.contains('hidden');
  document.body.classList.toggle('modalOpen',Boolean(settingsOpen||previewOpen));
}
function ensureImagePreview(){
  if(imagePreview)return;
  imagePreview=document.createElement('div');
  imagePreview.className='imagePreview hidden';
  imagePreview.setAttribute('role','presentation');
  const dialog=document.createElement('div');
  dialog.className='imagePreviewDialog';
  dialog.setAttribute('role','dialog');
  dialog.setAttribute('aria-modal','true');
  dialog.setAttribute('aria-label','图片预览');
  imagePreviewImage=document.createElement('img');
  imagePreviewImage.className='imagePreviewImage';
  imagePreviewClose=document.createElement('button');
  imagePreviewClose.type='button';
  imagePreviewClose.className='imagePreviewClose';
  imagePreviewClose.title='关闭图片预览';
  imagePreviewClose.setAttribute('aria-label','关闭图片预览');
  setIconLabel(imagePreviewClose,'x','关闭图片预览',false);
  dialog.appendChild(imagePreviewImage);
  dialog.appendChild(imagePreviewClose);
  imagePreview.appendChild(dialog);
  document.body.appendChild(imagePreview);
  imagePreviewClose.addEventListener('click',closeImagePreview);
  imagePreview.addEventListener('click',(event)=>{if(event.target===imagePreview||event.target===dialog)closeImagePreview()});
  refreshIcons(imagePreview);
}
function openImagePreview(src,alt,trigger){
  ensureImagePreview();
  imagePreviewReturnFocus=trigger||document.activeElement;
  imagePreviewImage.src=String(src||'');
  imagePreviewImage.alt=String(alt||'图片预览');
  imagePreview.classList.remove('hidden');
  syncModalOpenState();
  requestAnimationFrame(()=>imagePreviewClose?.focus());
}
function closeImagePreview(){
  if(!imagePreview||imagePreview.classList.contains('hidden'))return;
  imagePreview.classList.add('hidden');
  imagePreviewImage.removeAttribute('src');
  syncModalOpenState();
  if(imagePreviewReturnFocus?.isConnected)imagePreviewReturnFocus.focus();
  imagePreviewReturnFocus=null;
}
function trapSettingsFocus(event){
  if(event.key!=='Tab'||!settingsDialog)return;
  const focusable=[...settingsDialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[href]')].filter((item)=>item.offsetParent!==null);
  if(!focusable.length)return;
  const first=focusable[0];
  const last=focusable[focusable.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
}
async function submitPasswordChange(event){
  event.preventDefault();
  const currentPassword=document.getElementById('currentPassword').value;
  const newPassword=document.getElementById('newPassword').value;
  const confirmPassword=document.getElementById('confirmPassword').value;
  if(newPassword!==confirmPassword){passwordStatus.textContent='两次输入的新密码不一致';passwordStatus.classList.remove('success');return}
  const submit=passwordForm.querySelector('button[type="submit"]');
  submit.disabled=true;
  passwordStatus.textContent='正在更新...';
  passwordStatus.classList.remove('success');
  try{
    const res=await fetch('/api/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword,newPassword,confirmPassword})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||'密码更新失败');
    passwordForm.reset();
    passwordStatus.textContent='密码已更新，其他设备已退出登录';
    passwordStatus.classList.add('success');
  }catch(e){
    passwordStatus.textContent=e.message;
  }finally{
    submit.disabled=false;
  }
}
function enhanceInterface(){
  const sideBrand=document.querySelector('.side > div:first-child');
  sideBrand?.classList.add('sideBrand');
  const logo=document.querySelector('.logo');
  if(logo){
    const label=logo.textContent;
    logo.replaceChildren();
    const mark=document.createElement('span');
    mark.className='logoMark';
    const icon=document.createElement('i');
    icon.setAttribute('data-lucide','square-terminal');
    icon.setAttribute('aria-hidden','true');
    const copy=document.createElement('span');
    copy.className='logoCopy';
    copy.textContent=label;
    mark.appendChild(icon);
    logo.appendChild(mark);
    logo.appendChild(copy);
  }
  const protectedPill=document.querySelector('.pill');
  setIconLabel(protectedPill,'shield-check','Protected');
  const sideActions=document.querySelector('.sideActions');
  if(sideActions&&settingsToggle)sideActions.appendChild(settingsToggle);
  enhanceSettingsModal();
  setIconLabel(document.getElementById('newChat'),'plus','新建任务');
  setIconLabel(settingsToggle,'settings','设置',false);
  settingsToggle?.setAttribute('title','设置');
  settingsToggle?.setAttribute('aria-expanded','false');
  setIconLabel(document.getElementById('refreshProviderModels'),'refresh-cw','更新模型');
  setIconLabel(document.getElementById('saveDefault'),'save','保存默认');
  setIconLabel(document.getElementById('deleteProvider'),'trash-2','删除服务商');
  setIconLabel(document.getElementById('fetchNewModels'),'refresh-cw','获取模型');
  setIconLabel(providerForm?.querySelector('.miniPrimary'),'check','保存并设为默认');
  setIconLabel(deleteBackground,'trash-2','删除背景',false);
  deleteBackground?.setAttribute('title','删除背景');
  setIconLabel(document.getElementById('logout'),'log-out','退出登录');
  menuBtn?.setAttribute('aria-controls','sidePanel');
  enhanceComposer();
  setIconLabel(loginForm?.querySelector('.primary'),'log-in','登录');
  if(titleEl)titleEl.textContent='新任务';
  statusEl?.classList.add('topStatus');
  const historyTitle=history?.previousElementSibling;
  if(historyTitle){
    historyTitle.className='historyTitle';
    historyTitle.textContent='最近任务';
    const count=document.createElement('span');
    count.id='historyTitleCount';
    count.className='historyTitleCount';
    historyTitle.appendChild(count);
    const search=document.createElement('label');
    search.className='historySearch';
    search.setAttribute('aria-label','搜索任务');
    const searchIcon=document.createElement('i');
    searchIcon.setAttribute('data-lucide','search');
    searchIcon.setAttribute('aria-hidden','true');
    historyFilter=document.createElement('input');
    historyFilter.type='search';
    historyFilter.placeholder='搜索任务或路径';
    historyFilter.autocomplete='off';
    historyFilter.addEventListener('input',()=>renderHistory());
    search.appendChild(searchIcon);
    search.appendChild(historyFilter);
    historyTitle.after(search);
  }
  const empty=document.querySelector('.empty');
  if(empty){
    const heading=empty.querySelector('b');
    const detail=empty.querySelector('span');
    if(heading)heading.textContent='新任务';
    if(detail)detail.textContent='等待输入';
  }
  refreshIcons(document);
}
enhanceInterface();
restoreSidebarState();
applyAppearance();
loginForm?.addEventListener('submit', async (e)=>{e.preventDefault();loginError.textContent='';const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('password').value})});if(res.ok){login.classList.add('hidden');app.classList.remove('hidden');await boot(true);input.focus()}else{loginError.textContent=(await res.json()).error||'登录失败'}});
document.getElementById('logout')?.addEventListener('click', async()=>{await fetch('/api/logout',{method:'POST'});location.reload()});
document.getElementById('newChat')?.addEventListener('click', newChat);
document.getElementById('refreshProviderModels')?.addEventListener('click', refreshProviderModels);
document.getElementById('saveDefault')?.addEventListener('click', saveDefaultModel);
document.getElementById('deleteProvider')?.addEventListener('click', deleteSelectedProvider);
settingsToggle?.addEventListener('click', toggleSettings);
menuBtn?.addEventListener('click', toggleMenu);
document.getElementById('scrim')?.addEventListener('click', closeMenu);
document.addEventListener('click',()=>closeHistoryProjectMenu());
desktopSidebarMedia.addEventListener?.('change',()=>{app.classList.remove('menuOpen');syncMenuButton()});
document.addEventListener('keydown',(event)=>{if(event.key!=='Escape')return;if(activeHistoryProjectMenu){closeHistoryProjectMenu(true);return}if(imagePreview&&!imagePreview.classList.contains('hidden')){closeImagePreview();return}if(settingsOverlay&&!settingsOverlay.classList.contains('hidden')){closeSettings();return}closeComposerPopovers();if(app.classList.contains('menuOpen'))closeMenu()});
providerForm?.addEventListener('submit', async(e)=>{e.preventDefault();providerMsg.textContent='保存中...';const payload={name:document.getElementById('newProviderName').value,baseUrl:document.getElementById('newProviderUrl').value,apiKey:document.getElementById('newProviderKey').value,model:newProviderModel.value,wireApi:document.getElementById('newProviderWire').value};const res=await fetch('/api/providers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await res.json();if(!res.ok){providerMsg.textContent=data.error||'保存失败';return}providerMsg.textContent='已保存';document.getElementById('newProviderKey').value='';await boot();provider.value=data.provider;await loadModels(data.provider,data.model);});
document.getElementById('fetchNewModels')?.addEventListener('click', async()=>{providerMsg.textContent='获取模型中...';const data=await requestModels({baseUrl:document.getElementById('newProviderUrl').value,apiKey:document.getElementById('newProviderKey').value});if(data.error){providerMsg.textContent=data.error;return}fillSelect(newProviderModel,data.models,data.models[0]||'');providerMsg.textContent=data.models.length?'已获取 '+data.models.length+' 个模型':'没有返回模型';});
provider?.addEventListener('change',async()=>{await loadModels(provider.value);syncComposerChrome()});
model?.addEventListener('change',syncComposerChrome);
reasoningEffort?.addEventListener('change',syncComposerChrome);
sandbox?.addEventListener('change',()=>{dangerConfirmed=false;updateSafetyHint();syncComposerChrome()});
approval?.addEventListener('change',syncComposerChrome);
themeToggle?.addEventListener('click',toggleTheme);
chatBackground?.addEventListener('change',handleChatBackgroundChange);
chatBackgroundFile?.addEventListener('change',()=>handleCustomBackground(chatBackgroundFile.files?.[0]));
deleteBackground?.addEventListener('click',deleteSelectedBackground);
sendBtn?.addEventListener('click', send);input?.addEventListener('keydown',(e)=>{if(e.key!=='Enter'||e.shiftKey||e.isComposing||e.keyCode===229)return;e.preventDefault();if(!e.repeat)send()});input?.addEventListener('input',()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,180)+'px';applyConversationMode()});
attachFile?.addEventListener('click',()=>fileInput?.click());
fileInput?.addEventListener('change',()=>{handleAttachmentFiles(fileInput.files);fileInput.value=''});
dropZone?.addEventListener('dragover',(e)=>{if(hasFileDrag(e)){e.preventDefault();dropZone.classList.add('drag')}});
dropZone?.addEventListener('dragleave',()=>dropZone.classList.remove('drag'));
dropZone?.addEventListener('drop',(e)=>{dropZone.classList.remove('drag');const files=[...(e.dataTransfer?.files||[])];if(!files.length)return;e.preventDefault();handleAttachmentFiles(files)});
dropZone?.addEventListener('paste',handleAttachmentPaste);
input?.addEventListener('paste',handleAttachmentPaste);
cancelBtn?.addEventListener('click', cancelRun);
nativeRequestForm?.addEventListener('submit',(e)=>e.preventDefault());
document.addEventListener('visibilitychange',syncNativeAfterPageResume);
window.addEventListener('pageshow',syncNativeAfterPageResume);
window.addEventListener('online',syncNativeAfterPageResume);
if (${authenticated ? 'true' : 'false'}) boot(true);
async function toggleTheme(){const next=appearance.theme==='dark'?'light':'dark';await saveAppearance({theme:next})}
function applyAppearance(){const theme=appearance.theme==='dark'?'dark':'light';const selected=cleanBackgroundValue(appearance.chatBackground);const custom=selected.startsWith('bg:')?findCustomBackground(selected):null;const bg=custom?'custom':selected;document.body.dataset.theme=theme;document.body.dataset.chatBg=bg;document.body.style.setProperty('--custom-chat-bg',custom?'url("'+custom.url+'")':'none');if(themeToggle){setIconLabel(themeToggle,theme==='dark'?'sun':'moon','',false);themeToggle.title=theme==='dark'?'切换明亮模式':'切换黑暗模式';themeToggle.setAttribute('aria-label',themeToggle.title)}renderBackgroundOptions(selected);updateDeleteBackgroundButton(selected)}
async function saveAppearance(patch){const res=await fetch('/api/appearance',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});const data=await res.json();if(!res.ok){statusEl.textContent=data.error||'外观保存失败';applyAppearance();return null}appearance=data.appearance;applyAppearance();return appearance}
function renderBackgroundOptions(selected){if(!chatBackground)return;const options=[['default','默认'],['dream-skin','Dream Skin']];for(const item of appearance.customBackgrounds||[])options.push([item.value,item.name]);options.push(['custom','自定义']);chatBackground.innerHTML='';for(const [value,label] of options){const opt=document.createElement('option');opt.value=value;opt.textContent=label;chatBackground.appendChild(opt)}chatBackground.value=options.some(([value])=>value===selected)?selected:'default'}
function cleanBackgroundValue(value){const text=String(value||'');if(text==='default')return text;return findCustomBackground(text)?text:'default'}
function findCustomBackground(value){return (appearance.customBackgrounds||[]).find((item)=>item.value===value&&item.url)}
function updateDeleteBackgroundButton(selected){if(!deleteBackground)return;deleteBackground.classList.toggle('hidden',!findCustomBackground(selected));deleteBackground.disabled=!findCustomBackground(selected)}
function openDreamSkinGenerator(){if(!dreamSkinPanel)return;dreamSkinPanel.classList.remove('hidden');renderDreamSkinReferences();chatBackground.value='dream-skin';requestAnimationFrame(()=>{dreamSkinPanel.scrollIntoView({block:'nearest'});dreamSkinIdea?.focus()})}
function closeDreamSkinGenerator(){dreamSkinPanel?.classList.add('hidden');if(chatBackground)chatBackground.value=cleanBackgroundValue(appearance.chatBackground)}
function renderDreamSkinReferences(){if(!dreamSkinReferenceList)return;dreamSkinReferenceList.replaceChildren();dreamSkinReferenceList.classList.toggle('hidden',!dreamSkinReferenceFiles.length);dreamSkinReferenceFiles.forEach((file,index)=>{const chip=document.createElement('div');chip.className='dreamSkinReferenceChip';const image=document.createElement('img');image.alt='参考图 '+(index+1);const url=URL.createObjectURL(file);image.src=url;image.addEventListener('load',()=>URL.revokeObjectURL(url),{once:true});const name=document.createElement('span');name.textContent=file.name;name.title=file.name;const remove=document.createElement('button');remove.type='button';remove.title='移除参考图';remove.setAttribute('aria-label','移除参考图 '+(index+1));setIconLabel(remove,'x','移除参考图',false);remove.addEventListener('click',()=>{dreamSkinReferenceFiles.splice(index,1);renderDreamSkinReferences()});chip.appendChild(image);chip.appendChild(name);chip.appendChild(remove);dreamSkinReferenceList.appendChild(chip)});refreshIcons(dreamSkinReferenceList)}
async function uploadDreamSkinReference(file){const data=await readFileDataUrl(file);const res=await fetch('/api/uploads/file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name,type:file.type,data})});const body=await res.json();if(!res.ok)throw new Error(body.error||'参考图上传失败');return body.attachment}
async function generateDreamSkinBackground(){if(!dreamSkinGenerateButton||dreamSkinGenerateButton.disabled)return;const mode=dreamSkinMode?.value||'no-person';if(mode==='reference'&&!dreamSkinReferenceFiles.length){dreamSkinStatus.textContent='参考图模式至少需要添加 1 张图片';dreamSkinReferenceInput?.focus();return}dreamSkinGenerateButton.disabled=true;dreamSkinStatus.textContent='准备生成任务...';try{const attachments=[];for(let index=0;index<dreamSkinReferenceFiles.length;index++){dreamSkinStatus.textContent='上传参考图 '+(index+1)+' / '+dreamSkinReferenceFiles.length;attachments.push(await uploadDreamSkinReference(dreamSkinReferenceFiles[index]))}const res=await fetch('/api/dream-skin/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({description:dreamSkinIdea?.value||'',mode,referenceCount:attachments.length})});const body=await res.json();if(!res.ok)throw new Error(body.error||'生成任务创建失败');dreamSkinStatus.textContent='正在启动 Codex App...';closeSettings();newChat();cwd.value=body.cwd||cwd.value;syncComposerChrome();input.value=body.prompt;input.style.height='auto';input.style.height=Math.min(input.scrollHeight,180)+'px';pendingAttachments=attachments;renderAttachmentTray();dreamSkinReferenceFiles=[];if(dreamSkinIdea)dreamSkinIdea.value='';renderDreamSkinReferences();closeDreamSkinGenerator();dreamSkinGenerateButton.disabled=false;dreamSkinStatus.textContent='';await send()}catch(error){dreamSkinStatus.textContent=error.message;dreamSkinGenerateButton.disabled=false}}
async function handleChatBackgroundChange(){const value=chatBackground.value;if(value==='dream-skin'){openDreamSkinGenerator();return}closeDreamSkinGenerator();if(value==='custom'){const reset=saveAppearance({chatBackground:'default'});chatBackgroundFile?.click();await reset;return}await saveAppearance({chatBackground:value});statusEl.textContent='会话背景已更新'}
async function handleCustomBackground(file){if(!file){await saveAppearance({chatBackground:'default'});statusEl.textContent='已恢复默认背景';return}if(!file.type.startsWith('image/')){statusEl.textContent='请选择图片文件';await saveAppearance({chatBackground:'default'});return}try{statusEl.textContent='上传背景...';const data=await readFileDataUrl(file);const res=await fetch('/api/appearance/background',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name,type:file.type,data})});const body=await res.json();if(!res.ok)throw new Error(body.error||'背景上传失败');appearance=body.appearance;applyAppearance();statusEl.textContent='自定义背景已应用'}catch(e){statusEl.textContent=e.message;await saveAppearance({chatBackground:'default'})}finally{chatBackgroundFile.value=''}}
async function applyGeneratedImageBackground(source,button){if(!source||button.disabled)return;button.disabled=true;button.classList.add('loading');statusEl.textContent='正在应用背景...';try{const imageResponse=await fetch(source);if(!imageResponse.ok)throw new Error('读取生成图片失败');const blob=await imageResponse.blob();if(!/^image\\/(?:png|jpeg|webp|gif)$/.test(blob.type))throw new Error('该图片格式不能用作背景');const data=await readFileDataUrl(blob);const extension=blob.type==='image/jpeg'?'jpg':blob.type.split('/')[1];const res=await fetch('/api/appearance/background',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Dream Skin.'+extension,type:blob.type,data})});const body=await res.json();if(!res.ok)throw new Error(body.error||'背景应用失败');appearance=body.appearance;applyAppearance();setIconLabel(button,'check','背景已应用',false);button.title='背景已应用';button.setAttribute('aria-label','背景已应用');statusEl.textContent='Dream Skin 背景已应用'}catch(error){statusEl.textContent=error.message;button.disabled=false}finally{button.classList.remove('loading')}}
async function deleteSelectedBackground(){const selected=cleanBackgroundValue(appearance.chatBackground);const custom=findCustomBackground(selected);if(!custom)return;if(!confirm('删除自定义背景 '+custom.name+'？'))return;statusEl.textContent='删除背景...';const res=await fetch('/api/appearance/background',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:selected})});const data=await res.json();if(!res.ok){statusEl.textContent=data.error||'背景删除失败';return}appearance=data.appearance;applyAppearance();statusEl.textContent='自定义背景已删除'}
async function boot(selectRecent=false){const res=await fetch('/api/config');if(!res.ok)return;const data=await res.json();appearance=data.appearance||appearance;applyAppearance();forceFullAccess=Boolean(data.capabilities?.forceFullAccess);cwd.value=data.defaults.cwd;sandbox.value=forceFullAccess?'danger-full-access':data.defaults.sandbox;approval.value=forceFullAccess?'never':data.defaults.approval;reasoningEffort.value=data.defaults.reasoningEffort||'';const canManage=Boolean(data.capabilities?.manageProviders);providerManager?.classList.toggle('hidden',!canManage);saveDefault?.classList.toggle('hidden',!canManage);deleteProviderButton?.classList.toggle('hidden',!canManage);provider.innerHTML='<option value="">默认</option>';for(const p of data.providers){const opt=document.createElement('option');opt.value=p;opt.textContent=p;provider.appendChild(opt)}provider.value=data.defaults.provider||'';renderHistory(data.conversations);updateSafetyHint();applyConversationMode();connectSessionEvents();refreshNativeRequests();await loadModels(provider.value,data.defaults.model);if(selectRecent&&data.conversations.length){const recent=data.conversations[0];await loadConversation(recent.id,recent.source)}}
async function refreshHistory(){if(activeHistoryProjectMenu)return;const res=await fetch('/api/config');if(!res.ok)return;const data=await res.json();renderHistory(data.conversations)}
async function loadModels(providerName,selected){model.innerHTML='<option value="">获取模型中...</option>';const data=await requestModels({provider:providerName});if(data.error){fillSelect(model,[selected||'gpt-5.5'],selected||'gpt-5.5');statusEl.textContent=data.error;return}fillSelect(model,data.models,selected||data.models[0]||'')}
async function refreshProviderModels(){const providerName=provider.value;if(!providerName){defaultMsg.textContent='请选择要更新模型的服务商';return}const selected=model.value;defaultMsg.textContent='更新模型中...';const data=await requestModels({provider:providerName});if(data.error){defaultMsg.textContent=data.error;return}fillSelect(model,data.models,selected);defaultMsg.textContent=data.models.length?'模型列表已更新，共 '+data.models.length+' 个':'没有返回模型'}
async function saveDefaultModel(){defaultMsg.textContent='保存中...';const res=await fetch('/api/defaults',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:provider.value,model:model.value,reasoningEffort:reasoningEffort.value})});const data=await res.json();if(!res.ok){defaultMsg.textContent=data.error||'保存失败';return}defaultMsg.textContent='默认设置已保存：'+data.model+' / '+(data.reasoningEffort||'默认');statusEl.textContent='Default: '+data.provider+' / '+data.model+' / '+(data.reasoningEffort||'default')}
async function deleteSelectedProvider(){const name=provider.value;if(!name){defaultMsg.textContent='请选择要删除的具体服务商';return}if(!confirm('删除服务商 '+name+'？该操作会移除对应配置和 API Key。'))return;defaultMsg.textContent='删除中...';const res=await fetch('/api/providers/'+encodeURIComponent(name),{method:'DELETE'});const data=await res.json();if(!res.ok){defaultMsg.textContent=data.error||'删除失败';return}defaultMsg.textContent='已删除服务商 '+name;await boot();if(data.provider){provider.value=data.provider;await loadModels(data.provider,data.model)}statusEl.textContent='Provider deleted'}
async function requestModels(payload){try{const res=await fetch('/api/models',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await res.json();return res.ok?data:{error:data.error||'获取模型失败'}}catch(e){return{error:e.message}}}
function fillSelect(select,items,selected){select.innerHTML='';const list=[...new Set((items||[]).filter(Boolean))];if(!list.length)list.push(selected||'gpt-5.5');for(const item of list){const opt=document.createElement('option');opt.value=item;opt.textContent=item;select.appendChild(opt)}select.value=list.includes(selected)?selected:list[0];syncComposerChrome()}
function conversationKey(source,id){return (source==='codex'?'codex':'web')+':'+id}
function historyProjectKey(value){return normalizeProjectPath(value)||'__unknown__'}
function normalizeProjectPath(value){const raw=String(value||'').trim();if(!raw)return'';if(raw==='/'||/^[A-Za-z]:[\\\\/]?$/.test(raw))return raw;return raw.replace(/[\\\\/]+$/,'')}
function projectNameFromPath(value){const clean=String(value||'').replace(/\\\\/g,'/').replace(/\\/+$/,'');const parts=clean.split('/').filter(Boolean);return parts.length?parts[parts.length-1]:'未指定项目'}
function readRenamedHistoryProjects(){try{const saved=JSON.parse(localStorage.getItem(HISTORY_PROJECT_NAMES_STORAGE_KEY)||'{}');if(!saved||Array.isArray(saved)||typeof saved!=='object')return new Map();return new Map(Object.entries(saved).filter(([key,value])=>key&&typeof value==='string'&&value.trim()).map(([key,value])=>[key,value.trim().replace(/\s+/g,' ').slice(0,80)]))}catch{return new Map()}}
function storeRenamedHistoryProjects(){try{localStorage.setItem(HISTORY_PROJECT_NAMES_STORAGE_KEY,JSON.stringify(Object.fromEntries([...renamedHistoryProjects.entries()].sort(([left],[right])=>left.localeCompare(right)))))}catch{}}
function historyProjectName(value){return renamedHistoryProjects.get(historyProjectKey(value))||projectNameFromPath(value)}
function readCollapsedHistoryProjects(){try{const saved=JSON.parse(localStorage.getItem(HISTORY_PROJECTS_STORAGE_KEY)||'[]');return new Set(Array.isArray(saved)?saved.filter((value)=>typeof value==='string'&&value):[])}catch{return new Set()}}
function storeCollapsedHistoryProjects(){try{localStorage.setItem(HISTORY_PROJECTS_STORAGE_KEY,JSON.stringify([...collapsedHistoryProjects].sort()))}catch{}}
function readHiddenHistoryProjects(){try{const saved=JSON.parse(localStorage.getItem(HIDDEN_HISTORY_PROJECTS_STORAGE_KEY)||'[]');return new Set(Array.isArray(saved)?saved.filter((value)=>typeof value==='string'&&value):[])}catch{return new Set()}}
function storeHiddenHistoryProjects(){try{localStorage.setItem(HIDDEN_HISTORY_PROJECTS_STORAGE_KEY,JSON.stringify([...hiddenHistoryProjects].sort()))}catch{}}
function closeHistoryProjectMenu(restoreFocus=false){
  const active=activeHistoryProjectMenu;
  if(!active)return;
  active.menu.hidden=true;
  active.menu.classList.remove('openAbove');
  active.button.setAttribute('aria-expanded','false');
  activeHistoryProjectMenu=null;
  if(restoreFocus&&active.button.isConnected)active.button.focus();
}
function toggleHistoryProjectMenu(button,menu){
  const shouldOpen=menu.hidden;
  closeHistoryProjectMenu();
  if(!shouldOpen)return;
  menu.hidden=false;
  button.setAttribute('aria-expanded','true');
  activeHistoryProjectMenu={button,menu};
  requestAnimationFrame(()=>{
    const bounds=history.getBoundingClientRect();
    const anchor=button.getBoundingClientRect();
    menu.classList.toggle('openAbove',anchor.bottom+menu.offsetHeight+8>bounds.bottom&&anchor.top-menu.offsetHeight>bounds.top);
    menu.querySelector('button:not(:disabled)')?.focus();
  });
}
function addHistoryProjectMenuAction(menu,iconName,label,handler,{danger=false,disabled=false}={}){
  const action=document.createElement('button');
  action.type='button';
  action.className='historyProjectMenuAction'+(danger?' danger':'');
  action.setAttribute('role','menuitem');
  action.disabled=disabled;
  setIconLabel(action,iconName,label);
  action.addEventListener('click',(event)=>{event.stopPropagation();closeHistoryProjectMenu();handler()});
  menu.appendChild(action);
  return action;
}
function createHistoryProjectMenu(groupKey,groupData,projectName){
  const button=document.createElement('button');
  button.type='button';
  button.className='historyProjectMenuButton';
  button.title='项目操作';
  button.setAttribute('aria-label','项目 '+projectName+' 的操作');
  button.setAttribute('aria-haspopup','menu');
  button.setAttribute('aria-expanded','false');
  setIconLabel(button,'ellipsis','项目操作',false);
  const menu=document.createElement('div');
  menu.className='historyProjectMenu';
  menu.setAttribute('role','menu');
  menu.setAttribute('aria-label','项目 '+projectName+' 的操作');
  menu.hidden=true;
  addHistoryProjectMenuAction(menu,'pencil','重命名项目',()=>renameHistoryProject(groupKey,groupData.path,projectName));
  addHistoryProjectMenuAction(menu,'archive','归档项目任务',()=>archiveHistoryProject(groupData.path,projectName,groupData.items),{disabled:!groupData.path});
  const hidden=hiddenHistoryProjects.has(groupKey);
  addHistoryProjectMenuAction(menu,hidden?'undo-2':'x',hidden?'恢复项目':'移除项目',()=>toggleHistoryProjectHidden(groupKey,projectName,groupData.items.length),{danger:!hidden});
  button.addEventListener('click',(event)=>{event.stopPropagation();toggleHistoryProjectMenu(button,menu)});
  menu.addEventListener('click',(event)=>event.stopPropagation());
  return{button,menu};
}
function renameHistoryProject(groupKey,projectPath,projectName){
  const next=prompt('重命名项目（留空恢复默认名称）',projectName);
  if(next===null)return;
  const clean=next.trim().replace(/\s+/g,' ').slice(0,80);
  const defaultName=projectNameFromPath(projectPath);
  if(!clean||clean===defaultName)renamedHistoryProjects.delete(groupKey);
  else renamedHistoryProjects.set(groupKey,clean);
  storeRenamedHistoryProjects();
  renderHistory();
  statusEl.textContent=clean&&clean!==defaultName?'项目已重命名':'项目名称已恢复默认';
}
async function archiveHistoryProject(projectPath,projectName,items){
  if(!projectPath)return;
  if(!confirm('归档项目「'+projectName+'」下的 '+items.length+' 个任务？归档后可在 Codex App 中恢复。'))return;
  statusEl.textContent='正在归档项目任务...';
  try{
    const res=await fetch('/api/native-projects/archive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cwd:projectPath})});
    const data=await res.json().catch(()=>({}));
    if((data.archived||[]).includes(currentConversationId))newChat();
    await refreshHistory();
    if(!res.ok)throw new Error(data.error||'归档项目任务失败');
    statusEl.textContent='已归档 '+data.archived.length+' 个项目任务';
  }catch(error){
    await refreshHistory();
    statusEl.textContent=error.message;
  }
}
function toggleHistoryProjectHidden(groupKey,projectName,itemCount){
  const hidden=hiddenHistoryProjects.has(groupKey);
  if(!hidden&&!confirm('从侧栏移除项目「'+projectName+'」？不会删除目录或 '+itemCount+' 个任务，可通过搜索恢复。'))return;
  if(hidden)hiddenHistoryProjects.delete(groupKey);else hiddenHistoryProjects.add(groupKey);
  storeHiddenHistoryProjects();
  renderHistory();
  statusEl.textContent=hidden?'项目已恢复':'项目已从侧栏移除';
}
function setHistoryProjectExpanded(group,expanded){
  const head=group?.querySelector('.historyProjectHead');
  const rows=group?.querySelector('.historyProjectItems');
  if(!head||!rows)return;
  const projectName=group.dataset.projectName||'未指定项目';
  const projectPath=group.dataset.projectPath||'路径未知';
  group.classList.toggle('collapsed',!expanded);
  head.setAttribute('aria-expanded',String(expanded));
  head.setAttribute('aria-label',(expanded?'收起':'展开')+'项目 '+projectName);
  head.title=(expanded?'收起':'展开')+' '+projectName+'\\n'+projectPath;
  rows.hidden=!expanded;
}
function renderHistory(items){
  if(Array.isArray(items))historyItems=items;
  renderComposerProjectOptions();
  const query=String(historyFilter?.value||'').trim().toLocaleLowerCase();
  const candidates=query?historyItems:historyItems.filter((item)=>!hiddenHistoryProjects.has(historyProjectKey(item.cwd)));
  const visibleItems=query?candidates.filter((item)=>(String(item.title||'')+' '+String(item.cwd||'')+' '+historyProjectName(item.cwd)).toLocaleLowerCase().includes(query)):candidates;
  const scrollTop=history.scrollTop;
  closeHistoryProjectMenu();
  history.innerHTML='';
  const historyCount=document.getElementById('historyTitleCount');
  if(historyCount)historyCount.textContent=(query||visibleItems.length!==historyItems.length)?visibleItems.length+'/'+historyItems.length:String(historyItems.length);
  if(!visibleItems.length){
    const empty=document.createElement('div');
    empty.className='historyEmpty';
    empty.textContent=query?'没有匹配的任务':hiddenHistoryProjects.size?'项目已从侧栏移除，可通过搜索恢复':'暂无任务';
    history.appendChild(empty);
    return;
  }
  const groups=new Map();
  for(const item of visibleItems){
    const projectPath=normalizeProjectPath(item.cwd);
    const groupKey=historyProjectKey(projectPath);
    if(!groups.has(groupKey))groups.set(groupKey,{path:projectPath,items:[]});
    groups.get(groupKey).items.push(item);
  }
  let groupIndex=0;
  for(const [groupKey,groupData] of groups){
    const group=document.createElement('section');
    group.className='historyProject';
    group.dataset.projectPath=groupData.path;
    const projectName=historyProjectName(groupData.path);
    group.dataset.projectName=projectName;
    group.setAttribute('aria-label','项目 '+projectName+'，路径 '+(groupData.path||'未知'));
    const header=document.createElement('div');
    header.className='historyProjectHeader';
    const head=document.createElement('button');
    head.type='button';
    head.className='historyProjectHead';
    const rowsId='history-project-items-'+groupIndex++;
    head.setAttribute('aria-controls',rowsId);
    const chevron=document.createElement('span');
    chevron.className='historyProjectChevron';
    setIconLabel(chevron,'chevron-right','',false);
    const headText=document.createElement('span');
    headText.className='historyProjectHeadText';
    const title=document.createElement('span');
    title.className='historyProjectTitle';
    const name=document.createElement('span');
    name.className='historyProjectName';
    name.textContent=projectName;
    const count=document.createElement('span');
    count.className='historyProjectCount';
    count.textContent=String(groupData.items.length);
    title.appendChild(name);
    title.appendChild(count);
    const projectPath=document.createElement('span');
    projectPath.className='historyProjectPath';
    projectPath.textContent=groupData.path||'路径未知';
    headText.appendChild(title);
    headText.appendChild(projectPath);
    head.appendChild(chevron);
    head.appendChild(headText);
    const projectMenu=createHistoryProjectMenu(groupKey,groupData,projectName);
    header.appendChild(head);
    header.appendChild(projectMenu.button);
    header.appendChild(projectMenu.menu);
    const rows=document.createElement('div');
    rows.className='historyProjectItems';
    rows.id=rowsId;
    for(const item of groupData.items)rows.appendChild(createHistoryRow(item,groupData.path));
    group.appendChild(header);
    group.appendChild(rows);
    history.appendChild(group);
    const currentKey=conversationKey(currentConversationSource,currentConversationId);
    const containsCurrent=Boolean(currentConversationId)&&groupData.items.some((item)=>conversationKey(item.source,item.id)===currentKey);
    setHistoryProjectExpanded(group,Boolean(query)||containsCurrent||!collapsedHistoryProjects.has(groupKey));
    head.addEventListener('click',()=>{
      const expanded=head.getAttribute('aria-expanded')==='true';
      setHistoryProjectExpanded(group,!expanded);
      if(query)return;
      if(expanded)collapsedHistoryProjects.add(groupKey);
      else collapsedHistoryProjects.delete(groupKey);
      storeCollapsedHistoryProjects();
    });
  }
  history.scrollTop=scrollTop;
}
function createHistoryRow(item,projectPath){
  const source=item.source==='codex'?'codex':'web';
  const row=document.createElement('div');
  row.className='hist'+(source==='codex'?' native':'');
  row.dataset.key=conversationKey(source,item.id);
  if(row.dataset.key===conversationKey(currentConversationSource,currentConversationId))row.classList.add('active');
  row.title=item.title+(projectPath?'\\n'+projectPath:'');
  row.addEventListener('click',()=>loadConversation(item.id,source));
  const open=document.createElement('button');
  open.type='button';
  open.className='histOpen'+(item.status==='running'?' running':'');
  open.textContent=item.title;
  open.title=row.title;
  open.addEventListener('click',(e)=>{e.stopPropagation();loadConversation(item.id,source)});
  if(source==='codex'){
    const badge=document.createElement('span');
    badge.className='histSource';
    badge.textContent='App';
    badge.title='Codex App 原生会话';
    row.appendChild(badge);
  }
  row.appendChild(open);
  if(source==='codex'){
    const rename=document.createElement('button');
    rename.type='button';
    rename.className='histRename';
    rename.title='修改会话标题';
    rename.setAttribute('aria-label','修改会话标题');
    setIconLabel(rename,'pencil','修改会话标题',false);
    rename.addEventListener('click',(e)=>{e.stopPropagation();renameConversation(item.id,item.title,source)});
    const del=document.createElement('button');
    del.type='button';
    del.className='histDelete';
    del.title='归档会话';
    del.setAttribute('aria-label','归档会话');
    setIconLabel(del,'archive','归档会话',false);
    del.addEventListener('click',(e)=>{e.stopPropagation();deleteConversation(item.id,item.title,source)});
    row.appendChild(rename);
    row.appendChild(del);
  }else{
    const rename=document.createElement('button');
    rename.type='button';
    rename.className='histRename';
    rename.title='修改会话标题';
    rename.setAttribute('aria-label','修改会话标题');
    setIconLabel(rename,'pencil','修改会话标题',false);
    rename.addEventListener('click',(e)=>{e.stopPropagation();renameConversation(item.id,item.title,source)});
    const del=document.createElement('button');
    del.type='button';
    del.className='histDelete';
    del.title='删除会话';
    del.setAttribute('aria-label','删除会话');
    setIconLabel(del,'trash-2','删除会话',false);
    del.addEventListener('click',(e)=>{e.stopPropagation();deleteConversation(item.id,item.title,source)});
    row.appendChild(rename);
    row.appendChild(del);
  }
  refreshIcons(row);
  return row;
}
function updateActiveHistory(){const key=conversationKey(currentConversationSource,currentConversationId);let activeRow=null;history.querySelectorAll('.hist').forEach((row)=>{const active=row.dataset.key===key;row.classList.toggle('active',active);if(active)activeRow=row});if(activeRow)setHistoryProjectExpanded(activeRow.closest('.historyProject'),true)}
async function renameConversation(id,title,source='codex'){const next=prompt('修改会话标题',title||'');if(next===null)return;const clean=next.trim().replace(/\s+/g,' ').slice(0,80);if(!clean){statusEl.textContent='标题不能为空';return}const endpoint=source==='codex'?'/api/native-sessions/':'/api/conversations/';const res=await fetch(endpoint+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:clean})});const data=await res.json();if(!res.ok){statusEl.textContent=data.error||'改名失败';return}await refreshHistory();statusEl.textContent='标题已更新'}
async function deleteConversation(id,title,source='codex'){const verb=source==='codex'?'归档':'删除';if(!confirm(verb+'会话：'+title+'？'))return;const endpoint=source==='codex'?'/api/native-sessions/':'/api/conversations/';const res=await fetch(endpoint+encodeURIComponent(id),{method:'DELETE'});const data=await res.json().catch(()=>({}));if(!res.ok){statusEl.textContent=data.error||verb+'失败';return}if(currentConversationId===id)newChat();await refreshHistory();statusEl.textContent=verb+'完成'}
function sidebarCollapsedPreference(){try{return localStorage.getItem(SIDEBAR_STORAGE_KEY)==='1'}catch{return false}}
function storeSidebarCollapsed(collapsed){try{localStorage.setItem(SIDEBAR_STORAGE_KEY,collapsed?'1':'0')}catch{}}
function syncMenuButton(){if(!menuBtn)return;const desktop=desktopSidebarMedia.matches;const expanded=desktop?!app.classList.contains('sideCollapsed'):app.classList.contains('menuOpen');const label=desktop?(expanded?'收起侧栏':'展开侧栏'):(expanded?'关闭菜单':'打开菜单');const icon=desktop?(expanded?'panel-left-close':'panel-left-open'):(expanded?'x':'menu');setIconLabel(menuBtn,icon,label,false);menuBtn.setAttribute('aria-label',label);menuBtn.setAttribute('title',label);menuBtn.setAttribute('aria-expanded',String(expanded))}
function restoreSidebarState(){app.classList.toggle('sideCollapsed',sidebarCollapsedPreference());app.classList.remove('menuOpen');syncMenuButton()}
function toggleMenu(){if(desktopSidebarMedia.matches){const collapsed=app.classList.toggle('sideCollapsed');storeSidebarCollapsed(collapsed)}else{app.classList.toggle('menuOpen')}syncMenuButton()}
function closeMenu(){if(!desktopSidebarMedia.matches)app.classList.remove('menuOpen');syncMenuButton()}
function toggleSettings(){if(settingsOverlay?.classList.contains('hidden'))openSettings();else closeSettings()}
function applyConversationMode(){
  const native=currentConversationSource==='codex';
  const legacyLocked=webRunActive&&!native;
  const queueStarting=native&&Boolean(currentConversationId)&&queueDispatchingThreads.has(currentConversationId);
  input.disabled=legacyLocked||steerSubmitting||queueStarting;
  attachFile.disabled=legacyLocked||steerSubmitting||queueStarting;
  fileInput.disabled=legacyLocked||steerSubmitting||queueStarting;
  sendBtn.disabled=legacyLocked||steerSubmitting||queueStarting||(!input.value.trim()&&!pendingAttachments.length);
  for(const control of [provider,model,reasoningEffort])control.disabled=webRunActive;
  sandbox.disabled=webRunActive||forceFullAccess;
  approval.disabled=webRunActive||forceFullAccess;
  nativeNotice.classList.toggle('hidden',!native);
  setIconLabel(modeLabel,native?'app-window':'globe-2',native?'Codex App':'Web');
  statusEl.classList.toggle('running',webRunActive);
  input.placeholder=queueStarting?'正在发送队列消息...':steerSubmitting?'正在发送引导...':webRunActive&&native?'继续输入，消息将加入队列':webRunActive?'当前任务运行中':currentConversationId?'要求后续变更':'描述任务或提出问题';
  sendBtn.setAttribute('aria-label',webRunActive&&native?'加入队列':'发送');
  sendBtn.title=webRunActive&&native?'加入队列':'发送';
  cancelBtn.classList.toggle('hidden',!webRunActive||!native);
  cancelBtn.disabled=!webRunActive;
  dropZone?.classList.toggle('runActive',webRunActive&&native);
  if(webRunActive)closeComposerPopovers();
  syncComposerChrome();
  renderPromptQueue();
}
function newChat(){closeComposerPopovers();clearNativeCompletionSync();conversationLoadSeq++;currentConversationId='';currentConversationSource='codex';nativeCursor=0;nativeGeneration=0;activeNativeTurnId='';webRunActive=false;steerSubmitting=false;nativeRunningElement=null;nativeOptimisticElements=[];nativeOptimisticSteering=new Map();nativeLiveItems=new Map();latestToolElement=null;latestAssistantElement=null;latestFinalAssistantElement=null;latestUserElement=null;resetTurnProcessCollection();if(titleEl)titleEl.textContent='新任务';applyConversationMode();updateActiveHistory();chat.innerHTML='<div class="empty"><b>新任务</b><span>等待输入</span></div>';nativeNotice.textContent='Codex App 会话 · 双向同步';statusEl.textContent='Ready';input.value='';input.style.height='auto';clearPendingAttachments();closeMenu();input.focus()}
function scrollChatToLatest(){requestAnimationFrame(()=>{chat.scrollTop=chat.scrollHeight})}
async function loadConversation(id,source='web'){
  if(webRunActive&&currentConversationSource==='web'&&(id!==currentConversationId||source!==currentConversationSource)){statusEl.textContent='旧版任务运行中，暂不能切换会话';return false}
  clearNativeCompletionSync();
  const seq=++conversationLoadSeq;
  nativeOptimisticElements=[];
  nativeOptimisticSteering=new Map();
  nativeRunningElement=null;
  nativeLiveItems=new Map();
  latestToolElement=null;
  latestAssistantElement=null;
  latestFinalAssistantElement=null;
  latestUserElement=null;
  resetTurnProcessCollection();
  currentConversationId=id;
  currentConversationSource=source==='codex'?'codex':'web';
  nativeCursor=0;
  nativeGeneration=0;
  applyConversationMode();
  updateActiveHistory();
  statusEl.textContent='Loading...';
  const endpoint=currentConversationSource==='codex'?'/api/native-sessions/':'/api/conversations/';
  const res=await fetch(endpoint+encodeURIComponent(id));
  if(seq!==conversationLoadSeq)return false;
  if(!res.ok){statusEl.textContent='加载失败';return false}
  const data=await res.json();
  if(seq!==conversationLoadSeq)return false;
  const conversation=data.conversation;
  if(titleEl)titleEl.textContent=conversation.title||'Chat';
  currentConversationId=conversation.id;
  currentConversationSource=conversation.source==='codex'?'codex':'web';
  nativeCursor=Number(conversation.cursor||0);
  nativeGeneration=Number(conversation.generation||0);
  activeNativeTurnId=String(conversation.activeTurnId||'');
  webRunActive=currentConversationSource==='codex'&&conversation.status==='running';
  if(currentConversationSource==='codex')applyNativeConversationMetadata(conversation.metadata||{});
  applyConversationMode();
  updateActiveHistory();
  chat.innerHTML='';
  beginTurnProcessCollection();
  (conversation.messages||[]).forEach((msg,index)=>addMsg(msg.role==='log'?'log':msg.role,msg.content,{messageIndex:currentConversationSource==='web'?index:undefined,nativeMessageSeq:currentConversationSource==='codex'?msg.seq:undefined,turnId:currentConversationSource==='codex'?msg.turnId:undefined,autoScroll:false,kind:msg.kind,at:msg.at}));
  if(!(conversation.messages||[]).length)chat.innerHTML='<div class="empty"><b>Empty</b><span>暂无可显示消息。</span></div>';
  updateConversationStatus(conversation);
  renderPromptQueue();
  if(currentConversationSource==='codex'&&!webRunActive)schedulePromptQueueDispatch(currentConversationId,180);
  closeMenu();
  scrollChatToLatest();
  return true;
}
function updateConversationStatus(conversation){
  const time=new Date(conversation.updatedAt||conversation.createdAt);
  const stamp=Number.isNaN(time.getTime())?'':time.toLocaleString();
  statusEl.classList.toggle('running',conversation.status==='running');
  if(conversation.source==='codex'){
    statusEl.textContent='Codex App · '+(conversation.status==='running'?'运行中':'已同步')+(stamp?' · '+stamp:'');
    nativeNotice.textContent='Codex App 会话 · 双向同步'+(conversation.truncated?' · 仅显示最近记录':'');
  }else{
    statusEl.textContent='Loaded '+stamp;
  }
}
function applyNativeConversationMetadata(metadata){if(metadata.cwd)cwd.value=metadata.cwd;if(!forceFullAccess&&['read-only','workspace-write','danger-full-access'].includes(metadata.sandboxPolicy))sandbox.value=metadata.sandboxPolicy;if(!forceFullAccess&&['never','on-request','untrusted'].includes(metadata.approvalPolicy))approval.value=metadata.approvalPolicy;if(['low','medium','high','xhigh','max'].includes(metadata.reasoningEffort))reasoningEffort.value=metadata.reasoningEffort;if(metadata.modelProvider&&[...provider.options].some((opt)=>opt.value===metadata.modelProvider))provider.value=metadata.modelProvider;if(metadata.model){if(![...model.options].some((opt)=>opt.value===metadata.model)){const opt=document.createElement('option');opt.value=metadata.model;opt.textContent=metadata.model;model.appendChild(opt)}model.value=metadata.model}if(forceFullAccess){sandbox.value='danger-full-access';approval.value='never'}updateSafetyHint()}
async function rollbackConversation(messageIndex){if(!currentConversationId||currentConversationSource==='codex')return;if(sendBtn.disabled){statusEl.textContent='任务运行中，不能回退';return}if(!confirm('重新编辑这条用户消息？这条消息及其后的所有消息都会被删除。'))return;statusEl.textContent='回退中...';const res=await fetch('/api/conversations/'+encodeURIComponent(currentConversationId)+'/rollback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messageIndex})});const data=await res.json();if(!res.ok){statusEl.textContent=data.error||'回退失败';return}clearPendingAttachments();await loadConversation(data.conversation.id,'web');input.value=data.draft||'';input.style.height='auto';input.style.height=Math.min(input.scrollHeight,180)+'px';input.focus();await refreshHistory();statusEl.textContent='已回退，可重新编辑后发送'}
async function forkNativeConversation(messageSeq,{continueAfter=false}={}){
  if(!currentConversationId||currentConversationSource!=='codex')return;
  if(webRunActive){statusEl.textContent='任务运行中，不能创建历史分支';return}
  const prompt=continueAfter
    ?'在新任务中从这条回答之后继续？原任务会保留，已经产生的本地文件修改不会撤销。'
    :'从这条消息重新开始？原会话会保留，新分支不会撤销已经产生的本地文件修改，原消息中的附件需要重新添加。';
  if(!confirm(prompt))return;
  const sourceThreadId=currentConversationId;
  statusEl.textContent='正在创建历史分支...';
  try{
    const res=await fetch('/api/native-sessions/'+encodeURIComponent(sourceThreadId)+'/fork',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messageSeq,provider:provider.value,model:model.value,reasoningEffort:reasoningEffort.value,cwd:cwd.value,sandbox:sandbox.value,approval:approval.value})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||'创建历史分支失败');
    clearPendingAttachments();
    const loaded=await loadConversation(data.threadId,'codex');
    if(!loaded){
      newChat();
      currentConversationId=data.threadId;
      currentConversationSource='codex';
      if(titleEl)titleEl.textContent=data.conversation?.title||'新分支';
      nativeNotice.textContent='Codex App 会话 · 历史分支';
      statusEl.textContent='Codex App · 新分支';
      applyNativeConversationMetadata(data.conversation?.metadata||{});
      applyConversationMode();
      updateActiveHistory();
    }
    input.value=data.draft||'';
    input.style.height='auto';
    input.style.height=Math.min(input.scrollHeight,180)+'px';
    await refreshHistory();
    statusEl.textContent=continueAfter?'已在新任务中继续；原任务保持不变':'已创建分支，可修改后发送；原会话保持不变';
    input.focus();
  }catch(e){
    statusEl.textContent=e.message;
  }
}
function connectSessionEvents(){
  if(sessionEvents||!window.EventSource)return;
  sessionEvents=new EventSource('/api/session-events');
  sessionEvents.addEventListener('open',async()=>{
    await refreshHistory();
    syncNativeAfterPageResume();
  });
  sessionEvents.addEventListener('sessions',(event)=>{
    let changedIds=[];
    try{changedIds=JSON.parse(event.data||'{}').changedIds||[]}catch(e){}
    if(nativeSyncTimer)clearTimeout(nativeSyncTimer);
    nativeSyncTimer=setTimeout(async()=>{
      nativeSyncTimer=null;
      await refreshHistory();
      if(currentConversationSource==='codex'&&(!changedIds.length||changedIds.includes(currentConversationId)))await syncCurrentNativeConversation();
    },260);
  });
  sessionEvents.addEventListener('native-runtime',(event)=>{
    let runtime={};
    try{runtime=JSON.parse(event.data||'{}')}catch(e){}
    refreshHistory();
    if(runtime.threadId!==currentConversationId||currentConversationSource!=='codex')return;
    if(runtime.type==='delta'){
      updateNativeLiveDelta(runtime);
    }else if(runtime.type==='item-completed'){
      finishNativeLiveItem(runtime.itemId);
    }else if(runtime.type==='connection-error'){
      activeNativeTurnId=runtime.turnId||activeNativeTurnId;
      if(runtime.willRetry){
        webRunActive=true;
        clearNativeCompletionSync();
        statusEl.textContent='Codex App · 上游连接中断，正在重连';
      }else{
        statusEl.textContent='Codex App · 上游请求异常，等待任务状态';
      }
      applyConversationMode();
    }else if(runtime.type==='turn'){
      const runtimeTurnId=runtime.turnId||activeNativeTurnId;
      activeNativeTurnId=runtimeTurnId;
      webRunActive=runtime.status==='running';
      if(!webRunActive){
        activeNativeTurnId='';
        removeNativeRunningElement();
        finishAllNativeLiveItems();
        statusEl.textContent=runtime.status==='error'?'Codex App 任务失败':runtime.status==='interrupted'?'Codex App 任务已取消':'Codex App 任务完成';
        playTaskCompleteSound();
        const completedId=currentConversationId;
        scheduleNativeCompletionSync(completedId,runtimeTurnId,220);
        schedulePromptQueueDispatch(completedId,320);
      }else{
        clearNativeCompletionSync();
        statusEl.textContent='Codex App · 运行中';
      }
      applyConversationMode();
    }
  });
  sessionEvents.addEventListener('native-request',()=>refreshNativeRequests());
}
async function syncCurrentNativeConversationOnce(){
  if(currentConversationSource!=='codex'||!currentConversationId)return;
  const id=currentConversationId;
  const seq=conversationLoadSeq;
  const nearBottom=chat.scrollHeight-chat.scrollTop-chat.clientHeight<120;
  const url='/api/native-sessions/'+encodeURIComponent(id)+'?after='+nativeCursor+'&generation='+nativeGeneration;
  const res=await fetch(url);
  if(seq!==conversationLoadSeq||currentConversationSource!=='codex'||currentConversationId!==id)return;
  if(!res.ok){if(res.status===404)statusEl.textContent='Codex App 会话已移除';return}
  const data=await res.json();
  const conversation=data.conversation;
  if(conversation.reset){
    if(webRunActive||nativeLiveItems.size){
      nativeCursor=Number(conversation.cursor||nativeCursor);
      nativeGeneration=Number(conversation.generation||nativeGeneration);
      if(conversation.status!=='running')scheduleNativeCompletionSync(id,nativeCompletionSync?.turnId||activeNativeTurnId,120);
      return;
    }
    await loadConversation(id,'codex');return;
  }
  const wasRunning=webRunActive;
  const completingTurnId=activeNativeTurnId;
  if((conversation.messages||[]).length){
    clearNativeOptimisticElements();
    removeNativeRunningElement();
  }
  for(const msg of conversation.messages||[]){const role=msg.role==='log'?'log':msg.role;if((webRunActive||nativeCompletionSync)&&nativeLiveItems.size&&['assistant','thinking'].includes(role))continue;addMsg(role,msg.content,{nativeMessageSeq:msg.seq,turnId:msg.turnId,autoScroll:false,kind:msg.kind,at:msg.at})}
  nativeCursor=Number(conversation.cursor||nativeCursor);
  nativeGeneration=Number(conversation.generation||nativeGeneration);
  activeNativeTurnId=String(conversation.activeTurnId||activeNativeTurnId||'');
  webRunActive=conversation.status==='running';
  if(wasRunning&&!webRunActive){
    activeNativeTurnId='';
    finishAllNativeLiveItems();
    if(nativeTerminalPersisted(conversation,completingTurnId)&&nativeLiveItems.size){
      clearNativeCompletionSync();
      await loadConversation(id,'codex');
      return;
    }
    scheduleNativeCompletionSync(id,completingTurnId,120);
  }
  updateConversationStatus(conversation);
  applyConversationMode();
  if(!webRunActive)schedulePromptQueueDispatch(id,180);
  if(nearBottom&&(conversation.messages||[]).length)scrollChatToLatest();
}
function nativeTerminalPersisted(conversation,turnId){
  const id=String(turnId||'');
  if(!id)return false;
  return (conversation.messages||[]).some((message)=>(
    message.turnId===id
    && message.role==='process'
    && ['task_complete','task_error','turn_aborted','error'].includes(message.kind)
  ));
}
function clearNativeCompletionSync(){
  if(nativeCompletionTimer)clearTimeout(nativeCompletionTimer);
  nativeCompletionTimer=null;
  nativeCompletionSync=null;
}
function scheduleNativeCompletionSync(threadId,turnId,delay=180){
  const cleanThreadId=String(threadId||'');
  const cleanTurnId=String(turnId||'');
  if(!cleanThreadId||!cleanTurnId)return;
  if(!nativeCompletionSync||nativeCompletionSync.threadId!==cleanThreadId||nativeCompletionSync.turnId!==cleanTurnId){
    nativeCompletionSync={threadId:cleanThreadId,turnId:cleanTurnId,attempt:0};
  }
  if(nativeCompletionTimer)clearTimeout(nativeCompletionTimer);
  nativeCompletionTimer=setTimeout(reconcileNativeCompletion,delay);
}
async function reconcileNativeCompletion(){
  nativeCompletionTimer=null;
  const pending=nativeCompletionSync;
  if(!pending)return;
  if(currentConversationSource!=='codex'||currentConversationId!==pending.threadId){clearNativeCompletionSync();return}
  try{
    const res=await fetch('/api/native-sessions/'+encodeURIComponent(pending.threadId));
    if(res.ok){
      const data=await res.json();
      if(nativeCompletionSync!==pending)return;
      if(nativeTerminalPersisted(data.conversation,pending.turnId)){
        nativeCompletionSync=null;
        await loadConversation(pending.threadId,'codex');
        return;
      }
    }
  }catch(e){}
  if(nativeCompletionSync!==pending)return;
  pending.attempt+=1;
  if(pending.attempt>=60){nativeCompletionSync=null;statusEl.textContent='任务已结束，历史记录仍在同步';return}
  scheduleNativeCompletionSync(pending.threadId,pending.turnId,Math.min(1500,180+pending.attempt*90));
}
function syncNativeAfterPageResume(){
  if(document.visibilityState==='hidden'||currentConversationSource!=='codex'||!currentConversationId)return;
  if(nativeCompletionSync){scheduleNativeCompletionSync(nativeCompletionSync.threadId,nativeCompletionSync.turnId,0);return}
  syncCurrentNativeConversation();
}
const MARKDOWN_ALLOWED_TAGS=['p','br','strong','em','del','code','pre','blockquote','ul','ol','li','h1','h2','h3','h4','h5','h6','hr','a','table','thead','tbody','tr','th','td'];
const MARKDOWN_ALLOWED_ATTRS=['href','title','align','colspan','rowspan','start'];
function renderAssistantMarkdown(body,text){
  const memoryParsed=extractMemoryCitations(String(text||''));
  const parsed=extractCodeComments(memoryParsed.markdown);
  const source=parsed.markdown;
  if(!window.marked?.parse||!window.DOMPurify?.sanitize){
    body.textContent=source;
    if(parsed.comments.length)renderReviewComments(body,parsed.comments);
    if(memoryParsed.citations.length)renderMemoryCitations(body,memoryParsed.citations);
    return;
  }
  try{
    const html=window.marked.parse(source,{gfm:true,breaks:true});
    body.classList.add('markdownBody');
    body.innerHTML=window.DOMPurify.sanitize(html,{ALLOWED_TAGS:MARKDOWN_ALLOWED_TAGS,ALLOWED_ATTR:MARKDOWN_ALLOWED_ATTRS});
    for(const link of body.querySelectorAll('a')){link.target='_blank';link.rel='noopener noreferrer'}
  }catch(e){
    body.classList.remove('markdownBody');
    body.textContent=source;
  }
  if(parsed.comments.length)renderReviewComments(body,parsed.comments);
  if(memoryParsed.citations.length)renderMemoryCitations(body,memoryParsed.citations);
}
function extractMemoryCitations(source){
  const citations=[];
  const pattern=/<oai-mem-citation>\\s*([\\s\\S]*?)<\\/oai-mem-citation>/gi;
  const markdown=String(source||'').replace(pattern,(block,content)=>{
    const entries=String(content||'').match(/<citation_entries>\\s*([\\s\\S]*?)<\\/citation_entries>/i)?.[1];
    if(!entries)return block;
    const parsed=[];
    for(const rawLine of entries.split(/\\r?\\n/)){
      const line=rawLine.trim();
      if(!line)continue;
      const noteStart=line.indexOf('|note=[');
      const location=(noteStart>=0?line.slice(0,noteStart):line).trim();
      const note=noteStart>=0&&line.endsWith(']')?line.slice(noteStart+7,-1).trim():'';
      const match=location.match(/^(.*):(\\d+)-(\\d+)$/);
      if(!match)continue;
      parsed.push({file:match[1],start:Number(match[2]),end:Number(match[3]),note});
    }
    if(!parsed.length)return block;
    citations.push(...parsed);
    return'';
  });
  return{markdown:markdown.replace(/\\n{3,}/g,'\\n\\n').trim(),citations};
}
function memoryCitationTitle(file){
  const normalized=String(file||'').replace(/\\\\/g,'/');
  const name=normalized.split('/').filter(Boolean).pop()||normalized;
  if(name==='MEMORY.md')return'长期记忆';
  if(normalized.startsWith('rollout_summaries/')){
    const date=name.match(/^(\\d{4}-\\d{2}-\\d{2})/)?.[1];
    return'任务回顾'+(date?' · '+date:'');
  }
  if(normalized.startsWith('skills/')||normalized.includes('/skills/'))return'技能记忆';
  return name.replace(/\\.[^.]+$/,'')||'记忆来源';
}
function memoryCitationSource(file){
  const normalized=String(file||'').replace(/\\\\/g,'/');
  const name=normalized.split('/').filter(Boolean).pop()||normalized;
  if(name==='MEMORY.md')return'MEMORY.md';
  if(normalized.startsWith('rollout_summaries/'))return'任务摘要';
  if(normalized.startsWith('skills/')||normalized.includes('/skills/'))return'SKILL.md';
  return name||'记忆文件';
}
function renderMemoryCitations(body,citations){
  const group=document.createElement('details');
  group.className='memoryCitations';
  group.open=false;
  group.setAttribute('aria-label',citations.length+' 条记忆引用');
  const summary=document.createElement('summary');
  summary.className='memoryCitationsSummary';
  const chevron=document.createElement('i');
  chevron.className='memoryCitationsChevron';
  chevron.setAttribute('data-lucide','chevron-right');
  chevron.setAttribute('aria-hidden','true');
  const typeIcon=document.createElement('i');
  typeIcon.className='memoryCitationsTypeIcon';
  typeIcon.setAttribute('data-lucide','database');
  typeIcon.setAttribute('aria-hidden','true');
  const label=document.createElement('span');
  label.className='memoryCitationsLabel';
  label.textContent='记忆引用';
  const count=document.createElement('span');
  count.className='memoryCitationsCount';
  count.textContent=String(citations.length);
  summary.appendChild(chevron);
  summary.appendChild(typeIcon);
  summary.appendChild(label);
  summary.appendChild(count);
  const list=document.createElement('div');
  list.className='memoryCitationList';
  for(const citation of citations){
    const item=document.createElement('details');
    item.className='memoryCitationItem';
    const row=document.createElement('summary');
    row.className='memoryCitationRow';
    row.title=citation.file;
    const fileIcon=document.createElement('i');
    fileIcon.className='memoryCitationFileIcon';
    fileIcon.setAttribute('data-lucide','file-text');
    fileIcon.setAttribute('aria-hidden','true');
    const identity=document.createElement('span');
    identity.className='memoryCitationIdentity';
    const name=document.createElement('span');
    name.className='memoryCitationName';
    name.textContent=memoryCitationTitle(citation.file);
    const source=document.createElement('span');
    source.className='memoryCitationSource';
    source.textContent=memoryCitationSource(citation.file);
    identity.appendChild(name);
    identity.appendChild(source);
    const lines=document.createElement('span');
    lines.className='memoryCitationLines';
    lines.textContent=citation.start===citation.end?citation.start+' 行':citation.start+'–'+citation.end+' 行';
    const itemChevron=document.createElement('i');
    itemChevron.className='memoryCitationItemChevron';
    itemChevron.setAttribute('data-lucide','chevron-right');
    itemChevron.setAttribute('aria-hidden','true');
    row.appendChild(fileIcon);
    row.appendChild(identity);
    row.appendChild(lines);
    row.appendChild(itemChevron);
    const detail=document.createElement('div');
    detail.className='memoryCitationDetail';
    const path=document.createElement('div');
    path.className='memoryCitationPath';
    path.textContent=citation.file;
    detail.appendChild(path);
    if(citation.note){
      const purpose=document.createElement('div');
      purpose.className='memoryCitationPurpose';
      const purposeLabel=document.createElement('span');
      purposeLabel.textContent='用途';
      const purposeText=document.createElement('span');
      purposeText.textContent=citation.note;
      purpose.appendChild(purposeLabel);
      purpose.appendChild(purposeText);
      detail.appendChild(purpose);
    }
    item.appendChild(row);
    item.appendChild(detail);
    list.appendChild(item);
  }
  group.appendChild(summary);
  group.appendChild(list);
  body.appendChild(group);
  refreshIcons(group);
}
function extractCodeComments(source){
  const comments=[];
  const markdown=[];
  for(const line of String(source||'').split('\\n')){
    const trimmed=line.trim();
    if(trimmed.startsWith('::code-comment{')){
      const comment=parseCodeCommentDirective(trimmed);
      if(comment)comments.push(comment);
      continue;
    }
    markdown.push(line);
  }
  return{markdown:markdown.join('\\n').trim(),comments};
}
function parseCodeCommentDirective(line){
  if(!line.endsWith('}'))return null;
  const attributes={};
  const source=line.slice('::code-comment{'.length,-1);
  const pattern=/(\\w+)="((?:\\\\.|[^"])*)"/g;
  let match;
  while((match=pattern.exec(source))){
    try{attributes[match[1]]=JSON.parse('"'+match[2]+'"')}catch(e){attributes[match[1]]=match[2]}
  }
  if(!attributes.title||!attributes.body||!attributes.file)return null;
  const prefix=String(attributes.title).match(/^\\[P([0-3])\\]\\s*/);
  const explicitPriority=Number(attributes.priority);
  return{
    title:String(attributes.title).replace(/^\\[P[0-3]\\]\\s*/,''),
    body:String(attributes.body),
    file:String(attributes.file),
    start:Number(attributes.start)||0,
    end:Number(attributes.end)||0,
    priority:Number.isInteger(explicitPriority)&&explicitPriority>=0&&explicitPriority<=3?explicitPriority:prefix?Number(prefix[1]):null,
  };
}
function reviewFileLabel(file){
  const full=String(file||'');
  const root=String(cwd?.value||'').replace(/[\\\\/]+$/,'');
  return root&&full.startsWith(root+'/')?full.slice(root.length+1):full;
}
function renderReviewComments(body,comments){
  const card=document.createElement('section');
  card.className='reviewComments';
  card.setAttribute('aria-label',comments.length+' comments');
  const head=document.createElement('div');
  head.className='reviewCommentsHead';
  const iconWrap=document.createElement('span');
  iconWrap.className='reviewCommentsIcon';
  const icon=document.createElement('i');
  icon.setAttribute('data-lucide','message-square');
  icon.setAttribute('aria-hidden','true');
  const count=document.createElement('span');
  count.textContent=comments.length+' comments';
  iconWrap.appendChild(icon);
  head.appendChild(iconWrap);
  head.appendChild(count);
  card.appendChild(head);
  for(const comment of comments){
    const item=document.createElement('details');
    item.className='reviewComment';
    const row=document.createElement('summary');
    row.className='reviewCommentRow';
    if(comment.priority!==null){
      const priority=document.createElement('span');
      priority.className='reviewPriority priority'+comment.priority;
      priority.textContent='P'+comment.priority;
      row.appendChild(priority);
    }
    const title=document.createElement('span');
    title.className='reviewCommentTitle';
    title.textContent=comment.title;
    row.appendChild(title);
    const location=document.createElement('span');
    location.className='reviewCommentLocation';
    let locationText=reviewFileLabel(comment.file);
    if(comment.start)locationText+=':'+comment.start+(comment.end&&comment.end!==comment.start?'-'+comment.end:'');
    location.textContent=locationText;
    row.appendChild(location);
    const commentBody=document.createElement('div');
    commentBody.className='reviewCommentBody';
    commentBody.textContent=comment.body;
    item.appendChild(row);
    item.appendChild(commentBody);
    card.appendChild(item);
  }
  body.appendChild(card);
}
function decodeEmbeddedToolString(value){try{return JSON.parse('"'+value+'"')}catch(e){return String(value||'')}}
function readEmbeddedToolString(source,marker){const start=String(source||'').indexOf(marker);if(start<0)return null;let value='';let escaped=false;for(let index=start+marker.length;index<source.length;index++){const char=source[index];if(char==='"'&&!escaped)return decodeEmbeddedToolString(value);value+=char;if(char==='\\\\'&&!escaped)escaped=true;else escaped=false}return null}
function executableOrchestratedToolCallOffsets(source,toolName){
  const text=String(source||'');
  const needle='tools.'+toolName;
  const offsets=[];
  let quote='';
  let escaped=false;
  let lineComment=false;
  let blockComment=false;
  for(let index=0;index<text.length;index++){
    const char=text[index];
    const next=text[index+1];
    if(lineComment){if(char==='\\n')lineComment=false;continue}
    if(blockComment){if(char==='*'&&next==='/'){blockComment=false;index++}continue}
    if(quote){if(escaped)escaped=false;else if(char==='\\\\')escaped=true;else if(char===quote)quote='';continue}
    if(char==='/'&&next==='/'){lineComment=true;index++;continue}
    if(char==='/'&&next==='*'){blockComment=true;index++;continue}
    if(char==='"'||char==="'"||char.charCodeAt(0)===96){quote=char;continue}
    if(!text.startsWith(needle,index))continue;
    let cursor=index+needle.length;
    while(/\\s/.test(text[cursor]||''))cursor++;
    if(text[cursor]==='(')offsets.push(index);
  }
  return offsets;
}
function toolCallDescriptor(text){const source=String(text||'');const lineBreak=source.indexOf('\\n');let name=(lineBreak<0?source:source.slice(0,lineBreak)).trim();let detail=lineBreak<0?'':source.slice(lineBreak+1);if(name==='exec'){const command=readEmbeddedToolString(detail,'tools.exec_command({cmd:"');if(command!==null)return{name:'exec_command',detail:command};const patch=readEmbeddedToolString(detail,'const patch = "');if(patch!==null&&detail.includes('tools.apply_patch'))return{name:'apply_patch',detail:patch};if(detail.includes('mcp__node_repl__js'))return{name:'browser_check',detail}}if(name==='exec_command')detail=detail.split('\\n').filter((line)=>!line.startsWith('workdir=')).join('\\n');return{name:name||'tool',detail}}
function activityFileLabel(file){const clean=String(file||'').trim().replace(/^["']|["',;)]$/g,'');const parts=clean.split('/').filter(Boolean);return parts[parts.length-1]||clean||'文件'}
function extractActivityFiles(source){const matches=String(source||'').match(/[A-Za-z0-9_@.+-]+\\.(?:mjs|cjs|js|css|jsonl?|md|toml|ya?ml|py|sh|html|tsx?|jsx?|go|rs|java|cpp|hpp|c|h)/g)||[];return[...new Set(matches.map(activityFileLabel))].slice(0,4)}
function shortActivityText(value,max=100){const clean=String(value||'').replace(/\\s+/g,' ').trim();return clean.length>max?clean.slice(0,max-3)+'...':clean}
function orchestratedActivityPresentations(text){
  const source=String(text||'');
  if(!source.startsWith('exec\\n'))return[];
  const detail=source.slice(source.indexOf('\\n')+1);
  const imageCount=executableOrchestratedToolCallOffsets(detail,'view_image').length;
  const commandCount=executableOrchestratedToolCallOffsets(detail,'exec_command').length;
  const items=[];
  if(imageCount)items.push({verb:'已查看',target:imageCount+' 张图像',icon:'images'});
  if(commandCount>1)items.push({verb:'已读取文件并运行了多个命令',icon:'search'});
  return items;
}
function runningActivityVerb(verb){
  const exact={
    '已读取':'正在读取',
    '已搜索':'正在搜索',
    '已运行':'正在运行',
    '已检查':'正在检查',
    '已请求':'正在请求',
    '已查看':'正在查看',
    '已编辑':'正在编辑',
    '已新增':'正在新增',
    '已删除':'正在删除',
    '已调用':'正在调用',
    '已读取文件并运行了多个命令':'正在读取文件并运行多个命令',
  };
  return exact[verb]||verb.replace(/^已/,'正在');
}
function patchActivityPresentations(patch){const items=[];let current=null;for(const line of String(patch||'').split('\\n')){const prefixes=[['*** Update File: ','已编辑','pencil'],['*** Add File: ','已新增','file-plus-2'],['*** Delete File: ','已删除','trash-2']];const match=prefixes.find(([prefix])=>line.startsWith(prefix));if(match){current={verb:match[1],icon:match[2],target:activityFileLabel(line.slice(match[0].length)),added:0,removed:0};items.push(current);continue}if(!current)continue;if(line.startsWith('+')&&!line.startsWith('+++'))current.added++;else if(line.startsWith('-')&&!line.startsWith('---'))current.removed++}return items.map((item)=>({...item,meta:'+'+item.added+' -'+item.removed}))}
function commandActivityPresentation(command){const source=String(command||'');const clean=shortActivityText(source,120);const files=extractActivityFiles(source);if(/(?:^|\\s)(?:cat|sed|nl|head|tail)(?:\\s|$)/.test(source))return{verb:'已读取',target:files.join('、')||clean,icon:'book-open'};if(/\\brg\\b/.test(source)){const query=source.match(/\\brg\\b[^\\n]*?["']([^"']+)["']/)?.[1]||'';return{verb:'已搜索',target:(files.join('、')||'内容')+(query?' · “'+shortActivityText(query,48)+'”':''),icon:'search'}}if(/(?:npm test|node --test|pytest|unittest|compileall|node --check|git diff --check)/.test(source))return{verb:'已运行',target:/git diff --check/.test(source)?'代码差异检查':files.join('、')||shortActivityText(source.split('\\n')[0],84),icon:'circle-check'};if(/\\bgit (?:status|diff|log|show)\\b/.test(source))return{verb:'已检查',target:'Git '+(source.match(/\\bgit (status|diff|log|show)\\b/)?.[1]||'状态'),icon:'git-branch'};if(/(?:health|api\\/health)/i.test(source))return{verb:'已检查',target:'服务状态',icon:'activity'};if(/\\bcurl\\b/.test(source))return{verb:'已请求',target:source.match(/https?:\\/\\/[^\\s"']+/)?.[0]||'本地资源',icon:'globe-2'};return{verb:'已运行',target:files.join('、')||clean||'工具调用',icon:'terminal'}}
function toolActivityPresentations(text){const orchestrated=orchestratedActivityPresentations(text);if(orchestrated.length)return orchestrated;const descriptor=toolCallDescriptor(text);if(descriptor.name==='apply_patch'){const patches=patchActivityPresentations(descriptor.detail);if(patches.length)return patches}if(descriptor.name==='exec_command')return[commandActivityPresentation(descriptor.detail)];if(descriptor.name==='view_image')return[{verb:'已查看',target:'1 张图像',icon:'image'}];if(descriptor.name==='browser_check')return[{verb:'已检查',target:'浏览器页面',icon:'panel-top'}];if(descriptor.name==='exec')return[{verb:'已调用',target:'工具',icon:'wrench'}];if(/search/i.test(descriptor.name))return[{verb:'已搜索',target:shortActivityText(descriptor.detail,90)||'工具',icon:'search'}];return[{verb:'已调用',target:shortActivityText(descriptor.name,72)||'工具',icon:'wrench'}]}
function isImageViewActivityPresentation(presentation){return presentation?.verb==='已查看'&&/\\d+ 张图像$/.test(String(presentation.target||''))&&['image','images'].includes(presentation.icon)}
function nativeToolImageUrls(presentations,messageSeq){
  const sequence=Number(messageSeq);
  if(currentConversationSource!=='codex'||!currentConversationId||!Number.isInteger(sequence)||sequence<1)return[];
  const count=presentations.reduce((total,presentation)=>total+(Number(String(presentation.target||'').match(/^(\\d+) 张图像$/)?.[1])||0),0);
  if(!count)return[];
  const base='/api/native-sessions/'+encodeURIComponent(currentConversationId)+'/tool-images/'+sequence+'/';
  return Array.from({length:count},(_,index)=>base+(index+1));
}
function createActivityImageGallery(urls){
  const gallery=document.createElement('div');
  gallery.className='activityImageGallery'+(urls.length===1?' single':'');
  urls.forEach((url,index)=>{
    const preview=document.createElement('button');
    preview.type='button';
    preview.className='activityImagePreview';
    preview.title='放大查看第 '+(index+1)+' 张图片';
    preview.setAttribute('aria-label',preview.title);
    const img=document.createElement('img');
    img.alt='查看的图像 '+(index+1);
    img.loading='lazy';
    img.decoding='async';
    img.addEventListener('load',()=>preview.classList.add('loaded'),{once:true});
    img.src=url;
    const unavailable=document.createElement('span');
    unavailable.className='activityImageUnavailable';
    unavailable.hidden=true;
    const unavailableIcon=document.createElement('i');
    unavailableIcon.setAttribute('data-lucide','image-off');
    unavailableIcon.setAttribute('aria-hidden','true');
    const unavailableText=document.createElement('span');
    unavailableText.textContent='图片已不可用';
    unavailable.appendChild(unavailableIcon);
    unavailable.appendChild(unavailableText);
    img.addEventListener('error',()=>{img.remove();unavailable.hidden=false;preview.classList.add('unavailable');preview.disabled=true;refreshIcons(unavailable)});
    preview.appendChild(img);
    preview.appendChild(unavailable);
    preview.addEventListener('click',()=>openImagePreview(url,img.alt,preview));
    gallery.appendChild(preview);
  });
  return gallery;
}
function createToolActivityItem(presentation,rawText,running=false){
  const expandable=presentation.expandable!==false;
  const galleryOnly=Boolean(presentation.galleryOnly);
  const imageUrls=Array.isArray(presentation.imageUrls)?presentation.imageUrls.filter(Boolean):[];
  const item=document.createElement(expandable?'details':'div');
  item.className='activityItem'+(expandable?'':' static')+(imageUrls.length?' withImages':'');
  if(expandable)item.open=false;
  item.dataset.messageText=String(rawText||'');
  const summary=document.createElement(expandable?'summary':'div');
  summary.className='activityItemSummary'+(presentation.target?'':' standalone');
  const iconWrap=document.createElement('span');
  iconWrap.className='activityItemIcon';
  const icon=document.createElement('i');
  icon.setAttribute('data-lucide',presentation.icon||'wrench');
  icon.setAttribute('aria-hidden','true');
  iconWrap.appendChild(icon);
  const verb=document.createElement('span');
  verb.className='activityVerb';
  verb.dataset.completedVerb=presentation.verb||'已调用';
  verb.textContent=running?runningActivityVerb(verb.dataset.completedVerb):verb.dataset.completedVerb;
  summary.appendChild(iconWrap);
  summary.appendChild(verb);
  if(presentation.target){
    const target=document.createElement('span');
    target.className='activityTarget';
    target.textContent=presentation.target;
    target.title=target.textContent;
    summary.appendChild(target);
  }
  if(presentation.meta){
    const meta=document.createElement('span');
    meta.className='activityMeta';
    meta.textContent=presentation.meta;
    summary.appendChild(meta);
  }
  if(expandable){
    const chevron=document.createElement('i');
    chevron.className='activityItemChevron';
    chevron.setAttribute('data-lucide','chevron-right');
    chevron.setAttribute('aria-hidden','true');
    summary.appendChild(chevron);
  }
  item.appendChild(summary);
  if(imageUrls.length)item.appendChild(createActivityImageGallery(imageUrls));
  if(expandable&&!galleryOnly){
    const content=document.createElement('div');
    content.className='activityItemContent';
    const raw=document.createElement('pre');
    raw.className='activityRaw';
    raw.textContent=String(rawText||'');
    const copy=document.createElement('button');
    copy.type='button';
    copy.className='copyMsg activityCopy';
    copy.title='复制工具调用';
    copy.setAttribute('aria-label','复制工具调用');
    setIconLabel(copy,'copy','复制工具调用',false);
    copy.addEventListener('click',(event)=>{event.stopPropagation();copyText(item.dataset.messageText||'',copy)});
    content.appendChild(raw);
    content.appendChild(copy);
    item.appendChild(content);
  }
  return item;
}
function createActivityBatch(presentations,rawText,kind,running=false){
  const batch=document.createElement('div');
  batch.className='msg activityBatch'+(running?' streaming':'');
  batch.dataset.messageKind=kind||'activity';
  batch.dataset.messageText=String(rawText||'');
  for(const presentation of presentations)batch.appendChild(createToolActivityItem(presentation,rawText,running));
  return batch;
}
function joinActivityActions(actions){
  if(actions.length<2)return actions[0]||'';
  return actions.length===2?actions[0]+'并'+actions[1]:actions.slice(0,-1).join('、')+'并'+actions.at(-1);
}
function activityClusterPresentation(cluster){
  const batches=[...cluster.querySelectorAll(':scope > .activityClusterItems > .activityBatch')];
  const items=[...cluster.querySelectorAll('.activityItem')];
  const running=batches.some((batch)=>batch.classList.contains('streaming'));
  const records=items.map((item)=>({
    verb:String(item.querySelector('.activityVerb')?.dataset.completedVerb||'').trim(),
    currentVerb:String(item.querySelector('.activityVerb')?.textContent||'').trim(),
    target:String(item.querySelector('.activityTarget')?.textContent||'').trim(),
    icon:item.querySelector('.activityItemIcon [data-lucide]')?.getAttribute('data-lucide')||'activity',
  }));
  const browser=records.some((record)=>record.icon==='panel-top'||/浏览器/.test(record.target));
  if(browser)return{icon:'panel-top',text:(running?'正在使用':'已使用')+' 浏览器'};
  if(records.length===1&&batches.length===1){
    const record=records[0];
    return{icon:record.icon,text:[record.currentVerb,record.target].filter(Boolean).join(' ')||'工具调用'};
  }
  const edited=records.some((record)=>['已编辑','已新增','已删除'].includes(record.verb));
  const read=records.some((record)=>['已读取','已搜索','已查看'].includes(record.verb));
  const ran=batches.length>1||records.some((record)=>[
    '已运行','已检查','已请求','已调用','已使用','已读取文件并运行了多个命令',
  ].includes(record.verb));
  const actions=[];
  if(edited)actions.push(running?'编辑文件':'编辑了文件');
  if(read)actions.push(running?'读取文件':'读取文件');
  if(ran)actions.push(running?'运行多个命令':'运行了多个命令');
  const text=joinActivityActions(actions)||(running?'正在使用工具':'已使用工具');
  return{
    icon:edited?'pencil':read?'book-open':'terminal',
    text:running&&!text.startsWith('正在')?'正在'+text:text,
  };
}
function createActivityCluster(){
  const cluster=document.createElement('details');
  cluster.className='msg activityCluster';
  cluster.dataset.messageKind='activity_cluster';
  cluster.open=false;
  const summary=document.createElement('summary');
  summary.className='activityClusterSummary';
  const icon=document.createElement('span');
  icon.className='activityItemIcon activityClusterIcon';
  const label=document.createElement('span');
  label.className='activityClusterText';
  const chevron=document.createElement('i');
  chevron.className='activityClusterChevron';
  chevron.setAttribute('data-lucide','chevron-right');
  chevron.setAttribute('aria-hidden','true');
  summary.appendChild(icon);
  summary.appendChild(label);
  summary.appendChild(chevron);
  const items=document.createElement('div');
  items.className='activityClusterItems';
  cluster.appendChild(summary);
  cluster.appendChild(items);
  return cluster;
}
function updateActivityCluster(cluster){
  if(!cluster)return;
  const presentation=activityClusterPresentation(cluster);
  const iconWrap=cluster.querySelector(':scope > summary .activityClusterIcon');
  const label=cluster.querySelector(':scope > summary .activityClusterText');
  const icon=document.createElement('i');
  icon.setAttribute('data-lucide',presentation.icon);
  icon.setAttribute('aria-hidden','true');
  iconWrap?.replaceChildren(icon);
  if(label){label.textContent=presentation.text;label.title=presentation.text}
  cluster.dataset.messageText=presentation.text;
  cluster.classList.toggle('streaming',Boolean(cluster.querySelector('.activityBatch.streaming')));
  refreshIcons(cluster);
}
function appendActivityBatchToCluster(cluster,batch){
  cluster.querySelector(':scope > .activityClusterItems')?.appendChild(batch);
  updateActivityCluster(cluster);
}
function settleActivityCluster(cluster){
  for(const batch of cluster?.querySelectorAll('.activityBatch')||[])settleTurnTool(batch);
  cluster?.classList.remove('streaming');
  updateActivityCluster(cluster);
}
function appendTurnTool(text,options={}){
  const presentations=toolActivityPresentations(text);
  const imageViews=presentations.filter(isImageViewActivityPresentation);
  const folded=presentations.filter((presentation)=>!isImageViewActivityPresentation(presentation));
  const imageUrls=nativeToolImageUrls(imageViews,options.nativeMessageSeq);
  let visibleBatch=null;
  if(imageViews.length){
    visibleBatch=createActivityBatch(imageViews.map((presentation,index)=>({...presentation,expandable:true,galleryOnly:true,imageUrls:index===0?imageUrls:[]})),text,'image_view_activity',true);
    activateTurnProcessElement(visibleBatch);
    refreshIcons(visibleBatch);
  }
  if(!folded.length)return visibleBatch;
  const batch=createActivityBatch(folded,text,'tool_activity',true);
  if(visibleBatch)batch._relatedActivityBatches=[visibleBatch];
  activateTurnProcessElement(batch);
  refreshIcons(batch);
  return batch;
}
function settleTurnTool(batch){
  if(!batch)return;
  for(const item of [batch,...(batch._relatedActivityBatches||[])]){
    item.classList.remove('streaming');
    for(const verb of item.querySelectorAll('.activityVerb[data-completed-verb]'))verb.textContent=verb.dataset.completedVerb;
    const cluster=item.closest('.activityCluster');
    if(cluster)updateActivityCluster(cluster);
  }
}
function appendTurnProcessActivity(text,kind){
  const presentation=kind==='context_compacted'
    ?{verb:'上下文已自动压缩',icon:'scan-text',expandable:false}
    :{verb:String(text||'过程'),icon:'activity',expandable:false};
  const batch=createActivityBatch([presentation],text,kind);
  activateTurnProcessElement(batch);
  refreshIcons(batch);
  return batch;
}
function toolMessageTitle(text){const lines=String(text||'').split('\\n').map((line)=>line.trim()).filter(Boolean);if(!lines.length)return '工具调用';let title=lines[0].replace(/^调用工具:\\s*/,'').trim()||'工具调用';const output=/\\soutput$/i.test(title)||['工具返回','搜索结果'].includes(title);if(!output){const detail=lines.slice(1).find((line)=>!/^call_id=/.test(line)&&!/^workdir=/.test(line)&&!['[',']','{','}','],','},'].includes(line));if(detail)title+=' · '+detail}title=title.replace(/\\s+/g,' ');return title.length>120?title.slice(0,117)+'...':title}
function thinkingMessageTitle(text){const line=String(text||'').split('\\n').map((item)=>item.trim()).find(Boolean)||'正在思考';const clean=line.replace(/[*_~\`#]/g,'').replace(/\\s+/g,' ').trim()||'正在思考';return clean.length>120?clean.slice(0,117)+'...':clean}
function contextMessageTitle(text,kind){const lines=String(text||'').split('\\n').map((line)=>line.trim()).filter(Boolean);if(kind==='environment_context'){const date=lines.find((line)=>line.startsWith('日期 '))?.slice(3);const workspace=lines.find((line)=>line.startsWith('工作区 '))?.slice(4);return ['环境',date,workspace?workspace+' 个工作区':''].filter(Boolean).join(' · ')}if(kind==='browser_context'){const page=lines.find((line)=>line.startsWith('当前页面 '))?.slice(5);return page?'浏览器 · '+page:'浏览器上下文'}if(kind==='goal_context')return'持续目标';if(kind==='turn_aborted')return'任务已中断';return'上下文'}
function completionMessageTitle(text){
  const seconds=Number(String(text||'').match(/耗时\\s*([\\d.]+)s/)?.[1]);
  if(!Number.isFinite(seconds))return'已处理';
  const rounded=Math.max(1,Math.round(seconds));
  if(rounded<60)return'已处理 '+rounded+'s';
  const minutes=Math.floor(rounded/60);
  const remainder=rounded%60;
  return'已处理 '+minutes+'m'+(remainder?' '+remainder+'s':'');
}
function clearTurnProcessHeader(){
  if(turnProcessHeader?.parentNode)turnProcessHeader.remove();
  turnProcessHeader=null;
  turnProcessTimeline=null;
}
function ensureTurnProcessHeader(){
  if(turnProcessHeader)return turnProcessHeader;
  turnProcessHeader=document.createElement('div');
  turnProcessHeader.className='liveProcessPanel';
  turnProcessHeader.dataset.messageKind='live_process';
  turnProcessTimeline=document.createElement('div');
  turnProcessTimeline.className='completionTimeline liveProcessTimeline';
  turnProcessHeader.appendChild(turnProcessTimeline);
  chat.appendChild(turnProcessHeader);
  return turnProcessHeader;
}
function formatMessageTime(value){
  const date=new Date(value||Date.now());
  if(Number.isNaN(date.getTime()))return'';
  try{return new Intl.DateTimeFormat([],{hour:'numeric',minute:'2-digit'}).format(date)}catch(e){return date.toLocaleTimeString().slice(0,5)}
}
function resetTurnProcessCollection(){
  clearTurnProcessHeader();
  turnProcessElements=[];
  currentActivityCluster=null;
  nativeOptimisticSteering.clear();
  collectingTurnProcess=false;
}
function beginTurnProcessCollection(){
  for(const element of turnProcessElements)if(element?.parentNode===chat)element.remove();
  clearTurnProcessHeader();
  turnProcessElements=[];
  currentActivityCluster=null;
  nativeOptimisticSteering.clear();
  collectingTurnProcess=true;
}
function activateTurnProcessElement(element){
  if(!collectingTurnProcess||!element)return;
  ensureTurnProcessHeader();
  if(element.classList.contains('activityBatch')&&element.dataset.messageKind==='tool_activity'){
    if(!currentActivityCluster?.isConnected){
      currentActivityCluster=createActivityCluster();
      turnProcessElements.push(currentActivityCluster);
      turnProcessTimeline.appendChild(currentActivityCluster);
    }
    appendActivityBatchToCluster(currentActivityCluster,element);
    return currentActivityCluster;
  }
  currentActivityCluster=null;
  if(!turnProcessElements.includes(element))turnProcessElements.push(element);
  turnProcessTimeline.appendChild(element);
  return element;
}
function takeTurnProcessElements(){
  const elements=[...turnProcessElements];
  resetTurnProcessCollection();
  return elements;
}
function isTurnProcessMessage(role,kind){
  return role==='tool'||role==='process'||(role==='assistant'&&['commentary','live_progress'].includes(kind));
}
function collectTurnArtifactsFromDom(anchor,elements){
  const collected=[...elements];
  const children=[...chat.children];
  const anchorIndex=anchor?children.indexOf(anchor):children.length;
  let boundary=-1;
  for(let index=0;index<anchorIndex;index++){
    const child=children[index];
    if(child.classList?.contains('user')||child.classList?.contains('completionSummary'))boundary=index;
  }
  for(let index=boundary+1;index<children.length;index++){
    const child=children[index];
    if(child===anchor||!child.classList?.contains('msg'))continue;
    const kind=child.dataset.messageKind||'';
    const process=child.classList.contains('tool')||child.classList.contains('activityBatch')||(child.classList.contains('process')&&!child.classList.contains('completionSummary')&&!child.classList.contains('liveProcessHeader'));
    const assistant=child.classList.contains('assistant')&&['commentary','live_progress','final_answer'].includes(kind);
    if((process||assistant)&&!collected.includes(child))collected.push(child);
  }
  return collected;
}
function createCompletionMessage(text,processElements=[]){
  const el=document.createElement('details');
  el.className='msg process completionSummary';
  el.dataset.messageText=String(text||'');
  const summary=document.createElement('summary');
  const label=document.createElement('span');
  label.textContent=completionMessageTitle(text);
  const chevron=document.createElement('i');
  chevron.className='completionChevron';
  chevron.setAttribute('data-lucide','chevron-right');
  chevron.setAttribute('aria-hidden','true');
  summary.appendChild(label);
  summary.appendChild(chevron);
  const content=document.createElement('div');
  content.className='completionContent';
  if(processElements.length){
    const timeline=document.createElement('div');
    timeline.className='completionTimeline';
    for(const item of processElements){
      item.classList.remove('streaming');
      if(item.classList.contains('activityBatch'))settleTurnTool(item);
      if(item.classList.contains('activityCluster'))settleActivityCluster(item);
      if(item.tagName==='DETAILS')item.open=false;
      timeline.appendChild(item);
    }
    content.appendChild(timeline);
  }else{
    content.textContent=text;
  }
  el.appendChild(summary);
  el.appendChild(content);
  return el;
}
function appendInputImageToUser(userElement,source,at){
  if(!userElement?.isConnected||!userElement._messageBody)return null;
  const userAt=String(userElement.dataset.messageAt||'');
  const imageAt=String(at||'');
  if(userAt&&imageAt&&userAt!==imageAt)return null;
  let stack=userElement.querySelector(':scope > .userAttachmentStack');
  if(!stack){
    stack=document.createElement('div');
    stack.className='userAttachmentStack';
    userElement.insertBefore(stack,userElement._messageBody);
  }
  const existing=[...stack.querySelectorAll('img')].find((image)=>image.getAttribute('src')===source);
  if(existing)return existing.closest('button');
  const item=document.createElement('button');
  item.type='button';
  item.className='userAttachment';
  item.title='放大查看图片';
  item.setAttribute('aria-label','放大查看图片');
  const img=document.createElement('img');
  img.src=source;
  img.alt='用户上传的图片';
  img.loading='lazy';
  img.decoding='async';
  item.appendChild(img);
  item.addEventListener('click',()=>openImagePreview(source,img.alt,item));
  stack.appendChild(item);
  stack.classList.toggle('single',stack.children.length===1);
  userElement.classList.add('hasInputImage');
  return item;
}
function consumeNativeOptimisticSteering(text,at){
  const expected=String(text||'').trim();
  for(const [id,element] of nativeOptimisticSteering){
    if(!element?.isConnected){nativeOptimisticSteering.delete(id);continue}
    if(String(element.dataset.messageText||'').trim()!==expected)continue;
    nativeOptimisticSteering.delete(id);
    element.classList.remove('optimistic');
    delete element.dataset.optimisticQueueId;
    element.dataset.messageAt=String(at||element.dataset.messageAt||'');
    latestUserElement=element;
    return element;
  }
  return null;
}
function addMsg(role,text,options={}){
  const kind=String(options.kind||'');
  const steeringUser=role==='user'&&kind==='steering_user';
  const inputImage=role==='image'&&['input_image','steering_input_image'].includes(kind);
  if(role!=='user'&&!inputImage)latestUserElement=null;
  if(role==='thinking')return null;
  if(role==='tool'&&['function_call_output','custom_tool_call_output','tool_search_output'].includes(options.kind)){
    settleTurnTool(latestToolElement);
    return null;
  }
  if(role==='process'&&kind==='task_started'){
    beginTurnProcessCollection(options.at);
    latestToolElement=null;
    latestAssistantElement=null;
    latestFinalAssistantElement=null;
    return null;
  }
  if(role==='process'&&kind==='context_compacted'){
    if(!collectingTurnProcess)beginTurnProcessCollection();
    chat.querySelector('.empty')?.remove();
    const activity=appendTurnProcessActivity(text,kind);
    if(options.autoScroll!==false)scrollChatToLatest();
    return activity;
  }
  if(role==='user'){
    if(steeringUser){
      if(!collectingTurnProcess)beginTurnProcessCollection(options.at);
    }else{
      if(!collectingTurnProcess)beginTurnProcessCollection(options.at);
      latestToolElement=null;
      latestAssistantElement=null;
      latestFinalAssistantElement=null;
    }
  }
  const empty=chat.querySelector('.empty');
  if(empty)empty.remove();
  if(steeringUser&&!options.optimisticQueueId){
    const optimistic=consumeNativeOptimisticSteering(text,options.at);
    if(optimistic){
      if(options.autoScroll!==false)scrollChatToLatest();
      return optimistic;
    }
  }
  if(role==='process'&&kind==='task_complete'){
    const anchor=latestFinalAssistantElement?.parentNode===chat?latestFinalAssistantElement:null;
    const artifacts=collectTurnArtifactsFromDom(anchor,takeTurnProcessElements());
    const visibleActivities=artifacts.filter((item)=>item.dataset?.messageKind==='image_view_activity');
    const foldedActivities=artifacts.filter((item)=>item.dataset?.messageKind!=='image_view_activity');
    for(const item of visibleActivities)settleTurnTool(item);
    const completion=createCompletionMessage(text,foldedActivities);
    if(anchor){
      chat.insertBefore(completion,anchor);
      for(const item of visibleActivities)chat.insertBefore(item,anchor);
    }else{
      chat.appendChild(completion);
      for(const item of visibleActivities)chat.appendChild(item);
    }
    latestToolElement=null;
    refreshIcons(chat);
    if(options.autoScroll!==false)scrollChatToLatest();
    return completion;
  }
  if(collectingTurnProcess&&role==='tool'){
    const activity=appendTurnTool(text,options);
    latestToolElement=activity;
    if(options.autoScroll!==false)scrollChatToLatest();
    return activity;
  }
  if(inputImage){
    const attachment=appendInputImageToUser(latestUserElement,text,options.at);
    if(attachment){
      if(options.autoScroll!==false)scrollChatToLatest();
      return attachment;
    }
    latestUserElement=null;
  }
  const collapsible=role==='tool'||role==='thinking'||role==='context';
  const el=document.createElement(collapsible?'details':'div');
  el.className='msg '+role+(collapsible?' toolDetails':'')+(options.streaming?' streaming':'');
  if(role==='assistant'&&['commentary','live_progress'].includes(kind))el.classList.add('progressCommentary');
  if(role==='image'&&inputImage)el.classList.add('inputImage');
  el.dataset.messageText=String(text||'');
  el.dataset.messageKind=kind;
  el.dataset.messageAt=String(options.at||'');
  if(steeringUser){
    el.classList.add('steeringUser');
    if(options.optimisticQueueId){
      el.classList.add('optimistic');
      el.dataset.optimisticQueueId=String(options.optimisticQueueId);
    }
  }
  if(options.streaming&&collapsible)el.open=true;
  if(role==='image'){
    const img=document.createElement('img');
    img.src=text;
    img.alt=inputImage?'用户上传的图片':'生成的图片';
    img.loading='lazy';
    img.decoding='async';
    img.tabIndex=0;
    img.setAttribute('role','button');
    img.setAttribute('aria-label','放大查看图片');
    img.addEventListener('click',()=>openImagePreview(text,img.alt,img));
    img.addEventListener('keydown',(event)=>{
      if(!['Enter',' '].includes(event.key))return;
      event.preventDefault();
      openImagePreview(text,img.alt,img);
    });
    el.appendChild(img);
    if(!inputImage){
      const imageActions=document.createElement('div');
      imageActions.className='generatedImageActions';
      const applyBackground=document.createElement('button');
      applyBackground.type='button';
      applyBackground.className='generatedBackgroundApply';
      applyBackground.title='设为会话背景';
      applyBackground.setAttribute('aria-label','设为会话背景');
      setIconLabel(applyBackground,'paintbrush','设为会话背景',false);
      applyBackground.addEventListener('click',(event)=>{event.stopPropagation();applyGeneratedImageBackground(text,applyBackground)});
      imageActions.appendChild(applyBackground);
      el.appendChild(imageActions);
    }
  }else{
    const body=document.createElement('div');
    body.className='msgBody';
    if(role==='assistant'||role==='thinking')renderAssistantMarkdown(body,text);else body.textContent=text;
    const actions=document.createElement('div');
    actions.className='msgActions';
    if(['process','log'].includes(role)){
      const tag=document.createElement('span');
      tag.className='tag';
      tag.textContent=role==='process'?'过程':'日志';
      actions.appendChild(tag);
    }
    const copy=document.createElement('button');
    copy.type='button';
    copy.className='copyMsg messageAction';
    copy.title='复制此消息';
    copy.dataset.tooltip='复制';
    copy.setAttribute('aria-label','复制此消息');
    setIconLabel(copy,'copy','复制此消息',false);
    copy.addEventListener('click',(e)=>{e.stopPropagation();copyText(el.dataset.messageText||'',copy)});
    actions.appendChild(copy);
    if(role==='user'&&Number.isInteger(options.nativeMessageSeq)&&options.turnId){
      const fork=document.createElement('button');
      fork.type='button';
      fork.className='rollbackMsg messageAction';
      fork.title='从这里重新开始';
      fork.dataset.tooltip='从这里重新开始';
      fork.setAttribute('aria-label','从这里重新开始');
      setIconLabel(fork,'git-branch','从这里重新开始',false);
      fork.addEventListener('click',(e)=>{e.stopPropagation();forkNativeConversation(options.nativeMessageSeq)});
      actions.appendChild(fork);
    }else if(role==='user'&&Number.isInteger(options.messageIndex)){
      const rollback=document.createElement('button');
      rollback.type='button';
      rollback.className='rollbackMsg messageAction';
      rollback.title='回退到这条消息';
      rollback.dataset.tooltip='回退到这条消息';
      rollback.setAttribute('aria-label','回退到这条消息');
      setIconLabel(rollback,'rotate-ccw','回退到这条消息',false);
      rollback.addEventListener('click',(e)=>{e.stopPropagation();rollbackConversation(options.messageIndex)});
      actions.appendChild(rollback);
    }
    if(role==='assistant'&&Number.isInteger(options.nativeMessageSeq)&&options.turnId&&['','message','final_answer'].includes(kind)){
      const continueTask=document.createElement('button');
      continueTask.type='button';
      continueTask.className='continueMsg messageAction';
      continueTask.title='在新任务中继续';
      continueTask.dataset.tooltip='在新任务中继续';
      continueTask.setAttribute('aria-label','在新任务中继续');
      setIconLabel(continueTask,'corner-up-right','在新任务中继续',false);
      continueTask.addEventListener('click',(e)=>{e.stopPropagation();forkNativeConversation(options.nativeMessageSeq,{continueAfter:true})});
      actions.appendChild(continueTask);
    }
    if(['user','assistant'].includes(role)){
      const time=document.createElement('time');
      time.className='messageTime';
      time.dateTime=String(options.at||new Date().toISOString());
      time.textContent=formatMessageTime(time.dateTime);
      actions.appendChild(time);
    }
    if(collapsible){
      const summary=document.createElement('summary');
      const row=document.createElement('span');
      row.className='toolSummaryRow';
      const chevron=document.createElement('i');
      chevron.className='toolChevron';
      chevron.setAttribute('data-lucide','chevron-right');
      chevron.setAttribute('aria-hidden','true');
      const tag=document.createElement('span');
      tag.className='tag toolSummaryTag';
      tag.textContent=role==='tool'?'工具':role==='thinking'?'思考':'上下文';
      const label=document.createElement('span');
      label.className='toolSummaryText';
      label.textContent=role==='tool'?toolMessageTitle(text):role==='thinking'?thinkingMessageTitle(text):contextMessageTitle(text,options.kind);
      label.title=label.textContent;
      const content=document.createElement('div');
      content.className='toolContent';
      content.appendChild(body);
      content.appendChild(actions);
      row.appendChild(chevron);
      row.appendChild(tag);
      row.appendChild(label);
      summary.appendChild(row);
      el.appendChild(summary);
      el.appendChild(content);
      el._messageLabel=label;
    }else{
      el.appendChild(body);
      el.appendChild(actions);
    }
    el._messageBody=body;
  }
  if(role==='tool'&&latestToolElement?.parentNode)latestToolElement.remove();
  chat.appendChild(el);
  if(steeringUser||isTurnProcessMessage(role,kind))activateTurnProcessElement(el);
  refreshIcons(el);
  if(role==='tool')latestToolElement=el;
  if(role==='assistant'){
    latestAssistantElement=el;
    if(kind==='final_answer')latestFinalAssistantElement=el;
  }
  if(role==='user')latestUserElement=el;
  if(options.autoScroll!==false)scrollChatToLatest();
  return el;
}
function updateNativeLiveDelta(runtime){
  const itemId=String(runtime.itemId||'');
  const delta=String(runtime.delta||'');
  if(!itemId||!delta)return;
  removeNativeRunningElement();
  if(!collectingTurnProcess)beginTurnProcessCollection();
  let live=nativeLiveItems.get(itemId);
  if(!live){
    const element=addMsg('assistant','',{streaming:true,kind:'live_progress'});
    live={role:'assistant',element,text:'',targetText:'',complete:false,renderTimer:null};
    nativeLiveItems.set(itemId,live);
    statusEl.textContent='Codex App · 正在处理';
    statusEl.classList.add('running');
  }
  activateTurnProcessElement(live.element);
  live.targetText+=delta;
  scheduleNativeLiveRender(live);
}
function scheduleNativeLiveRender(live){
  if(live.renderTimer)return;
  live.renderTimer=setTimeout(()=>{
    live.renderTimer=null;
    pumpNativeLiveRender(live);
  },32);
}
function pumpNativeLiveRender(live){
  const remaining=live.targetText.length-live.text.length;
  if(remaining>0){
    const step=remaining>1500?240:remaining>600?120:remaining>180?48:remaining>60?18:6;
    live.text=live.targetText.slice(0,live.text.length+step);
    renderNativeLiveItem(live);
  }
  if(live.text.length<live.targetText.length){
    scheduleNativeLiveRender(live);
  }else if(live.complete){
    settleNativeLiveItem(live);
  }
}
function renderNativeLiveItem(live){
  live.element.dataset.messageText=live.text;
  if(live.element._messageBody)renderAssistantMarkdown(live.element._messageBody,live.text);
  scrollChatToLatest();
}
function settleNativeLiveItem(live){
  live.element.classList.remove('streaming');
}
function finishNativeLiveItem(itemId){
  const live=nativeLiveItems.get(String(itemId||''));
  if(!live)return;
  live.complete=true;
  if(live.text.length<live.targetText.length)scheduleNativeLiveRender(live);else settleNativeLiveItem(live);
}
function finishAllNativeLiveItems(){
  for(const live of nativeLiveItems.values()){
    if(live.renderTimer)clearTimeout(live.renderTimer);
    live.renderTimer=null;
    live.complete=true;
    if(live.text!==live.targetText){live.text=live.targetText;renderNativeLiveItem(live)}
    settleNativeLiveItem(live);
  }
}
async function copyText(text,button){try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text)}else{const tmp=document.createElement('textarea');tmp.value=text;tmp.setAttribute('readonly','');tmp.style.position='fixed';tmp.style.left='-9999px';document.body.appendChild(tmp);tmp.select();document.execCommand('copy');tmp.remove()}setIconLabel(button,'check','复制成功',false);setTimeout(()=>setIconLabel(button,'copy','复制此消息',false),1200)}catch(e){setIconLabel(button,'circle-alert','复制失败',false);setTimeout(()=>setIconLabel(button,'copy','复制此消息',false),1200)}}
function hasFileDrag(e){return [...(e.dataTransfer?.items||[])].some((item)=>item.kind==='file')}
function handleAttachmentPaste(e){const files=[...(e.clipboardData?.items||[])].filter((item)=>item.kind==='file'&&item.type.startsWith('image/')).map((item)=>item.getAsFile()).filter(Boolean);if(!files.length)return;e.preventDefault();e.stopPropagation();handleAttachmentFiles(files)}
async function handleAttachmentFiles(fileList){const files=[...(fileList||[])];if(!files.length)return;for(const file of files){if(pendingAttachments.length>=12){statusEl.textContent='最多一次上传 12 个附件';break}try{statusEl.textContent='上传附件...';const data=await readFileDataUrl(file);const res=await fetch('/api/uploads/file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name,type:file.type,data})});const body=await res.json();if(!res.ok)throw new Error(body.error||'上传失败');pendingAttachments.push(body.attachment);renderAttachmentTray();statusEl.textContent='已添加附件'}catch(e){statusEl.textContent=e.message}}input.focus()}
function readFileDataUrl(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('读取文件失败'));reader.readAsDataURL(file)})}
function formatBytes(size){if(!Number.isFinite(size))return '';if(size<1024)return size+' B';if(size<1024*1024)return (size/1024).toFixed(1)+' KB';return (size/1024/1024).toFixed(1)+' MB'}
function fileLabel(attachment){const ext=(attachment.name||'file').split('.').pop()||'file';return ext.slice(0,4)}
function renderAttachmentTray(){attachmentTray.innerHTML='';attachmentTray.classList.toggle('hidden',pendingAttachments.length===0);pendingAttachments.forEach((attachment,index)=>{const chip=document.createElement('div');chip.className='attachmentChip';if(attachment.kind==='image'){const img=document.createElement('img');img.src=attachment.url;img.alt=attachment.name||'uploaded image';chip.appendChild(img)}else{const icon=document.createElement('div');icon.className='attachmentIcon';icon.textContent=fileLabel(attachment);chip.appendChild(icon)}const text=document.createElement('div');text.className='attachmentText';const name=document.createElement('span');name.textContent=attachment.name||'attachment';const meta=document.createElement('span');meta.className='attachmentMeta';meta.textContent=(attachment.kind==='image'?'图片':'文件')+(attachment.size?' · '+formatBytes(attachment.size):'');text.appendChild(name);text.appendChild(meta);const remove=document.createElement('button');remove.type='button';remove.title='移除附件';remove.setAttribute('aria-label','移除附件');setIconLabel(remove,'x','移除附件',false);remove.addEventListener('click',()=>{pendingAttachments.splice(index,1);renderAttachmentTray();input.focus()});chip.appendChild(text);chip.appendChild(remove);attachmentTray.appendChild(chip);refreshIcons(chip)});applyConversationMode()}
function clearPendingAttachments(){pendingAttachments=[];renderAttachmentTray()}
function clearNativeOptimisticElements(){for(const element of nativeOptimisticElements){if(element?.parentNode)element.remove()}nativeOptimisticElements=[]}
function removeNativeRunningElement(){if(nativeRunningElement?.parentNode)nativeRunningElement.remove();nativeRunningElement=null}
async function refreshNativeRequests(){try{const res=await fetch('/api/native-requests');if(!res.ok)return;const data=await res.json();renderNativeRequest((data.requests||[])[0]||null)}catch(e){}}
function renderNativeRequest(request){
  currentNativeRequest=request;
  nativeRequestModal.classList.toggle('hidden',!request);
  if(!request)return;
  nativeRequestTitle.textContent=nativeRequestLabel(request.method);
  nativeRequestMeta.textContent=(request.threadId?'会话 '+request.threadId.slice(0,8):'Codex App')+(request.createdAt?' · '+new Date(request.createdAt).toLocaleString():'');
  nativeRequestDetail.textContent=nativeRequestSummary(request);
  nativeRequestDetail.classList.toggle('hidden',!nativeRequestDetail.textContent);
  nativeRequestFields.innerHTML='';
  nativeRequestActions.innerHTML='';
  if(request.method==='item/tool/requestUserInput'){
    for(const question of request.params?.questions||[])renderQuestionField(question);
    addRequestAction('提交答案','primary',()=>submitQuestionAnswers(request));
    return;
  }
  if(request.method==='mcpServer/elicitation/request'){
    renderMcpRequestFields(request);
    addRequestAction('允许','primary',()=>submitMcpResponse(request,'accept'));
    addRequestAction('拒绝','',()=>respondNativeRequest({action:'decline'}));
    addRequestAction('取消任务','danger',()=>respondNativeRequest({action:'cancel'}));
    return;
  }
  addRequestAction('允许一次','primary',()=>respondNativeRequest({decision:'accept'}));
  addRequestAction('本会话允许','',()=>respondNativeRequest({decision:'acceptForSession'}));
  addRequestAction('拒绝','',()=>respondNativeRequest({decision:'decline'}));
  addRequestAction('取消任务','danger',()=>respondNativeRequest({decision:'cancel'}));
}
function nativeRequestLabel(method){return {'item/commandExecution/requestApproval':'确认命令执行','execCommandApproval':'确认命令执行','item/fileChange/requestApproval':'确认文件修改','applyPatchApproval':'确认文件修改','item/permissions/requestApproval':'确认额外权限','item/tool/requestUserInput':'Codex 需要你的选择','mcpServer/elicitation/request':'MCP 请求信息'}[method]||'Codex 请求确认'}
function nativeRequestSummary(request){const p=request.params||{};if(request.method.includes('commandExecution')||request.method==='execCommandApproval'){const command=Array.isArray(p.command)?p.command.join(' '):p.command||'';return [p.reason,p.cwd?'目录: '+p.cwd:'',command?'命令:\\n'+command:''].filter(Boolean).join('\\n\\n')}if(request.method.includes('fileChange')||request.method==='applyPatchApproval'){return [p.reason,p.grantRoot?'写入范围: '+p.grantRoot:'',p.fileChanges?JSON.stringify(p.fileChanges,null,2):''].filter(Boolean).join('\\n\\n')}if(request.method.includes('permissions'))return [p.reason,p.cwd?'目录: '+p.cwd:'',JSON.stringify(p.permissions||{},null,2)].filter(Boolean).join('\\n\\n');if(request.method.includes('requestUserInput'))return (p.questions||[]).map((q)=>q.header+'\\n'+q.question).join('\\n\\n');if(request.method.includes('elicitation'))return [p.serverName?'MCP: '+p.serverName:'',p.message,p.url].filter(Boolean).join('\\n\\n');return JSON.stringify(p,null,2)}
function renderQuestionField(question){const field=document.createElement('div');field.className='requestField';const label=document.createElement('label');label.textContent=(question.header?question.header+' · ':'')+question.question;const input=document.createElement('input');input.dataset.questionId=question.id;input.type=question.isSecret?'password':'text';input.autocomplete=question.isSecret?'off':'on';const options=question.options||[];if(options.length){const list=document.createElement('datalist');list.id='request-options-'+question.id.replace(/[^A-Za-z0-9_-]/g,'');for(const option of options){const item=document.createElement('option');item.value=option.label;item.label=option.description||option.label;list.appendChild(item)}input.setAttribute('list',list.id);field.appendChild(list);input.placeholder=question.isOther?'选择或输入其他答案':'选择一个答案'}field.appendChild(label);field.appendChild(input);nativeRequestFields.appendChild(field)}
function renderMcpRequestFields(request){const p=request.params||{};if(p.mode==='url'&&p.url){const field=document.createElement('div');field.className='requestField';const link=document.createElement('a');link.className='requestLink';link.href=p.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=p.url;field.appendChild(link);nativeRequestFields.appendChild(field);return}const schema=p.requestedSchema;if(!schema?.properties){const field=document.createElement('div');field.className='requestField';const label=document.createElement('label');label.textContent='返回内容 JSON';const area=document.createElement('textarea');area.rows=5;area.dataset.mcpJson='true';area.value='{}';field.appendChild(label);field.appendChild(area);nativeRequestFields.appendChild(field);return}for(const [key,definition] of Object.entries(schema.properties)){const field=document.createElement('div');field.className='requestField';const label=document.createElement('label');label.textContent=(definition.title||key)+((schema.required||[]).includes(key)?' *':'');let control;const values=definition.enum||(definition.oneOf||[]).map((item)=>item.const).filter((item)=>item!==undefined);if(definition.type==='boolean'||values.length){control=document.createElement('select');const options=definition.type==='boolean'?['true','false']:values;for(const value of options){const option=document.createElement('option');option.value=String(value);option.textContent=String(value);control.appendChild(option)}}else{control=document.createElement('input');control.type=['number','integer'].includes(definition.type)?'number':'text';if(definition.default!==undefined&&definition.default!==null)control.value=String(definition.default)}control.dataset.mcpKey=key;control.dataset.mcpType=definition.type||'string';field.appendChild(label);field.appendChild(control);nativeRequestFields.appendChild(field)}}
function addRequestAction(label,kind,handler){const button=document.createElement('button');button.type='button';button.className='requestAction'+(kind?' '+kind:'');button.textContent=label;button.addEventListener('click',handler);nativeRequestActions.appendChild(button)}
async function submitQuestionAnswers(request){const answers={};for(const input of nativeRequestFields.querySelectorAll('[data-question-id]'))answers[input.dataset.questionId]=input.value;await respondNativeRequest({answers})}
async function submitMcpResponse(request,action){let content={};const json=nativeRequestFields.querySelector('[data-mcp-json]');if(json){try{content=JSON.parse(json.value||'{}')}catch(e){statusEl.textContent='MCP 返回内容必须是有效 JSON';return}}else{for(const control of nativeRequestFields.querySelectorAll('[data-mcp-key]')){let value=control.value;if(control.dataset.mcpType==='boolean')value=value==='true';else if(['number','integer'].includes(control.dataset.mcpType))value=Number(value);content[control.dataset.mcpKey]=value}}await respondNativeRequest({action,content})}
async function respondNativeRequest(payload){if(!currentNativeRequest)return;for(const button of nativeRequestActions.querySelectorAll('button'))button.disabled=true;statusEl.textContent='提交确认...';try{const res=await fetch('/api/native-requests/'+encodeURIComponent(currentNativeRequest.id)+'/respond',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await res.json();if(!res.ok)throw new Error(data.error||'提交失败');currentNativeRequest=null;nativeRequestModal.classList.add('hidden');statusEl.textContent='确认已提交';await refreshNativeRequests()}catch(e){statusEl.textContent=e.message;for(const button of nativeRequestActions.querySelectorAll('button'))button.disabled=false}}
function updateSafetyHint(){const mode=sandbox.value;safetyHint.className='safety '+(mode==='read-only'?'safe':mode==='workspace-write'?'warn':'danger');safetyHint.textContent=mode==='read-only'?'只读 · 不写入文件':mode==='workspace-write'?'工作区写入 · 当前目录':'高危全权限 · 首次发送需确认'}
let completeAudioCtx;
function playTaskCompleteSound(){try{const AudioContext=window.AudioContext||window.webkitAudioContext;if(!AudioContext)return;if(!completeAudioCtx)completeAudioCtx=new AudioContext();completeAudioCtx.resume?.();const now=completeAudioCtx.currentTime;const master=completeAudioCtx.createGain();master.gain.setValueAtTime(1.15,now);master.connect(completeAudioCtx.destination);[[660,0,.12],[880,.13,.22]].forEach(([freq,offset,duration])=>{const osc=completeAudioCtx.createOscillator();const gain=completeAudioCtx.createGain();osc.type='triangle';osc.frequency.value=freq;gain.gain.setValueAtTime(0.0001,now+offset);gain.gain.exponentialRampToValueAtTime(0.55,now+offset+0.006);gain.gain.exponentialRampToValueAtTime(0.0001,now+offset+duration);osc.connect(gain);gain.connect(master);osc.start(now+offset);osc.stop(now+offset+duration+.02)})}catch(e){}}
async function cancelRun(){closeComposerPopovers();if(currentConversationSource!=='codex'||!currentConversationId)return;cancelBtn.disabled=true;statusEl.textContent='正在取消...';try{const res=await fetch('/api/native-sessions/'+encodeURIComponent(currentConversationId)+'/interrupt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({turnId:activeNativeTurnId})});const data=await res.json();if(!res.ok)throw new Error(data.error||'取消失败');addMsg('log','已请求取消当前任务。');webRunActive=false;activeNativeTurnId='';removeNativeRunningElement();statusEl.textContent='Cancelled';applyConversationMode();setTimeout(syncCurrentNativeConversation,180);refreshHistory()}catch(e){statusEl.textContent=e.message;cancelBtn.disabled=false}}
async function send(){
  closeComposerPopovers();
  const text=input.value.trim();
  const attachments=[...pendingAttachments];
  if((!text&&!attachments.length)||sendBtn.disabled)return;
  const existingId=currentConversationSource==='codex'?currentConversationId:'';
  if(existingId&&webRunActive){
    enqueuePrompt(text,attachments);
    return;
  }
  if(sandbox.value==='danger-full-access'&&!dangerConfirmed){
    if(!confirm('当前是高危全权限。本任务可能修改系统文件、运行高危命令或跨目录操作。本会话确认一次后，除非切换权限模式，否则不再提示。确认继续？'))return;
    dangerConfirmed=true;
  }
  input.value='';
  input.style.height='auto';
  clearPendingAttachments();
  showNativePromptOptimistically({message:text,attachments});
  webRunActive=true;
  activeNativeTurnId='';
  applyConversationMode();
  statusEl.textContent='Codex App · 运行中';
  try{
    const endpoint=existingId?'/api/native-sessions/'+encodeURIComponent(existingId)+'/turns':'/api/native-sessions';
    const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,attachments,provider:provider.value,model:model.value,reasoningEffort:reasoningEffort.value,cwd:cwd.value,sandbox:sandbox.value,approval:approval.value})});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||res.statusText);
    currentConversationSource='codex';
    currentConversationId=data.threadId;
    activeNativeTurnId=data.turnId||'';
    if(!existingId){nativeCursor=0;nativeGeneration=0}
    updateActiveHistory();
    nativeNotice.textContent='Codex App 会话 · 双向同步';
    setTimeout(syncCurrentNativeConversation,240);
    refreshHistory();
  }catch(e){
    webRunActive=false;
    activeNativeTurnId='';
    removeNativeRunningElement();
    clearNativeOptimisticElements();
    input.value=text;
    input.style.height=Math.min(input.scrollHeight,180)+'px';
    pendingAttachments=attachments;
    renderAttachmentTray();
    addMsg('assistant','错误: '+e.message);
    statusEl.textContent='Ready';
    applyConversationMode();
    input.focus();
    refreshHistory();
  }
}
</script>
<script src="/image-prompt.js"></script>
</body>
</html>`;
}
