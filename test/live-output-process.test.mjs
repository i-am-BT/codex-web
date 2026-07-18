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
  assert.match(inlineScript, /\['task_error','turn_aborted','error'\]\.includes\(kind\)\)\{freezeTurnProcessElapsed\([^}]*clearLiveTurnProgress\(\)/);
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
  const dropZone = { kind: 'drop-zone', parentNode: null, isConnected: true };
  let composerInsertCalls = 0;
  const composer = {
    children: [dropZone],
    insertBefore(node, reference) {
      composerInsertCalls += 1;
      assert.strictEqual(reference, dropZone);
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
  );

  const first = api.refresh();
  const second = api.refresh();
  assert.notStrictEqual(first, second);
  assert.deepEqual(timeline.children, []);
  assert.deepEqual(composer.children, [second, dropZone]);
  assert.strictEqual(second.parentNode, composer);
  assert.strictEqual(composer.children.at(-1), dropZone);
  assert.equal(composerInsertCalls, 1);
  assert.deepEqual(api.state().turnProcessElements, [toolArtifact]);
  assert.equal(api.state().turnProcessElements.includes(second), false);
  assert.match(inlineScript, /if\(files\.length\)container\.appendChild\(createEditedFilesResultCard\(files,turnId\)\)/);
});

test('the compact pill matches the reference sizing and closed tools stay hidden', () => {
  assert.doesNotMatch(inlineScript, /function createTurnPlanElement|turnPlanPanel/);
  assert.doesNotMatch(uiStyles, /\.turnPlanPanel|\.turnPlanList|\.turnPlanStep/);
  assert.match(uiStyles, /\.activityCluster:not\(\[open\]\) > \.activityClusterItems\s*\{[^}]*display:\s*none/s);
  assert.match(uiStyles, /\.editedFilesResult\.withPlan > \.turnResultHead\s*\{[^}]*min-height:\s*36px/s);
  assert.match(uiStyles, /\.turnPlanProgressRing\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;[^}]*flex:\s*0 0 12px/s);
  assert.match(uiStyles, /\.turnPlanProgressRing::after\s*\{[^}]*inset:\s*2px/s);
  assert.match(uiStyles, /conic-gradient\(#339cff var\(--turn-plan-progress\), #2b3c4f 0\)/);
  assert.match(uiStyles, /body \.composer > \.editedFilesResult\.live\s*\{[^}]*align-self:\s*center;[^}]*margin:\s*0 auto 8px/s);
  assert.doesNotMatch(uiStyles, /\.liveProcessTimeline > \.editedFilesResult\.live/);
  assert.equal((inlineScript.match(/fileChanges:msg\.fileChanges/g) || []).length, 2);
});
