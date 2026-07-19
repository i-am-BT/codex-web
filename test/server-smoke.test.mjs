import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
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
  const appServerControlFile = path.join(temporary, 'app-server-control.json');
  const webEnv = path.join(temporary, 'web.env');
  const toolImagePath = path.join(temporary, 'tool-preview.png');
  const nativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa729';
  const nativeFirstTurnId = '019f4f84-ea9f-73c2-b997-deba7b4aa780';
  const nativeSecondTurnId = '019f4f84-ea9f-73c2-b997-deba7b4aa781';
  const forkedNativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa797';
  const createdNativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa799';
  const archivedNativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa730';
  const automationNativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa731';
  const subagentNativeSessionId = '019f4f84-ea9f-73c2-b997-deba7b4aa732';
  let child;
  let desktopIpc;
  let providerServer;
  let customProviderServer;
  let providerBaseUrl = '';
  let customProviderBaseUrl = '';
  const providerRequests = [];

  try {
    const providerHandler = async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      providerRequests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || '',
        contentType: req.headers['content-type'] || '',
        body,
      });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/usage') {
        if (req.headers.authorization === 'Bearer bad-sub-key') {
          res.end(JSON.stringify({ isValid: false, status: 'invalid_key' }));
          return;
        }
        res.end(JSON.stringify({
          isValid: true,
          mode: 'unrestricted',
          planName: 'GPT-20x-300',
          unit: 'USD',
          remaining: 70,
          subscription: {
            weekly_limit_usd: 100,
            weekly_usage_usd: 30,
            monthly_limit_usd: 400,
            monthly_usage_usd: 50,
            expires_at: '2026-08-01T00:00:00Z',
          },
          rate_limits: [{
            window: '5h',
            limit: 50,
            used: 10,
            remaining: 40,
            reset_at: '2026-07-19T05:00:00Z',
          }],
          usage: { today: { requests: 4, actual_cost: 3 } },
        }));
        return;
      }
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }] }));
        return;
      }
      if (req.url?.startsWith('/v1/images/generations')) {
        res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('proxy-image').toString('base64') }] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    };
    providerServer = createHttpServer(providerHandler);
    await new Promise((resolve, reject) => {
      providerServer.once('error', reject);
      providerServer.listen(0, '127.0.0.1', resolve);
    });
    providerBaseUrl = `http://127.0.0.1:${providerServer.address().port}`;
    customProviderServer = createHttpServer(providerHandler);
    await new Promise((resolve, reject) => {
      customProviderServer.once('error', reject);
      customProviderServer.listen(0, '127.0.0.1', resolve);
    });
    customProviderBaseUrl = `http://127.0.0.1:${customProviderServer.address().port}`;
    await mkdir(runtime, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(appServerControlFile, '{}');
    await writeFile(
      toolImagePath,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
    );
    await writeFile(path.join(codexHome, 'config.toml'), `model_provider = "fake"
model = "test-model"
model_reasoning_effort = "max"

[model_providers.fake]
name = "Fake"
base_url = "${providerBaseUrl}/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "test-token"
`);
    await writeFile(path.join(codexHome, '.codex-global-state.json'), JSON.stringify({
      'pinned-thread-ids': [nativeSessionId, archivedNativeSessionId],
      'projectless-thread-ids': [],
      'thread-project-assignments': {},
    }));
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
            originator: 'codex-chrome-extension-sidepanel',
            source: 'vscode',
            cli_version: 'test',
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:31.990Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: nativeFirstTurnId },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:31.995Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'native earlier message' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:31.997Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'native assistant answer' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:31.997Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'false-tool-image-patch',
            input: 'const patch = "*** Begin Patch\\n*** Update File: /tmp/fake-ui.js\\n+tools.view_image({path:\\"/tmp/not-a-real-image.png\\"})\\n*** End Patch";\ntext(await tools.apply_patch(patch));',
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:31.998Z',
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: nativeFirstTurnId },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:31.999Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: nativeSecondTurnId },
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
        JSON.stringify({
          timestamp: '2026-07-11T04:52:32.004Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'tool-image-preview',
            input: `const result = await tools.view_image({path:${JSON.stringify(toolImagePath)},detail:"original"});\nimage(result.image_url);`,
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:32.005Z',
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: nativeSecondTurnId },
        }),
        '',
      ].join('\n'),
    );
    const archivedNativeSessionFile = path.join(
      nativeSessionDir,
      `rollout-2026-07-11T12-52-19-${archivedNativeSessionId}.jsonl`,
    );
    const subagentNativeSessionFile = path.join(
      nativeSessionDir,
      `rollout-2026-07-11T12-52-21-${subagentNativeSessionId}.jsonl`,
    );
    await writeFile(
      subagentNativeSessionFile,
      [
        JSON.stringify({
          timestamp: '2026-07-11T04:52:35.000Z',
          type: 'session_meta',
          payload: {
            id: subagentNativeSessionId,
            cwd: temporary,
            source: { subagent: { thread_spawn: {
              parent_thread_id: nativeSessionId,
              depth: 1,
              agent_path: '/root/ui_trace',
              agent_nickname: 'Russell',
            } } },
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:35.001Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'subagent-turn' },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:35.002Z',
          type: 'inter_agent_communication_metadata',
          payload: { trigger_turn: true },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:35.003Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: '子代理正在检查界面' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:35.004Z',
          type: 'response_item',
          payload: { type: 'function_call', call_id: 'subagent-call', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:36.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: '子代理检查完成' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-07-11T04:52:36.001Z',
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: 'subagent-turn', duration_ms: 1000 },
        }),
        '',
      ].join('\n'),
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
      'Archived fixture',
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
      'Automation fixture',
      0,
      'Automation: Fixture\nAutomation ID: fixture\nAutomation memory: $CODEX_HOME/automations/fixture/memory.md',
      'test',
      'user',
      1783745554000,
      1783745554000,
      1783745554000,
    );
    insertThread.run(
      subagentNativeSessionId,
      subagentNativeSessionFile,
      JSON.stringify({ subagent: { thread_spawn: {
        parent_thread_id: nativeSessionId,
        depth: 1,
        agent_path: '/root/ui_trace',
        agent_nickname: 'Russell',
      } } }),
      temporary,
      'UI trace',
      0,
      'subagent fixture',
      'test',
      'subagent',
      1783745555000,
      1783745556001,
      1783745556001,
    );
    stateDb.close();
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli test');
  process.exit(0);
}
if (args[0] === 'app-server') {
  appendFileSync(process.env.FAKE_APP_SERVER_TRACE, JSON.stringify({
    type: 'process_env',
    sub2ApiKey: process.env.SUB2API_API_KEY,
  }) + '\\n');
  const createdThreadId = '${createdNativeSessionId}';
  const forkedThreadId = '${forkedNativeSessionId}';
  const fixtureThreadId = '${nativeSessionId}';
  const archivedThreadId = '${archivedNativeSessionId}';
  const archivedThreadIds = new Set([archivedThreadId]);
  const archiveListCounters = new Map();
  const archiveControl = () => {
    try {
      return JSON.parse(readFileSync(process.env.FAKE_APP_SERVER_CONTROL, 'utf8'));
    } catch {
      return {};
    }
  };
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
      else if (message.method === 'thread/list') {
        const control = archiveControl();
        const raceToken = String(control.unarchiveAfterFirstListToken || '');
        const raceId = String(control.unarchiveAfterFirstListId || '');
        if (message.params.archived === true && raceToken && raceId) {
          const seen = archiveListCounters.get(raceToken) || 0;
          if (seen >= 1) archivedThreadIds.delete(raceId);
          archiveListCounters.set(raceToken, seen + 1);
        }
        const data = message.params.archived === true
          ? [...archivedThreadIds].map((id) => thread(id))
          : [];
        send({ id: message.id, result: { data, nextCursor: null, backwardsCursor: null } });
      }
      else if (message.method === 'thread/start') send({ id: message.id, result: { thread: thread(createdThreadId) } });
      else if (message.method === 'thread/fork') send({ id: message.id, result: { thread: thread(forkedThreadId) } });
      else if (message.method === 'thread/resume') send({ id: message.id, result: { thread: thread(message.params.threadId || fixtureThreadId) } });
      else if (message.method === 'turn/start') {
        const turnId = '019f4f84-ea9f-73c2-b997-deba7b4aa798';
        send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
        send({ method: 'turn/started', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'inProgress', items: [] } } });
        send({
          method: 'error',
          params: {
            error: { message: 'Reconnecting... 1/5' },
            willRetry: true,
            threadId: message.params.threadId,
            turnId
          }
        });
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
      else if (message.method === 'thread/archive') {
        archivedThreadIds.add(message.params.threadId);
        send({ id: message.id, result: {} });
      }
      else if (message.method === 'thread/unarchive') {
        archivedThreadIds.delete(message.params.threadId);
        send({ id: message.id, result: { thread: thread(message.params.threadId) } });
      }
      else if (message.method === 'thread/delete') {
        archivedThreadIds.delete(message.params.threadId);
        send({ id: message.id, result: {} });
      }
      else if (['thread/name/set', 'turn/interrupt'].includes(message.method)) {
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
    codexHome: process.env.CODEX_HOME,
    sub2ApiKey: process.env.SUB2API_API_KEY
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
      appServerControlFile,
      desktopIpcEnabled: 'true',
      desktopIpcSocket: desktopIpc.socketPath,
      playgroundProxyAllowedOrigins: customProviderBaseUrl,
      sub2ApiBaseUrl: providerBaseUrl,
      sub2ApiKey: 'test-sub-key',
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
    assert.match(uiStyles, /\.historyProjectMenu\s*\{/);
    assert.match(uiStyles, /\.historyProjectMenu\.openAbove/);
    assert.match(uiStyles, /\.historyProjectMenuAction\.danger/);
    assert.match(uiStyles, /body\[data-theme\] \.requestAction\s*\{[^}]*background:\s*var\(--surface-raised\);[^}]*color:\s*var\(--text\)/s);
    assert.match(uiStyles, /body\[data-theme\] \.requestAction\.danger\s*\{[^}]*background:\s*var\(--danger-soft\);[^}]*color:\s*var\(--danger\)/s);
    assert.match(uiStyles, /\.settingsDialog \.dreamSkinGenerator/);
    assert.match(uiStyles, /\.dreamSkinConceptList\s*\{/);
    assert.match(uiStyles, /\.dreamSkinConcept\.active\s*\{/);
    assert.match(uiStyles, /\.dreamSkinConceptThumb\s*\{/);
    assert.match(uiStyles, /\.dreamSkinConceptPreview\s*\{/);
    assert.match(uiStyles, /body\[data-chat-bg="custom"\] \.chat\s*\{[^}]*background-image:\s*var\(--custom-chat-bg\)/s);
    assert.match(uiStyles, /body\[data-chat-bg="skin"\] \.app\s*\{[^}]*background-image:[^}]*var\(--custom-chat-bg\)[^}]*background-position:\s*var\(--skin-art-position\)/s);
    assert.match(uiStyles, /body\[data-chat-bg="skin"\] \.main\s*\{[^}]*background:\s*transparent/s);
    assert.match(uiStyles, /body\[data-chat-bg="skin"\] \.chat\s*\{[^}]*var\(--skin-content-wash\)/s);
    assert.match(uiStyles, /body\[data-chat-bg="skin"\] \.side,[^}]*body\[data-chat-bg="skin"\] \.top\s*\{[^}]*var\(--skin-surface-soft\)/s);
    assert.match(uiStyles, /body\[data-chat-bg="skin"\] \.miniPrimary,[^}]*body\[data-chat-bg="skin"\] \.send\s*\{[^}]*background:\s*var\(--primary\)/s);
    assert.match(uiStyles, /\.generatedBackgroundApply/);
    assert.doesNotMatch(uiStyles, /data-chat-bg="dream-skin"|portal-hero\.png/);
    assert.match(uiStyles, /@media \(hover: hover\) and \(pointer: fine\)\s*\{[^}]*body \.histRename,[^}]*opacity:\s*0;[\s\S]*body \.hist:hover \.histRename/s);
    assert.match(uiStyles, /body \.hist\.native\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto/s);
    assert.match(uiStyles, /body \.hist\.native\.running\s*\{[^}]*grid-template-columns:\s*auto auto minmax\(0, 1fr\) auto auto/s);
    assert.match(uiStyles, /\.historyProjectFolder\s*\{/);
    assert.match(uiStyles, /\.historyProjectPreview\.visible\s*\{/);
    assert.match(uiStyles, /\.historyProjectItems\s*\{[^}]*padding-left:\s*22px/s);
    assert.match(uiStyles, /\.memoryCitations\[open\]/);
    assert.match(uiStyles, /\.memoryCitationItem\[open\]/);
    assert.match(uiStyles, /\.composerModelToggle/);
    assert.match(uiStyles, /\.composerPermissionToggle/);
    assert.match(uiStyles, /\.composerProjectToggle/);
    assert.match(uiStyles, /\.composerProjectPanel/);
    assert.match(uiStyles, /\.composerProjectPicker:not\(\.hidden\) \+ \.box/);
    assert.match(uiStyles, /\.promptQueueRow/);
    assert.match(uiStyles, /\.box\.runActive/);
    assert.match(uiStyles, /\.composerModelToggle\.running:not\(:disabled\)\s*\{[^}]*cursor:\s*pointer/s);
    assert.match(uiStyles, /\.composerModelToggle\.running \.composerModelState\s*\{[^}]*border-right-color:\s*transparent;[^}]*animation:\s*spin/s);
    assert.match(uiStyles, /\.composerModelPanel\s*\{[^}]*width:\s*min\(244px,[^}]*border-radius:\s*18px/s);
    assert.match(uiStyles, /\.composerModelMenuRow\s*\{[^}]*min-height:\s*44px;[^}]*grid-template-columns:/s);
    assert.match(uiStyles, /\.composerModelMenuRow\.active\s*\{[^}]*background:\s*var\(--surface-hover\)/s);
    assert.match(uiStyles, /\.composerModelSubmenu\s*\{[^}]*left:\s*calc\(100% \+ 8px\);[^}]*right:\s*auto;[^}]*max-height:/s);
    assert.match(uiStyles, /\.composerModelPanel\[data-submenu\] \.composerModelMainMenu\s*\{[^}]*display:\s*none/s);
    assert.match(uiStyles, /\.composerModelOption\[aria-selected="true"\]/);
    assert.match(uiStyles, /body \.box\.runActive > \.send:not\(\.cancelButton\):disabled\s*\{[^}]*display:\s*none/s);
    assert.match(uiStyles, /body \.cancelButton \.lucide\s*\{[^}]*fill:\s*currentColor;[^}]*stroke:\s*none/s);
    assert.match(uiStyles, /\.msg\.user:hover \.msgActions/);
    assert.match(uiStyles, /\.msg\.user::after\s*\{[^}]*width:\s*min\(124px, 100%\);[^}]*height:\s*6px/s);
    assert.match(uiStyles, /\.msg\.user \.msgActions\s*\{[^}]*top:\s*calc\(100% - 1px\);[^}]*padding:\s*5px 0 0 8px/s);
    assert.match(uiStyles, /\.msg\.user\.hasInputImage > \.msgBody\s*\{[^}]*border-radius:\s*16px;[^}]*background:\s*color-mix\(in oklab, var\(--text\) 5%, transparent\);[^}]*padding:\s*8px 12px/s);
    assert.match(uiStyles, /\.completionTimeline > \.activityBatch \+ \.activityBatch/);
    assert.match(uiStyles, /body\[data-theme="dark"\] \.completionTimeline\s*\{[^}]*--text:\s*#ffffff;[^}]*--text-muted:\s*#acacac;[^}]*--text-subtle:\s*#7b7b7b/s);
    assert.match(uiStyles, /body \.msg\.process\.completionSummary\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%/s);
    assert.match(uiStyles, /\.activityClusterText\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/s);
    assert.match(uiStyles, /\.activityClusterSummary\s*\{[^}]*width:\s*100%;[^}]*grid-template-columns:\s*var\(--activity-icon-box\) minmax\(0, 1fr\) 14px/s);
    assert.match(uiStyles, /\.activityCluster\[open\] > summary \.activityClusterChevron/);
    assert.match(uiStyles, /\.activityCluster:not\(\[open\]\) > \.activityClusterItems\s*\{[^}]*display:\s*none/s);
    assert.match(uiStyles, /\.activityClusterItems::before\s*\{[^}]*width:\s*1px;[^}]*background:\s*var\(--activity-rail\)/s);
    assert.match(uiStyles, /\.activityCluster \.activityItemChevron\s*\{[^}]*opacity:\s*0/s);
    assert.match(uiStyles, /\.activityCluster \.activityItem\[data-current="true"\] > \.activityItemSummary \.activityItemChevron,[^}]*opacity:\s*1/s);
    assert.match(uiStyles, /\.activityCluster \.activityItem\[data-current="true"\] > \.activityItemSummary,[^}]*color:\s*var\(--text\)/s);
    assert.match(uiStyles, /body\[data-theme\] \.msg\.process\.reasoningStatus/);
    assert.match(uiStyles, /--reasoning-flow-muted:\s*#b0b0b1/);
    assert.match(uiStyles, /\.reasoningStatus\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/s);
    assert.match(uiStyles, /> \.msg\.process\.reasoningStatus\.streaming\s*\{[^}]*var\(--reasoning-flow-muted\)[^}]*var\(--reasoning-flow-strong\)/s);
    assert.match(uiStyles, /\.browserCommentSteering > \.browserCommentSource\s*\{[^}]*display:\s*block;[^}]*background:\s*color-mix\(in oklab, var\(--text\) 5%, transparent\)/s);
    assert.match(uiStyles, /\.activityItem\.fileTarget \.activityTarget/);
    assert.match(uiStyles, /\.activityItem\[open\] > \.activityItemSummary \.activityItemChevron/);
    assert.match(uiStyles, /\.agentActivityItem\[open\] > \.agentActivityRow \.agentActivityChevron/);
    assert.match(uiStyles, /\.completionTimeline > \.msg\.agentActivityGroup\s*\{[^}]*display:\s*flex;[^}]*width:\s*100%;[^}]*flex-wrap:\s*wrap;[^}]*column-gap:\s*6px/s);
    assert.match(uiStyles, /\.agentActivityGroup > \.activityBatch\s*\{[^}]*display:\s*contents/s);
    assert.match(uiStyles, /\.agentActivityGroup \.agentActivityItem\[open\]\s*\{[^}]*flex:\s*1 0 100%/s);
    assert.match(uiStyles, /\.agentActivityGroup \.agentActivityItem > \.agentActivityRow \.agentActivityStatus,[^}]*\.agentActivityChevron\s*\{[^}]*display:\s*none/s);
    assert.match(uiStyles, /\.agentActivityLabel\s*\{[^}]*max-width:\s*150px/s);
    assert.match(uiStyles, /\.agentActivityGroupStatus\[data-trace-state="done"\],\s*\.agentActivityGroupStatus\[data-trace-state="updated"\]\s*\{[^}]*color:\s*var\(--text-muted\)/s);
    assert.match(uiStyles, /\.subagentTraceTimeline\s*\{/);
    assert.match(uiStyles, /\.subagentTraceMessage\.final\s*\{/);
    assert.match(uiStyles, /\.subagentTraceNotice\.loading::before/);
    assert.match(uiStyles, /\.activityImageGallery\s*\{/);
    assert.match(uiStyles, /\.activityImagePreview\s*\{[^}]*display:\s*grid;[^}]*border:\s*0;[^}]*background:\s*transparent/s);
    assert.match(uiStyles, /\.activityImagePreview\.loaded\s*\{[^}]*aspect-ratio:\s*auto/s);
    assert.match(uiStyles, /\.activityImagePreview img\s*\{[^}]*width:\s*100%;[^}]*object-fit:\s*contain/s);
    assert.match(uiStyles, /\.activityImagePreview\.loaded img\s*\{[^}]*height:\s*auto/s);
    assert.match(uiStyles, /\.liveProcessElapsed\s*\{[^}]*width:\s*100%;[^}]*height:\s*40px;[^}]*align-items:\s*center;[^}]*border-bottom:\s*1px solid var\(--border\);[^}]*font-size:\s*14px;[^}]*white-space:\s*nowrap/s);
    assert.match(uiStyles, /\.liveProcessElapsed \+ \.liveProcessTimeline\s*\{[^}]*margin-top:\s*14px/s);
    assert.match(uiStyles, /body\[data-theme="dark"\] \.liveProcessElapsed\s*\{[^}]*border-bottom-color:\s*#303030;[^}]*color:\s*#acacac/s);
    assert.match(uiStyles, /\.liveProcessTimeline\s*\{[^}]*width:\s*100%;[^}]*gap:\s*14px/s);
    assert.doesNotMatch(uiStyles, /\.turnPlanPanel|\.turnPlanList|\.turnPlanStep/);
    assert.match(uiStyles, /\.liveProcessTimeline > \.progressCommentary\.streaming \.markdownBody > :last-child,[^}]*\.activityCluster\.streaming > summary \.activityClusterText[^}]*animation:\s*liveProcessFlow 2\.1s linear infinite/s);
    assert.match(uiStyles, /\.liveProcessTimeline > \.msg\.process\.reasoningStatus\.streaming\s*\{[^}]*animation:\s*liveProcessFlow 2\.1s linear infinite/s);
    assert.match(uiStyles, /@keyframes liveProcessFlow/);
    assert.match(uiStyles, /\.completionTimeline > \.msg\.user\.steeringUser/);
    assert.match(uiStyles, /\.sideActions\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) repeat\(4, 36px\)/s);
    assert.match(uiStyles, /\.subQuotaPopover\s*\{/);
    assert.match(uiStyles, /@container sidebar \(max-width: 264px\)/);
    assert.match(uiStyles, /\.archiveView\s*\{[^}]*flex:\s*1 1 auto;[^}]*overflow:\s*auto/s);
    assert.match(uiStyles, /\.archiveTaskRestore,[^}]*\.archiveTaskDelete\s*\{/s);
    assert.match(uiStyles, /body\[data-theme\] \.archiveProjectFilter select\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%/s);
    assert.match(uiStyles, /\.turnResultArtifacts\s*\{[^}]*align-self:\s*center/s);
    assert.match(uiStyles, /\.editedFilesResult\s*\{[^}]*width:\s*min\(160px, 100%\);[^}]*border-radius:\s*999px/s);
    assert.match(uiStyles, /\.editedFilesResult\.withPlan\s*\{[^}]*width:\s*max-content/s);
    assert.match(uiStyles, /\.editedFilesResult\.withPlan > \.turnResultHead\s*\{[^}]*min-height:\s*36px;[^}]*gap:\s*7px;[^}]*padding-inline:\s*12px/s);
    assert.match(uiStyles, /\.turnPlanProgressRing\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;[^}]*flex:\s*0 0 12px;[^}]*conic-gradient\(var\(--info\) var\(--turn-plan-progress\)/s);
    assert.match(uiStyles, /\.turnPlanProgressRing::after\s*\{[^}]*inset:\s*2px/s);
    assert.match(uiStyles, /body \.composer > \.editedFilesResult\.live\s*\{[^}]*align-self:\s*center;[^}]*margin:\s*0 auto 8px/s);
    assert.match(uiStyles, /body \.composer > \.editedFilesResult\.live\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s);
    assert.match(uiStyles, /\.turnResultStatus\s*\{[^}]*color:\s*var\(--success\)/s);
    assert.doesNotMatch(uiStyles, /\.liveProcessTimeline > \.editedFilesResult\.live/);
    assert.match(uiStyles, /body\[data-theme="dark"\] \.editedFilesResult:not\(\[open\]\)\s*\{[^}]*border-color:\s*#383838;[^}]*background:\s*#272727/s);
    assert.match(uiStyles, /body\[data-theme="dark"\] \.editedFilesResult\.withPlan \.turnPlanProgressRing\s*\{[^}]*conic-gradient\(#339cff var\(--turn-plan-progress\), #2b3c4f 0\)/s);
    assert.match(uiStyles, /body\[data-theme="dark"\] \.editedFilesResult\.withPlan \.turnPlanProgressLabel,[^}]*\.turnResultFileLabel\s*\{[^}]*color:\s*#bbbbbb/s);
    assert.match(uiStyles, /\.turnResultStat\.added\s*\{[^}]*color:\s*var\(--success\)/s);
    assert.match(uiStyles, /\.turnResultStat\.removed\s*\{[^}]*color:\s*var\(--danger\)/s);
    assert.match(uiStyles, /\.webPreviewResult\s*\{/);
    assert.match(uiStyles, /body\[data-theme\] \.msg\.assistant\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%/s);
    assert.match(uiStyles, /\.msg\.assistant > \.msgBody > :not\(\.memoryCitations\)\s*\{[^}]*max-width:\s*min\(780px, 100%\)/s);
    assert.match(uiStyles, /\.msg\.assistant > \.msgActions\s*\{[^}]*width:\s*fit-content;[^}]*opacity:\s*0/s);
    assert.match(uiStyles, /\.messageAction::after\s*\{[^}]*content:\s*attr\(data-tooltip\)/s);
    assert.match(uiStyles, /\.msg\.assistant \.continueMsg\s*\{[^}]*background:\s*transparent/s);
    assert.match(uiStyles, /--conversation-width:\s*760px/);
    assert.match(uiStyles, /body \.chat > :is\([^}]*\.msg:not\(\.user\):not\(\.inputImage\)[^}]*\.liveProcessPanel[^}]*\)\s*\{[^}]*width:\s*min\(var\(--conversation-width\), 100%\);[^}]*align-self:\s*center/s);
    assert.match(uiStyles, /body \.chat > :is\(\.msg\.user, \.msg\.image\.inputImage\)\s*\{[^}]*margin-right:\s*max\(0px, calc\(\(100% - var\(--conversation-width\)\) \/ 2\)\)/s);
    assert.match(uiStyles, /body \.composer\s*\{[^}]*border-top:\s*0;[^}]*background:\s*transparent/s);
    assert.match(uiStyles, /body\[data-theme="light"\] \.composer\s*\{[^}]*background:\s*transparent/s);
    assert.match(uiStyles, /\.composer > \*\s*\{[^}]*width:\s*min\(var\(--conversation-width\), 100%\)/s);
    assert.match(uiStyles, /\.memoryCitations\s*\{[^}]*width:\s*100%/s);
    assert.match(uiStyles, /\.imagePreview\s*\{/);
    assert.match(uiStyles, /\.userAttachmentStack\s*\{/);
    assert.match(uiStyles, /\.userAttachmentStack\.single\s*\{[^}]*width:\s*144px/s);
    assert.match(uiStyles, /\.msg\.user\.hasInputImage > \.msgBody:empty/);
    assert.match(uiStyles, /\.settingsDialog/);

    const imagePromptStylesResponse = await fetch(`${baseUrl}/image-prompt.css`);
    assert.equal(imagePromptStylesResponse.status, 200);
    const imagePromptStyles = await imagePromptStylesResponse.text();
    assert.match(imagePromptStyles, /\.workspaceNavButton\.active/);
    assert.match(imagePromptStyles, /\.imagePromptGrid/);
    assert.match(imagePromptStyles, /\.imagePromptDetailDialog/);
    assert.match(imagePromptStyles, /\.imagePromptPreviewFrame\.imageLoading img/);
    assert.match(imagePromptStyles, /\.imagePromptPlaygroundFrame/);
    assert.match(imagePromptStyles, /\.imagePromptViewTab\.active/);
    assert.match(imagePromptStyles, /\.imagePromptSyncStatus\[data-status="error"\]/);
    assert.match(imagePromptStyles, /\.imagePromptSyncButton\.syncing \.lucide/);

    const imagePromptScriptResponse = await fetch(`${baseUrl}/image-prompt.js`);
    assert.equal(imagePromptScriptResponse.status, 200);
    const imagePromptScript = await imagePromptScriptResponse.text();
    assert.doesNotThrow(() => new Function(imagePromptScript));
    assert.match(imagePromptScript, /function loadDetailImage/);
    assert.match(imagePromptScript, /function useSelectedPromptInPlayground/);
    assert.match(imagePromptScript, /function handlePlaygroundBridgeMessage/);
    assert.match(imagePromptScript, /codex-web:image-prompt/);
    assert.match(imagePromptScript, /在生图工作台使用/);
    assert.match(imagePromptScript, /transparent_output/);
    assert.doesNotMatch(imagePromptScript, /发送到 Codex App|function composeCodexImagePrompt/);
    assert.match(imagePromptScript, /function setImagePromptView/);
    assert.match(imagePromptScript, /function syncPromptLibrary/);
    assert.match(imagePromptScript, /function checkLibraryStatus/);
    assert.match(imagePromptScript, /data-src="\/playground\/"/);

    const unauthorized = await fetch(`${baseUrl}/api/config`);
    assert.equal(unauthorized.status, 401);
    const unauthorizedPlaygroundConfig = await fetch(`${baseUrl}/api/playground-config`);
    assert.equal(unauthorizedPlaygroundConfig.status, 401);
    const unauthorizedPlaygroundProxy = await fetch(
      `${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(providerBaseUrl)}`,
      { method: 'POST' },
    );
    assert.equal(unauthorizedPlaygroundProxy.status, 401);
    const unauthorizedImagePrompts = await fetch(`${baseUrl}/api/image-prompts`);
    assert.equal(unauthorizedImagePrompts.status, 401);
    const unauthorizedImagePromptStatus = await fetch(`${baseUrl}/api/image-prompts/status`);
    assert.equal(unauthorizedImagePromptStatus.status, 401);
    const unauthorizedImagePromptSync = await fetch(`${baseUrl}/api/image-prompts/sync`, { method: 'POST' });
    assert.equal(unauthorizedImagePromptSync.status, 401);
    const unauthorizedDreamSkin = await fetch(`${baseUrl}/api/dream-skin/prompt`, { method: 'POST' });
    assert.equal(unauthorizedDreamSkin.status, 401);
    const unauthorizedArchivedTasks = await fetch(`${baseUrl}/api/native-archived-sessions`);
    assert.equal(unauthorizedArchivedTasks.status, 401);
    const unauthorizedAutomations = await fetch(`${baseUrl}/api/automations`);
    assert.equal(unauthorizedAutomations.status, 401);
    const unauthorizedSubQuotas = await fetch(`${baseUrl}/api/sub-quotas`);
    assert.equal(unauthorizedSubQuotas.status, 401);
    const unauthorizedSubQuotaConfig = await fetch(`${baseUrl}/api/sub-quota-config`);
    assert.equal(unauthorizedSubQuotaConfig.status, 401);
    const unauthorizedPlayground = await fetch(`${baseUrl}/playground/`);
    assert.equal(unauthorizedPlayground.status, 401);

    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-password' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];

    const subQuotaConfig = await fetch(`${baseUrl}/api/sub-quota-config`, {
      headers: { Cookie: cookie },
    });
    assert.equal(subQuotaConfig.status, 200);
    const subQuotaConfigPayload = await subQuotaConfig.json();
    assert.equal(subQuotaConfigPayload.baseUrl, providerBaseUrl);
    assert.equal(subQuotaConfigPayload.keyConfigured, true);
    assert.doesNotMatch(JSON.stringify(subQuotaConfigPayload), /test-sub-key/);

    const rejectedSubQuotaKey = await fetch(`${baseUrl}/api/sub-quota-config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'bad-sub-key' }),
    });
    assert.equal(rejectedSubQuotaKey.status, 422);
    assert.doesNotMatch(await readFile(webEnv, 'utf8').catch(() => ''), /bad-sub-key/);

    const updatedSubQuotaKey = await fetch(`${baseUrl}/api/sub-quota-config`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'new-sub-key' }),
    });
    assert.equal(updatedSubQuotaKey.status, 200);
    assert.doesNotMatch(await updatedSubQuotaKey.text(), /new-sub-key/);
    assert.match(await readFile(webEnv, 'utf8'), /^SUB2API_API_KEY="new-sub-key"$/m);
    assert.equal((await stat(webEnv)).mode & 0o777, 0o600);
    assert.equal(providerRequests.at(-1).authorization, 'Bearer new-sub-key');

    const subQuotas = await fetch(`${baseUrl}/api/sub-quotas`, {
      headers: { Cookie: cookie },
    });
    assert.equal(subQuotas.status, 200);
    assert.match(subQuotas.headers.get('cache-control'), /private, no-store/);
    const subQuotaPayload = await subQuotas.json();
    assert.equal(subQuotaPayload.configured, true);
    assert.equal(subQuotaPayload.count, 1);
    assert.equal(subQuotaPayload.quotas[0].planName, 'GPT-20x-300');
    assert.equal(subQuotaPayload.quotas[0].subscription.weekly.remaining, 70);
    assert.equal(subQuotaPayload.quotas[0].rateLimits[0].window, '5h');
    assert.equal(subQuotaPayload.quotas[0].rateLimits[0].remaining, 40);
    assert.doesNotMatch(JSON.stringify(subQuotaPayload), /test-sub-key/);
    const refreshedSubQuotas = await fetch(`${baseUrl}/api/sub-quotas?refresh=1`, {
      headers: { Cookie: cookie },
    });
    assert.equal(refreshedSubQuotas.status, 200);

    const emptyAutomations = await fetch(`${baseUrl}/api/automations`, {
      headers: { Cookie: cookie },
    });
    assert.equal(emptyAutomations.status, 200);
    assert.equal((await emptyAutomations.json()).count, 0);
    const heartbeatDirectory = path.join(codexHome, 'automations', 'fixture-heartbeat');
    await mkdir(heartbeatDirectory, { recursive: true });
    await writeFile(path.join(heartbeatDirectory, 'automation.toml'), `version = 1
id = "fixture-heartbeat"
kind = "heartbeat"
name = "Fixture heartbeat"
prompt = "Keep the fixture task moving."
status = "ACTIVE"
rrule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=30"
target_thread_id = "${nativeSessionId}"
created_at = 1784422800000
updated_at = 1784422800000
`);
    const createdAutomation = await fetch(`${baseUrl}/api/automations`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Daily project brief',
        prompt: 'Summarize the latest project work.',
        cwd: temporary,
        model: 'test-model',
        reasoningEffort: 'xhigh',
        notificationPolicy: 'always',
        status: 'PAUSED',
        schedule: { frequency: 'weekdays', time: '08:00' },
      }),
    });
    assert.equal(createdAutomation.status, 201);
    const createdAutomationPayload = await createdAutomation.json();
    assert.equal(createdAutomationPayload.automation.id, 'daily-project-brief');
    assert.equal(createdAutomationPayload.automation.scheduleLabel, '工作日 08:00');
    assert.equal(createdAutomationPayload.automation.model, 'test-model');
    assert.equal(createdAutomationPayload.automation.reasoningEffort, 'xhigh');
    assert.equal(createdAutomationPayload.automation.notificationPolicy, 'always');
    assert.equal(createdAutomationPayload.automation.status, 'PAUSED');
    const editedAutomation = await fetch(`${baseUrl}/api/automations/daily-project-brief`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Weekly project brief',
        prompt: 'Summarize the latest project work every Friday.',
        cwd: '',
        model: 'test-model',
        reasoningEffort: 'ultra',
        notificationPolicy: 'failed_runs_only',
        status: 'PAUSED',
        schedule: { frequency: 'weekly', day: 'FR', time: '09:30' },
      }),
    });
    assert.equal(editedAutomation.status, 200);
    const editedAutomationPayload = await editedAutomation.json();
    assert.equal(editedAutomationPayload.automation.id, 'daily-project-brief');
    assert.equal(editedAutomationPayload.automation.name, 'Weekly project brief');
    assert.equal(editedAutomationPayload.automation.scheduleLabel, '周五 09:30');
    assert.deepEqual(editedAutomationPayload.automation.cwds, []);
    assert.equal(editedAutomationPayload.automation.reasoningEffort, 'ultra');
    assert.equal(editedAutomationPayload.automation.notificationPolicy, 'failed_runs_only');
    const automationToml = await readFile(
      path.join(codexHome, 'automations', 'daily-project-brief', 'automation.toml'),
      'utf8',
    );
    assert.match(automationToml, /name = "Weekly project brief"/);
    assert.match(automationToml, /rrule = "FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=30"/);
    assert.match(automationToml, /cwds = \[\]/);
    assert.match(automationToml, /model = "test-model"/);
    assert.match(automationToml, /reasoning_effort = "ultra"/);
    assert.match(automationToml, /notification_policy = "failed_runs_only"/);
    assert.match(automationToml, /status = "PAUSED"/);
    assert.match(automationToml, /target = \{ type = "projectless" \}/);
    const activatedAutomation = await fetch(
      `${baseUrl}/api/automations/daily-project-brief/status`,
      {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ACTIVE' }),
      },
    );
    assert.equal(activatedAutomation.status, 200);
    assert.equal((await activatedAutomation.json()).automation.status, 'ACTIVE');

    const archivedTasks = await fetch(`${baseUrl}/api/native-archived-sessions`, {
      headers: { Cookie: cookie },
    });
    assert.equal(archivedTasks.status, 200);
    assert.match(archivedTasks.headers.get('cache-control'), /private, no-store/);
    const archivedTasksPayload = await archivedTasks.json();
    assert.equal(archivedTasksPayload.count, 1);
    assert.equal(archivedTasksPayload.sessions[0].id, archivedNativeSessionId);
    assert.equal(archivedTasksPayload.sessions[0].source, 'codex');
    assert.equal(archivedTasksPayload.sessions[0].cwd, temporary);

    const rejectedUnarchivedDelete = await fetch(
      `${baseUrl}/api/native-archived-sessions/${nativeSessionId}`,
      { method: 'DELETE', headers: { Cookie: cookie } },
    );
    assert.equal(rejectedUnarchivedDelete.status, 404);
    assert.match((await rejectedUnarchivedDelete.json()).error, /不在已归档列表/);

    const unarchivedTask = await fetch(
      `${baseUrl}/api/native-archived-sessions/${archivedNativeSessionId}/unarchive`,
      { method: 'POST', headers: { Cookie: cookie } },
    );
    assert.equal(unarchivedTask.status, 200);
    assert.equal((await unarchivedTask.json()).id, archivedNativeSessionId);
    assert.ok(desktopIpc.messages.some((message) => (
      message.type === 'broadcast'
      && message.method === 'thread-unarchived'
      && message.version === 1
      && message.params?.hostId === 'local'
      && message.params?.conversationId === archivedNativeSessionId
      && message.params?.cwd === temporary
    )));
    assert.ok(desktopIpc.messages.some((message) => (
      message.type === 'broadcast'
      && message.method === 'query-cache-invalidate'
      && message.version === 0
      && JSON.stringify(message.params?.queryKey) === JSON.stringify(['archived-threads'])
    )));

    const playgroundResponse = await fetch(`${baseUrl}/playground/`, {
      headers: { Cookie: cookie },
    });
    assert.equal(playgroundResponse.status, 200);
    assert.match(playgroundResponse.headers.get('cache-control'), /private, no-store/);
    const playgroundPage = await playgroundResponse.text();
    assert.match(playgroundPage, /<title>GPT Image Playground<\/title>/);
    const playgroundAssetPath = playgroundPage.match(/src="\.\/(assets\/[^\"]+\.js)"/)?.[1];
    assert.ok(playgroundAssetPath);
    const playgroundAsset = await fetch(`${baseUrl}/playground/${playgroundAssetPath}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(playgroundAsset.status, 200);
    assert.match(playgroundAsset.headers.get('content-type'), /javascript/);
    assert.match(playgroundAsset.headers.get('cache-control'), /private, max-age=31536000, immutable/);
    const playgroundAssetScript = await playgroundAsset.text();
    assert.match(playgroundAssetScript, /codex-web:playground-ready/);
    assert.match(playgroundAssetScript, /codex-web:image-prompt-applied/);
    assert.match(playgroundAssetScript, /\/api\/playground-config/);
    assert.match(playgroundAssetScript, /codex-web-agent/);
    assert.match(playgroundAssetScript, /agentApiConfigMode/);
    assert.match(playgroundAssetScript, /codex_upstream/);
    assert.match(playgroundAssetScript, /Agent 规划服务暂时不可用，已切换为直接生图/);
    assert.match(playgroundAssetScript, /上游 Agent 流式请求失败/);
    assert.match(playgroundAssetScript, /请求将通过 Codex Web 同源代理转发到此 URL/);
    assert.doesNotMatch(playgroundAssetScript, /此处设置被忽略/);
    const playgroundPatchSource = await readFile(
      path.join(ROOT, 'vendor', 'gpt-image-playground', 'patches', 'codex-web.patch'),
      'utf8',
    );
    assert.match(playgroundPatchSource, /baseUrl: existing\?\.baseUrl\?\.trim\(\) \|\| profile\.baseUrl/);
    assert.match(playgroundPatchSource, /apiKey: existing\?\.apiKey\?\.trim\(\) \|\| profile\.apiKey/);
    assert.match(playgroundPatchSource, /responseError = getErrorMessageFromValue\(response\?\.error\)/);
    assert.match(playgroundPatchSource, /isDirectAgentImageFallbackPrompt/);
    assert.match(playgroundPatchSource, /modulePreload: \{ polyfill: false \}/);
    assert.match(playgroundAssetScript, /输入 @ 选择或上传参考图/);
    assert.match(playgroundAssetScript, /上传新的参考图/);
    const playgroundServiceWorker = await fetch(`${baseUrl}/playground/sw.js`, {
      headers: { Cookie: cookie },
    });
    assert.equal(playgroundServiceWorker.status, 200);
    assert.match(playgroundServiceWorker.headers.get('content-type'), /javascript/);
    assert.match(await playgroundServiceWorker.text(), /registration\.unregister/);

    const dreamSkinSkill = await fetch(`${baseUrl}/assets/dream-skin/SKILL.md`, {
      headers: { Cookie: cookie },
    });
    assert.equal(dreamSkinSkill.status, 200);
    assert.match(dreamSkinSkill.headers.get('content-type'), /markdown|text\/plain/);
    const dreamSkinSkillMarkdown = await dreamSkinSkill.text();
    assert.match(dreamSkinSkillMarkdown, /Required Workflow[\s\S]*imagegen/);
    assert.match(dreamSkinSkillMarkdown, /Theme Integration Contract[\s\S]*concept-themes\.json/);

    const dreamSkinConceptSource = await fetch(
      `${baseUrl}/assets/dream-skin/background-generation-prompts.md`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(dreamSkinConceptSource.status, 200);
    const dreamSkinConceptMarkdown = await dreamSkinConceptSource.text();
    assert.equal((dreamSkinConceptMarkdown.match(/^## skin-0[1-8]｜/gm) || []).length, 8);
    assert.match(dreamSkinConceptMarkdown, /skin-03｜红白未来城市主题/);
    assert.match(dreamSkinConceptMarkdown, /完整皮肤由本文件生成的纯背景与 `concept-themes\.json`/);

    const dreamSkinThemeSource = await fetch(
      `${baseUrl}/assets/dream-skin/concept-themes.json`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(dreamSkinThemeSource.status, 200);
    const dreamSkinThemePayload = await dreamSkinThemeSource.json();
    assert.equal(dreamSkinThemePayload.schemaVersion, 1);
    assert.equal(Object.keys(dreamSkinThemePayload.themes).length, 8);

    const dreamSkinConfigResponse = await fetch(`${baseUrl}/api/config`, {
      headers: { Cookie: cookie },
    });
    assert.equal(dreamSkinConfigResponse.status, 200);
    const dreamSkinConfig = await dreamSkinConfigResponse.json();
    assert.equal(dreamSkinConfig.dreamSkinConcepts.length, 8);
    assert.deepEqual(
      dreamSkinConfig.dreamSkinConcepts.map((concept) => concept.id),
      [
        'skin-01',
        'skin-02',
        'skin-03',
        'skin-04',
        'skin-05',
        'skin-06',
        'skin-07',
        'skin-08',
      ],
    );
    assert.deepEqual(
      dreamSkinConfig.dreamSkinConcepts.map((concept) => concept.name),
      [
        '粉系玫瑰人物主题',
        '财神打工主题',
        '红白未来城市主题',
        '清透鼠尾草人物主题',
        '彩色灵感小宇宙主题',
        '蓝紫星夜人物主题',
        '青蓝虚拟歌姬主题',
        '舞台黑金人物主题',
      ],
    );
    assert.equal(dreamSkinConfig.dreamSkinConcepts.find((concept) => concept.id === 'skin-03').mode, 'no-person');
    assert.equal(dreamSkinConfig.dreamSkinConcepts.every((concept) => !('prompt' in concept)), true);
    assert.equal(dreamSkinConfig.dreamSkinConcepts.every((concept) => concept.theme?.colors?.light && concept.theme?.colors?.dark), true);
    assert.equal(dreamSkinConfig.dreamSkinConcepts.find((concept) => concept.id === 'skin-07').theme.colors.light.accent, '#0b7f91');
    assert.equal(dreamSkinConfig.dreamSkinConcepts.find((concept) => concept.id === 'skin-07').theme.art.focusX, 0.73);
    assert.deepEqual(
      dreamSkinConfig.dreamSkinConcepts.map((concept) => concept.wallpaper),
      [
        '/assets/dream-skin/wallpapers/skin-01.jpg',
        '/assets/dream-skin/wallpapers/skin-02.jpg',
        '/assets/dream-skin/wallpapers/skin-03.jpg',
        '/assets/dream-skin/wallpapers/skin-04.jpg',
        '/assets/dream-skin/wallpapers/skin-05.jpg',
        '/assets/dream-skin/wallpapers/skin-06.jpg',
        '/assets/dream-skin/wallpapers/skin-07.jpg',
        '/assets/dream-skin/wallpapers/skin-08.jpg',
      ],
    );

    const dreamSkinWallpaper = await fetch(
      `${baseUrl}/assets/dream-skin/wallpapers/skin-03.jpg`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(dreamSkinWallpaper.status, 200);
    assert.match(dreamSkinWallpaper.headers.get('content-type'), /image\/jpeg/);
    assert.ok((await dreamSkinWallpaper.arrayBuffer()).byteLength > 100_000);

    const retiredDreamSkinPresetAppearance = await fetch(`${baseUrl}/api/appearance`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatBackground: 'dream:preset-midnight-aurora',
        theme: 'dark',
      }),
    });
    assert.equal(retiredDreamSkinPresetAppearance.status, 200);
    const retiredDreamSkinPresetState = (await retiredDreamSkinPresetAppearance.json()).appearance;
    assert.equal(retiredDreamSkinPresetState.chatBackground, 'default');
    assert.equal(retiredDreamSkinPresetState.theme, 'dark');

    const appliedDreamSkinWallpaper = await fetch(`${baseUrl}/api/appearance`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatBackground: 'dream:skin-03' }),
    });
    assert.equal(appliedDreamSkinWallpaper.status, 200);
    assert.equal((await appliedDreamSkinWallpaper.json()).appearance.chatBackground, 'dream:skin-03');

    const generatedDreamSkinUpload = await fetch(`${baseUrl}/api/appearance/background`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Dream Skin generated.png',
        type: 'image/png',
        data: `data:image/png;base64,${Buffer.from('dream-skin-smoke').toString('base64')}`,
        themeId: 'skin-07',
      }),
    });
    assert.equal(generatedDreamSkinUpload.status, 200);
    const generatedDreamSkinState = await generatedDreamSkinUpload.json();
    assert.equal(generatedDreamSkinState.background.themeId, 'skin-07');
    assert.equal(
      generatedDreamSkinState.appearance.customBackgrounds.find(
        (background) => background.value === generatedDreamSkinState.background.value,
      ).themeId,
      'skin-07',
    );

    const persistedDreamSkinConfig = await fetch(`${baseUrl}/api/config`, {
      headers: { Cookie: cookie },
    });
    assert.equal(persistedDreamSkinConfig.status, 200);
    assert.equal(
      (await persistedDreamSkinConfig.json()).appearance.customBackgrounds.find(
        (background) => background.value === generatedDreamSkinState.background.value,
      ).themeId,
      'skin-07',
    );

    const dreamSkinAppearanceResponse = await fetch(`${baseUrl}/api/appearance`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatBackground: 'dream-skin' }),
    });
    assert.equal(dreamSkinAppearanceResponse.status, 200);
    assert.equal((await dreamSkinAppearanceResponse.json()).appearance.chatBackground, 'default');

    const dreamSkinPromptResponse = await fetch(`${baseUrl}/api/dream-skin/prompt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: '雨夜东京工作室，右侧霓虹窗景',
        conceptId: 'skin-03',
        referenceCount: 0,
      }),
    });
    assert.equal(dreamSkinPromptResponse.status, 200);
    const dreamSkinTask = await dreamSkinPromptResponse.json();
    assert.equal(dreamSkinTask.mode, 'no-person');
    assert.equal(dreamSkinTask.conceptId, 'skin-03');
    assert.equal(dreamSkinTask.skill, 'vendor/codex-dream-skin/SKILL.md');
    assert.match(dreamSkinTask.prompt, /完整读取并遵循项目内置技能/);
    assert.match(dreamSkinTask.prompt, /选用概念风格：skin-03 · 红白未来城市主题/);
    assert.match(dreamSkinTask.prompt, /完整 Dream Skin 的 artwork 层/);
    assert.match(dreamSkinTask.prompt, /严禁把侧栏、卡片、按钮、输入框或文字画进图片/);
    assert.match(dreamSkinTask.prompt, /A colossal translucent coral-red energy sphere rises above the horizon/);
    assert.match(dreamSkinTask.prompt, /必须实际调用 \$imagegen/);
    assert.match(dreamSkinTask.prompt, /雨夜东京工作室/);
    assert.equal(dreamSkinTask.cwd, ROOT);

    const dreamSkinReferenceError = await fetch(`${baseUrl}/api/dream-skin/prompt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'reference', referenceCount: 0 }),
    });
    assert.equal(dreamSkinReferenceError.status, 400);

    const pageResponse = await fetch(baseUrl, { headers: { Cookie: cookie } });
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /src="\/vendor\/marked\.js"/);
    assert.match(page, /src="\/vendor\/purify\.js"/);
    assert.match(page, /href="\/image-prompt\.css"/);
    assert.match(page, /src="\/image-prompt\.js"/);
    assert.match(page, /\['dream-skin','Dream Skin'\]/);
    assert.doesNotMatch(page, /\['plain','纯净'\]|\['paper','纸张'\]|\['grid','网格'\]/);
    assert.match(page, /function createDreamSkinGenerator/);
    assert.match(page, /function renderDreamSkinConcepts/);
    assert.match(page, /function renderDreamSkinConceptPreview/);
    assert.match(page, /function selectDreamSkinConcept/);
    assert.match(page, /saveAppearance\(\{chatBackground:'dream:'\+concept\.id\}\)/);
    assert.match(page, /function applyDreamSkinTheme/);
    assert.match(page, /const bg=skin&&backgroundUrl\?'skin':backgroundUrl\?'custom':selected/);
    assert.match(page, /themeId:concept\?\.id\|\|''/);
    assert.match(page, /if\(findDreamSkinConcept\(appearance\.chatBackground\)\)openDreamSkinGenerator\(\)/);
    assert.match(page, /conceptId:dreamSkinSelectedConcept/);
    assert.match(page, /function generateDreamSkinBackground/);
    assert.match(page, /function applyGeneratedImageBackground/);
    assert.match(page, /generatedBackgroundApply/);
    assert.match(page, /function renderAssistantMarkdown/);
    assert.match(page, /function toolActivityPresentations/);
    assert.match(page, /function planActivityPresentation/);
    assert.doesNotMatch(page, /function createTurnPlanElement|turnPlanPanel/);
    assert.match(page, /function upsertLiveTurnPlan/);
    assert.match(page, /presentation\.variant==='plan'/);
    assert.match(page, /descriptor\.name==='exec'[^\n]+target:'工具'/);
    assert.doesNotMatch(page, /descriptor\.name\+\(descriptor\.detail/);
    assert.match(page, /activityBatch/);
    assert.match(page, /liveProcessPanel/);
    assert.match(page, /let turnProcessStartedAt = 0;[\s\S]*let turnProcessElapsedLabel = null;[\s\S]*let turnProcessElapsedTimer = null;[\s\S]*let turnProcessElapsedFrozen = false;[\s\S]*let turnProcessElapsedTurnId = '';/);
    assert.match(page, /turnProcessHeader=document\.createElement\('div'\)/);
    assert.match(page, /turnProcessHeader\.insertBefore\(turnProcessElapsedLabel,turnProcessTimeline\)/);
    assert.match(page, /function beginTurnProcessCollection\(startedAt='',showElapsed=false,turnId=''\)/);
    assert.match(page, /beginTurnProcessCollection\(options\.at,showElapsed,options\.turnId\)/);
    assert.match(page, /function clearTurnProcessHeader\(\)\{\s*clearTurnReasoningStatus\(\);\s*clearTurnProcessElapsed\(\);/);
    assert.match(page, /beginTurnProcessCollection\(activeStartedAt,true,activeNativeTurnId\)/);
    assert.match(page, /hydrating:true/);
    assert.match(page, /function turnProcessElapsedMatches\(turnId\)/);
    assert.match(page, /if\(terminalProcess&&!turnProcessElapsedMatches\(options\.turnId\)\)return null/);
    assert.match(page, /if\(isCompletedNativeRuntimeTurn\(runtime\.turnId\)&&\['delta','item-completed','connection-error','turn'\]\.includes\(runtime\.type\)\)return/);
    assert.match(page, /\['delta','item-completed','connection-error','turn'\]\.includes\(runtime\.type\)\)return/);
    assert.match(page, /freezeTurnProcessElapsed\(options\.at,options\.turnId\)/);
    assert.match(page, /freezeTurnProcessElapsed\(runtime\.updatedAt,runtimeTurnId\)/);
    assert.match(page, /freezeTurnProcessElapsed\(conversation\.updatedAt,completingTurnId\)/);
    assert.match(page, /freezeTurnProcessElapsed\('',activeNativeTurnId\);clearLiveTurnProgress\(\);webRunActive=false/);
    assert.match(page, /function createActivityCluster/);
    assert.match(page, /function createActivityCluster[\s\S]*?cluster\.open=false;/);
    assert.match(page, /currentActivityCluster\.dataset\.activityLive='true'/);
    assert.match(page, /cluster\.dataset\.activityLive==='true'/);
    assert.match(page, /function updateTurnReasoningStatus/);
    assert.match(page, /if\(!turnReasoningStatus\)\{[\s\S]*turnReasoningStatus\.textContent=clean;[\s\S]*turnProcessTimeline\.appendChild\(turnReasoningStatus\)/);
    assert.doesNotMatch(page, /pendingActivityClusterTitle/);
    assert.match(page, /function isImageViewActivityPresentation/);
    assert.match(page, /image_view_activity/);
    assert.match(page, /function nativeToolImageUrls/);
    assert.match(page, /function createActivityImageGallery/);
    assert.match(page, /function loadSubagentTrace/);
    assert.match(page, /function appendSubagentTraceMessage/);
    assert.match(page, /function markSubagentTraceFinal/);
    assert.match(page, /if\(kind==='reasoning_summary'\)return false/);
    assert.match(page, /\/api\/native-sessions\/'\+encodeURIComponent\(state\.parentThreadId\)\+'\/subagents/);
    assert.match(page, /if\(source==='codex'\)\{\s*if\(running\)row\.appendChild\(running\);[\s\S]*row\.appendChild\(badge\);\s*}\s*row\.appendChild\(open\);\s*if\(running&&source!=='codex'\)row\.appendChild\(running\)/s);
    assert.match(page, /galleryOnly:true/);
    assert.doesNotMatch(page, /base\+\(index\+1\)\+generation/);
    assert.match(page, /continueMsg messageAction/);
    assert.match(page, /className='completionTimeline liveProcessTimeline'/);
    assert.doesNotMatch(page, /function updateTurnProcessLatest/);
    assert.match(page, /function appendInputImageToUser/);
    assert.match(page, /latestUserElement/);
    assert.match(page, /addMsg\('image',attachment\.url,\{kind:'input_image'\}\)/);
    assert.match(page, /stack\.classList\.toggle\('single',stack\.children\.length===1\)/);
    assert.match(page, /function runningActivityVerb/);
    assert.match(page, /sessionEvents\.addEventListener\('open'/);
    assert.match(page, /NATIVE_INITIAL_MESSAGE_LIMIT=60/);
    assert.match(page, /images=external&limit=/);
    assert.match(page, /function addNativeHistoryLoadButton/);
    assert.match(page, /function scheduleNativeCompletionSync/);
    assert.match(page, /function reconcileNativeCompletion/);
    assert.match(page, /runtime\.type==='connection-error'/);
    assert.match(page, /上游连接中断，正在重连/);
    assert.match(page, /document\.addEventListener\('visibilitychange',syncNativeAfterPageResume\)/);
    assert.match(page, /window\.addEventListener\('pageshow',syncNativeAfterPageResume\)/);
    assert.doesNotMatch(page, /setTimeout\(\(\)=>\{if\(currentConversationSource==='codex'.*loadConversation\(completedId,'codex'\)/);
    assert.doesNotMatch(page, /turnProcessAutoFollow/);
    assert.match(page, /上下文已自动压缩/);
    assert.doesNotMatch(page, /function appendTurnThinking/);
    assert.match(page, /id="sidePanel"/);
    assert.match(page, /function syncMenuButton/);
    assert.match(page, /sideCollapsed/);
    assert.match(page, /function setHistoryProjectExpanded/);
    assert.match(page, /function showHistoryProjectPreview/);
    assert.match(page, /itemCount\+' 个对话串 · '\+runningCount\+' 个已开启'/);
    assert.match(page, /codexWeb\.historyProjectsCollapsed/);
    assert.match(page, /codexWeb\.historyTasksCollapsed/);
    assert.match(page, /codexWeb\.historyProjectsHidden/);
    assert.match(page, /function createHistoryProjectMenu/);
    assert.match(page, /function archiveHistoryProject/);
    assert.match(page, /function toggleHistoryProjectHidden/);
    assert.match(page, /codexWeb\.historyProjectNames\.v1/);
    assert.match(page, /function renameHistoryProject/);
    assert.match(page, /'pencil','重命名项目'/);
    assert.match(page, /historyProjectName\(item\.cwd\)/);
    assert.match(page, /async function refreshHistory\(\)\{if\(activeHistoryProjectMenu\|\|historyProjectPreviewAnchor\)\{historyRefreshPending=true;return\}/);
    assert.match(page, /\/api\/native-projects\/archive/);
    assert.match(page, /function extractMemoryCitations/);
    assert.match(page, /function renderMemoryCitations/);
    assert.match(page, /group\.open=false/);
    assert.match(page, /function enhanceComposer/);
    assert.match(page, /function renderComposerProjectOptions/);
    assert.match(page, /function selectComposerProjectPath/);
    assert.match(page, /composerProjectToggle/);
    assert.match(page, /composerProjectPicker\.classList\.toggle\('hidden',hasConversation\)/);
    assert.match(page, /composerProjectPicker\.setAttribute\('aria-hidden',String\(hasConversation\)\)/);
    assert.match(page, /function enqueuePrompt/);
    assert.match(page, /function steerQueuedPrompt/);
    assert.match(page, /function showNativeSteerOptimistically/);
    assert.match(page, /kind:'steering_user'/);
    assert.match(page, /steering_browser_comment/);
    assert.doesNotMatch(page, /createBrowserCommentDetails/);
    assert.match(page, /id="archiveToggle"[^>]*>已归档任务<\/button><button id="automationToggle"[^>]*>自动化安排<\/button><\/div><button id="settingsToggle"/);
    assert.match(page, /function enhanceSubQuota/);
    assert.match(page, /subQuotaToggle\.id='subQuotaToggle'/);
    assert.match(page, /setIconLabel\(subQuotaToggle,'gauge','Sub2API 额度',false\)/);
    assert.match(page, /subQuotaPopover\.id='subQuotaPopover'/);
    assert.match(page, /pointerenter.*showSubQuotaPreview/);
    assert.match(page, /openSettings\(\{returnFocus:subQuotaToggle,focusTarget:subQuotaApiKeyInput\}\)/);
    assert.match(page, /id='subQuotaSettings'/);
    assert.match(page, /fetch\('\/api\/sub-quota-config'/);
    assert.match(page, /fetch\('\/api\/sub-quotas'/);
    assert.match(page, /!subQuotaToggle\?\.contains\(event\.target\)/);
    assert.match(page, /id="archiveView"[^>]*aria-labelledby="archiveViewTitle"/);
    assert.match(page, /id="automationView"[^>]*aria-labelledby="automationViewTitle"/);
    assert.match(page, /让 ChatGPT 安排任务、设置提醒或监测更新/);
    assert.match(page, /class="automationFormBody"/);
    assert.match(page, /id="automationName"[^>]*placeholder="已安排任务标题"/);
    assert.match(page, /id="automationPrompt"[^>]*placeholder="描述 ChatGPT 应该做什么"/);
    assert.match(page, /id="automationRunAt"[^>]*><option value="new-task">新任务/);
    assert.match(page, /id="automationCwd"[^>]*><option value="">无/);
    assert.match(page, /id="automationModel"[^>]*><option value="">默认模型/);
    assert.match(page, /id="automationReasoning"[^>]*>.*<option value="ultra">极高/s);
    assert.match(page, /id="automationFrequency"[^>]*>.*<option value="hourly">每隔数小时/s);
    assert.match(page, /id="automationDayField" class="automationSettingRow hidden"/);
    assert.match(page, /id="automationIntervalField" class="automationSettingRow hidden"/);
    assert.match(page, /class="automationTimeControl"[^>]*>.*id="automationTimeDisplay">9:00.*id="automationTime" type="time" value="09:00"/s);
    assert.match(page, /getElementById\('automationTime'\)\?\.addEventListener\('input',syncAutomationTimeDisplay\)/);
    assert.match(page, /id="automationNotification"[^>]*><option value="always">所有运行/);
    assert.match(page, /automationFrequency\?\.addEventListener\('change',syncAutomationScheduleFields\)/);
    assert.match(page, /notificationPolicy:document\.getElementById\('automationNotification'\)\?\.value\|\|'always'/);
    assert.match(page, /className='automationTabs'/);
    assert.match(page, /\{value:'',label:'全部'\}/);
    assert.match(page, /\{value:'ACTIVE',label:'已开启'\}/);
    assert.match(page, /\{value:'PAUSED',label:'已暂停'\}/);
    assert.match(page, /button\.setAttribute\('role','tab'\)/);
    assert.match(page, /toggle\.className='automationStateToggle '\+\(item\.status==='ACTIVE'\?'active':'paused'\)/);
    assert.match(page, /schedule\.textContent=scheduleLabel\+\(item\.status==='ACTIVE'&&item\.nextRunAt\?' · 下次运行 '/);
    assert.match(page, /button\.dataset\.accent=template\.accent/);
    assert.match(page, /icon:'file-search-2',accent:'green'/);
    assert.doesNotMatch(page, /add\.setAttribute\('data-lucide','plus'\)/);
    assert.match(page, /function openAutomationView/);
    assert.match(page, /function renderAutomations/);
    assert.match(page, /function openArchivedView/);
    assert.match(page, /function renderArchivedTasks/);
    assert.match(page, /永久删除全部已归档任务/);
    assert.match(page, /function createTurnResultArtifacts/);
    assert.match(page, /function createEditedFilesResultCard/);
    assert.match(page, /status\.className='turnResultStatus';\s*status\.textContent='已完成'/);
    assert.match(page, /function createWebPreviewResultCard/);
    assert.match(page, /function refreshLiveEditedFilesResult/);
    assert.match(page, /createEditedFilesResultCard\(files,'',\{live:true,plan:liveTurnPlan\}\)/);
    assert.match(page, /if\(item\._subagentTrace\?\.autoTrack\)loadSubagentTrace/);
    assert.doesNotMatch(page, /currentActivityCluster\.dataset\.activityGroup!==group/);
    assert.match(page, /turnProcessTimeline\.insertBefore\(element,matched\.nextSibling\)/);
    assert.match(page, /function appendConversationElement\(element,role\)/);
    assert.match(page, /appendConversationElement\(el,role\)/);
    assert.doesNotMatch(page, /matched\.open=true/);
    assert.match(page, /if\(steeringUser&&completedSteeringTimeline\)completedSteeringTimeline\.appendChild\(el\)/);
    assert.doesNotMatch(page, /function resetTurnProcessCollection\(\)[\s\S]*?nativeOptimisticSteering\.clear\(\)[\s\S]*?function beginTurnProcessCollection/);
    assert.match(page, /function dispatchNextQueuedPrompt/);
    assert.match(page, /createTrailingSingleFlight\(syncCurrentNativeConversationOnce\)/);
    assert.match(page, /<option value="ultra">ultra<\/option>/);
    assert.match(page, /\['low','medium','high','xhigh','max','ultra'\]\.includes\(metadata\.reasoningEffort\)/);
    assert.match(page, /function rememberNativeComposerOverride\(\)/);
    assert.match(page, /provider\?\.addEventListener\('change',async\(\)=>\{rememberNativeComposerOverride\(\);await loadModels\(provider\.value\);rememberNativeComposerOverride\(\);syncComposerChrome\(\)\}\)/);
    assert.match(page, /reasoningEffort\?\.addEventListener\('change',\(\)=>\{rememberNativeComposerOverride\(\);syncComposerChrome\(\)\}\)/);
    assert.match(page, /nativeComposerOverride=\{threadId:currentConversationId,provider:[^}]*reasoningEffort:/);
    assert.match(page, /if\(!preserveProviderModel&&\['low','medium','high','xhigh','max','ultra'\]\.includes\(metadata\.reasoningEffort\)\)/);
    assert.match(page, /if\(!preserveProviderModel&&metadata\.modelProvider/);
    assert.match(page, /setNativeComposerOverride\(existingId,requestedProvider,requestedModel,requestedReasoningEffort\);\s*const res=await fetch\(endpoint/);
    assert.match(page, /setNativeComposerOverride\(data\.threadId,requestedProvider,requestedModel,requestedReasoningEffort\)/);
    assert.match(page, /if\(currentConversationSource==='codex'&&currentConversationId===threadId\)\{\s*setNativeComposerOverride\(threadId,item\.provider,item\.model,item\.reasoningEffort\);/);
    assert.match(page, /for\(const control of \[provider,model,reasoningEffort\]\)control\.disabled=legacyLocked/);
    assert.match(page, /if\(webRunActive\)closeLockedComposerPopovers\(\{includeModel:legacyLocked\}\)/);
    assert.doesNotMatch(page, /if\(webRunActive\)closeComposerPopovers\(\)/);
    assert.match(page, /createComposerModelMenuRow\('model','模型'\)/);
    assert.match(page, /createComposerModelMenuRow\('reasoning','推理强度'\)/);
    assert.match(page, /createComposerModelMenuRow\('advanced','高级'\)/);
    assert.match(page, /row\.button\.classList\.toggle\('active',kind===activeKind\)/);
    assert.match(page, /row\.button\.setAttribute\('aria-expanded',String\(kind===activeKind\)\)/);
    assert.match(page, /运行中修改将用于下一条消息/);
    assert.match(page, /const conversation=data\.conversation;\s*if\(conversation\.status==='running'\)\{\s*applyNativeConversationMetadata\(conversation\.metadata\|\|\{\},\{preserveProviderModel:nativeComposerOverrideApplies\(id\)\}\);\s*syncComposerChrome\(\);\s*\}\s*if\(conversation\.reset\)/);
    assert.match(page, /e\.isComposing\|\|e\.keyCode===229/);
    assert.match(page, /if\(!e\.repeat\)send\(\)/);
    assert.match(page, /function formatMessageTime/);
    assert.match(page, /function enhanceSettingsModal/);
    assert.match(page, /function openImagePreview/);
    assert.match(page, /在新任务中继续/);
    assert.match(page, /continueAfter:true/);
    assert.doesNotMatch(page, /查看原图/);
    assert.match(page, /\/api\/password/);
    assert.match(page, /codexWeb\.promptQueue\.v1/);
    assert.match(page, /inputImage/);
    assert.match(page, /boot\(true\)/);
    assert.match(page, /async function boot\(selectRecent=false\)/);
    const inlineScript = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(inlineScript);
    const completedRuntimeHelper = inlineScript.match(/(function isCompletedNativeRuntimeTurn[\s\S]*?)(?=function connectSessionEvents)/)?.[1];
    assert.ok(completedRuntimeHelper);
    const isCompletedNativeRuntimeTurn = new Function(
      completedRuntimeHelper + '; return isCompletedNativeRuntimeTurn;',
    )();
    assert.equal(isCompletedNativeRuntimeTurn('turn-old', 'turn-old', ''), true);
    assert.equal(isCompletedNativeRuntimeTurn('turn-old', '', 'turn-old'), true);
    assert.equal(isCompletedNativeRuntimeTurn('turn-new', 'turn-old', 'turn-old'), false);
    assert.equal(isCompletedNativeRuntimeTurn('', 'turn-old', 'turn-old'), false);
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
    assert.equal(composerLabels.composerEffortLabel('ultra'), '极高');
    const elapsedTitleHelpers = inlineScript.match(/(function processedMessageTitle[\s\S]*?)(?=function clearTurnReasoningStatus)/)?.[1];
    assert.ok(elapsedTitleHelpers);
    const elapsedTitleApi = new Function(
      elapsedTitleHelpers + '; return { completionMessageTitle, liveProcessElapsedTitle, turnProcessStartTimestamp };',
    )();
    assert.equal(elapsedTitleApi.completionMessageTitle('任务完成，耗时 0.1s'), '已处理 1s');
    assert.equal(elapsedTitleApi.completionMessageTitle('任务完成，耗时 2159.6s'), '已处理 36m');
    assert.equal(elapsedTitleApi.completionMessageTitle('任务完成', 65), '已处理 1m 5s');
    assert.equal(elapsedTitleApi.liveProcessElapsedTitle(100_000, 100_000), '已处理 0s');
    assert.equal(elapsedTitleApi.liveProcessElapsedTitle(100_000, 133_999), '已处理 33s');
    assert.equal(elapsedTitleApi.liveProcessElapsedTitle(100_000, 160_000), '已处理 1m');
    assert.equal(elapsedTitleApi.liveProcessElapsedTitle(100_000, 165_000), '已处理 1m 5s');
    assert.equal(elapsedTitleApi.turnProcessStartTimestamp('not-a-date', 100_000), 100_000);
    const elapsedLifecycleHelpers = inlineScript.match(/(function turnProcessElapsedMatches[\s\S]*?)(?=function clearTurnProcessHeader)/)?.[1];
    assert.ok(elapsedLifecycleHelpers);
    const elapsedHeader = {
      children: [],
      insertBefore(node, before) {
        node.remove?.();
        const index = this.children.indexOf(before);
        node.parentNode = this;
        this.children.splice(index >= 0 ? index : this.children.length, 0, node);
        return node;
      },
    };
    const elapsedTimeline = { parentNode: elapsedHeader };
    elapsedHeader.children.push(elapsedTimeline);
    const elapsedDocument = {
      createElement() {
        return {
          className: '',
          dataset: {},
          parentNode: null,
          textContent: '',
          remove() {
            if (!this.parentNode) return;
            const index = this.parentNode.children.indexOf(this);
            if (index >= 0) this.parentNode.children.splice(index, 1);
            this.parentNode = null;
          },
        };
      },
    };
    let elapsedTimerCallback = null;
    let nextElapsedTimer = 17;
    const clearedElapsedTimers = [];
    const elapsedLifecycleApi = new Function(
      'document',
      'setInterval',
      'clearInterval',
      'liveProcessElapsedTitle',
      'turnProcessStartTimestamp',
      'turnProcessHeader',
      'turnProcessTimeline',
      `
        let turnProcessStartedAt = 0;
        let turnProcessElapsedLabel = null;
        let turnProcessElapsedTimer = null;
        let turnProcessElapsedFrozen = false;
        let turnProcessElapsedTurnId = '';
        function ensureTurnProcessHeader() { return turnProcessHeader; }
        ${elapsedLifecycleHelpers}
        return {
          clear: clearTurnProcessElapsed,
          ensure: ensureTurnProcessElapsedRunning,
          freeze: freezeTurnProcessElapsed,
          resume: resumeTurnProcessElapsed,
          start: startTurnProcessElapsed,
          update: updateTurnProcessElapsed,
          state: () => ({ turnProcessStartedAt, turnProcessElapsedLabel, turnProcessElapsedTimer, turnProcessElapsedFrozen, turnProcessElapsedTurnId }),
        };
      `,
    )(
      elapsedDocument,
      (callback, delay) => {
        assert.equal(delay, 1000);
        elapsedTimerCallback = callback;
        return nextElapsedTimer++;
      },
      (timer) => clearedElapsedTimers.push(timer),
      elapsedTitleApi.liveProcessElapsedTitle,
      elapsedTitleApi.turnProcessStartTimestamp,
      elapsedHeader,
      elapsedTimeline,
    );
    const liveElapsed = elapsedLifecycleApi.start('', 100_000, 'turn-new');
    assert.equal(liveElapsed.className, 'liveProcessElapsed');
    assert.equal(liveElapsed.dataset.messageKind, 'live_elapsed');
    assert.equal(liveElapsed.textContent, '已处理 0s');
    assert.deepEqual(elapsedHeader.children, [liveElapsed, elapsedTimeline]);
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedTimer, 17);
    elapsedLifecycleApi.update(133_999);
    assert.equal(liveElapsed.textContent, '已处理 33s');
    elapsedLifecycleApi.freeze(133_999, 'turn-old');
    assert.deepEqual(clearedElapsedTimers, []);
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedTimer, 17);
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedFrozen, false);
    elapsedLifecycleApi.freeze(133_999, 'turn-new');
    assert.deepEqual(clearedElapsedTimers, [17]);
    assert.deepEqual(elapsedHeader.children, [liveElapsed, elapsedTimeline]);
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedTimer, null);
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedFrozen, true);
    elapsedTimerCallback();
    assert.equal(liveElapsed.textContent, '已处理 33s');
    assert.strictEqual(elapsedLifecycleApi.resume(165_000), liveElapsed);
    assert.equal(liveElapsed.textContent, '已处理 1m 5s');
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedTimer, 18);
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedFrozen, false);
    assert.strictEqual(elapsedLifecycleApi.ensure('ignored', 166_000, 'turn-new'), liveElapsed);
    assert.equal(elapsedLifecycleApi.state().turnProcessElapsedTimer, 18);
    elapsedLifecycleApi.clear();
    assert.deepEqual(clearedElapsedTimers, [17, 18]);
    assert.deepEqual(elapsedHeader.children, [elapsedTimeline]);
    assert.deepEqual(elapsedLifecycleApi.state(), {
      turnProcessStartedAt: 0,
      turnProcessElapsedLabel: null,
      turnProcessElapsedTimer: null,
      turnProcessElapsedFrozen: false,
      turnProcessElapsedTurnId: '',
    });
    const reasoningStatusHelpers = inlineScript.match(/(function clearTurnReasoningStatus[\s\S]*?)(?=function clearTurnProcessHeader)/)?.[1];
    assert.ok(reasoningStatusHelpers);
    const reasoningTimeline = {
      children: [],
      appendChild(node) {
        if (node.parentNode) {
          const currentIndex = node.parentNode.children.indexOf(node);
          if (currentIndex >= 0) node.parentNode.children.splice(currentIndex, 1);
        }
        node.parentNode = this;
        node.isConnected = true;
        this.children.push(node);
        return node;
      },
    };
    const reasoningDocument = {
      createElement() {
        return {
          className: '',
          dataset: {},
          isConnected: false,
          parentNode: null,
          remove() {
            if (!this.parentNode) return;
            const currentIndex = this.parentNode.children.indexOf(this);
            if (currentIndex >= 0) this.parentNode.children.splice(currentIndex, 1);
            this.parentNode = null;
            this.isConnected = false;
          },
        };
      },
    };
    const reasoningApi = new Function('document', 'turnProcessTimeline', `
      let turnReasoningStatus = null;
      let currentActivityCluster = null;
      function shortActivityText(value, max = 100) {
        const clean = String(value || '').replace(/\\s+/g, ' ').trim();
        return clean.length > max ? clean.slice(0, max - 3) + '...' : clean;
      }
      function ensureTurnProcessHeader() { return turnProcessTimeline; }
      function moveLiveEditedFilesResultToEnd() {}
      function clearActiveActivityReasoning() {}
      ${reasoningStatusHelpers}
      return {
        clear: clearTurnReasoningStatus,
        current: () => turnReasoningStatus,
        move: moveTurnReasoningStatusToEnd,
        shouldClear: shouldClearTurnReasoningStatus,
        shouldClearPending: shouldClearPendingActivityReasoning,
        update: updateTurnReasoningStatus,
      };
    `)(reasoningDocument, reasoningTimeline);
    const firstReasoning = reasoningApi.update('Opening browser skill for execution');
    const secondReasoning = reasoningApi.update('Refining chat view loading and display logic');
    assert.strictEqual(secondReasoning, firstReasoning);
    assert.equal(reasoningTimeline.children.length, 1);
    assert.equal(secondReasoning.textContent, 'Refining chat view loading and display logic');
    const laterTool = { isConnected: false, parentNode: null };
    reasoningTimeline.appendChild(laterTool);
    reasoningApi.move();
    assert.strictEqual(reasoningTimeline.children.at(-1), secondReasoning);
    assert.equal(reasoningApi.shouldClear('assistant', 'commentary'), true);
    assert.equal(reasoningApi.shouldClear('assistant', 'final_answer'), true);
    assert.equal(reasoningApi.shouldClear('process', 'turn_aborted'), true);
    assert.equal(reasoningApi.shouldClear('process', 'task_error'), true);
    assert.equal(reasoningApi.shouldClear('process', 'context_compacted'), false);
    assert.equal(reasoningApi.shouldClearPending('assistant', 'commentary'), false);
    assert.equal(reasoningApi.shouldClearPending('assistant', 'final_answer'), true);
    assert.equal(reasoningApi.shouldClearPending('user', 'steering_browser_comment', true), false);
    assert.equal(reasoningApi.shouldClearPending('user', 'message', false), true);
    reasoningApi.clear();
    assert.equal(reasoningTimeline.children.length, 1);
    assert.equal(reasoningApi.current(), null);
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
    const activityApi = new Function(`${activityHelpers}; return { normalizeTurnPlanItems, toolActivityPresentations, activityClusterPresentation, activityClusterMatchesBrowserTarget, markCurrentActivityItem };`)();
    const parseToolActivity = activityApi.toolActivityPresentations;
    const semanticCluster = (activityGroup, streaming = false) => ({
      dataset: { activityGroup },
      querySelectorAll(selector) {
        if (selector === ':scope > .activityClusterItems > .activityBatch') {
          return streaming ? [{ classList: { contains: (name) => name === 'streaming' } }] : [];
        }
        return [];
      },
    });
    assert.deepEqual(activityApi.activityClusterPresentation(semanticCluster('loaded_tools')), {
      icon: 'wrench',
      text: '已加载工具',
    });
    assert.deepEqual(activityApi.activityClusterPresentation(semanticCluster('files_read')), {
      icon: 'book-open',
      text: '已读取文件',
    });
    const clusterItem = ({ verb, currentVerb = verb, target = '', icon = 'wrench', classes = [] }) => ({
      classList: { contains: (name) => classes.includes(name) },
      querySelector(selector) {
        if (selector === '.activityVerb') return { dataset: { completedVerb: verb }, textContent: currentVerb };
        if (selector === '.activityTarget') return { textContent: target };
        if (selector === '.activityItemIcon [data-lucide]') {
          return { getAttribute: (name) => name === 'data-lucide' ? icon : null };
        }
        return null;
      },
    });
    const clusterBatch = (activityGroup, items, streaming = false) => ({
      dataset: { activityGroup },
      classList: { contains: (name) => name === 'streaming' && streaming },
      querySelectorAll: (selector) => selector === '.activityItem' ? items : [],
    });
    const activityCluster = (batches, reasoning = [], rawReasoning = null) => ({
      dataset: {
        activityGroup: 'tools',
        activityReasoning: rawReasoning ?? JSON.stringify(reasoning),
      },
      querySelectorAll(selector) {
        if (selector === ':scope > .activityClusterItems > .activityBatch') return batches;
        if (selector === '.activityItem') return batches.flatMap((batch) => batch.querySelectorAll('.activityItem'));
        return [];
      },
    });
    const commandItem = () => clusterItem({
      verb: 'Ran',
      currentVerb: 'Ran',
      target: 'command',
      icon: 'square-terminal',
    });
    assert.deepEqual(activityApi.activityClusterPresentation(activityCluster([
      clusterBatch('commands', [commandItem()]),
      clusterBatch('commands', [commandItem()]),
      clusterBatch('commands', [commandItem()]),
    ])), {
      icon: 'square-terminal',
      text: '运行了多个命令',
    });
    assert.deepEqual(activityApi.activityClusterPresentation(activityCluster([
      clusterBatch('commands', [commandItem()]),
      clusterBatch('commands', [commandItem()]),
    ], ['Planning first step', 'Planning latest step'])), {
      icon: 'square-terminal',
      text: 'Planning latest step',
    });
    assert.deepEqual(activityApi.activityClusterPresentation(activityCluster([
      clusterBatch('commands', [commandItem()]),
      clusterBatch('commands', [commandItem()]),
    ], ['   '])), {
      icon: 'square-terminal',
      text: '运行了多个命令',
    });
    assert.deepEqual(activityApi.activityClusterPresentation(activityCluster([
      clusterBatch('commands', [commandItem()]),
      clusterBatch('commands', [commandItem()]),
    ], [], '{broken')), {
      icon: 'square-terminal',
      text: '运行了多个命令',
    });
    const currentItems = [{ dataset: { current: 'true' } }, { dataset: {} }];
    assert.strictEqual(activityApi.markCurrentActivityItem({
      querySelectorAll: (selector) => selector === '.activityItem' ? currentItems : [],
    }), currentItems[1]);
    assert.equal(currentItems[0].dataset.current, undefined);
    assert.equal(currentItems[1].dataset.current, 'true');
    assert.deepEqual(activityApi.activityClusterPresentation(activityCluster([
      clusterBatch('loaded_tools', [clusterItem({
        verb: '读取',
        currentVerb: '读取',
        target: 'Browser 技能',
        icon: 'wrench',
        classes: ['skillTarget'],
      })]),
      clusterBatch('commands', [commandItem(), commandItem()]),
    ])), {
      icon: 'wrench',
      text: '已加载工具运行了多个命令',
    });
    assert.deepEqual(activityApi.activityClusterPresentation(activityCluster([
      clusterBatch('files_read', [clusterItem({
        verb: '已读取',
        currentVerb: '正在读取',
        target: '2026-07-11T04-52-18-ZaKl-codex_web',
        icon: 'book-open',
        classes: ['memoryTarget'],
      })], true),
    ])), {
      icon: 'book-open',
      text: '正在读取 2026-07-11T04-52-18-ZaKl-codex_web',
    });
    const skillClusterAfterCommentary = {
      dataset: { activityReasoning: JSON.stringify(['Opening browser skill for execution']) },
    };
    assert.equal(
      activityApi.activityClusterMatchesBrowserTarget(skillClusterAfterCommentary, 'Opening browser skill for execution'),
      true,
    );
    assert.equal(
      activityApi.activityClusterMatchesBrowserTarget({
        dataset: { activityReasoning: JSON.stringify(['Older planning title', 'Latest planning title']) },
      }, 'Older planning title'),
      true,
    );
    const skillCall = [
      'exec',
      'const result = await tools.exec_command({"cmd":"cat /tmp/plugins/browser/skills/control-in-app-browser/SKILL.md"});',
    ].join('\n');
    assert.deepEqual(parseToolActivity(skillCall), [{
      verb: '读取',
      target: 'Control In App Browser 技能',
      icon: 'wrench',
      targetType: 'skill',
      activityGroup: 'loaded_tools',
      expandable: false,
    }]);
    assert.deepEqual(parseToolActivity("exec_command\nsed -n '1,40p' server.mjs\nworkdir=/workspace"), [{
      verb: '已读取',
      target: 'server.mjs',
      icon: 'book-open',
      targetType: 'file',
    }]);
    assert.deepEqual(parseToolActivity('exec\nconst result = await tools.exec_command({cmd:"sed -n \'1,40p\' server.mjs", workdir:"/workspace"});'), [{
      verb: '已读取',
      target: 'server.mjs',
      icon: 'book-open',
      targetType: 'file',
      expandable: false,
    }]);
    assert.deepEqual(parseToolActivity('exec_command\nrg -n "menuBtn|toggleMenu" server.mjs ui.css'), [{
      verb: '已在',
      target: 'server.mjs',
      suffix: '中搜索“menuBtn|toggleMenu”',
      icon: 'search',
      targetType: 'file',
    }]);
    assert.deepEqual(parseToolActivity('spawn_agent\n{\n  "task_name": "ui_trace",\n  "fork_turns": "all"\n}'), [{
      variant: 'agent',
      agentKey: 'ui_trace',
      label: 'Ui trace',
      agentAction: 'spawn',
      status: '已开始工作',
      icon: 'flower-2',
      expandable: true,
    }]);
    assert.deepEqual(parseToolActivity('followup_task\n{\n  "target": "agent_group_final_review",\n  "message": "复核当前改动"\n}'), [{
      variant: 'agent',
      agentKey: 'agent_group_final_review',
      label: 'Agent group final review',
      agentAction: 'followup',
      status: '已更新',
      icon: 'flower-2',
      expandable: true,
    }]);
    assert.deepEqual(parseToolActivity([
      '调用工具: update_plan',
      'call_id=call-plan-1',
      '{"explanation":"同步当前进度","plan":[{"step":"拆解参考图并对照当前实页 DOM、状态与样式","status":"completed"},{"step":"实现连续工具聚合、最新运行项、Agent 自动完成与紧凑文件 pill","status":"in_progress"},{"step":"补充状态/DOM/CSS 回归测试并运行完整检查","status":"pending"}]}',
    ].join('\n')), [{
      variant: 'plan',
      explanation: '同步当前进度',
      plan: [
        { step: '拆解参考图并对照当前实页 DOM、状态与样式', status: 'completed' },
        { step: '实现连续工具聚合、最新运行项、Agent 自动完成与紧凑文件 pill', status: 'in_progress' },
        { step: '补充状态/DOM/CSS 回归测试并运行完整检查', status: 'pending' },
      ],
    }]);
    assert.deepEqual(parseToolActivity([
      'exec',
      'const result = await tools.update_plan({',
      '  explanation: "同步当前进度",',
      '  plan: [',
      '    { step: "拆解参考图并对照当前实页 DOM、状态与样式", status: "completed" },',
      '    { step: "实现连续工具聚合、最新运行项、Agent 自动完成与紧凑文件 pill", status: "in_progress" },',
      '    { step: "补充状态/DOM/CSS 回归测试并运行完整检查", status: "pending" }',
      '  ]',
      '});',
      'text(result);',
    ].join('\n')), [{
      variant: 'plan',
      explanation: '同步当前进度',
      plan: [
        { step: '拆解参考图并对照当前实页 DOM、状态与样式', status: 'completed' },
        { step: '实现连续工具聚合、最新运行项、Agent 自动完成与紧凑文件 pill', status: 'in_progress' },
        { step: '补充状态/DOM/CSS 回归测试并运行完整检查', status: 'pending' },
      ],
    }]);
    assert.deepEqual(parseToolActivity([
      'exec_command',
      'nl -ba /Users/ikirito/.codex/memories/rollout_summaries/2026-07-11T04-52-18-ZaKl-codex_web.md',
    ].join('\n')), [{
      verb: '已读取',
      target: '2026-07-11T04-52-18-ZaKl-codex_web',
      icon: 'book-open',
      targetType: 'memory',
      expandable: false,
    }]);
    assert.deepEqual(parseToolActivity('调用工具: spawn_agent\ncall_id=call-1\n{"task_name":"ui_trace"}'), [{
      variant: 'agent',
      agentKey: 'ui_trace',
      label: 'Ui trace',
      agentAction: 'spawn',
      status: '已开始工作',
      icon: 'flower-2',
      expandable: true,
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
      { verb: '已读取', target: 'server.mjs', icon: 'book-open', targetType: 'file', expandable: false },
      { verb: '已在', target: 'ui.css', suffix: '中搜索“composer”', icon: 'search', targetType: 'file', expandable: false },
    ]);
    const archiveProtocolCall = [
      'exec',
      'const results = await Promise.all([',
      ...[
        "rg -n -C 6 'archive|archived|归档|unarchive' server.mjs native-sessions.mjs desktop-ipc-client.mjs",
        "sed -n '430,670p' desktop-ipc-client.mjs",
        "sed -n '4300,4660p' server.mjs",
        "sed -n '2500,2825p' server.mjs",
        "rg -n -i 'thread.*archive|archive.*thread|conversation.*archive|archived' /Applications/Codex.app/Contents/Resources | head",
      ].map((command) => '  tools.exec_command({cmd:'+JSON.stringify(command)+'}),'),
      ']);',
    ].join('\n');
    const archiveProtocolActivity = parseToolActivity(archiveProtocolCall);
    assert.deepEqual(archiveProtocolActivity.slice(0, 4), [
      { verb: '已读取', target: 'desktop-ipc-client.mjs', icon: 'book-open', targetType: 'file', expandable: false },
      { verb: '已读取', target: 'server.mjs', icon: 'book-open', targetType: 'file', expandable: false },
      { verb: '已读取', target: 'server.mjs', icon: 'book-open', targetType: 'file', expandable: false },
      {
        verb: '已在',
        target: 'server.mjs',
        suffix: '中搜索“archive|archived|归档|unarchive”',
        icon: 'search',
        targetType: 'file',
        expandable: false,
      },
    ]);
    assert.equal(archiveProtocolActivity[4].verb, 'Ran');
    assert.equal(archiveProtocolActivity[4].icon, 'square-terminal');
    assert.equal(archiveProtocolActivity[4].expandable, false);
    assert.match(archiveProtocolActivity[4].target, /^rg -n -i/);
    const patchCall = 'exec\nconst patch = "*** Begin Patch\\n*** Update File: /workspace/server.mjs\\n-old\\n---literal-minus\\n+new\\n+++literal-plus\\n*** Update File: /workspace/ui.css\\n+added\\n*** End Patch";\ntext(await tools.apply_patch(patch));';
    assert.deepEqual(parseToolActivity(patchCall), [
      {
        verb: '已编辑',
        icon: 'pencil',
        target: 'server.mjs',
        filePath: '/workspace/server.mjs',
        added: 2,
        removed: 2,
        meta: '+2 -2',
      },
      {
        verb: '已编辑',
        icon: 'pencil',
        target: 'ui.css',
        filePath: '/workspace/ui.css',
        added: 1,
        removed: 0,
        meta: '+1 -0',
      },
    ]);
    const falseImagePatchCall = 'exec\nconst patch = "*** Begin Patch\\n*** Update File: /workspace/fake-ui.js\\n+tools.view_image({path:\\"/tmp/not-a-real-image.png\\"})\\n*** End Patch";\ntext(await tools.apply_patch(patch));';
    assert.deepEqual(parseToolActivity(falseImagePatchCall), [
      {
        verb: '已编辑',
        icon: 'pencil',
        target: 'fake-ui.js',
        filePath: '/workspace/fake-ui.js',
        added: 1,
        removed: 0,
        meta: '+1 -0',
      },
    ]);

    const editedFilesHelper = inlineScript.match(
      /(function editedFilesFromTurnArtifacts[\s\S]*?)(?=function browserPreviewFromTurnArtifacts)/,
    )?.[1];
    assert.ok(editedFilesHelper);
    const editedFilesFromTurnArtifacts = new Function(
      editedFilesHelper + '; return editedFilesFromTurnArtifacts;',
    )();
    const editedItem = {
      dataset: { filePath: '/workspace/server.mjs' },
      querySelector(selector) {
        if (selector === '.activityVerb') return { dataset: { completedVerb: '已编辑' } };
        if (selector === '.activityTarget') return { textContent: 'server.mjs' };
        if (selector === '.activityMeta') return { textContent: '+12 -3' };
        return null;
      },
    };
    assert.deepEqual(editedFilesFromTurnArtifacts([{
      matches: () => false,
      querySelectorAll: () => [editedItem],
    }]), [{ name: '/workspace/server.mjs', verb: '已编辑', added: 12, removed: 3 }]);
    const sameBasenameItem = {
      dataset: { filePath: '/workspace/test/server.mjs' },
      querySelector(selector) {
        if (selector === '.activityVerb') return { dataset: { completedVerb: '已编辑' } };
        if (selector === '.activityTarget') return { textContent: 'server.mjs' };
        if (selector === '.activityMeta') return { textContent: '+4 -1' };
        return null;
      },
    };
    assert.deepEqual(editedFilesFromTurnArtifacts([{
      matches: () => false,
      querySelectorAll: () => [editedItem, sameBasenameItem],
    }]), [
      { name: '/workspace/server.mjs', verb: '已编辑', added: 12, removed: 3 },
      { name: '/workspace/test/server.mjs', verb: '已编辑', added: 4, removed: 1 },
    ]);

    const browserPreviewHelper = inlineScript.match(
      /(function browserPreviewFromTurnArtifacts[\s\S]*?)(?=function createResultCardButton)/,
    )?.[1];
    assert.ok(browserPreviewHelper);
    const browserPreviewFromTurnArtifacts = new Function(
      browserPreviewHelper + '; return browserPreviewFromTurnArtifacts;',
    )();
    assert.deepEqual(browserPreviewFromTurnArtifacts([{
      dataset: {
        messageText: [
          'mcp__node_repl__js',
          'await tab.goto("http://127.0.0.1:36354/demo")',
          'await tab.playwright.domSnapshot()',
          'const docs = "https://example.com/unrelated"',
        ].join('\n'),
      },
      querySelectorAll: () => [],
    }]), {
      url: 'http://127.0.0.1:36354/demo',
      label: '127.0.0.1:36354/demo',
    });
    assert.equal(browserPreviewFromTurnArtifacts([{
      dataset: {
        messageText: 'mcp__node_repl__js\nawait browser.documentation()\nconst docs = "https://example.com/docs"',
      },
      querySelectorAll: () => [],
    }]), null);

    class FixtureElement {
      constructor(tagName) {
        this.tagName = String(tagName).toUpperCase();
        this.children = [];
        this.dataset = {};
        this.attributes = new Map();
        this.className = '';
        this.open = false;
      }

      appendChild(child) {
        if (child.parentNode) {
          const previousIndex = child.parentNode.children.indexOf(child);
          if (previousIndex >= 0) child.parentNode.children.splice(previousIndex, 1);
        }
        this.children.push(child);
        child.parentNode = this;
        return child;
      }

      insertBefore(child, before) {
        if (child.parentNode) {
          const previousIndex = child.parentNode.children.indexOf(child);
          if (previousIndex >= 0) child.parentNode.children.splice(previousIndex, 1);
        }
        const index = this.children.indexOf(before);
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
        child.parentNode = this;
        return child;
      }

      get classList() {
        const element = this;
        const values = () => new Set(String(element.className || '').split(/\s+/).filter(Boolean));
        const write = (items) => { element.className = [...items].join(' '); };
        return {
          contains(name) { return values().has(name); },
          add(name) { const items = values(); items.add(name); write(items); },
          remove(name) { const items = values(); items.delete(name); write(items); },
          toggle(name, force) {
            const items = values();
            const enabled = force === undefined ? !items.has(name) : Boolean(force);
            if (enabled) items.add(name); else items.delete(name);
            write(items);
            return enabled;
          },
        };
      }

      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      }

      addEventListener() {}
    }
    const activityDomHelpers = inlineScript.match(
      /(function createActivityImageGallery[\s\S]*?)(?=const SUBAGENT_TRACE_POLL_MS)/,
    )?.[1];
    assert.ok(activityDomHelpers);
    const activityDomApi = new Function(
      'document',
      'openImagePreview',
      'refreshIcons',
      'setIconLabel',
      `let pendingAgentActivityBatches = []; ${activityDomHelpers}; return { createToolActivityItem, createActivityBatch, createAgentActivityGroup, appendAgentActivityBatch, updateAgentActivityGroupStatus, isAgentActivityOutput, queueAgentActivityBatch, takePendingAgentActivityBatch };`,
    )(
      { createElement: (tagName) => new FixtureElement(tagName) },
      () => {},
      () => {},
      () => {},
    );
    const { createToolActivityItem } = activityDomApi;
    const imageActivity = createToolActivityItem({
      verb: '已查看',
      target: '1 张图像',
      icon: 'image',
      expandable: true,
      galleryOnly: true,
      imageUrls: ['/api/native-sessions/thread/tool-images/7/1'],
    }, 'exec\nreal image call');
    const activityNodes = (node) => [node, ...node.children.flatMap(activityNodes)];
    const turnPlanProgressHelper = inlineScript.match(
      /(function turnPlanProgress[\s\S]*?)(?=function upsertLiveTurnPlan)/,
    )?.[1];
    assert.ok(turnPlanProgressHelper);
    const turnPlanDomApi = new Function(
      'normalizeTurnPlanItems',
      turnPlanProgressHelper + '; return { turnPlanProgress };',
    )(
      activityApi.normalizeTurnPlanItems,
    );
    const referencePlan = [
      { step: '拆解参考图并对照当前实页 DOM、状态与样式', status: 'completed' },
      { step: '实现连续工具聚合、最新运行项、Agent 自动完成与紧凑文件 pill', status: 'in_progress' },
      { step: '补充状态/DOM/CSS 回归测试并运行完整检查', status: 'pending' },
      { step: '重启本地服务并在桌面、375px、345px 深浅主题验收', status: 'pending' },
      { step: '提交、推送到 PR #12 并等待 CI', status: 'pending' },
    ];
    assert.deepEqual(turnPlanDomApi.turnPlanProgress(referencePlan), {
      items: referencePlan,
      total: 5,
      current: 2,
      completed: 1,
      percent: 40,
    });
    const upsertLiveTurnPlanHelper = inlineScript.match(
      /(function upsertLiveTurnPlan[\s\S]*?)(?=function appendTurnTool)/,
    )?.[1];
    assert.ok(upsertLiveTurnPlanHelper);
    const planTransparencyApi = new Function('normalizeTurnPlanItems', `
      const toolCluster = { kind: 'tool-cluster' };
      const agentGroup = { kind: 'agent-group' };
      const livePill = { kind: 'live-pill' };
      let currentActivityCluster = toolCluster;
      let currentAgentActivityGroup = agentGroup;
      let pendingActivityReasoning = ['kept reasoning'];
      let liveTurnPlan = [];
      let ensureCalls = 0;
      let refreshCalls = 0;
      let moveCalls = 0;
      function ensureTurnProcessHeader() { ensureCalls += 1; }
      function refreshLiveEditedFilesResult() { refreshCalls += 1; return livePill; }
      function moveLiveEditedFilesResultToEnd() { moveCalls += 1; }
      ${upsertLiveTurnPlanHelper}
      return {
        run: upsertLiveTurnPlan,
        state: () => ({
          currentActivityCluster,
          currentAgentActivityGroup,
          pendingActivityReasoning,
          liveTurnPlan,
          ensureCalls,
          refreshCalls,
          moveCalls,
          toolCluster,
          agentGroup,
          livePill,
        }),
      };
    `)(activityApi.normalizeTurnPlanItems);
    assert.strictEqual(planTransparencyApi.run(referencePlan), planTransparencyApi.state().livePill);
    const transparentPlanState = planTransparencyApi.state();
    assert.strictEqual(transparentPlanState.currentActivityCluster, transparentPlanState.toolCluster);
    assert.strictEqual(transparentPlanState.currentAgentActivityGroup, transparentPlanState.agentGroup);
    assert.deepEqual(transparentPlanState.pendingActivityReasoning, ['kept reasoning']);
    assert.deepEqual(transparentPlanState.liveTurnPlan, referencePlan);
    assert.equal(transparentPlanState.ensureCalls, 1);
    assert.equal(transparentPlanState.refreshCalls, 1);
    assert.equal(transparentPlanState.moveCalls, 1);
    const renderedActivityNodes = activityNodes(imageActivity);
    assert.equal(imageActivity.tagName, 'DETAILS');
    assert.equal(imageActivity.open, false);
    assert.equal(renderedActivityNodes.filter((node) => node.className.includes('activityImageGallery')).length, 1);
    assert.equal(renderedActivityNodes.filter((node) => node.className === 'activityRaw').length, 0);
    assert.equal(renderedActivityNodes.filter((node) => node.className === 'activityItemChevron').length, 1);
    assert.equal(renderedActivityNodes.find((node) => node.tagName === 'IMG').src, '/api/native-sessions/thread/tool-images/7/1');

    const agentActivity = createToolActivityItem({
      variant: 'agent',
      agentKey: 'ui_trace',
      label: 'Ui trace',
      status: '已开始工作',
      icon: 'flower-2',
      expandable: true,
    }, 'spawn_agent\n{"task_name":"ui_trace"}', true, { parentThreadId: nativeSessionId });
    const agentActivityNodes = activityNodes(agentActivity);
    assert.equal(agentActivity.tagName, 'DETAILS');
    assert.equal(agentActivity.open, false);
    assert.equal(agentActivity.className, 'activityItem agentActivityItem');
    assert.equal(agentActivity.dataset.agentKey, 'ui_trace');
    assert.equal(agentActivity.dataset.parentThreadId, nativeSessionId);
    assert.equal(agentActivityNodes.find((node) => node.className === 'agentActivityLabel').textContent, 'Ui trace');
    assert.equal(agentActivityNodes.find((node) => node.className === 'agentActivityStatus').textContent, '正在启动');
    assert.equal(agentActivityNodes.find((node) => node.className === 'agentActivityIcon').children[0].attributes.get('data-lucide'), 'flower-2');
    assert.equal(agentActivityNodes.filter((node) => node.className.includes('subagentTraceTimeline')).length, 1);
    assert.equal(agentActivityNodes.filter((node) => node.className.includes('agentActivityChevron')).length, 1);

    const agentPresentation = (agentKey, label) => ({
      variant: 'agent',
      agentKey,
      label,
      status: '已开始工作',
      icon: 'flower-2',
      expandable: true,
    });
    const firstAgentBatch = activityDomApi.createActivityBatch(
      [agentPresentation('final_diff_review', 'Final diff review')],
      'spawn_agent\n{"task_name":"final_diff_review"}',
      'agent_activity',
      true,
      { parentThreadId: nativeSessionId },
    );
    const secondAgentBatch = activityDomApi.createActivityBatch(
      [agentPresentation('final_ui_review', 'Final ui review')],
      'spawn_agent\n{"task_name":"final_ui_review"}',
      'agent_activity',
      true,
      { parentThreadId: nativeSessionId },
    );
    const agentGroup = activityDomApi.createAgentActivityGroup();
    activityDomApi.appendAgentActivityBatch(agentGroup, firstAgentBatch);
    activityDomApi.appendAgentActivityBatch(agentGroup, secondAgentBatch);
    assert.equal(agentGroup.className, 'msg agentActivityGroup streaming');
    assert.deepEqual(agentGroup.children, [firstAgentBatch, secondAgentBatch, agentGroup._agentActivityStatus]);
    assert.equal(agentGroup._agentActivityItems.length, 2);
    assert.equal(agentGroup._agentActivityStatus.textContent, '正在启动');
    assert.equal(agentGroup._agentActivityStatus.attributes.get('role'), 'status');
    assert.equal(activityDomApi.isAgentActivityOutput('spawn_agent output\n{"task_name":"/root/final_diff_review"}'), true);
    assert.equal(activityDomApi.isAgentActivityOutput('followup_task output\n{"target":"/root/final_diff_review"}'), true);
    assert.equal(activityDomApi.isAgentActivityOutput('exec output\n[]'), false);
    activityDomApi.queueAgentActivityBatch(firstAgentBatch);
    activityDomApi.queueAgentActivityBatch(secondAgentBatch);
    assert.strictEqual(activityDomApi.takePendingAgentActivityBatch(), firstAgentBatch);
    firstAgentBatch.classList.remove('streaming');
    assert.strictEqual(activityDomApi.takePendingAgentActivityBatch(), secondAgentBatch);
    for (const item of agentGroup._agentActivityItems) item.dataset.traceState = 'ready';
    firstAgentBatch.classList.remove('streaming');
    secondAgentBatch.classList.remove('streaming');
    activityDomApi.updateAgentActivityGroupStatus(agentGroup);
    assert.equal(agentGroup.className, 'msg agentActivityGroup');
    assert.equal(agentGroup._agentActivityStatus.textContent, '已开始工作');

    const editedFilesCardHelper = inlineScript.match(
      /(function createEditedFilesResultCard[\s\S]*?)(?=function moveLiveEditedFilesResultToEnd)/,
    )?.[1];
    assert.ok(editedFilesCardHelper);
    const createEditedFilesResultCard = new Function(
      'document',
      'createResultCardButton',
      'prepareUndoEditedFiles',
      'reviewTurnArtifacts',
      'turnPlanProgress',
      editedFilesCardHelper + '; return createEditedFilesResultCard;',
    )(
      { createElement: (tagName) => new FixtureElement(tagName) },
      () => new FixtureElement('button'),
      () => {},
      () => {},
      turnPlanDomApi.turnPlanProgress,
    );
    const compactEditedFiles = createEditedFilesResultCard([
      { name: '/workspace/ui.css', verb: '已编辑', added: 1, removed: 1 },
      { name: '/workspace/server.mjs', verb: '已编辑', added: 1, removed: 1 },
    ], '', { live: true });
    const compactEditedNodes = activityNodes(compactEditedFiles);
    assert.equal(compactEditedFiles.tagName, 'DETAILS');
    assert.equal(compactEditedFiles.className, 'turnResultCard editedFilesResult live');
    assert.equal(compactEditedFiles.attributes.get('aria-label'), '2 个文件已更改');
    assert.equal(compactEditedFiles.children[0].tagName, 'SUMMARY');
    assert.equal(compactEditedNodes.find((node) => node.tagName === 'STRONG').textContent, '2 个文件已更改');
    assert.equal(compactEditedNodes.find((node) => node.className === 'turnResultStat added').textContent, '+2');
    assert.equal(compactEditedNodes.find((node) => node.className === 'turnResultStat removed').textContent, '-2');
    assert.equal(compactEditedNodes.some((node) => node.className === 'turnResultActions'), false);
    const planProgressCard = createEditedFilesResultCard([
      { name: '/workspace/ui.css', verb: '已编辑', added: 370, removed: 92 },
      { name: '/workspace/server.mjs', verb: '已编辑', added: 0, removed: 0 },
      { name: '/workspace/test/server-smoke.test.mjs', verb: '已编辑', added: 0, removed: 0 },
    ], '', { live: true, plan: referencePlan });
    const planProgressNodes = activityNodes(planProgressCard);
    assert.equal(planProgressCard.className, 'turnResultCard editedFilesResult live withPlan');
    assert.equal(planProgressCard.attributes.get('aria-label'), '第 2 / 5 步，3 个文件已更改');
    assert.equal(planProgressNodes.find((node) => node.className === 'turnPlanProgressLabel').textContent, '第 2 / 5 步');
    assert.equal(planProgressNodes.find((node) => node.className === 'turnPlanProgressRing').attributes.get('style'), '--turn-plan-progress:40%');
    assert.equal(planProgressNodes.find((node) => node.className === 'turnResultFileLabel').textContent, '3 个文件已更改');
    assert.equal(planProgressNodes.find((node) => node.className === 'turnResultStat added').textContent, '+370');
    assert.equal(planProgressNodes.find((node) => node.className === 'turnResultStat removed').textContent, '-92');
    const planOnlyProgressCard = createEditedFilesResultCard([], '', { live: true, plan: referencePlan });
    assert.equal(planOnlyProgressCard.tagName, 'DIV');
    assert.equal(planOnlyProgressCard.className, 'turnResultCard editedFilesResult live withPlan planOnly');
    assert.equal(planOnlyProgressCard.children.length, 1);
    assert.equal(planOnlyProgressCard.children[0].tabIndex, 0);
    const planTooltip = planOnlyProgressCard.children[0].children.find((node) => node.className === 'turnPlanTooltip');
    assert.ok(planTooltip);
    assert.equal(planTooltip.attributes.get('role'), 'tooltip');
    assert.deepEqual(planTooltip.children.map((node) => node.children.find((child) => child.className === 'turnPlanTooltipText')?.textContent), referencePlan.map((item) => item.step));

    const liveResultHelpers = inlineScript.match(
      /(function moveLiveEditedFilesResultToEnd[\s\S]*?)(?=function createWebPreviewResultCard)/,
    )?.[1];
    assert.ok(liveResultHelpers);
    const detachLiveNode = (node) => {
      if (!node.parentNode) return;
      const previousIndex = node.parentNode.children.indexOf(node);
      if (previousIndex >= 0) node.parentNode.children.splice(previousIndex, 1);
    };
    const liveTimeline = {
      children: [],
      appendChild(node) {
        detachLiveNode(node);
        node.parentNode = this;
        node.isConnected = true;
        this.children.push(node);
        return node;
      },
      replaceChild(next, previous) {
        const index = this.children.indexOf(previous);
        assert.notEqual(index, -1);
        previous.parentNode = null;
        previous.isConnected = false;
        next.parentNode = this;
        next.isConnected = true;
        this.children.splice(index, 1, next);
        return previous;
      },
    };
    const livePromptQueuePanel = { kind: 'prompt-queue', parentNode: null, isConnected: true };
    const liveAttachmentTray = { kind: 'attachment-tray', parentNode: null, isConnected: true };
    const liveDropZone = { kind: 'drop-zone', parentNode: null, isConnected: true };
    let liveComposerInsertCalls = 0;
    const liveComposer = {
      children: [livePromptQueuePanel, liveAttachmentTray, liveDropZone],
      insertBefore(node, reference) {
        liveComposerInsertCalls += 1;
        assert.strictEqual(reference, livePromptQueuePanel);
        detachLiveNode(node);
        const index = this.children.indexOf(reference);
        assert.notEqual(index, -1);
        node.parentNode = this;
        node.isConnected = true;
        this.children.splice(index, 0, node);
        return node;
      },
      replaceChild(next, previous) {
        const index = this.children.indexOf(previous);
        assert.notEqual(index, -1);
        previous.parentNode = null;
        previous.isConnected = false;
        next.parentNode = this;
        next.isConnected = true;
        this.children.splice(index, 1, next);
        return previous;
      },
    };
    livePromptQueuePanel.parentNode = liveComposer;
    liveAttachmentTray.parentNode = liveComposer;
    liveDropZone.parentNode = liveComposer;
    const toolArtifact = { kind: 'tool-artifact' };
    const liveElements = [toolArtifact];
    const createdLiveCards = [];
    const makeLiveCard = (files, turnId, options) => {
      const card = {
        files,
        turnId,
        options,
        parentNode: null,
        isConnected: false,
        get nextSibling() {
          if (!this.parentNode) return null;
          const index = this.parentNode.children.indexOf(this);
          return this.parentNode.children[index + 1] || null;
        },
        remove() {
          if (!this.parentNode) return;
          const index = this.parentNode.children.indexOf(this);
          if (index >= 0) this.parentNode.children.splice(index, 1);
          this.parentNode = null;
          this.isConnected = false;
        },
      };
      createdLiveCards.push(card);
      return card;
    };
    const liveResultApi = new Function(
      'turnProcessTimeline',
      'turnProcessElements',
      'editedFilesFromTurnArtifacts',
      'createEditedFilesResultCard',
      'refreshIcons',
      'initialPlan',
      'composer',
      'dropZone',
      'promptQueuePanel',
      `
        let liveEditedFilesResult = null;
        let liveTurnPlan = initialPlan;
        ${liveResultHelpers}
        return {
          refresh: refreshLiveEditedFilesResult,
          state: () => ({ liveEditedFilesResult, liveTurnPlan, turnProcessElements }),
        };
      `,
    )(
      liveTimeline,
      liveElements,
      (elements) => {
        assert.strictEqual(elements, liveElements);
        return [{ name: '/workspace/server.mjs', verb: '已编辑', added: 2, removed: 1 }];
      },
      makeLiveCard,
      () => {},
      referencePlan,
      liveComposer,
      liveDropZone,
      livePromptQueuePanel,
    );
    const firstLivePill = liveResultApi.refresh();
    const secondLivePill = liveResultApi.refresh();
    assert.notStrictEqual(firstLivePill, secondLivePill);
    assert.deepEqual(liveTimeline.children, []);
    assert.deepEqual(liveComposer.children, [secondLivePill, livePromptQueuePanel, liveAttachmentTray, liveDropZone]);
    assert.strictEqual(secondLivePill.parentNode, liveComposer);
    assert.strictEqual(secondLivePill.nextSibling, livePromptQueuePanel);
    assert.strictEqual(liveComposer.children.at(-1), liveDropZone);
    assert.equal(liveComposerInsertCalls, 1);
    assert.deepEqual(liveResultApi.state().turnProcessElements, [toolArtifact]);
    assert.equal(liveResultApi.state().turnProcessElements.includes(secondLivePill), false);
    assert.equal(createdLiveCards.length, 2);
    assert.deepEqual(createdLiveCards.at(-1).options, { live: true, plan: referencePlan });
    assert.match(inlineScript, /const anchor=promptQueuePanel\?\.parentNode===composer\?promptQueuePanel:dropZone/);
    assert.match(inlineScript, /if\(files\.length\)container\.appendChild\(createEditedFilesResultCard\(files,turnId\)\)/);

    const searchActivity = createToolActivityItem({
      verb: '已在',
      target: 'server.mjs',
      suffix: '中搜索“archive”',
      icon: 'search',
      targetType: 'file',
      expandable: false,
    }, 'exec\nsearch archive');
    const searchActivityNodes = activityNodes(searchActivity);
    assert.equal(searchActivity.className, 'activityItem static fileTarget');
    assert.equal(searchActivityNodes.find((node) => node.className === 'activityTarget').textContent, 'server.mjs');
    assert.equal(searchActivityNodes.find((node) => node.className === 'activitySuffix').textContent, '中搜索“archive”');

    const configResponse = await fetch(`${baseUrl}/api/config`, { headers: { Cookie: cookie } });
    assert.equal(configResponse.status, 200);
    const config = await configResponse.json();
    assert.equal(config.defaults.model, 'test-model');
    assert.equal(config.defaults.reasoningEffort, 'max');
    assert.equal(config.capabilities.manageProviders, false);
    assert.equal(config.appearance.chatBackground, 'default');
    assert.deepEqual(config.pinnedThreadIds, [nativeSessionId, archivedNativeSessionId]);

    const playgroundConfigResponse = await fetch(`${baseUrl}/api/playground-config`, {
      headers: { Cookie: cookie },
    });
    assert.equal(playgroundConfigResponse.status, 200);
    assert.match(playgroundConfigResponse.headers.get('cache-control'), /private, no-store/);
    assert.deepEqual(await playgroundConfigResponse.json(), {
      profile: {
        id: 'codex-web-default',
        name: 'Codex Image · Fake',
        provider: 'openai',
        baseUrl: `${providerBaseUrl}/v1`,
        apiKey: 'test-token',
        model: 'gpt-image-2',
        apiMode: 'images',
        codexCli: true,
        apiProxy: true,
      },
      profiles: [
        {
          id: 'codex-web-default',
          name: 'Codex Image · Fake',
          provider: 'openai',
          baseUrl: `${providerBaseUrl}/v1`,
          apiKey: 'test-token',
          model: 'gpt-image-2',
          apiMode: 'images',
          codexCli: true,
          apiProxy: true,
        },
        {
          id: 'codex-web-agent',
          name: 'Codex Agent · Fake',
          provider: 'openai',
          baseUrl: `${providerBaseUrl}/v1`,
          apiKey: 'test-token',
          model: 'test-model',
          apiMode: 'responses',
          codexCli: false,
          apiProxy: true,
        },
      ],
      agentApiConfigMode: 'hybrid',
      agentTextProfileId: 'codex-web-agent',
      agentImageProfileId: 'codex-web-default',
    });
    const blockedPlaygroundOrigin = await fetch(
      `${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent('http://127.0.0.1:1')}`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    assert.equal(blockedPlaygroundOrigin.status, 403);
    const blockedPlaygroundPath = await fetch(
      `${baseUrl}/api-proxy/models?codex_upstream=${encodeURIComponent(providerBaseUrl)}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(blockedPlaygroundPath.status, 403);
    const playgroundProxyPayload = { model: 'gpt-image-2', prompt: 'proxy smoke test' };
    const playgroundProxyResponse = await fetch(
      `${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(providerBaseUrl)}`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Authorization: 'Bearer browser-playground-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(playgroundProxyPayload),
      },
    );
    assert.equal(playgroundProxyResponse.status, 200);
    assert.equal((await playgroundProxyResponse.json()).data.length, 1);
    assert.equal(providerRequests.at(-1).url, '/v1/images/generations');
    assert.equal(providerRequests.at(-1).authorization, 'Bearer browser-playground-token');
    assert.equal(providerRequests.at(-1).contentType, 'application/json');
    assert.deepEqual(JSON.parse(providerRequests.at(-1).body), playgroundProxyPayload);
    const playgroundProxyFallback = await fetch(
      `${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(`${providerBaseUrl}/v1`)}`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(playgroundProxyPayload),
      },
    );
    assert.equal(playgroundProxyFallback.status, 200);
    assert.equal(providerRequests.at(-1).authorization, 'Bearer test-token');
    const allowedCustomOrigin = await fetch(
      `${baseUrl}/api-proxy/images/generations?codex_upstream=${encodeURIComponent(customProviderBaseUrl)}`,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Authorization: 'Bearer custom-site-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(playgroundProxyPayload),
      },
    );
    assert.equal(allowedCustomOrigin.status, 200);
    assert.equal(providerRequests.at(-1).authorization, 'Bearer custom-site-token');
    assert.ok(config.conversations.some((conversation) => (
      conversation.id === nativeSessionId
      && conversation.source === 'codex'
      && conversation.title === 'Codex App fixture'
      && conversation.cwd === temporary
      && conversation.originator === 'codex-chrome-extension-sidepanel'
      && conversation.automation?.id === 'fixture-heartbeat'
      && conversation.automation?.kind === 'heartbeat'
      && conversation.automation?.name === 'Fixture heartbeat'
      && conversation.automation?.scheduleLabel === '每天 09:30'
    )));
    assert.equal(config.conversations.some((conversation) => conversation.id === archivedNativeSessionId), false);
    assert.equal(config.conversations.some((conversation) => conversation.id === automationNativeSessionId), false);

    const imagePromptsResponse = await fetch(`${baseUrl}/api/image-prompts`, {
      headers: { Cookie: cookie },
    });
    assert.equal(imagePromptsResponse.status, 200);
    assert.match(imagePromptsResponse.headers.get('cache-control'), /private, no-store/);
    const imagePrompts = await imagePromptsResponse.json();
    assert.equal(imagePrompts.totalCases, 517);
    assert.equal(imagePrompts.totalTemplates, 22);
    assert.equal(imagePrompts.cases.length, 517);
    assert.equal(imagePrompts.templates.length, 22);
    assert.match(imagePrompts.imageBaseUrl, /awesome-gpt-image-2\/60b6e1d3/);
    assert.equal(imagePrompts.revision, '60b6e1d3ddaf1c982426d6c8181827764c6b2012');
    assert.equal(imagePrompts.sync.source, 'bundled');
    assert.equal(imagePrompts.sync.status, 'ready');
    assert.equal(imagePrompts.sync.autoSync, false);
    assert.ok(imagePrompts.sources.some((source) => source.name === 'gpt_image_playground'));
    assert.ok(imagePrompts.cases.some((item) => item.id === 520 && item.prompt));

    const imagePromptStatusResponse = await fetch(`${baseUrl}/api/image-prompts/status`, {
      headers: { Cookie: cookie },
    });
    assert.equal(imagePromptStatusResponse.status, 200);
    assert.match(imagePromptStatusResponse.headers.get('cache-control'), /private, no-store/);
    const imagePromptStatus = await imagePromptStatusResponse.json();
    assert.equal(imagePromptStatus.version, imagePrompts.version);
    assert.equal(imagePromptStatus.totalCases, 517);

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

    const unauthorizedSubagent = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}/subagents?agent=ui_trace`,
    );
    assert.equal(unauthorizedSubagent.status, 401);
    const subagentResponse = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}/subagents?agent=ui_trace&limit=100`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(subagentResponse.status, 200);
    const subagentConversation = (await subagentResponse.json()).subagent;
    assert.equal(subagentConversation.id, subagentNativeSessionId);
    assert.equal(subagentConversation.source, 'subagent');
    assert.equal(subagentConversation.status, 'done');
    assert.equal(subagentConversation.metadata.parentThreadId, nativeSessionId);
    assert.equal(subagentConversation.metadata.agentPath, '/root/ui_trace');
    assert.ok(subagentConversation.messages.some((message) => message.content === '子代理正在检查界面'));
    assert.ok(subagentConversation.messages.some((message) => message.content.includes('exec_command')));
    assert.ok(subagentConversation.messages.some((message) => message.content === '子代理检查完成'));
    const incrementalSubagentResponse = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}/subagents?agent=%2Froot%2Fui_trace&after=${subagentConversation.cursor}&generation=${subagentConversation.generation}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(incrementalSubagentResponse.status, 200);
    const incrementalSubagent = (await incrementalSubagentResponse.json()).subagent;
    assert.equal(incrementalSubagent.reset, false);
    assert.deepEqual(incrementalSubagent.messages, []);
    const missingSubagent = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}/subagents?agent=missing_agent`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(missingSubagent.status, 404);
    const nativeTargetMessage = nativeConversation.messages.find((message) => (
      message.role === 'user' && message.content === 'native fixture message'
    ));
    const nativeFirstMessage = nativeConversation.messages.find((message) => (
      message.role === 'user' && message.content === 'native earlier message'
    ));
    const nativeAssistantMessage = nativeConversation.messages.find((message) => (
      message.role === 'assistant' && message.content === 'native assistant answer'
    ));
    assert.equal(nativeFirstMessage.turnId, nativeFirstTurnId);
    assert.equal(nativeFirstMessage.previousTurnId, undefined);
    assert.equal(nativeAssistantMessage.turnId, nativeFirstTurnId);
    assert.equal(nativeTargetMessage.turnId, nativeSecondTurnId);
    assert.equal(nativeTargetMessage.previousTurnId, nativeFirstTurnId);
    assert.ok(nativeConversation.messages.some((message) => (
      message.role === 'image'
      && message.kind === 'input_image'
      && message.content === 'data:image/png;base64,c21va2U='
    )));
    const nativeToolImageMessage = nativeConversation.messages.find((message) => (
      message.role === 'tool' && message.content.includes(toolImagePath)
    ));
    assert.ok(nativeToolImageMessage);
    const toolImageUrl = `/api/native-sessions/${nativeSessionId}/tool-images/${nativeToolImageMessage.seq}/1`;
    const unauthorizedToolImage = await fetch(`${baseUrl}${toolImageUrl}`);
    assert.equal(unauthorizedToolImage.status, 401);
    const toolImage = await fetch(`${baseUrl}${toolImageUrl}`, { headers: { Cookie: cookie } });
    assert.equal(toolImage.status, 200);
    assert.equal(toolImage.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await toolImage.arrayBuffer()), await readFile(toolImagePath));

    const falseToolImageMessage = nativeConversation.messages.find((message) => (
      message.role === 'tool' && message.content.includes('not-a-real-image.png')
    ));
    assert.ok(falseToolImageMessage);
    const falseToolImage = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}/tool-images/${falseToolImageMessage.seq}/1`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(falseToolImage.status, 404);

    const limitedNativeSession = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}?limit=3`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(limitedNativeSession.status, 200);
    const limitedNativeConversation = (await limitedNativeSession.json()).conversation;
    assert.equal(limitedNativeConversation.messages.length, 3);
    assert.equal(limitedNativeConversation.hasEarlierMessages, true);
    const externalizedImage = limitedNativeConversation.messages.find((message) => message.role === 'image');
    assert.match(externalizedImage.content, new RegExp(
      `^/api/native-sessions/${nativeSessionId}/images/${externalizedImage.seq}\\?generation=\\d+$`,
    ));

    const externalizedNativeSession = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}?images=external`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(externalizedNativeSession.status, 200);
    const externalizedNativeConversation = (await externalizedNativeSession.json()).conversation;
    assert.equal(externalizedNativeConversation.messages.length, nativeConversation.messages.length);
    assert.match(
      externalizedNativeConversation.messages.find((message) => message.role === 'image').content,
      new RegExp(`^/api/native-sessions/${nativeSessionId}/images/\\d+\\?generation=\\d+$`),
    );

    const nativeImage = await fetch(`${baseUrl}${externalizedImage.content}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(nativeImage.status, 200);
    assert.equal(nativeImage.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await nativeImage.arrayBuffer()).toString(), 'smoke');

    const restartedFromFirst = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/fork`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageSeq: nativeFirstMessage.seq,
        provider: 'fake',
        model: 'test-model',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'untrusted',
      }),
    });
    assert.equal(restartedFromFirst.status, 201);
    const restartedFromFirstPayload = await restartedFromFirst.json();
    assert.equal(restartedFromFirstPayload.threadId, createdNativeSessionId);
    assert.equal(restartedFromFirstPayload.forkedThroughTurnId, '');
    assert.equal(restartedFromFirstPayload.draft, 'native earlier message');

    const forked = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/fork`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageSeq: nativeTargetMessage.seq,
        provider: 'fake',
        model: 'test-model',
        cwd: temporary,
        sandbox: 'workspace-write',
        approval: 'on-request',
      }),
    });
    assert.equal(forked.status, 201);
    const forkedPayload = await forked.json();
    assert.equal(forkedPayload.threadId, forkedNativeSessionId);
    assert.equal(forkedPayload.sourceThreadId, nativeSessionId);
    assert.equal(forkedPayload.forkedThroughTurnId, nativeFirstTurnId);
    assert.equal(forkedPayload.draft, 'native fixture message');
    assert.equal(forkedPayload.conversation.status, 'done');

    const continuedFromAssistant = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/fork`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageSeq: nativeAssistantMessage.seq,
        provider: 'fake',
        model: 'test-model',
        cwd: temporary,
        sandbox: 'workspace-write',
        approval: 'on-request',
      }),
    });
    assert.equal(continuedFromAssistant.status, 201);
    const continuedFromAssistantPayload = await continuedFromAssistant.json();
    assert.equal(continuedFromAssistantPayload.threadId, forkedNativeSessionId);
    assert.equal(continuedFromAssistantPayload.forkedThroughTurnId, nativeFirstTurnId);
    assert.equal(continuedFromAssistantPayload.draft, '');

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
        reasoningEffort: 'ultra',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'on-request',
      }),
    });
    assert.equal(desktopContinued.status, 202);
    const desktopContinuedPayload = await desktopContinued.json();
    assert.equal(desktopContinuedPayload.turnId, 'desktop-turn-1');
    const activeDesktopSession = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(activeDesktopSession.status, 200);
    const activeDesktopConversation = (await activeDesktopSession.json()).conversation;
    assert.equal(activeDesktopConversation.activeTurnId, desktopContinuedPayload.turnId);
    assert.match(activeDesktopConversation.activeTurnStartedAt, /^\d{4}-\d{2}-\d{2}T/);

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

    const interruptCountBeforeStaleRequest = desktopIpc.messages.filter(
      (message) => message.method === 'thread-follower-interrupt-turn',
    ).length;
    const staleInterrupt = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: desktopContinuedPayload.turnId }),
    });
    assert.equal(staleInterrupt.status, 409);
    assert.match((await staleInterrupt.json()).error, /任务已过期/);
    assert.equal(
      desktopIpc.messages.filter((message) => message.method === 'thread-follower-interrupt-turn').length,
      interruptCountBeforeStaleRequest,
    );
    const missingTurnInterrupt = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(missingTurnInterrupt.status, 409);
    assert.match((await missingTurnInterrupt.json()).error, /状态已变化/);
    assert.equal(
      desktopIpc.messages.filter((message) => message.method === 'thread-follower-interrupt-turn').length,
      interruptCountBeforeStaleRequest,
    );

    desktopIpc.broadcast({
      type: 'broadcast',
      method: 'thread-stream-state-changed',
      version: 11,
      sourceClientId: 'desktop-owner',
      params: {
        conversationId: nativeSessionId,
        change: {
          type: 'snapshot',
          revision: 1,
          conversationState: {
            requests: [],
          },
        },
      },
    });
    desktopIpc.broadcast({
      type: 'broadcast',
      method: 'thread-stream-state-changed',
      version: 11,
      sourceClientId: 'desktop-owner',
      params: {
        conversationId: nativeSessionId,
        change: {
          type: 'patches',
          baseRevision: 1,
          revision: 2,
          patches: [{
            op: 'add',
            path: ['requests', 0],
            value: {
              id: 'desktop-approval-1',
              method: 'item/commandExecution/requestApproval',
              params: {
                threadId: nativeSessionId,
                turnId: echoedContinuationPayload.turnId,
                command: 'printf desktop',
                cwd: temporary,
                reason: 'desktop approval test',
              },
            },
          }],
        },
      },
    });
    const desktopApproval = await waitForPendingRequest(baseUrl, cookie);
    assert.equal(desktopApproval.method, 'item/commandExecution/requestApproval');
    assert.equal(desktopApproval.threadId, nativeSessionId);
    const desktopApproved = await fetch(`${baseUrl}/api/native-requests/${encodeURIComponent(desktopApproval.id)}/respond`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'accept' }),
    });
    assert.equal(desktopApproved.status, 200);
    const desktopApprovalMessage = desktopIpc.messages.find(
      (message) => message.method === 'thread-follower-command-approval-decision',
    );
    assert.equal(desktopApprovalMessage.version, 1);
    assert.equal(desktopApprovalMessage.targetClientId, 'desktop-owner');
    assert.deepEqual(desktopApprovalMessage.params, {
      conversationId: nativeSessionId,
      requestId: 'desktop-approval-1',
      decision: 'accept',
    });

    desktopIpc.broadcast({
      type: 'broadcast',
      method: 'thread-stream-state-changed',
      version: 11,
      sourceClientId: 'desktop-owner',
      params: {
        conversationId: nativeSessionId,
        change: {
          type: 'patches',
          baseRevision: 2,
          revision: 3,
          patches: [{
            op: 'add',
            path: ['requests', 0],
            value: {
              id: 'desktop-approval-removed',
              method: 'item/fileChange/requestApproval',
              params: {
                threadId: nativeSessionId,
                turnId: echoedContinuationPayload.turnId,
                reason: 'desktop removal test',
              },
            },
          }],
        },
      },
    });
    const removedDesktopApproval = await waitForPendingRequest(baseUrl, cookie);
    assert.equal(removedDesktopApproval.method, 'item/fileChange/requestApproval');
    desktopIpc.broadcast({
      type: 'broadcast',
      method: 'thread-stream-state-changed',
      version: 11,
      sourceClientId: 'desktop-owner',
      params: {
        conversationId: nativeSessionId,
        change: {
          type: 'patches',
          baseRevision: 3,
          revision: 4,
          patches: [{ op: 'remove', path: ['requests', 0] }],
        },
      },
    });
    await waitForPendingRequestGone(baseUrl, cookie, removedDesktopApproval.id);

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
    assert.equal(desktopStart.params.turnStartParams.effort, 'ultra');
    assert.equal(desktopStart.params.turnStartParams.model, 'test-model');
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
    assert.equal(trace.sub2ApiKey, undefined);

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
    assert.ok(desktopIpc.messages.some((message) => (
      message.type === 'broadcast'
      && message.method === 'thread-archived'
      && message.version === 2
      && message.params?.hostId === 'local'
      && message.params?.conversationId === createdNativeSessionId
      && message.params?.cwd === temporary
    )));

    const deletedArchivedTask = await fetch(
      `${baseUrl}/api/native-archived-sessions/${createdNativeSessionId}`,
      { method: 'DELETE', headers: { Cookie: cookie } },
    );
    assert.equal(deletedArchivedTask.status, 200);
    assert.equal((await deletedArchivedTask.json()).id, createdNativeSessionId);

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

    const runningProjectArchive = await fetch(`${baseUrl}/api/native-projects/archive`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: temporary }),
    });
    assert.equal(runningProjectArchive.status, 409);

    const stoppedForProjectArchive = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: continuedPayload.turnId }),
    });
    assert.equal(stoppedForProjectArchive.status, 200);

    const desktopStartsBeforeProviderSwitch = desktopIpc.messages.filter(
      (message) => message.method === 'thread-follower-start-turn',
    ).length;
    const mismatchedProvider = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/turns`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'switch native provider',
        provider: 'custom',
        model: 'custom-model',
        reasoningEffort: 'max',
        cwd: temporary,
        sandbox: 'read-only',
        approval: 'on-request',
      }),
    });
    assert.equal(mismatchedProvider.status, 202);
    const mismatchedProviderPayload = await mismatchedProvider.json();
    assert.equal(
      desktopIpc.messages.filter((message) => message.method === 'thread-follower-start-turn').length,
      desktopStartsBeforeProviderSwitch,
    );
    const mismatchedProviderConversation = await fetch(
      `${baseUrl}/api/native-sessions/${nativeSessionId}`,
      { headers: { Cookie: cookie } },
    );
    const mismatchedProviderMetadata = (await mismatchedProviderConversation.json()).conversation.metadata;
    assert.equal(mismatchedProviderMetadata.modelProvider, 'custom');
    assert.equal(mismatchedProviderMetadata.model, 'custom-model');

    const mismatchedInterrupted = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}/interrupt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: mismatchedProviderPayload.turnId }),
    });
    assert.equal(mismatchedInterrupted.status, 200);

    const archivedProject = await fetch(`${baseUrl}/api/native-projects/archive`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: temporary }),
    });
    assert.equal(archivedProject.status, 200);
    const archivedProjectPayload = await archivedProject.json();
    assert.deepEqual(archivedProjectPayload.archived, [nativeSessionId]);
    assert.ok(desktopIpc.messages.some((message) => (
      message.type === 'broadcast'
      && message.method === 'thread-archived'
      && message.version === 2
      && message.params?.hostId === 'local'
      && message.params?.conversationId === nativeSessionId
      && message.params?.cwd === temporary
    )));

    const rejectedDeleteAll = await fetch(`${baseUrl}/api/native-archived-sessions`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'delete' }),
    });
    assert.equal(rejectedDeleteAll.status, 400);

    const deletedAllArchived = await fetch(`${baseUrl}/api/native-archived-sessions`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: '永久删除全部已归档任务' }),
    });
    assert.equal(deletedAllArchived.status, 200);
    const deletedAllArchivedPayload = await deletedAllArchived.json();
    assert.deepEqual(deletedAllArchivedPayload.deleted, [nativeSessionId]);
    assert.deepEqual(deletedAllArchivedPayload.skipped, []);
    assert.deepEqual(deletedAllArchivedPayload.failed, []);

    const protocolMessages = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(protocolMessages.some((message) => message.type === 'process_env' && message.sub2ApiKey === undefined));
    assert.ok(protocolMessages.some((message) => message.method === 'initialize'));
    assert.ok(protocolMessages.some((message) => message.method === 'thread/start'));
    assert.ok(protocolMessages.some((message) => (
      message.method === 'thread/list'
      && message.params.archived === true
      && message.params.useStateDbOnly === true
    )));
    assert.ok(protocolMessages.some((message) => (
      message.method === 'thread/unarchive'
      && message.params.threadId === archivedNativeSessionId
    )));
    assert.deepEqual(
      protocolMessages.filter((message) => message.method === 'thread/delete').map((message) => message.params.threadId),
      [createdNativeSessionId, nativeSessionId],
    );

    const archivedForRace = await fetch(`${baseUrl}/api/native-sessions/${nativeSessionId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(archivedForRace.status, 200);
    const deleteCountBeforeRace = protocolMessages
      .filter((message) => message.method === 'thread/delete' && message.params.threadId === nativeSessionId)
      .length;
    await writeFile(appServerControlFile, JSON.stringify({
      unarchiveAfterFirstListToken: 'single-delete-race',
      unarchiveAfterFirstListId: nativeSessionId,
    }));
    const racedArchivedDelete = await fetch(`${baseUrl}/api/native-archived-sessions/${nativeSessionId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(racedArchivedDelete.status, 409);
    assert.deepEqual((await racedArchivedDelete.json()).skipped, [nativeSessionId]);
    const protocolMessagesAfterRace = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      protocolMessagesAfterRace
        .filter((message) => message.method === 'thread/delete' && message.params.threadId === nativeSessionId)
        .length,
      deleteCountBeforeRace,
    );

    for (const threadId of [nativeSessionId, createdNativeSessionId]) {
      const archivedForBulkRace = await fetch(`${baseUrl}/api/native-sessions/${threadId}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });
      assert.equal(archivedForBulkRace.status, 200);
    }
    const createdDeleteCountBeforeBulkRace = protocolMessagesAfterRace
      .filter((message) => message.method === 'thread/delete' && message.params.threadId === createdNativeSessionId)
      .length;
    await writeFile(appServerControlFile, JSON.stringify({
      unarchiveAfterFirstListToken: 'bulk-delete-race',
      unarchiveAfterFirstListId: createdNativeSessionId,
    }));
    const bulkRaceDelete = await fetch(`${baseUrl}/api/native-archived-sessions`, {
      method: 'DELETE',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: '永久删除全部已归档任务' }),
    });
    assert.equal(bulkRaceDelete.status, 200);
    const bulkRaceDeletePayload = await bulkRaceDelete.json();
    assert.deepEqual(bulkRaceDeletePayload.deleted, [nativeSessionId]);
    assert.deepEqual(bulkRaceDeletePayload.skipped, [createdNativeSessionId]);
    assert.deepEqual(bulkRaceDeletePayload.failed, []);
    const protocolMessagesAfterBulkRace = (await readFile(appServerTraceFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      protocolMessagesAfterBulkRace
        .filter((message) => message.method === 'thread/delete' && message.params.threadId === createdNativeSessionId)
        .length,
      createdDeleteCountBeforeBulkRace,
    );
    assert.equal(protocolMessages.filter((message) => message.method === 'thread/resume').length, 2);
    assert.equal(protocolMessages.filter((message) => message.method === 'turn/start').length, 3);
    const switchedProviderResume = protocolMessages.find((message) => (
      message.method === 'thread/resume'
      && message.params.modelProvider === 'custom'
    ));
    assert.ok(switchedProviderResume);
    assert.equal(switchedProviderResume.params.model, 'custom-model');
    const restartFromFirstMessage = protocolMessages.find((message) => (
      message.method === 'thread/start'
      && message.params.sandbox === 'read-only'
      && message.params.approvalPolicy === 'untrusted'
    ));
    assert.ok(restartFromFirstMessage);
    const forkMessages = protocolMessages.filter((message) => message.method === 'thread/fork');
    assert.equal(forkMessages.length, 2);
    const forkMessage = forkMessages[0];
    assert.equal(forkMessage.params.threadId, nativeSessionId);
    assert.equal(forkMessage.params.lastTurnId, nativeFirstTurnId);
    assert.equal(forkMessage.params.sandbox, 'workspace-write');
    assert.equal(forkMessage.params.approvalPolicy, 'on-request');
    const turnStartMessages = protocolMessages.filter((message) => message.method === 'turn/start');
    assert.equal(turnStartMessages[0].params.sandboxPolicy.type, 'workspaceWrite');
    assert.deepEqual(turnStartMessages[0].params.sandboxPolicy.writableRoots, [temporary]);
    assert.equal(turnStartMessages[1].params.sandboxPolicy.type, 'readOnly');
    assert.equal(turnStartMessages[2].params.model, 'custom-model');
    assert.equal(turnStartMessages[2].params.effort, 'max');
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

    child = await startServer({
      temporary,
      runtime,
      codexHome,
      fakeCodex,
      traceFile,
      appServerTraceFile,
      webEnv,
      sub2ApiBaseUrl: providerBaseUrl,
    });
    port = await waitForServer(child, runtime);
    const restored = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { Cookie: cookie } });
    assert.equal(restored.status, 200);
    const restoredSubQuotaConfig = await fetch(`http://127.0.0.1:${port}/api/sub-quota-config`, { headers: { Cookie: cookie } });
    assert.equal(restoredSubQuotaConfig.status, 200);
    assert.equal((await restoredSubQuotaConfig.json()).keyConfigured, true);
  } finally {
    if (child) await stopServer(child);
    if (desktopIpc) await desktopIpc.close();
    if (providerServer) {
      providerServer.closeAllConnections?.();
      await new Promise((resolve) => providerServer.close(resolve));
    }
    if (customProviderServer) {
      customProviderServer.closeAllConnections?.();
      await new Promise((resolve) => customProviderServer.close(resolve));
    }
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
  appServerControlFile = path.join(temporary, 'app-server-control.json'),
  webEnv = path.join(temporary, 'web.env'),
  configWritable = 'false',
  desktopIpcEnabled = 'false',
  desktopIpcSocket = '',
  playgroundProxyAllowedOrigins = '',
  sub2ApiBaseUrl,
  sub2ApiKey,
}) {
  const env = {
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
      PLAYGROUND_PROXY_ALLOWED_ORIGINS: playgroundProxyAllowedOrigins,
      HOMEPAGE_API_TOKEN: '',
      IMAGE_PROMPT_AUTO_SYNC: 'false',
      DEFAULT_CWD: temporary,
      DEFAULT_SANDBOX: 'read-only',
      DEFAULT_APPROVAL: 'never',
      FORCE_FULL_ACCESS: 'false',
      FAKE_CODEX_TRACE: traceFile,
      FAKE_APP_SERVER_TRACE: appServerTraceFile,
      FAKE_APP_SERVER_CONTROL: appServerControlFile,
  };
  delete env.SUB2API_BASE_URL;
  delete env.SUB2API_API_KEY;
  if (sub2ApiBaseUrl !== undefined) env.SUB2API_BASE_URL = sub2ApiBaseUrl;
  if (sub2ApiKey !== undefined) env.SUB2API_API_KEY = sub2ApiKey;
  return spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env,
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
    broadcast(message) {
      for (const socket of sockets) writeDesktopFrame(socket, message);
    },
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
      if (message.type === 'broadcast') return;
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
          : message.method.includes('approval') || message.method.includes('submit-')
            ? { ok: true }
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

async function waitForPendingRequestGone(baseUrl, cookie, requestId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${baseUrl}/api/native-requests`, {
      headers: { Cookie: cookie },
    });
    if (response.ok) {
      const requests = (await response.json()).requests || [];
      if (!requests.some((request) => request.id === requestId)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('native approval request did not clear');
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
