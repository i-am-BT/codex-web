import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [serverSource, uiStyles] = await Promise.all([
  readFile(new URL('../server.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../ui.css', import.meta.url), 'utf8'),
]);
const rawInlineScript = serverSource.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
const inlineScript = rawInlineScript.replaceAll('\\\\', '\\');

function sourceBetween(start, end) {
  const source = inlineScript.match(new RegExp(`(${start}[\\s\\S]*?)(?=${end})`))?.[1];
  assert.ok(source, `missing helper source: ${start}`);
  return source;
}

const referencePlan = [
  { step: '对照 参考图', status: 'completed' },
  { step: '实现紧凑进度 pill', status: 'in_progress' },
  { step: '运行回归测试', status: 'pending' },
];

test('a user question stays before an already-mounted live response panel', () => {
  const appendSource = sourceBetween('function appendConversationElement', 'function addMsg');
  const chat = {
    children: [],
    appendChild(element) {
      this.children.push(element);
      element.parentNode = this;
    },
    insertBefore(element, reference) {
      const index = this.children.indexOf(reference);
      assert.notEqual(index, -1);
      this.children.splice(index, 0, element);
      element.parentNode = this;
    },
  };
  const livePanel = { kind: 'live-panel', parentNode: chat };
  chat.children.push(livePanel);
  const appendConversationElement = new Function(
    'chat',
    'turnProcessHeader',
    `${appendSource}; return appendConversationElement;`,
  )(chat, livePanel);
  const question = { kind: 'user-question' };
  const answer = { kind: 'assistant-answer' };

  appendConversationElement(question, 'user');
  appendConversationElement(answer, 'assistant');

  assert.deepEqual(chat.children, [question, livePanel, answer]);
});

test('the real exec-wrapped update_plan call becomes a plan event', () => {
  const activitySource = sourceBetween('function decodeEmbeddedToolString', 'function toolMessageTitle');
  const activityApi = new Function(`${activitySource}; return { toolActivityPresentations, nativeFileChangePresentations };`)();
  const presentation = activityApi.toolActivityPresentations([
    'exec',
    'const result = await tools.update_plan({',
    '  explanation: "同步当前进度",',
    '  plan: [',
    '    { step: "对照 参考图", status: "completed" },',
    '    { step: "实现紧凑进度 pill", status: "in_progress" },',
    '    { step: "运行回归测试", status: "pending" }',
    '  ]',
    '});',
    'text(result);',
  ].join('\n'));
  assert.deepEqual(presentation, [{
    variant: 'plan',
    explanation: '同步当前进度',
    plan: referencePlan,
  }]);
  assert.deepEqual(activityApi.nativeFileChangePresentations([
    { filePath: '/workspace/first.mjs', verb: '已编辑', added: 120, removed: 0 },
    { filePath: '/workspace/second.css', verb: '已编辑', added: 1, removed: 1 },
  ]), [
    {
      verb: '已编辑',
      icon: 'pencil',
      target: 'first.mjs',
      filePath: '/workspace/first.mjs',
      added: 120,
      removed: 0,
      meta: '+120 -0',
    },
    {
      verb: '已编辑',
      icon: 'pencil',
      target: 'second.css',
      filePath: '/workspace/second.css',
      added: 1,
      removed: 1,
      meta: '+1 -1',
    },
  ]);
  assert.deepEqual(activityApi.toolActivityPresentations([
    'apply_patch',
    '*** Begin Patch',
    '*** Update File: /workspace/example.mjs',
    '-old',
    '---literal-minus',
    '+new',
    '+++literal-plus',
    '*** End Patch',
  ].join('\n')), [{
    verb: '已编辑',
    icon: 'pencil',
    target: 'example.mjs',
    filePath: '/workspace/example.mjs',
    added: 2,
    removed: 2,
    meta: '+2 -2',
  }]);
});

test('activity clusters prefer the latest reasoning and mark only the latest row current', () => {
  const activitySource = sourceBetween('function joinActivityActions', 'function turnPlanProgress');
  const activityApi = new Function(`${activitySource}; return { activityClusterPresentation, activityClusterMatchesBrowserTarget, markCurrentActivityItem, mergeActivityClusterReasoning, clearActiveActivityReasoning };`)();
  const item = {
    classList: { contains: () => false },
    querySelector(selector) {
      if (selector === '.activityVerb') return { dataset: { completedVerb: 'Ran' }, textContent: 'Ran' };
      if (selector === '.activityTarget') return { textContent: 'command' };
      if (selector === '.activityItemIcon [data-lucide]') {
        return { getAttribute: (name) => name === 'data-lucide' ? 'square-terminal' : null };
      }
      return null;
    },
  };
  const batches = [0, 1].map(() => ({
    dataset: { activityGroup: 'commands' },
    classList: { contains: () => false },
    querySelectorAll: (selector) => selector === '.activityItem' ? [item] : [],
  }));
  const cluster = (activityReasoning, activeReasoning = '') => ({
    dataset: {
      activityGroup: 'tools',
      activityReasoning,
      ...(activeReasoning ? { activeReasoning, reasoningActive: 'true' } : {}),
    },
    querySelectorAll(selector) {
      if (selector === ':scope > .activityClusterItems > .activityBatch') return batches;
      if (selector === '.activityItem') return batches.flatMap((batch) => batch.querySelectorAll('.activityItem'));
      return [];
    },
  });

  assert.deepEqual(activityApi.activityClusterPresentation(cluster(JSON.stringify([
    'Planning first step',
    'Planning latest step',
  ]))), {
    icon: 'square-terminal',
    text: 'Planning latest step',
  });
  assert.deepEqual(activityApi.activityClusterPresentation(cluster(JSON.stringify(['   ']))), {
    icon: 'square-terminal',
    text: '运行了多个命令',
  });
  assert.deepEqual(activityApi.activityClusterPresentation(cluster('{broken')), {
    icon: 'square-terminal',
    text: '运行了多个命令',
  });
  assert.equal(activityApi.activityClusterMatchesBrowserTarget(cluster(JSON.stringify([
    'Older planning title',
    'Latest planning title',
  ])), 'Older planning title'), true);

  const transientCluster = cluster(JSON.stringify(['Planning owned tool A']), 'Planning unowned tool B');
  assert.equal(activityApi.activityClusterPresentation(transientCluster).text, 'Planning unowned tool B');
  assert.equal(activityApi.activityClusterMatchesBrowserTarget(transientCluster, 'Planning unowned tool B'), true);
  activityApi.clearActiveActivityReasoning(transientCluster, false);
  assert.equal(activityApi.activityClusterPresentation(transientCluster).text, 'Planning owned tool A');
  assert.deepEqual(JSON.parse(transientCluster.dataset.activityReasoning), ['Planning owned tool A']);
  activityApi.mergeActivityClusterReasoning(transientCluster, ['Planning unowned tool B']);
  assert.equal(activityApi.activityClusterPresentation(transientCluster).text, 'Planning unowned tool B');
  assert.deepEqual(JSON.parse(transientCluster.dataset.activityReasoning), [
    'Planning owned tool A',
    'Planning unowned tool B',
  ]);

  const rows = [{ dataset: { current: 'true' } }, { dataset: {} }];
  assert.strictEqual(activityApi.markCurrentActivityItem({ querySelectorAll: () => rows }), rows[1]);
  assert.equal(rows[0].dataset.current, undefined);
  assert.equal(rows[1].dataset.current, 'true');
});

test('active reasoning is temporary and collapse restores the owned cluster title', () => {
  const clearActiveSource = sourceBetween('function clearActiveActivityReasoning', 'function updateActivityCluster');
  const reasoningSource = sourceBetween('function clearTurnReasoningStatus', 'function shouldClearTurnReasoningStatus');
  const collapseSource = sourceBetween('function collapseCurrentActivityCluster', 'function activateTurnProcessElement');
  const api = new Function(`
    const cluster = {
      isConnected: true,
      open: true,
      dataset: { activityReasoning: JSON.stringify(['Planning owned tool A']) },
    };
    let currentActivityCluster = cluster;
    let turnReasoningStatus = null;
    const turnProcessTimeline = { appendChild() {} };
    let updates = 0;
    let merges = 0;
    function updateActivityCluster() { updates += 1; }
    function mergeActivityClusterReasoning() { merges += 1; }
    function shortActivityText(value) { return String(value || '').trim(); }
    function ensureTurnProcessHeader() {}
    function moveLiveEditedFilesResultToEnd() {}
    ${clearActiveSource}
    ${reasoningSource}
    ${collapseSource}
    return {
      update: updateTurnReasoningStatus,
      clear: clearTurnReasoningStatus,
      collapse: collapseCurrentActivityCluster,
      state: () => ({ cluster, currentActivityCluster, turnReasoningStatus, updates, merges }),
    };
  `)();

  assert.strictEqual(api.update('Planning unowned tool B'), api.state().cluster);
  assert.equal(api.state().cluster.dataset.activeReasoning, 'Planning unowned tool B');
  assert.equal(api.state().cluster.dataset.reasoningActive, 'true');
  assert.deepEqual(JSON.parse(api.state().cluster.dataset.activityReasoning), ['Planning owned tool A']);
  assert.equal(api.state().merges, 0);
  assert.equal(api.state().updates, 1);

  api.clear();
  assert.equal(api.state().cluster.dataset.activeReasoning, undefined);
  assert.equal(api.state().cluster.dataset.reasoningActive, undefined);
  assert.deepEqual(JSON.parse(api.state().cluster.dataset.activityReasoning), ['Planning owned tool A']);
  assert.strictEqual(api.state().currentActivityCluster, api.state().cluster);
  assert.equal(api.state().updates, 2);

  api.update('Planning unowned tool B');
  api.clear(true);
  assert.equal(api.state().cluster.dataset.activeReasoning, 'Planning unowned tool B');
  assert.equal(api.state().cluster.dataset.reasoningActive, 'true');
  assert.equal(api.state().updates, 3);

  api.collapse();
  assert.equal(api.state().cluster.dataset.activeReasoning, undefined);
  assert.equal(api.state().cluster.dataset.reasoningActive, undefined);
  assert.deepEqual(JSON.parse(api.state().cluster.dataset.activityReasoning), ['Planning owned tool A']);
  assert.equal(api.state().cluster.open, false);
  assert.equal(api.state().currentActivityCluster, null);
  assert.equal(api.state().updates, 4);
});

test('terminal states remove only the ephemeral progress pill', () => {
  const clearSource = sourceBetween('function clearLiveTurnProgress', 'function clearTurnProcessHeader');
  const api = new Function(`
    let removed = 0;
    let liveTurnPlan = [{ step: 'running', status: 'in_progress' }];
    let liveEditedFilesResult = {
      parentNode: {},
      remove() { removed += 1; this.parentNode = null; },
    };
    ${clearSource}
    return {
      clear: clearLiveTurnProgress,
      state: () => ({ removed, liveTurnPlan, liveEditedFilesResult }),
    };
  `)();
  api.clear();
  assert.deepEqual(api.state(), { removed: 1, liveTurnPlan: [], liveEditedFilesResult: null });
  assert.match(inlineScript, /\['task_error','turn_aborted','error'\]\.includes\(kind\)\)\{\s*freezeTurnProcessElapsed\([^}]*clearLiveTurnProgress\(\)/);
  assert.match(inlineScript, /\['task_error','turn_aborted','error'\]\.includes\(kind\)\)\{[\s\S]*?settleTurnTool\(latestToolElement\);[\s\S]*?collapseCurrentActivityCluster\(\)/);
  assert.match(inlineScript, /async function cancelRun\(\)[\s\S]*?freezeTurnProcessElapsed\('',activeNativeTurnId\);clearLiveTurnProgress\(\)/);
  assert.match(inlineScript, /if\(\['error','interrupted'\]\.includes\(runtime\.status\)\)clearLiveTurnProgress\(\)/);
});

test('plan updates preserve the active tool and agent rows', () => {
  const normalizeSource = sourceBetween('function normalizeTurnPlanItems', 'function planActivityPresentation');
  const upsertSource = sourceBetween('function upsertLiveTurnPlan', 'function appendTurnTool');
  const api = new Function(`
    ${normalizeSource}
    const toolCluster = { kind: 'tool-cluster' };
    const agentGroup = { kind: 'agent-group' };
    const livePill = { kind: 'live-pill' };
    let currentActivityCluster = toolCluster;
    let currentAgentActivityGroup = agentGroup;
    let pendingActivityReasoning = ['kept reasoning'];
    let liveTurnPlan = [];
    let ensured = 0;
    let refreshed = 0;
    let moved = 0;
    function ensureTurnProcessHeader() { ensured += 1; }
    function refreshLiveEditedFilesResult() { refreshed += 1; return livePill; }
    function moveLiveEditedFilesResultToEnd() { moved += 1; }
    ${upsertSource}
    return {
      run: upsertLiveTurnPlan,
      state: () => ({
        currentActivityCluster,
        currentAgentActivityGroup,
        pendingActivityReasoning,
        liveTurnPlan,
        toolCluster,
        agentGroup,
        livePill,
        ensured,
        refreshed,
        moved,
      }),
    };
  `)();

  const inputPlan = referencePlan.map((item, index) => ({
    ...item,
    step: index === 0 ? '  对照   参考图  ' : item.step,
  }));
  assert.strictEqual(api.run(inputPlan), api.state().livePill);
  const state = api.state();
  assert.strictEqual(state.currentActivityCluster, state.toolCluster);
  assert.strictEqual(state.currentAgentActivityGroup, state.agentGroup);
  assert.deepEqual(state.pendingActivityReasoning, ['kept reasoning']);
  assert.deepEqual(state.liveTurnPlan, referencePlan);
  assert.deepEqual([state.ensured, state.refreshed, state.moved], [1, 1, 1]);
});

test('the live progress pill stays out of completion artifacts', () => {
  const helpers = sourceBetween('function moveLiveEditedFilesResultToEnd', 'function createWebPreviewResultCard');
  const detachNode = (node) => {
    if (!node.parentNode) return;
    const index = node.parentNode.children.indexOf(node);
    if (index >= 0) node.parentNode.children.splice(index, 1);
  };
  const timeline = {
    children: [],
    appendChild(node) {
      detachNode(node);
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
    },
  };
  const promptQueuePanel = { kind: 'prompt-queue', parentNode: null, isConnected: true };
  const hiddenAttachmentTray = { kind: 'hidden-attachment-tray', parentNode: null, isConnected: true };
  const dropZone = { kind: 'drop-zone', parentNode: null, isConnected: true };
  let composerInsertCalls = 0;
  const composer = {
    children: [promptQueuePanel, hiddenAttachmentTray, dropZone],
    insertBefore(node, reference) {
      composerInsertCalls += 1;
      assert.strictEqual(reference, promptQueuePanel);
      detachNode(node);
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
  promptQueuePanel.parentNode = composer;
  hiddenAttachmentTray.parentNode = composer;
  dropZone.parentNode = composer;
  const toolArtifact = { kind: 'tool-artifact' };
  const processElements = [toolArtifact];
  const makeCard = () => ({
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
  });
  const api = new Function(
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
      ${helpers}
      return {
        refresh: refreshLiveEditedFilesResult,
        state: () => ({ liveEditedFilesResult, turnProcessElements }),
      };
    `,
  )(
    timeline,
    processElements,
    (elements) => {
      assert.strictEqual(elements, processElements);
      return [{ name: 'server.mjs', verb: '已编辑', added: 2, removed: 1 }];
    },
    makeCard,
    () => {},
    referencePlan,
    composer,
    dropZone,
    promptQueuePanel,
  );

  const first = api.refresh();
  const second = api.refresh();
  assert.notStrictEqual(first, second);
  assert.deepEqual(timeline.children, []);
  assert.deepEqual(composer.children, [second, promptQueuePanel, hiddenAttachmentTray, dropZone]);
  assert.strictEqual(second.parentNode, composer);
  assert.strictEqual(second.nextSibling, promptQueuePanel);
  assert.strictEqual(composer.children.at(-1), dropZone);
  assert.equal(composerInsertCalls, 1);
  assert.deepEqual(api.state().turnProcessElements, [toolArtifact]);
  assert.equal(api.state().turnProcessElements.includes(second), false);
  assert.match(inlineScript, /if\(files\.length\)container\.appendChild\(createEditedFilesResultCard\(files,turnId\)\)/);
});

test('the compact pill matches the reference sizing and closed tools stay hidden', () => {
  assert.doesNotMatch(inlineScript, /function createTurnPlanElement|turnPlanPanel/);
  assert.doesNotMatch(uiStyles, /\.turnPlanPanel|\.turnPlanList|\.turnPlanStep/);
  assert.match(inlineScript, /function activityClusterPresentation\(cluster\)\{[\s\S]*?activityClusterReasoning\(cluster\)\.at\(-1\)/);
  assert.match(inlineScript, /function createActivityCluster[\s\S]*?cluster\.open=true;/);
  assert.match(inlineScript, /function collapseCurrentActivityCluster[\s\S]*?currentActivityCluster\.open=false/);
  assert.match(inlineScript, /function markCurrentActivityItem[\s\S]*?current\.dataset\.current='true'/);
  assert.match(inlineScript, /if\(expandable\)item\.open=false;/);
  assert.match(inlineScript, /if\(item\.tagName==='DETAILS'\)item\.open=false;/);
  assert.match(uiStyles, /\.activityCluster:not\(\[open\]\) > \.activityClusterItems\s*\{[^}]*display:\s*none/s);
  assert.match(uiStyles, /\.activityClusterItems::before\s*\{[^}]*background:\s*var\(--activity-rail\)/s);
  assert.match(uiStyles, /\.activityCluster \.activityItem\[data-current="true"\] > \.activityItemSummary,[^}]*color:\s*var\(--text\)/s);
  assert.match(uiStyles, /\.activityCluster \.activityItemChevron\s*\{[^}]*opacity:\s*0/s);
  assert.match(uiStyles, /\.activityCluster \.activityItem\[data-current="true"\] > \.activityItemSummary \.activityItemChevron,[^}]*opacity:\s*1/s);
  assert.match(uiStyles, /\.activityBatch\.streaming \.activityItem:last-child \.activityItemIcon\s*\{[^}]*animation:\s*streamDot/s);
  assert.match(uiStyles, /\.activityCluster \.activityBatch\.streaming \.activityItem:last-child \.activityItemIcon\s*\{[^}]*animation:\s*none/s);
  assert.match(uiStyles, /@media \(hover: none\)[\s\S]*?\.activityCluster \.activityItem:not\(\[data-current="true"\]\):not\(\[open\]\)[^}]*opacity:\s*0\.5/s);
  assert.match(uiStyles, /\.editedFilesResult\.withPlan > \.turnResultHead\s*\{[^}]*min-height:\s*36px/s);
  assert.match(uiStyles, /\.turnPlanProgressRing\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;[^}]*flex:\s*0 0 12px/s);
  assert.match(uiStyles, /\.turnPlanProgressRing::after\s*\{[^}]*inset:\s*2px/s);
  assert.match(uiStyles, /conic-gradient\(#339cff var\(--turn-plan-progress\), #2b3c4f 0\)/);
  assert.match(uiStyles, /body \.composer > \.editedFilesResult\.live\s*\{[^}]*align-self:\s*center;[^}]*margin:\s*0 auto 8px/s);
  assert.doesNotMatch(uiStyles, /\.liveProcessTimeline > \.editedFilesResult\.live/);
  assert.equal((inlineScript.match(/fileChanges:msg\.fileChanges/g) || []).length, 2);
});

test('the prompt queue forms the inset overlapping boundary above the composer', () => {
  const ruleBody = (selector) => {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = uiStyles.match(new RegExp(`(?:^|\\n)\\s*${escapedSelector}\\s*\\{([^}]*)\\}`, 'm'))?.[1];
    assert.ok(body, `missing CSS rule: ${selector}`);
    return body;
  };
  const pixelValue = (body, property, { negative = false } = {}) => {
    const sign = negative ? '-' : '';
    const value = body.match(new RegExp(`${property}:\\s*${sign}(\\d+(?:\\.\\d+)?)px(?:;|$)`))?.[1];
    assert.ok(value, `missing ${negative ? 'negative ' : ''}${property} pixel value`);
    return Number(value);
  };

  const queueRule = ruleBody('.promptQueue');
  const queueWidth = queueRule.match(
    /width:\s*min\(calc\(var\(--conversation-width\)\s*-\s*(\d+(?:\.\d+)?)px\),\s*calc\(100%\s*-\s*(\d+(?:\.\d+)?)px\)\)/,
  );
  assert.ok(queueWidth, 'the queue width must stay inset from both the desktop and fluid composer widths');
  assert.equal(Number(queueWidth[1]), Number(queueWidth[2]));
  assert.ok(Number(queueWidth[1]) > 12, 'the queue must be narrower than the former six-pixels-per-side mobile inset');

  const overlap = pixelValue(queueRule, 'margin-bottom', { negative: true });
  const overlapPadding = pixelValue(queueRule, 'padding-bottom');
  assert.ok(overlap > 0, 'the queue must overlap the composer');
  assert.equal(overlapPadding, overlap, 'bottom padding must protect the final queue row from the overlap');

  const queueLayer = Number(queueRule.match(/z-index:\s*(-?\d+)(?:;|$)/)?.[1]);
  const composerRule = ruleBody('body .box');
  const composerLayer = Number(composerRule.match(/z-index:\s*(-?\d+)(?:;|$)/)?.[1]);
  assert.ok(Number.isFinite(queueLayer), 'the queue must declare its stacking layer');
  assert.ok(Number.isFinite(composerLayer), 'the composer box must declare its stacking layer');
  assert.ok(composerLayer > queueLayer, 'the rounded composer must paint over the queue boundary');

  assert.match(ruleBody('.promptQueueHead'), /display:\s*none(?:;|$)/);
  assert.doesNotMatch(uiStyles, /\.promptQueue\s*\{[^}]*width:\s*calc\(100%\s*-\s*12px\)/s);

  const queueStart = inlineScript.indexOf('function renderPromptQueue(){');
  const queueEnd = inlineScript.indexOf('function enqueuePrompt', queueStart);
  assert.ok(queueStart >= 0 && queueEnd > queueStart, 'missing prompt queue renderer source');
  const queueRenderer = inlineScript.slice(queueStart, queueEnd);
  assert.doesNotMatch(queueRenderer, /queueActionButton\('pencil'/);
  assert.match(queueRenderer, /queueActionButton\('ellipsis','编辑'/);
  assert.deepEqual(
    [...queueRenderer.matchAll(/row\.appendChild\((guide|remove|more)\)/g)].map((match) => match[1]),
    ['guide', 'remove', 'more'],
  );
});

test('persisted active commentary renders progressively and deduplicates by sequence', () => {
  const liveSource = sourceBetween('function isNativeSnapshotStreamingMessage', 'async function copyText');
  let nextTimerId = 1;
  const timers = new Map();
  const rendered = [];
  const addCalls = [];
  const fakeSetTimeout = (callback, delay) => {
    const id = nextTimerId++;
    timers.set(id, { callback, delay });
    return id;
  };
  const fakeClearTimeout = (id) => timers.delete(id);
  const runNextTimer = () => {
    const next = timers.entries().next().value;
    assert.ok(next, 'expected a pending render timer');
    const [id, timer] = next;
    timers.delete(id);
    timer.callback();
  };
  const drainTimers = () => {
    while (timers.size) runNextTimer();
  };
  const createElement = () => {
    const classes = new Set(['msg', 'assistant', 'streaming']);
    return {
      dataset: {},
      _messageBody: { textContent: '' },
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
      },
    };
  };
  const addMsg = (role, text, options) => {
    const element = createElement();
    element.dataset.messageText = text;
    addCalls.push({ role, text, options, element });
    return element;
  };
  const renderAssistantMarkdown = (body, text) => {
    body.textContent = text;
    rendered.push(text);
  };
  const api = new Function(
    'setTimeout',
    'clearTimeout',
    'addMsg',
    'renderAssistantMarkdown',
    'scrollChatToLatest',
    `
      let nativeGeneration = 4;
      let nativeCompletionSync = null;
      let nativeLiveItems = new Map();
      let nativeRuntimeStreamTurnIds = new Set();
      let nativeRenderedMessageKeys = new Set();
      let activeNativeTurnId = 'turn-active';
      ${liveSource}
      return {
        shouldStream: isNativeSnapshotStreamingMessage,
        upsert: upsertNativeSnapshotLiveMessage,
        finishAll: finishAllNativeLiveItems,
        clear: clearNativeLiveItems,
        setCompletionPending(value) { nativeCompletionSync = value; },
        state: () => ({ nativeLiveItems, nativeRuntimeStreamTurnIds, nativeRenderedMessageKeys }),
      };
    `,
  )(fakeSetTimeout, fakeClearTimeout, addMsg, renderAssistantMarkdown, () => {});

  const conversation = {
    status: 'running',
    activeTurnId: 'turn-active',
    generation: 4,
  };
  const message = {
    seq: 7,
    role: 'assistant',
    kind: 'commentary',
    turnId: 'turn-active',
    content: '这是一段足够长的实时处理说明，用来确认第一次刷新不会整段同时出现。',
    at: '2026-07-19T10:00:00.000Z',
  };

  assert.equal(api.shouldStream(message, conversation), true);
  assert.equal(api.shouldStream({ ...message, kind: 'final_answer' }, conversation), false);
  assert.equal(api.shouldStream({ ...message, turnId: 'turn-old' }, conversation), false);
  assert.equal(api.shouldStream(message, { ...conversation, status: 'done' }), false);
  api.setCompletionPending({ turnId: 'turn-active' });
  assert.equal(api.shouldStream(message, conversation), false);
  api.setCompletionPending(null);

  const first = api.upsert(message, conversation);
  const repeated = api.upsert(message, conversation);
  assert.strictEqual(repeated, first);
  assert.equal(addCalls.length, 1);
  assert.equal(first.targetText, message.content);
  assert.equal(first.text, '');
  assert.equal(first.element.classList.contains('streaming'), true);
  assert.equal(timers.size, 1);

  runNextTimer();
  assert.ok(message.content.startsWith(first.text));
  assert.notEqual(first.text, message.content);
  assert.ok(first.text.length <= 6, 'persisted snapshot should advance in visibly small steps');
  assert.equal(first.element.dataset.messageText, first.text);
  assert.equal(first.element.classList.contains('streaming'), true);

  const extended = { ...message, content: `${message.content}继续补充新的尾部。` };
  assert.strictEqual(api.upsert(extended, conversation), first);
  assert.equal(first.targetText, extended.content);
  assert.equal(addCalls.length, 1);
  drainTimers();
  assert.equal(first.text, extended.content);
  assert.equal(first.element.dataset.messageText, extended.content);
  assert.equal(first.element.classList.contains('streaming'), false);
  assert.equal(api.state().nativeLiveItems.size, 0);
  assert.equal(api.state().nativeRenderedMessageKeys.size, 1);
  assert.equal(rendered.at(-1), extended.content);

  assert.equal(api.upsert(extended, conversation), null);
  assert.equal(addCalls.length, 1);
  assert.equal(timers.size, 0);

  const pending = api.upsert({ ...message, seq: 8, content: `${message.content}尚未逐字完成。` }, conversation);
  assert.equal(timers.size, 1);
  api.finishAll();
  assert.equal(timers.size, 0);
  assert.equal(pending.text, pending.targetText);
  assert.equal(pending.element.dataset.messageText, pending.targetText);
  assert.equal(pending.element.classList.contains('streaming'), false);

  api.upsert({ ...message, seq: 9 }, conversation);
  assert.equal(timers.size, 1);
  api.clear();
  assert.equal(timers.size, 0);
  assert.equal(api.state().nativeLiveItems.size, 0);
  assert.equal(api.state().nativeRuntimeStreamTurnIds.size, 0);
  assert.equal(api.state().nativeRenderedMessageKeys.size, 0);

  assert.match(inlineScript, /loadConversation[\s\S]*hydrating:true/);
  assert.match(inlineScript, /nativeRuntimeStreamTurnIds\.has\(String\(msg\.turnId\|\|''\)\)/);
  assert.doesNotMatch(inlineScript, /nativeLiveItems\.size&&\['assistant','thinking'\]/);
});
