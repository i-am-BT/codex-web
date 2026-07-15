import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('login, read-only config, CLI arguments, and session restart', { timeout: 30000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-test-'));
  const runtime = path.join(temporary, 'runtime');
  const codexHome = path.join(temporary, 'codex-home');
  const fakeCodex = path.join(temporary, 'fake-codex.mjs');
  const traceFile = path.join(temporary, 'codex-trace.json');
  const appServerTraceFile = path.join(temporary, 'app-server-trace.jsonl');
  const webEnv = path.join(temporary, 'web.env');
  const nativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa729';
  const createdNativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa799';
  const archivedNativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa730';
  const automationNativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa731';
  let child;
  let desktopIpc;

  try {
    await mkdir(runtime, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), `model_provider = "fake"
model = "test-model"
model_reasoning_effort = "max"

[model_providers.fake]
name = "Fake"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "test-token"
`);
    const nativeSessionDir = path.join(codexHome, 'sessions', '2026', '07', '11');
    await mkdir(nativeSessionDir, { recursive: true });
    await writeFile(path.join(codexHome, 'session_index.jsonl'), [
      JSON.stringify({
        id: nativeSessionId,
        thread_name: 'Codex App fixture',
        updated_at: '2026-07-11T04:52:32Z',
      }),
      JSON.stringify({
        id: automationNativeSessionId,
        thread_name: 'Automation fixture',
        updated_at: '2026-07-11T04:52:34Z',
      }),
      '',
    ].join('\n'));
    const nativeSessionFile = path.join(
      nativeSessionDir,
      `rollout-2026-07-11T12-52-18-${nativeSessionId}.jsonl`,
    );
    await writeFile(
      nativeSessionFile,
      [
        JSON.stringify({
          timestamp: '2026-07-11T04:52:31.928Z',
          type: 'session_meta',
          payload: {
            id: nativeSessionId,
            timestamp: '2026-07-11T04:52:31.928Z',
            cwd: temporary,
            model_provider: 'fake',
            originator: 'Codex Desktop',
            source: 'vscode',
            cli_version: 'test',
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:32.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'native fixture message' },
              { type: 'input_image', image_url: 'data:image/png;base64,c21va2U=' },
            ],
          },
        }),
        '',
      ].join('\n'),
    );
    const archivedNativeSessionFile = path.join(
      nativeSessionDir,
      `rollout-2026-07-11T12-52-19-${archivedNativeSessionId}.jsonl`,
    );
    await writeFile(
      archivedNativeSessionFile,
      `${JSON.stringify({
        timestamp: '2026-07-11T04:52:33.000Z',
        type: 'session_meta',
        payload: {
          id: archivedNativeSessionId,
          source: 'vscode',
          cli_version: 'test',
        },
      })}\n`,
    );
    const automationNativeSessionFile = path.join(
      nativeSessionDir,
      `rollout-2026-07-11T12-52-20-${automationNativeSessionId}.jsonl`,
    );
    await writeFile(
      automationNativeSessionFile,
      `${JSON.stringify({
        timestamp: '2026-07-11T04:52:34.000Z',
        type: 'session_meta',
        payload: {
          id: automationNativeSessionId,
          source: 'vscode',
          cli_version: 'test',
        },
      })}\n`,
    );
    const stateDb = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
    stateDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        source TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        preview TEXT NOT NULL DEFAULT '',
        cli_version TEXT NOT NULL DEFAULT '',
        thread_source TEXT,
        created_at_ms INTEGER,
        updated_at_ms INTEGER,
        recency_at_ms INTEGER
      )
    `);
    const insertThread = stateDb.prepare(`
      INSERT INTO threads (
        id, rollout_path, source, cwd, title, archived, preview, cli_version, thread_source,
        created_at_ms, updated_at_ms, recency_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertThread.run(
      nativeSessionId,
      nativeSessionFile,
      'vscode',
      temporary,
      'Codex App fixture',
      0,
      'native fixture message',
      'test',
      'user',
      1783745551928,
      1783745552000,
      1783745552000,
    );
    insertThread.run(
      archivedNativeSessionId,
      archivedNativeSessionFile,
      'vscode',
      temporary,
      1,
      'archived fixture message',
      'test',
      'user',
      1783745553000,
      1783745553000,
      1783745553000,
    );
    insertThread.run(
      automationNativeSessionId,
      automationNativeSessionFile,
      'vscode',
      temporary,
      0,
      'Automation: Fixture\nAutomation ID: fixture\nAutomation memory: $CODEX_HOME/automations/fixture/memory.md',
      'test',
      'user',
      1783745554000,
      1783745554000,
      1783745554000,
    );
    stateDb.close();
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli test');
  process.exit(0);
}
if (args[0] === 'app-server') {
  const createdThreadId = '${createdNativeSessionId}';
  const fixtureThreadId = '${nativeSessionId}';
  const thread = (id) => ({
    id,
    sessionId: id,
    source: 'appServer',
    threadSource: 'user',
    cwd: process.env.HOME,
    cliVersion: 'test',
    createdAt: 1783745551,
    updatedAt: 1783745552,
    recencyAt: 1783745552,
    preview: 'native app-server fixture',
    name: null,
    modelProvider: 'fake',
    status: { type: 'idle' },
    turns: [],
    ephemeral: false
  });
  const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      appendFileSync(process.env.FAKE_APP_SERVER_TRACE, JSON.stringify(message) + '\\n');
      if (!Object.hasOwn(message, 'id') || !message.method) continue;
      if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake' } });
      else if (message.method === 'thread/start') send({ id: message.id, result: { thread: thread(createdThreadId) } });
      else if (message.method === 'thread/resume') send({ id: message.id, result: { thread: thread(message.params.threadId || fixtureThreadId) } });
      else if (message.method === 'turn/start') {
        const turnId = '019f4f84-ea9f-73c2-b997-deba7b4aa798';
        send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
        send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
        const text = (message.params.input || []).find((item) => item.type === 'text')?.text || '';
        if (text.includes('needs approval')) {
          send({
            id: 'approval-1',
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: message.params.threadId,
              turnId,
              itemId: 'item-1',
              startedAtMs: Date.now(),
              command: 'printf test',
              cwd: process.env.HOME,
              reason: 'test approval'
            }
          });
        }
      }
      else if (message.method === 'turn/steer') {
        send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
      }
      else if (['thread/name/set', 'thread/archive', 'turn/interrupt'].includes(message.method)) {
        send({ id: message.id, result: {} });
      }
      else send({ id: message.id, error: { code: -32601, message: 'unsupported fake method' } });
    }
  });
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  writeFileSync(process.env.FAKE_CODEX_TRACE, JSON.stringify({
    args,
    input,
    home: process.env.HOME,
    codexHome: process.env.CODEX_HOME
  }, null, 2));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'FAKE_OK' } }));
}
`);
    await chmod(fakeCodex, 0o755);

    desktopIpc = await createDesktopIpcFixture(temporary);
    child = await startServer({
      temporary,
      runtime,
      codexHome,
      fakeCodex,
      traceFile,
      appServerTraceFile,
      desktopIpcEnabled: 'true',
      desktopIpcSocket: desktopIpc.socketPath,
    });
    let port = await waitForServer(child, runtime);
    const baseUrl = `http://127.0.0.1:${port}`;

    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const homepageDisabled = await fetch(`${baseUrl}/api/homepage/stats`);
    assert.equal(homepageDisabled.status, 503);

    const markedAsset = await fetch(`${baseUrl}/vendor/marked.js`);
    assert.equal(markedAsset.status, 200);
    assert.match(await markedAsset.text(), /marked v18/);

    const purifyAsset = await fetch(`${baseUrl}/vendor/purify.js`);
    assert.equal(purifyAsset.status, 200);
    assert.match(await purifyAsset.text(), /DOMPurify 3/);

    const uiAsset = await fetch(`${baseUrl}/ui.css`);
    assert.equal(uiAsset.status, 200);
    const uiStyles = await uiAsset.text();
    assert.match(uiStyles, /\.historyProjectHead\[aria-expanded="true"\]/);
    assert.match(uiStyles, /\.historyProjectItems\[hidden\]/);
    assert.match(uiStyles, /\.memoryCitations\[open\]/);
    assert.match(uiStyles, /\.memoryCitationItem\[open\]/);
    assert.match(uiStyles, /\.composerModelToggle/);
    assert.match(uiStyles, /\.composerPermissionToggle/);
    assert.match(uiStyles, /\.promptQueueRow/);
    assert.match(uiStyles, /\.box\.runActive/);
    assert.match(uiStyles, /\.msg\.user:hover \.msgActions/);
    assert.match(uiStyles, /\.msg\.user::after\s*\{[^}]*width:\s*min\(124px, 100%\);[^}]*height:\s*6px/s);
    assert.match(uiStyles, /\.msg\.user \.msgActions\s*\{[^}]*top:\s*calc\(100% - 1px\);[^}]*padding:\s*5px 0 0 8px/s);
    assert.match(uiStyles, /\.completionTimeline > \.activityBatch \+ \.activityBatch/);
    assert.match(uiStyles, /body \.msg\.process\.completionSummary\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%/s);
    assert.match(uiStyles, /body\[data-theme\] \.msg\.assistant\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%/s);
    assert.match(uiStyles, /\.msg\.assistant > \.msgBody > :not\(\.memoryCitations\)\s*\{[^}]*max-width:\s*min\(780px, 100%\)/s);
    assert.match(uiStyles, /\.msg\.assistant > \.msgActions\s*\{[^}]*width:\s*100%/s);
    assert.match(uiStyles, /\.memoryCitations\s*\{[^}]*width:\s*100%/s);
    assert.match(uiStyles, /\.imagePreview\s*\{/);
    assert.match(uiStyles, /\.userAttachmentStack\s*\{/);
    assert.match(uiStyles, /\.settingsDialog/);

    const unauthorized = await fetch(`${baseUrl}/api/config`);
    assert.equal(unauthorized.status, 401);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];

    const pageResponse = await fetch(baseUrl, { headers: { Cookie: cookie } });
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /src="\/vendor\/marked\.js"/);
    assert.match(page, /src="\/vendor\/purify\.js"/);
    assert.match(page, /function renderAssistantMarkdown/);
    assert.match(page, /function toolActivityPresentations/);
    assert.match(page, /activityBatch/);
    assert.match(page, /liveProcessPanel/);
    assert.match(page, /function appendInputImageToUser/);
    assert.match(page, /latestUserElement/);
    assert.match(page, /addMsg\('image',attachment\.url,\{kind:'input_image'\}\)/);
    assert.match(page, /function runningActivityVerb/);
    assert.match(page, /turnProcessAutoFollow/);
    assert.match(page, /上下文已自动压缩/);
    assert.doesNotMatch(page, /function appendTurnThinking/);
    assert.match(page, /id="sidePanel"/);
    assert.match(page, /function syncMenuButton/);
    assert.match(page, /sideCollapsed/);
    assert.match(page, /function setHistoryProjectExpanded/);
    assert.match(page, /codexWeb\.historyProjectsCollapsed/);
    assert.match(page, /function extractMemoryCitations/);
    assert.match(page, /function renderMemoryCitations/);
    assert.match(page, /group\.open=false/);
    assert.match(page, /function enhanceComposer/);
    assert.match(page, /function enqueuePrompt/);
    assert.match(page, /function steerQueuedPrompt/);
    assert.match(page, /function dispatchNextQueuedPrompt/);
    assert.match(page, /createTrailingSingleFlight\(syncCurrentNativeConversationOnce\)/);
    assert.match(page, /e\.isComposing\|\|e\.keyCode===229/);
    assert.match(page, /if\(!e\.repeat\)send\(\)/);
    assert.match(page, /function formatMessageTime/);
    assert.match(page, /function enhanceSettingsModal/);
    assert.match(page, /function openImagePreview/);
    assert.doesNotMatch(page, /查看原图/);
    assert.match(page, /\/api\/password/);
    assert.match(page, /codexWeb\.promptQueue\.v1/);
    assert.match(page, /inputImage/);
    assert.match(page, /boot\(true\)/);
    assert.match(page, /async function boot\(selectRecent=false\)/);
    const inlineScript = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(inlineScript);
    assert.doesNotThrow(() => new Function(inlineScript));
    const singleFlightHelper = inlineScript.match(/(function createTrailingSingleFlight[\s\S]*?)(?=function readPromptQueues)/)?.[1];
    assert.ok(singleFlightHelper);
    const createTrailingSingleFlight = new Function(
      singleFlightHelper + '; return createTrailingSingleFlight;',
    )();
    let singleFlightRuns = 0;
    const singleFlightReleases = [];
    const runSingleFlight = createTrailingSingleFlight(async () => {
      singleFlightRuns += 1;
      await new Promise((resolve) => singleFlightReleases.push(resolve));
    });
    const firstSingleFlight = runSingleFlight();
    const joinedSingleFlight = runSingleFlight();
    assert.equal(firstSingleFlight, joinedSingleFlight);
    assert.equal(singleFlightRuns, 1);
    singleFlightReleases.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(singleFlightRuns, 2);
    singleFlightReleases.shift()();
    await firstSingleFlight;
    const composerLabelHelpers = inlineScript.match(/(function composerModelLabel[\s\S]*?)(?=function closeComposerPopovers)/)?.[1];
    assert.ok(composerLabelHelpers);
    const composerLabels = new Function(
      composerLabelHelpers + '; return { composerModelLabel, composerEffortLabel };',
    )();
    assert.equal(composerLabels.composerModelLabel('gpt-5.6-sol'), '5.6 Sol');
    assert.equal(composerLabels.composerEffortLabel('xhigh'), '极高');
    const memoryHelper = inlineScript.match(/(function extractMemoryCitations[\s\S]*?)(?=function memoryCitationTitle)/)?.[1];
    assert.ok(memoryHelper);
    const parseMemoryCitations = new Function(memoryHelper + '; return extractMemoryCitations;')();
    assert.deepEqual(parseMemoryCitations([
      '完成。',
      '<oai-mem-citation>',
      '<citation_entries>',
      'MEMORY.md:18-26|note=[reused UI direction]',
      'rollout_summaries/2026-07-11T04-52-18-demo.md:19-37|note=[reused verification path]',
      '</citation_entries>',
      '<rollout_ids>',
      '019f4f84-ea9f-73c2-b997-deba7b4aa729',
      '</rollout_ids>',
      '</oai-mem-citation>',
    ].join('\n')), {
      markdown: '完成。',
      citations: [
        { file: 'MEMORY.md', start: 18, end: 26, note: 'reused UI direction' },
        {
          file: 'rollout_summaries/2026-07-11T04-52-18-demo.md',
          start: 19,
          end: 37,
          note: 'reused verification path',
        },
      ],
    });
    const activityHelpers = inlineScript.match(/(function decodeEmbeddedToolString[\s\S]*?)(?=function toolMessageTitle)/)?.[1];
    assert.ok(activityHelpers);
    const parseToolActivity = new Function(`${activityHelpers}; return toolActivityPresentations;`)();
    assert.deepEqual(parseToolActivity("exec_command\nsed -n '1,40p' server.mjs\nworkdir=/workspace"), [{
      verb: '已读取',
      target: 'server.mjs',
      icon: 'book-open',
    }]);
    assert.deepEqual(parseToolActivity('exec\nconst result = await tools.exec_command({cmd:"sed -n \'1,40p\' server.mjs", workdir:"/workspace"});'), [{
      verb: '已读取',
      target: 'server.mjs',
      icon: 'book-open',
    }]);
    assert.deepEqual(parseToolActivity('exec_command\nrg -n "menuBtn|toggleMenu" server.mjs ui.css'), [{
      verb: '已搜索',
      target: 'server.mjs、ui.css · “menuBtn|toggleMenu”',
      icon: 'search',
    }]);
    const orchestratedCall = [
      'exec',
      'const calls = await Promise.all([',
      '  tools.view_image({path:"/tmp/reference.png"}),',
      '  tools.exec_command({cmd:"sed -n \'1,40p\' server.mjs"}),',
      '  tools.exec_command({cmd:"rg -n \\"composer\\" ui.css"}),',
      ']);',
    ].join('\n');
    assert.deepEqual(parseToolActivity(orchestratedCall), [
      { verb: '已查看', target: '1 张图像', icon: 'images' },
      { verb: '已读取文件并运行了多个命令', icon: 'search' },
    ]);
    const patchCall = 'exec\nconst patch = "*** Begin Patch\\n*** Update File: /workspace/server.mjs\\n-old\\n+new\\n*** Update File: /workspace/ui.css\\n+added\\n*** End Patch";\ntext(await tools.apply_patch(patch));';
    assert.deepEqual(parseToolActivity(patchCall), [
      { verb: '已编辑', icon: 'pencil', target: 'server.mjs', added: 1, removed: 1, meta: '+1 -1' },
      { verb: '已编辑', icon: 'pencil', target: 'ui.css', added: 1, removed: 0, meta: '+1 -0' },
    ]);

    const configResponse = await fetch(`${baseUrl}/api/config`, { headers: { Cookie: cookie } });
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json();
    assert.equal(config.defaults.model, 'test-model');
    assert.equal(config.defaults.reasoningEffort, 'max');
    assert.equal(config.capabilities.manageProviders, false);
    assert.ok(config.conversations.some((conversation) => (
      conversation.id === nativeSessionId
      && conversation.source === 'codex'
      && conversation.title === 'Codex App fixture'
      && conversation.cwd === temporary
    )));
    assert.equal(config.conversations.some((conversation) => conversation.id === archivedNativeSessionId), false);
    assert.equal(config.conversations.some((conversation) => conversation.id === automationNativeSessionId), false);

    const nativeSessions = await fetch(`${baseUrl}/api/native-sessions`, {
      headers: { Cookie: cookie },
    });
    assert.equal(nativeSessions.status, 200);
    const nativeSessionsPayload = await nativeSessions.json();
    assert.deepEqual(nativeSessionsPayload.sessions.map((session) => session.id), [nativeSessionId]);
    assert.equal(nativeSessionsPayload.sessions[0].cwd, temporary);

    const nativeSession = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(nativeSession.status, 200);
    const nativeConversation = (await nativeSession.json()).conversation;
    assert.equal(nativeConversation.source, 'codex');
    assert.equal(nativeConversation.readOnly, false);
    assert.ok(nativeConversation.messages.some((message) => (
      message.role === 'user' && message.content === 'native fixture message'
    )));
    assert.ok(nativeConversation.messages.some((message) => (
      message.role === 'image'
      && message.kind === 'input_image'
      && message.content === 'data:image/png;base64,c21va2U='
    )));

    const archivedNativeSession = await fetch(`${baseUrl}/api/native-sessions/${archivedNativeSessionId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(archivedNativeSession.status, 404);

    const automationNativeSession = await fetch(`${baseUrl}/api/native-sessions/${automationNativeSessionId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(automationNativeSession.status, 404);

    const desktopContinued = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'sync through desktop owner',
        provider: 'fake',
        model: 'test-model',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'on-request',
      }),
    });
    assert.equal(desktopContinued.status, 202);
    const desktopContinuedPayload = await desktopContinued.json();
    assert.equal(desktopContinuedPayload.turnId, 'desktop-turn-1');

    const desktopSteered = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/steer`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'steer through desktop owner',
        turnId: desktopContinuedPayload.turnId,
      }),
    });
    assert.equal(desktopSteered.status, 202);
    assert.equal((await desktopSteered.json()).turnId, desktopContinuedPayload.turnId);

    const desktopInterrupted = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: desktopContinuedPayload.turnId }),
    });
    assert.equal(desktopInterrupted.status, 200);

    desktopIpc.startTurnMode = 'echo-only';
    desktopIpc.onStartTurn = async (message) => {
      const text = message.params.turnStartParams.input.find((item) => item.type === 'text')?.text || '';
      assert.equal(text, 'recover from native echo');
      const records = [
        {
          timestamp: new Date().toISOString(),
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'desktop-echo-turn' },
        },
        {
          timestamp: new Date().toISOString(),
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
          },
        },
      ];
      await appendFile(nativeSessionFile, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    };
    const echoStartedAt = Date.now();
    const echoedContinuation = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'recover from native echo',
        provider: 'fake',
        model: 'test-model',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'on-request',
      }),
    });
    const echoedContinuationPayload = await echoedContinuation.json();
    const echoedSessionContent = await readFile(nativeSessionFile, 'utf8');
    assert.equal(desktopIpc.lastError, null);
    assert.match(echoedSessionContent, /recover from native echo/);
    assert.equal(echoedContinuation.status, 202, JSON.stringify(echoedContinuationPayload));
    assert.ok(Date.now() - echoStartedAt < 3000);
    assert.equal(echoedContinuationPayload.turnId, 'desktop-echo-turn');

    desktopIpc.startTurnMode = 'respond';
    desktopIpc.onStartTurn = null;
    const echoedInterrupted = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: echoedContinuationPayload.turnId }),
    });
    assert.equal(echoedInterrupted.status, 200);

    const desktopStart = desktopIpc.messages.find((message) => message.method === 'thread-follower-start-turn');
    assert.equal(desktopStart.params.conversationId, nativeSessionId);
    assert.deepEqual(desktopStart.params.turnStartParams.input, [{
      type: 'text',
      text: 'sync through desktop owner',
      text_elements: [],
    }]);
    assert.equal(desktopStart.params.turnStartParams.sandboxPolicy.type, 'readOnly');
    assert.ok(desktopIpc.messages.some((message) => message.method === 'thread-follower-steer-turn'));
    assert.ok(desktopIpc.messages.some((message) => message.method === 'thread-follower-interrupt-turn'));
    desktopIpc.ownerAvailable = false;

    const blockedWrite = await fetch(`${baseUrl}/api/defaults`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'fake', model: 'test-model' }),
    });
    assert.equal(blockedWrite.status, 403);

    const chat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'reply once',
        provider: 'fake',
        model: 'test-model',
        reasoningEffort: 'max',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'untrusted',
      }),
    });
    assert.equal(chat.status, 200);
    assert.match(await chat.text(), /FAKE_OK/);

    const trace = JSON.parse(await readFile(traceFile, 'utf8'));
    assert.deepEqual(trace.args.slice(0, 3), ['-a', 'untrusted', 'exec']);
    assert.ok(trace.args.includes('model_reasoning_effort="max"'));
    assert.equal(trace.codexHome, codexHome);
    assert.equal(trace.home, temporary);

    const created = await fetch(`${baseUrl}/api/native-sessions`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'create native thread',
        provider: 'fake',
        model: 'test-model',
        reasoningEffort: 'max',
        cwd: temporary,
        sandbox: 'workspace-write',
        approval: 'on-request',
      }),
    });
    assert.equal(created.status, 202);
    const createdPayload = await created.json();
    assert.equal(createdPayload.threadId, createdNativeSessionId);
    assert.ok(createdPayload.turnId);

    const interrupted = await fetch(`${baseUrl}/api/native-sessions/${createdNativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: createdPayload.turnId }),
    });
    assert.equal(interrupted.status, 200);

    const renamed = await fetch(`${baseUrl}/api/native-sessions/${createdNativeSessionId}`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed native thread' }),
    });
    assert.equal(renamed.status, 200);

    const archived = await fetch(`${baseUrl}/api/native-sessions/${createdNativeSessionId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(archived.status, 200);

    const continued = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'needs approval',
        provider: 'fake',
        model: 'test-model',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'on-request',
      }),
    });
    assert.equal(continued.status, 202);
    const continuedPayload = await continued.json();

    const steered = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/steer`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'change direction while running',
        turnId: continuedPayload.turnId,
      }),
    });
    assert.equal(steered.status, 202);
    assert.equal((await steered.json()).turnId, continuedPayload.turnId);

    const pendingRequest = await waitForPendingRequest(baseUrl, cookie);
    assert.equal(pendingRequest.method, 'item/commandExecution/requestApproval');
    assert.equal(pendingRequest.threadId, nativeSessionId);

    const approved = await fetch(`${baseUrl}/api/native-requests/${pendingRequest.id}/respond`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'accept' }),
    });
    assert.equal(approved.status, 200);

    const protocolMessages = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(protocolMessages.some((message) => message.method === 'initialize'));
    assert.ok(protocolMessages.some((message) => message.method === 'thread/start'));
    assert.equal(protocolMessages.filter((message) => message.method === 'thread/resume').length, 1);
    assert.equal(protocolMessages.filter((message) => message.method === 'turn/start').length, 2);
    const steerMessage = protocolMessages.find((message) => message.method === 'turn/steer');
    assert.equal(steerMessage.params.expectedTurnId, continuedPayload.turnId);
    assert.deepEqual(steerMessage.params.input, [{ type: 'text', text: 'change direction while running' }]);
    assert.ok(protocolMessages.some((message) => message.method === 'turn/interrupt'));
    assert.ok(protocolMessages.some((message) => message.method === 'thread/name/set'));
    assert.ok(protocolMessages.some((message) => message.method === 'thread/archive'));
    assert.ok(protocolMessages.some((message) => message.id === 'approval-1' && message.result?.decision === 'accept'));

    const secondLogin = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    assert.equal(secondLogin.status, 200);
    const secondCookie = secondLogin.headers.get('set-cookie').split(';', 1)[0];

    const wrongCurrentPassword = await fetch(`${baseUrl}/api/password`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: 'wrong-password',
        newPassword: 'new-test-password',
        confirmPassword: 'new-test-password',
      }),
    });
    assert.equal(wrongCurrentPassword.status, 401);

    const changedPassword = await fetch(`${baseUrl}/api/password`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: 'test-password',
        newPassword: 'new-test-password',
        confirmPassword: 'new-test-password',
      }),
    });
    assert.equal(changedPassword.status, 200);
    assert.match(await readFile(webEnv, 'utf8'), /^CODEX_WEB_PASSWORD="new-test-password"$/m);

    const staleSession = await fetch(`${baseUrl}/api/config`, { headers: { Cookie: secondCookie } });
    assert.equal(staleSession.status, 401);
    const currentSession = await fetch(`${baseUrl}/api/config`, { headers: { Cookie: cookie } });
    assert.equal(currentSession.status, 200);
    const oldPasswordLogin = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    assert.equal(oldPasswordLogin.status, 401);
    const newPasswordLogin = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'new-test-password' }),
    });
    assert.equal(newPasswordLogin.status, 200);

    await stopServer(child);
    child = undefined;
    await unlink(path.join(runtime, 'port'));

    child = await startServer({ temporary, runtime, codexHome, fakeCodex, traceFile, appServerTraceFile, webEnv });
    port = await waitForServer(child, runtime);
    const restored = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { Cookie: cookie } });
    assert.equal(restored.status, 200);
  } finally {
    if (child) await stopServer(child);
    if (desktopIpc) await desktopIpc.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('writable provider changes preserve unrelated Codex config', { timeout: 30000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'codex-web-config-test-'));
  const runtime = path.join(temporary, 'runtime');
  const codexHome = path.join(temporary, 'codex-home');
  const webEnv = path.join(temporary, 'web.env');
  let child;

  try {
    await mkdir(runtime, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), `model_provider = "alpha"
model = "alpha-model"
review_model = "alpha-model"
notify = ["/bin/echo", "keep-me"]

[model_providers.alpha]
name = "Alpha"
base_url = "https://alpha.invalid/v1"
env_key = "ALPHA_API_KEY"
wire_api = "responses"
requires_openai_auth = false

[model_providers.beta]
name = "Beta"
base_url = "https://beta.invalid/v1"
env_key = "BETA_API_KEY"
wire_api = "responses"
requires_openai_auth = false

[mcp_servers.keep]
command = "/bin/echo"
args = ["keep-me"]

[projects."/keep"]
trust_level = "trusted"
`);

    child = startServer({
      temporary,
      runtime,
      codexHome,
      fakeCodex: process.execPath,
      traceFile: path.join(temporary, 'unused-trace.json'),
      webEnv,
      configWritable: 'true',
    });
    const port = await waitForServer(child, runtime);
    const baseUrl = `http://127.0.0.1:${port}`;
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];

    const initial = await fetch(`${baseUrl}/api/config`, { headers: { Cookie: cookie } });
    assert.equal((await initial.json()).capabilities.manageProviders, true);

    const added = await fetch(`${baseUrl}/api/providers`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'gamma',
        baseUrl: 'https://gamma.invalid/v1',
        apiKey: 'gamma-test-key',
        model: 'gamma-model',
        wireApi: 'responses',
      }),
    });
    assert.equal(added.status, 200);

    let config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /notify = \["\/bin\/echo", "keep-me"\]/);
    assert.match(config, /\[mcp_servers\.keep\]/);
    assert.match(config, /\[projects\."\/keep"\]/);
    assert.match(config, /\[model_providers\.alpha\]/);
    assert.match(config, /\[model_providers\.beta\]/);
    assert.match(config, /\[model_providers\.gamma\]/);

    const defaults = await fetch(`${baseUrl}/api/defaults`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'gamma', model: 'gamma-model', reasoningEffort: 'max' }),
    });
    assert.equal(defaults.status, 200);

    config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /^model_provider = "gamma"/m);
    assert.match(config, /^model = "gamma-model"/m);
    assert.match(config, /^model_reasoning_effort = "max"/m);
    assert.match(config, /\[mcp_servers\.keep\]/);

    const deleted = await fetch(`${baseUrl}/api/providers/gamma`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(deleted.status, 200);

    config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.doesNotMatch(config, /\[model_providers\.gamma\]/);
    assert.match(config, /\[model_providers\.alpha\]/);
    assert.match(config, /\[model_providers\.beta\]/);
    assert.match(config, /\[mcp_servers\.keep\]/);
    assert.doesNotMatch(await readFile(webEnv, 'utf8'), /^GAMMA_API_KEY=/m);
  } finally {
    if (child) await stopServer(child);
    await rm(temporary, { recursive: true, force: true });
  }
});

function startServer({
  temporary,
  runtime,
  codexHome,
  fakeCodex,
  traceFile,
  appServerTraceFile = path.join(temporary, 'app-server-trace.jsonl'),
  webEnv = path.join(temporary, 'web.env'),
  configWritable = 'false',
  desktopIpcEnabled = 'false',
  desktopIpcSocket = '',
}) {
  return spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      APP_NAME: 'Codex Web Test',
      CODEX_WEB_PASSWORD: 'test-password',
      SESSION_SECRET: 'test-session-secret-with-enough-entropy',
      HOST: '127.0.0.1',
      PORT: '0',
      PORT_MIN: '41000',
      PORT_MAX: '41999',
      CODEX_BIN: fakeCodex,
      CODEX_HOME: codexHome,
      CODEX_PROCESS_HOME: temporary,
      CODEX_WEB_ENV_FILE: webEnv,
      CODEX_WEB_RUNTIME_DIR: runtime,
      CODEX_CONFIG_WRITABLE: configWritable,
      CODEX_DESKTOP_IPC_ENABLED: desktopIpcEnabled,
      CODEX_DESKTOP_IPC_SOCKET: desktopIpcSocket,
      DEFAULT_CWD: temporary,
      DEFAULT_SANDBOX: 'read-only',
      DEFAULT_APPROVAL: 'never',
      FAKE_CODEX_TRACE: traceFile,
      FAKE_APP_SERVER_TRACE: appServerTraceFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function createDesktopIpcFixture(temporary) {
  const socketPath = path.join(tmpdir(), `cwi-${path.basename(temporary)}.sock`);
  await unlink(socketPath).catch(() => {});
  const sockets = new Set();
  const fixture = {
    socketPath,
    messages: [],
    ownerAvailable: true,
    startTurnMode: 'respond',
    onStartTurn: null,
    lastError: null,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await unlink(socketPath).catch(() => {});
    },
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    attachDesktopFrameReader(socket, (message) => {
      fixture.messages.push(message);
      if (message.method === 'initialize') {
        writeDesktopFrame(socket, {
          type: 'response',
          requestId: message.requestId,
          resultType: 'success',
          method: message.method,
          result: { clientId: 'desktop-test-client' },
        });
        return;
      }
      if (!fixture.ownerAvailable) {
        writeDesktopFrame(socket, {
          type: 'response',
          requestId: message.requestId,
          resultType: 'error',
          error: 'no-client-found',
        });
        return;
      }
      if (message.method === 'thread-follower-start-turn' && fixture.startTurnMode === 'echo-only') {
        Promise.resolve(fixture.onStartTurn?.(message)).catch((error) => {
          fixture.lastError = error;
        });
        return;
      }
      const result = message.method === 'thread-follower-start-turn'
        ? { turn: { id: 'desktop-turn-1', status: 'inProgress' } }
        : message.method === 'thread-follower-steer-turn'
          ? { turnId: 'desktop-turn-1' }
          : {};
      writeDesktopFrame(socket, {
        type: 'response',
        requestId: message.requestId,
        resultType: 'success',
        method: message.method,
        handledByClientId: 'desktop-owner',
        result: { result },
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return fixture;
}

function attachDesktopFrameReader(socket, onMessage) {
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

function writeDesktopFrame(socket, message) {
  const payload = Buffer.from(JSON.stringify(message));
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  socket.write(frame);
}

async function waitForPendingRequest(baseUrl, cookie) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${baseUrl}/api/native-requests`, {
      headers: { Cookie: cookie },
    });
    if (response.ok) {
      const request = (await response.json()).requests?.[0];
      if (request) return request;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('native approval request did not arrive');
}

async function waitForServer(child, runtime) {
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    try {
      const port = Number((await readFile(path.join(runtime, 'port'), 'utf8')).trim());
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return port;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become ready:\n${output}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
