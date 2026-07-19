import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const [serverSource, nativeSource, uiStyles] = await Promise.all([
  readFile(new URL('../server.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../native-sessions.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../ui.css', import.meta.url), 'utf8'),
]);
const rawInlineScript = serverSource.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
const inlineScript = rawInlineScript.replaceAll('\\\\', '\\');

function sourceBetween(start, end) {
  const source = inlineScript.match(new RegExp(`(${start}[\\s\\S]*?)(?=${end})`))?.[1];
  assert.ok(source, `missing helper source: ${start}`);
  return source;
}

const groupingSource = sourceBetween('function conversationKey', 'function setMainView');
const composerProjectsSource = sourceBetween('function composerProjectPaths', 'function selectComposerProjectPath');

test('projectless sessions remain tasks even when they have generated working directories', () => {
  const api = new Function(`${groupingSource}; return { isStandaloneHistoryItem, partitionHistoryItems };`)();
  const explicitProjectPath = '/Users/test/Documents/Codex/2026-07-19/explicit-project';
  const items = [
    { id: 'task-running', workspaceKind: 'projectless', cwd: '/Users/test/Documents/Codex/2026-07-19/task-a', status: 'running' },
    { id: 'project-running', workspaceKind: 'project', cwd: explicitProjectPath, status: 'running' },
    { id: 'task-done', workspaceKind: 'projectless', cwd: '/another/generated/task-b', status: 'done' },
    { id: 'project-done', workspaceKind: 'project', cwd: `${explicitProjectPath}/`, status: 'done' },
    { id: 'legacy-project', workspaceKind: '', cwd: '/workspace/legacy', status: 'done' },
  ];

  const { tasks, projects } = api.partitionHistoryItems(items);
  assert.deepEqual(tasks.map((item) => item.id), ['task-running', 'task-done']);
  assert.equal(projects.size, 2);
  assert.deepEqual(projects.get(explicitProjectPath).items.map((item) => item.id), ['project-running', 'project-done']);
  assert.deepEqual(projects.get('/workspace/legacy').items.map((item) => item.id), ['legacy-project']);
  assert.equal(api.isStandaloneHistoryItem({ workspaceKind: 'projectless', cwd: '/non-empty' }), true);
  assert.equal(api.isStandaloneHistoryItem({ workspaceKind: 'project', cwd: '' }), false);
});

test('projectless working directories do not pollute the composer project picker', () => {
  const projectlessPath = '/Users/test/Documents/Codex/2026-07-19/task-a';
  const explicitProjectPath = '/workspace/codex-web';
  const historyItems = [
    { id: 'task', workspaceKind: 'projectless', cwd: projectlessPath },
    { id: 'project', workspaceKind: 'project', cwd: explicitProjectPath },
    { id: 'project-duplicate', workspaceKind: 'project', cwd: `${explicitProjectPath}/` },
  ];
  const composerProjectPaths = new Function(
    'cwd',
    'historyItems',
    `${groupingSource}\n${composerProjectsSource}; return composerProjectPaths;`,
  )({ value: projectlessPath }, historyItems);

  assert.deepEqual(composerProjectPaths(), [explicitProjectPath]);
});

test('the task section is rendered before project groups and can collapse independently', () => {
  const taskRenderSource = sourceBetween('function appendStandaloneHistoryTasks', 'function renderHistory');
  assert.match(taskRenderSource, /section\.className='historyTasks'/);
  assert.match(taskRenderSource, /head\.className='historyTasksHead'/);
  assert.match(taskRenderSource, /title\.textContent='任务'/);
  assert.match(taskRenderSource, /setIconLabel\(chevron,'chevron-right','',false\)/);
  assert.match(taskRenderSource, /rows\.className='historyTasksItems'/);
  assert.match(taskRenderSource, /createHistoryRow\(item,''\)/);
  assert.doesNotMatch(taskRenderSource, /createHistoryProjectMenu|historyProjectHead|historyProjectFolder/);
  assert.match(taskRenderSource, /setHistoryTasksExpanded\(section,Boolean\(query\)\|\|containsCurrent\|\|!historyTasksCollapsed\)/);
  assert.match(taskRenderSource, /historyTasksCollapsed=expanded;\s*storeHistoryTasksCollapsed\(\)/);
  assert.match(inlineScript, /const HISTORY_TASKS_COLLAPSED_STORAGE_KEY='codexWeb\.historyTasksCollapsed'/);
  assert.match(inlineScript, /const \{tasks:standaloneTasks,projects:groups\}=partitionHistoryItems\(visibleItems\);\s*appendStandaloneHistoryTasks\(standaloneTasks,\{query:Boolean\(query\)\}\);/);
  assert.match(uiStyles, /\.historyTasksHead\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 14px/s);
  assert.match(uiStyles, /\.historyTasksTitle\s*\{[^}]*color:\s*var\(--text-muted\);[^}]*font-size:\s*12px/s);
  assert.match(uiStyles, /\.historyTasksItems\s*\{[^}]*display:\s*grid;[^}]*gap:\s*1px/s);
  assert.match(uiStyles, /\.historyTasksItems\[hidden\]\s*\{[^}]*display:\s*none/s);
  assert.match(uiStyles, /\.historyTasksHead\[aria-expanded="true"\] \.historyTasksChevron\s*\{[^}]*transform:\s*rotate\(90deg\)/s);
});

test('workspace-kind changes are watched and included in session signatures', () => {
  assert.match(nativeSource, /relative !== '\.codex-global-state\.json'/);
  assert.match(nativeSource, /state\?\.\['projectless-thread-ids'\]/);
  assert.match(nativeSource, /workspaceKind: this\.workspaceStateAvailable/);
  assert.match(nativeSource, /entry\.workspaceKind \|\| ''/);
});

test('project archive targeting excludes standalone tasks with the same cwd', () => {
  const archiveMatch = serverSource.match(/(function normalizeNativeProjectPath[\s\S]*?function nativeSessionMatchesProject[\s\S]*?\n})/);
  assert.ok(archiveMatch, 'missing native project archive matcher');
  const api = new Function('path', `${archiveMatch[1]}; return nativeSessionMatchesProject;`)(path);
  assert.equal(api({ workspaceKind: 'projectless', cwd: '/workspace/shared' }, '/workspace/shared'), false);
  assert.equal(api({ workspaceKind: 'project', cwd: '/workspace/shared/' }, '/workspace/shared'), true);
  assert.equal(api({ cwd: '/workspace/shared' }, '/workspace/shared'), true);
});

test('archived standalone tasks keep a separate task group and filter', () => {
  assert.match(serverSource, /workspaceKind: nativeSessions\.workspaceKindForThread\?\.\(id\) \|\| ''/);
  assert.match(inlineScript, /tasks\.value='__tasks__'/);
  assert.match(inlineScript, /group\.className='archiveProject'\+\(standalone\?' archiveTasks':''\)/);
  assert.match(inlineScript, /if\(project==='__tasks__'&&!standalone\)return false/);
});

test('history refreshes deferred while a project menu or preview is open', () => {
  assert.match(inlineScript, /let historyRefreshPending=false/);
  assert.match(inlineScript, /function flushPendingHistoryRefresh/);
  assert.match(inlineScript, /if\(activeHistoryProjectMenu\|\|historyProjectPreviewAnchor\)\{historyRefreshPending=true;return\}/);
  assert.match(inlineScript, /flushPendingHistoryRefresh\(\)/);
});

test('starting a new task resets a generated standalone cwd to the configured default', () => {
  assert.match(inlineScript, /function resetStandaloneComposerCwd\(\)/);
  assert.match(inlineScript, /currentNativeWorkspaceKind==='projectless'&&defaultComposerCwd/);
  assert.match(inlineScript, /defaultComposerCwd=String\(data\.defaults\.cwd\|\|''\)/);
  assert.match(inlineScript, /resetStandaloneComposerCwd\(\);clearNativeCompletionSync/);
});
