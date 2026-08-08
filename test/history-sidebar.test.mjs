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
const completionStateSource = sourceBetween('function readHistoryCompletionState', 'function historyProjectName');

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
    'defaultComposerCwd',
    `${groupingSource}\n${composerProjectsSource}; return composerProjectPaths;`,
  )({ value: projectlessPath }, historyItems, '');

  assert.deepEqual(composerProjectPaths(), [explicitProjectPath]);
});

test('pinned Codex sessions keep App order and are removed from regular history groups', () => {
  const api = new Function(`${groupingSource}; return { partitionPinnedHistoryItems };`)();
  const items = [
    { id: 'project-b', source: 'codex', workspaceKind: 'project', cwd: '/workspace/b' },
    { id: 'pin-b', source: 'codex', workspaceKind: 'projectless', cwd: '/generated/b' },
    { id: 'pin-a', source: 'web', workspaceKind: 'projectless', cwd: '' },
    { id: 'task-a', source: 'codex', workspaceKind: 'projectless', cwd: '/generated/a' },
    { id: 'pin-a', source: 'codex', workspaceKind: 'project', cwd: '/workspace/a' },
  ];

  const { pinned, remaining } = api.partitionPinnedHistoryItems(items, ['pin-a', 'missing', 'pin-b', 'pin-a']);
  assert.deepEqual(pinned.map((item) => `${item.source}:${item.id}`), ['codex:pin-a', 'codex:pin-b']);
  assert.deepEqual(remaining.map((item) => `${item.source}:${item.id}`), ['codex:project-b', 'web:pin-a', 'codex:task-a']);
});

test('Chrome extension sidepanel sessions are separated from tasks and projects', () => {
  const api = new Function(`${groupingSource}; return { isBrowserSidebarHistoryItem, partitionBrowserSidebarHistoryItems };`)();
  const items = [
    { id: 'sidebar-project', source: 'codex', originator: 'codex-chrome-extension-sidepanel', workspaceKind: 'project', cwd: '/workspace/neng-f' },
    { id: 'desktop-project', source: 'codex', originator: 'Codex Desktop', workspaceKind: 'project', cwd: '/workspace/docker' },
    { id: 'sidebar-task', source: 'codex', originator: ' CODEX-CHROME-EXTENSION-SIDEPANEL ', workspaceKind: 'projectless', cwd: '/generated/task' },
    { id: 'web-task', source: 'web', originator: 'codex-chrome-extension-sidepanel', workspaceKind: 'projectless', cwd: '' },
  ];

  const { sidebar, remaining } = api.partitionBrowserSidebarHistoryItems(items);
  assert.deepEqual(sidebar.map((item) => item.id), ['sidebar-project', 'sidebar-task']);
  assert.deepEqual(remaining.map((item) => item.id), ['desktop-project', 'web-task']);
  assert.equal(api.isBrowserSidebarHistoryItem(items[0]), true);
  assert.equal(api.isBrowserSidebarHistoryItem(items[1]), false);
});

test('the pinned section renders above tasks, collapses independently, and marks automations', () => {
  const pinnedRenderSource = sourceBetween('function appendPinnedHistoryTasks', 'function setHistoryTasksExpanded');
  const rowSource = sourceBetween('function createHistoryRow', 'function updateActiveHistory');
  assert.match(pinnedRenderSource, /section\.className='historyPinned'/);
  assert.match(pinnedRenderSource, /head\.className='historyPinnedHead'/);
  assert.match(pinnedRenderSource, /icon\.className='historyPinnedIcon';\s*setIconLabel\(icon,'pin','',false\)/);
  assert.match(pinnedRenderSource, /title\.textContent='置顶'/);
  assert.match(pinnedRenderSource, /rows\.className='historyPinnedItems'/);
  assert.match(pinnedRenderSource, /setHistoryPinnedExpanded\(section,Boolean\(query\)\|\|containsCurrent\|\|!historyPinnedCollapsed\)/);
  assert.match(pinnedRenderSource, /historyPinnedCollapsed=expanded;\s*storeHistoryPinnedCollapsed\(\)/);
  assert.match(inlineScript, /const HISTORY_PINNED_COLLAPSED_STORAGE_KEY='codexWeb\.historyPinnedCollapsed'/);
  assert.match(inlineScript, /const HISTORY_COMPLETION_READ_STORAGE_KEY='codexWeb\.historyCompletionRead\.v2'/);
  assert.match(inlineScript, /const HISTORY_COMPLETION_SEEN_STORAGE_KEY='codexWeb\.historyCompletionSeen\.v2'/);
  assert.match(inlineScript, /const \{pinned,remaining:pinnedRemaining\}=partitionPinnedHistoryItems\(visibleItems\);\s*appendPinnedHistoryTasks\(pinned,\{query:Boolean\(query\)\}\);/);
  assert.match(rowSource, /automationIcon\.className='histAutomationIcon'/);
  assert.match(rowSource, /icon\.setAttribute\('data-lucide','calendar-clock'\)/);
  assert.match(rowSource, /automationIcon\.setAttribute\('aria-label','自动化任务：'\+automationName\)/);
  assert.match(rowSource, /row\.className='hist'\+\(source==='codex'\?' native':''\)\+\(item\.status==='running'\?' running':''\)/);
  assert.match(rowSource, /if\(source==='codex'\)\{\s*if\(running\)row\.appendChild\(running\);[\s\S]*row\.appendChild\(badge\);\s*}\s*row\.appendChild\(open\)/);
  assert.match(uiStyles, /body \.hist\.native\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto/s);
  assert.match(uiStyles, /body \.hist\.native\.running\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto/s);
  assert.match(uiStyles, /\.histRunning\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*2;[^}]*left:\s*-7px;[^}]*pointer-events:\s*none/s);
  assert.match(uiStyles, /\.histCompletionUnread\s*\{[^}]*position:\s*absolute;[^}]*left:\s*-7px;[^}]*background:\s*var\(--info\);[^}]*pointer-events:\s*none/s);
  assert.match(uiStyles, /\.historyPinned,\s*\.historySidebarTasks,\s*\.historyTasks\s*\{[^}]*display:\s*grid/s);
  assert.match(uiStyles, /\.historyPinnedItems\[hidden\],\s*\.historySidebarItems\[hidden\],\s*\.historyTasksItems\[hidden\]\s*\{[^}]*display:\s*none/s);
  assert.match(uiStyles, /\.historyPinnedHead\[aria-expanded="true"\] \.historyPinnedChevron,[^{]*\{[^}]*transform:\s*rotate\(90deg\)/s);
  assert.match(uiStyles, /\.histOpen\.hasAutomation\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 16px/s);
  assert.match(uiStyles, /\.histAutomationIcon \.lucide,\s*body \.histRename \.lucide,\s*body \.histDelete \.lucide\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px/s);
});

test('a read completion stays read when its completed metadata changes', () => {
  const storage = new Map();
  const localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  };
  const api = new Function(
    'localStorage',
    'conversationKey',
    'renderHistory',
    `const HISTORY_COMPLETION_READ_STORAGE_KEY='codexWeb.historyCompletionRead.v2';
     const HISTORY_COMPLETION_SEEN_STORAGE_KEY='codexWeb.historyCompletionSeen.v2';
     let historyCompletionRead=new Map();
     let historyCompletionSeen=new Map();
     let historyCompletionPushTimer=null;
     ${completionStateSource}
     return { trackHistoryCompletionState, historyCompletionUnread };`,
  )(localStorage, (source, id) => `${source}:${id}`, () => {});

  const doneAtFirstSync = { source: 'codex', id: 'thread-a', status: 'done', updatedAt: '2026-08-02T01:00:00.000Z' };
  const doneAfterMetadataSync = { ...doneAtFirstSync, updatedAt: '2026-08-02T01:05:00.000Z' };
  const runningAgain = { ...doneAtFirstSync, status: 'running', updatedAt: '2026-08-02T02:00:00.000Z' };
  const doneAgain = { ...doneAtFirstSync, updatedAt: '2026-08-02T02:05:00.000Z' };

  api.trackHistoryCompletionState([doneAtFirstSync]);
  assert.equal(api.historyCompletionUnread(doneAtFirstSync), false);
  api.trackHistoryCompletionState([doneAfterMetadataSync]);
  assert.equal(api.historyCompletionUnread(doneAfterMetadataSync), false);
  api.trackHistoryCompletionState([runningAgain]);
  api.trackHistoryCompletionState([doneAgain]);
  assert.equal(api.historyCompletionUnread(doneAgain), true);

  const runningUnread = { source: 'codex', id: 'thread-b', status: 'running', updatedAt: '2026-08-02T03:00:00.000Z' };
  const doneUnread = { ...runningUnread, status: 'done', updatedAt: '2026-08-02T03:05:00.000Z' };
  const doneUnreadAfterMetadataSync = { ...doneUnread, updatedAt: '2026-08-02T03:10:00.000Z' };
  api.trackHistoryCompletionState([runningUnread]);
  api.trackHistoryCompletionState([doneUnread]);
  assert.equal(api.historyCompletionUnread(doneUnread), true);
  api.trackHistoryCompletionState([doneUnreadAfterMetadataSync]);
  assert.equal(api.historyCompletionUnread(doneUnreadAfterMetadataSync), true);
});

test('history rename uses an inline editor instead of a browser prompt', () => {
  const renameSource = sourceBetween('function beginHistoryRename', 'async function deleteConversation');
  assert.match(renameSource, /input\.className='histRenameInput'/);
  assert.match(renameSource, /row\.replaceChild\(input,open\)/);
  assert.match(renameSource, /event\.key==='Enter'/);
  assert.match(renameSource, /event\.key==='Escape'/);
  assert.match(renameSource, /await renameConversation\(item\.id,clean,source\)/);
  assert.doesNotMatch(renameSource, /prompt\(/);
  assert.match(uiStyles, /\.histRenameInput\s*\{[^}]*height:\s*28px;[^}]*font-size:\s*12px/s);
});

test('history rename closes its inline editor after a successful Enter save', async () => {
  const renameSource = sourceBetween('function beginHistoryRename', 'async function renameConversation');
  const classes = new Set();
  const statusEl = { textContent: '' };
  const open = { isConnected: true };
  const row = {
    child: open,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    replaceChild(next, previous) {
      assert.equal(this.child, previous);
      this.child = next;
      previous.isConnected = false;
      next.isConnected = true;
    },
  };
  const makeInput = () => {
    const listeners = new Map();
    return {
      isConnected: false,
      value: '',
      addEventListener(type, listener) { listeners.set(type, listener); },
      dispatch(type, event) { return listeners.get(type)?.(event); },
      setAttribute() {},
      focus() {},
      select() {},
      replaceWith(next) {
        assert.equal(row.child, this);
        row.child = next;
        this.isConnected = false;
        next.isConnected = true;
      },
    };
  };
  let refreshes = 0;
  const api = new Function(
    'document',
    'statusEl',
    'flushPendingHistoryRefresh',
    'renameConversation',
    'refreshHistory',
    'requestAnimationFrame',
    `
      let historyRenameActive = false;
      ${renameSource}
      return { beginHistoryRename, isActive: () => historyRenameActive };
    `,
  )(
    { createElement: () => makeInput() },
    statusEl,
    () => {},
    async () => true,
    async () => { refreshes += 1; },
    (callback) => callback(),
  );

  api.beginHistoryRename(row, open, { id: 'rename-1', title: '旧标题' });
  const input = row.child;
  input.value = '新标题';
  let prevented = false;
  input.dispatch('keydown', { key: 'Enter', preventDefault: () => { prevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prevented, true);
  assert.equal(row.child, open, 'successful saves must restore the title button');
  assert.equal(classes.has('renaming'), false);
  assert.equal(api.isActive(), false);
  assert.equal(refreshes, 1);
  assert.equal(statusEl.textContent, '标题已更新');
});

test('native history archiving uses an in-app confirmation card', () => {
  const archiveSource = sourceBetween('function ensureArchiveConfirmDialog', 'function sidebarCollapsedPreference');
  const rowSource = sourceBetween('function createHistoryRow', 'function updateActiveHistory');
  assert.match(archiveSource, /archiveConfirmDialog\.setAttribute\('role','dialog'\)/);
  assert.match(archiveSource, /archiveConfirmDialog\.setAttribute\('aria-modal','true'\)/);
  assert.match(archiveSource, /title\.textContent='归档会话'/);
  assert.match(archiveSource, /description\.textContent='归档后会从最近任务移除，可在“已归档任务”中恢复。'/);
  assert.match(archiveSource, /archiveConfirmOverlay\.addEventListener\('click',\(event\)=>\{if\(event\.target===archiveConfirmOverlay\)closeArchiveConfirm\(\)\}\)/);
  assert.match(archiveSource, /trapDialogFocus\(archiveConfirmDialog,event\)/);
  assert.match(archiveSource, /if\(source==='codex'\)\{openArchiveConfirm\(id,title,trigger\);return\}/);
  assert.match(archiveSource, /if\(!confirm\('删除会话：'\+title\+'？'\)\)return/);
  assert.match(archiveSource, /fallbackRow=archiveConfirmReturnKey\?\[\.\.\.history\.querySelectorAll\('\.hist'\)\]\.find\(\(row\)=>row\.dataset\.key===archiveConfirmReturnKey\):null/);
  assert.match(archiveSource, /fallbackRow\?\.querySelector\('\.histDelete'\)/);
  assert.match(archiveSource, /const visibleRows=\[\.\.\.history\.querySelectorAll\('\.hist'\)\]\.filter\(\(row\)=>!row\.closest\('\[hidden\]'\)\)/);
  assert.match(archiveSource, /visibleRows\[triggerRowIndex\+1\]\|\|visibleRows\[triggerRowIndex-1\]/);
  assert.match(archiveSource, /const adjacentRow=adjacentKey\?\[\.\.\.history\.querySelectorAll\('\.hist'\)\]\.find\(\(row\)=>row\.dataset\.key===adjacentKey\):null/);
  assert.match(archiveSource, /const nextFocus=adjacentRow\?\.querySelector\('\.histOpen'\)\|\|document\.getElementById\('newChat'\)/);
  assert.match(archiveSource, /requestAnimationFrame\(\(\)=>nextFocus\?\.focus\(\)\)/);
  assert.match(rowSource, /deleteConversation\(item\.id,item\.title,source,del\)/);
  assert.match(inlineScript, /if\(archiveConfirmOverlay&&!archiveConfirmOverlay\.classList\.contains\('hidden'\)\)\{closeArchiveConfirm\(\);return\}/);
  assert.match(uiStyles, /\.archiveConfirmDialog\s*\{[^}]*border-radius:\s*8px/s);
  assert.match(uiStyles, /\.archiveConfirmOverlay\s*\{[^}]*z-index:\s*90/s);
  assert.match(uiStyles, /\.archiveConfirmActions button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--primary\)/s);
});

test('native history forks retain an in-chat continuation marker', () => {
  const markerSource = sourceBetween('function readNativeForkMarkers', 'function updateComposerOverlayInset');
  const forkSource = sourceBetween('async function forkNativeConversation', 'function isCompletedNativeRuntimeTurn');
  assert.match(inlineScript, /const NATIVE_FORK_MARKERS_STORAGE_KEY='codexWeb\.nativeForkMarkers\.v1'/);
  assert.match(markerSource, /localStorage\.getItem\(NATIVE_FORK_MARKERS_STORAGE_KEY\)/);
  assert.match(markerSource, /localStorage\.setItem\(NATIVE_FORK_MARKERS_STORAGE_KEY,JSON\.stringify\(nativeForkMarkers\)\)/);
  assert.match(markerSource, /divider\.className='nativeForkDivider'/);
  assert.match(markerSource, /divider\.setAttribute\('role','separator'\)/);
  assert.match(markerSource, /text\.textContent='从聊天中继续'/);
  assert.match(markerSource, /chat\.insertBefore\(divider,next\)/);
  assert.match(forkSource, /setNativeForkMarker\(data\.threadId,\{afterSeq,afterTurnId:data\.forkedThroughTurnId\}\)/);
  assert.match(inlineScript, /if\(currentConversationSource==='codex'\)renderNativeForkDivider\(messages\)/);
  assert.match(inlineScript, /if\(nativeForkMarkers\[id\]\)renderNativeForkDivider\(syncMessages\)/);
  assert.match(uiStyles, /\.nativeForkDivider\s*\{[^}]*grid-template-columns:\s*minmax\(20px, 1fr\) auto minmax\(20px, 1fr\)/s);
  assert.match(uiStyles, /\.nativeForkDivider::before,[\s\S]*\.nativeForkDivider::after\s*\{[^}]*height:\s*1px/s);
});

test('the browser sidepanel section renders between pinned and regular tasks', () => {
  const sidebarRenderSource = sourceBetween('function appendBrowserSidebarHistoryTasks', 'function setHistoryTasksExpanded');
  assert.match(sidebarRenderSource, /section\.className='historySidebarTasks'/);
  assert.match(sidebarRenderSource, /head\.className='historySidebarHead'/);
  assert.match(sidebarRenderSource, /icon\.className='historySidebarIcon';\s*setIconLabel\(icon,'panel-left','',false\)/);
  assert.match(sidebarRenderSource, /title\.textContent='侧边栏'/);
  assert.match(sidebarRenderSource, /rows\.className='historySidebarItems'/);
  assert.match(sidebarRenderSource, /setHistorySidebarExpanded\(section,Boolean\(query\)\|\|containsCurrent\|\|!historySidebarCollapsed\)/);
  assert.match(sidebarRenderSource, /historySidebarCollapsed=expanded;\s*storeHistorySidebarCollapsed\(\)/);
  assert.match(inlineScript, /const HISTORY_SIDEBAR_COLLAPSED_STORAGE_KEY='codexWeb\.historySidebarCollapsed'/);
  assert.match(inlineScript, /const \{sidebar,remaining\}=partitionBrowserSidebarHistoryItems\(pinnedRemaining\);\s*appendBrowserSidebarHistoryTasks\(sidebar,\{query:Boolean\(query\)\}\);\s*const \{tasks:standaloneTasks,projects:groups\}=partitionHistoryItems\(remaining\);/);
  assert.match(uiStyles, /\.historySidebarHead[\s\S]*grid-template-columns:\s*18px minmax\(0, 1fr\) 14px/);
  assert.match(uiStyles, /\.historySidebarHead\[aria-expanded="true"\] \.historySidebarChevron,[^{]*\{[^}]*transform:\s*rotate\(90deg\)/s);
});

test('the task section is rendered before project groups and can collapse independently', () => {
  const taskRenderSource = sourceBetween('function appendStandaloneHistoryTasks', 'function renderHistory');
  assert.match(taskRenderSource, /section\.className='historyTasks'/);
  assert.match(taskRenderSource, /head\.className='historyTasksHead'/);
  assert.match(taskRenderSource, /icon\.className='historyTasksIcon';\s*setIconLabel\(icon,'list-checks','',false\)/);
  assert.match(taskRenderSource, /title\.textContent='任务'/);
  assert.match(taskRenderSource, /setIconLabel\(chevron,'chevron-right','',false\)/);
  assert.match(taskRenderSource, /rows\.className='historyTasksItems'/);
  assert.match(taskRenderSource, /createHistoryRow\(item,''\)/);
  assert.doesNotMatch(taskRenderSource, /createHistoryProjectMenu|historyProjectHead|historyProjectFolder/);
  assert.match(taskRenderSource, /setHistoryTasksExpanded\(section,Boolean\(query\)\|\|containsCurrent\|\|!historyTasksCollapsed\)/);
  assert.match(taskRenderSource, /historyTasksCollapsed=expanded;\s*storeHistoryTasksCollapsed\(\)/);
  assert.match(inlineScript, /const HISTORY_TASKS_COLLAPSED_STORAGE_KEY='codexWeb\.historyTasksCollapsed'/);
  assert.match(inlineScript, /const \{tasks:standaloneTasks,projects:groups\}=partitionHistoryItems\(remaining\);\s*appendStandaloneHistoryTasks\(standaloneTasks,\{query:Boolean\(query\)\}\);/);
  assert.match(uiStyles, /\.historyPinnedHead,[\s\S]*\.historyTasksHead\s*\{[^}]*grid-template-columns:\s*18px minmax\(0, 1fr\) 14px/s);
  assert.match(uiStyles, /\.historyPinnedTitle,[\s\S]*\.historyTasksTitle\s*\{[^}]*color:\s*var\(--text\);[^}]*font-size:\s*12px;[^}]*font-weight:\s*650/s);
  assert.match(uiStyles, /\.historyPinnedIcon,[\s\S]*\.historyTasksIcon\s*\{[^}]*color:\s*var\(--primary\)/s);
  assert.match(uiStyles, /\.historyTasksItems\s*\{[^}]*display:\s*grid;[^}]*gap:\s*1px/s);
  assert.match(uiStyles, /\.historyTasksItems\[hidden\]\s*\{[^}]*display:\s*none/s);
  assert.match(uiStyles, /\.historyTasksHead\[aria-expanded="true"\] \.historyTasksChevron\s*\{[^}]*transform:\s*rotate\(90deg\)/s);
});

test('workspace-kind changes are watched and included in session signatures', () => {
  assert.match(nativeSource, /relative !== '\.codex-global-state\.json'/);
  assert.match(nativeSource, /state\['projectless-thread-ids'\]/);
  assert.match(nativeSource, /parsed\['projectless-thread-ids'\]/);
  assert.match(nativeSource, /legacy-projectless-thread-ids/);
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
  assert.match(inlineScript, /let historyRefreshPointerId=null/);
  assert.match(inlineScript, /function historyRefreshBlocked\(\)\{return historyRefreshPointerId!==null\|\|activeHistoryProjectMenu\|\|historyProjectPreviewAnchor\|\|historyRenameActive\|\|history\.querySelector\('\.hist\.renaming,\.histRenameInput'\)\}/);
  assert.match(inlineScript, /function beginHistoryRefreshPointerLock\(event\)\{[\s\S]*event\.button!==0\|\|event\.isPrimary===false\|\|!event\.target\.closest\?\.\('\.hist'\)[\s\S]*historyRefreshPointerId=event\.pointerId/);
  assert.match(inlineScript, /history\?\.addEventListener\('pointerdown',beginHistoryRefreshPointerLock,true\)/);
  assert.match(inlineScript, /window\.addEventListener\('pointerup',releaseHistoryRefreshPointerLock,true\)/);
  assert.match(inlineScript, /window\.addEventListener\('pointercancel',releaseHistoryRefreshPointerLock,true\)/);
  assert.match(inlineScript, /window\.addEventListener\('blur',clearHistoryRefreshPointerLock\)/);
  const pointerLockSource = sourceBetween('function beginHistoryRefreshPointerLock', 'function flushPendingHistoryRefresh');
  assert.doesNotMatch(pointerLockSource, /loadConversation\(|preventDefault\(/);
  assert.match(inlineScript, /function flushPendingHistoryRefresh/);
  assert.match(inlineScript, /if\(!historyRefreshPending\|\|historyRefreshBlocked\(\)\)return/);
  assert.match(inlineScript, /async function refreshHistory\(\)\{\s*if\(historyRefreshBlocked\(\)\)\{historyRefreshPending=true;return\}[\s\S]*const data=await res\.json\(\);\s*\/\/ A live-session refresh may have started just before the user pressed a row\.\s*if\(historyRefreshBlocked\(\)\)\{historyRefreshPending=true;return\}\s*pinnedThreadIds=/);
  const rowSource = sourceBetween('function createHistoryRow', 'function updateActiveHistory');
  assert.match(rowSource, /row\.addEventListener\('click',openConversation\)/);
  assert.match(rowSource, /open\.addEventListener\('click',\(e\)=>\{e\.stopPropagation\(\);openConversation\(\)\}\)/);
  assert.match(rowSource, /rename\.addEventListener\('click',\(e\)=>\{e\.preventDefault\(\);e\.stopPropagation\(\);beginHistoryRename/);
  assert.match(rowSource, /del\.addEventListener\('click',\(e\)=>\{e\.stopPropagation\(\);deleteConversation/);
  assert.match(inlineScript, /flushPendingHistoryRefresh\(\)/);
});

test('starting a new task clears inherited project selection', () => {
  assert.match(inlineScript, /function resetNewTaskComposerCwd\(\)\{\s*cwd\.value='';\s*currentNativeWorkspaceKind='';\s*}/);
  assert.match(inlineScript, /defaultComposerCwd=String\(data\.defaults\.cwd\|\|''\);if\(!currentConversationId\)cwd\.value='';/);
  assert.match(inlineScript, /resetNewTaskComposerCwd\(\);clearNativeCompletionSync/);
  assert.match(inlineScript, /<b>新任务<\/b><span>项目路径可选，直接输入即可。<\/span>/);
});

test('composer project selection includes an explicit no-project option', () => {
  const selectionSource = sourceBetween('function selectComposerProjectPath', 'function queueActionButton');
  assert.doesNotMatch(selectionSource, /if\(!path\)return/);
  assert.match(selectionSource, /cwd\.value=path/);
  assert.match(selectionSource, /noProjectName\.textContent='无项目'/);
  assert.match(selectionSource, /noProjectDetail\.textContent='使用默认工作目录'/);
  assert.match(selectionSource, /selectComposerProjectPath\(''\)/);
  assert.match(inlineScript, /projectName=projectPath\?historyProjectName\(projectPath\):'选择项目（可选）'/);
  assert.match(inlineScript, /projectTitle\.textContent='项目路径（可选）'/);
});
