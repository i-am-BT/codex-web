import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [serverSource, uiStyles, nativeSessionSource] = await Promise.all([
  readFile(new URL('../server.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../ui.css', import.meta.url), 'utf8'),
  readFile(new URL('../native-sessions.mjs', import.meta.url), 'utf8'),
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

test('input context, user questions, and browser comments stay before a live panel while steering keeps its send position', () => {
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
  const goalContext = { kind: 'goal-context', dataset: { messageKind: 'goal_context' } };
  const question = { kind: 'user-question' };
  const browserComment = { kind: 'browser-comment' };
  const answer = { kind: 'assistant-answer' };
  const steer = { kind: 'user-steer', classList: { contains: (name) => name === 'steeringUser' } };
  const afterSteer = { kind: 'assistant-after-steer' };

  appendConversationElement(answer, 'assistant');
  appendConversationElement(goalContext, 'context');
  appendConversationElement(question, 'user');
  appendConversationElement(browserComment, 'user', { steering: false });
  appendConversationElement(steer, 'user', { steering: true });
  appendConversationElement(afterSteer, 'assistant');

  assert.deepEqual(chat.children, [goalContext, question, browserComment, livePanel, answer, steer, afterSteer]);
});

test('steering stays chronological and input image helpers avoid duplicate uploads', () => {
  assert.match(inlineScript, /function normalizeInputImageSrc\(source\)/);
  assert.match(inlineScript, /function inputImageIdentity\(source\)/);
  assert.match(inlineScript, /function isOptimisticUploadImageSrc\(source\)/);
  assert.match(inlineScript, /function isServerSessionImageSrc\(source\)/);
  assert.match(inlineScript, /function cleanSteeringMessageDuplicates\(element\)/);
  assert.match(inlineScript, /const beforeLiveProcess=role==='context'\|\|\(role==='user'&&!steering\)/);
  assert.match(inlineScript, /const midTurnUser=role==='user'&&\['steering_user','steering_browser_comment'\]\.includes\(kind\)/);
  assert.match(inlineScript, /const steeringUser=role==='user'&&kind==='steering_user'/);
  assert.match(inlineScript, /appendConversationElement\(el,role,\{steering:steeringUser\}\)/);
  assert.match(inlineScript, /if\(steeringUser\|\|browserCommentUser\)cleanSteeringMessageDuplicates\(el\)/);
  assert.match(inlineScript, /function reconcileNativeSteeringElement\(element,options=\{\}\)/);
  assert.match(inlineScript, /Number\.isInteger\(options\.nativeMessageSeq\)\)element\.dataset\.nativeMessageSeq/);
  assert.match(inlineScript, /consumeNativeOptimisticSteering\(text,options\)\|\|findExistingNativeSteering\(text,options\)/);
  assert.match(inlineScript, /Historical steers should remain visible as input bubbles/);
  assert.match(inlineScript, /if\(!completedSteeringTimeline\)activateTurnProcessElement\(el\)/);
  assert.doesNotMatch(inlineScript, /pinSteeringMessageToBottom|pinOpenSteeringMessages|ensureSteeringPinObserver/);
  assert.match(inlineScript, /Rebind either direction instead of creating a second copy/);
  assert.match(inlineScript, /const singleImageInput=userElement\.classList\.contains\('steeringUser'\)[\s\S]*?browserCommentSteering/);
  assert.match(inlineScript, /if\(singleImageInput&&stack\.children\.length>=1\)/);
  assert.match(inlineScript, /Keep historical user\/steer bubbles in the main chat stream/);
  assert.doesNotMatch(inlineScript, /if\(browserCommentUser\)[\s\S]{0,120}classList\.add\('steeringUser'\)/);
});

test('browser comment attachment cards cannot collapse inside the chat scroll column', () => {
  assert.match(uiStyles, /body \.msg\.user\.browserCommentSteering\s*,\s*body \.msg\.user\.hasInputImage\.browserCommentSteering\s*\{[^}]*display:\s*flex;[^}]*flex:\s*0 0 auto/s);
  assert.match(uiStyles, /body \.chat > \.msg\.user\.browserCommentSteering,[\s\S]*?body \.chat > \.msg\.user\.hasInputImage\.browserCommentSteering\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*min\(280px, 88%\)/s);
  const railRuleIndex = uiStyles.indexOf('body .chat > :is(.msg.user, .msg.image.inputImage)');
  const browserOverrideIndex = uiStyles.indexOf('body .chat > .msg.user.browserCommentSteering');
  assert.ok(railRuleIndex >= 0 && browserOverrideIndex > railRuleIndex);
  assert.match(uiStyles, /body \.chat > \.msg\.user\.browserCommentSteering > \.msgBody\.browserCommentSource,[^}]*width:\s*fit-content;[^}]*border-radius:\s*16px;[^}]*padding:\s*8px 12px;[^}]*white-space:\s*normal/s);
  assert.match(uiStyles, /body \.chat > \.msg\.user\.browserCommentSteering > \.msgBody\.browserCommentSource > p\s*\{[^}]*margin:\s*0/s);
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
      dataset: { activityReasoning: JSON.stringify(['Planning owned tool A']), activityLive: 'true' },
      classList: { remove() {} },
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
  assert.equal(api.state().cluster.dataset.activityLive, undefined);
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
  const dropZone = { kind: 'drop-zone', parentNode: null, isConnected: true, children: [] };
  let composerInsertCalls = 0;
  const composer = {
    // Match enhanceComposer(): queue, attachment tray, then input capsule.
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
    'attachmentTray',
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
    hiddenAttachmentTray,
  );

  const first = api.refresh();
  const second = api.refresh();
  assert.notStrictEqual(first, second);
  assert.deepEqual(timeline.children, []);
  assert.deepEqual(composer.children, [second, promptQueuePanel, hiddenAttachmentTray, dropZone]);
  assert.strictEqual(second.parentNode, composer);
  assert.strictEqual(second.nextSibling, promptQueuePanel);
  assert.ok(composer.children.indexOf(second) < composer.children.indexOf(promptQueuePanel));
  assert.ok(composer.children.indexOf(promptQueuePanel) < composer.children.indexOf(hiddenAttachmentTray));
  assert.ok(composer.children.indexOf(hiddenAttachmentTray) < composer.children.indexOf(dropZone));
  assert.strictEqual(promptQueuePanel.parentNode, composer);
  assert.equal(composerInsertCalls, 1);
  assert.deepEqual(api.state().turnProcessElements, [toolArtifact]);
  assert.equal(api.state().turnProcessElements.includes(second), false);
  assert.match(inlineScript, /if\(files\.length\)container\.appendChild\(createEditedFilesResultCard\(files,turnId\)\)/);
});

test('the compact pill matches the reference sizing and closed tools stay hidden', () => {
  assert.doesNotMatch(inlineScript, /function createTurnPlanElement|turnPlanPanel/);
  assert.doesNotMatch(uiStyles, /\.turnPlanPanel|\.turnPlanList|\.turnPlanStep/);
  assert.match(inlineScript, /function activityClusterPresentation\(cluster\)\{[\s\S]*?activityClusterReasoning\(cluster\)\.at\(-1\)/);
  assert.match(inlineScript, /function createActivityCluster[\s\S]*?cluster\.open=false;/);
  assert.match(inlineScript, /function collapseCurrentActivityCluster[\s\S]*?currentActivityCluster\.open=false/);
  assert.match(inlineScript, /currentActivityCluster\.dataset\.activityLive='true'/);
  assert.match(inlineScript, /cluster\.dataset\.activityLive==='true'/);
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
  assert.match(
    uiStyles,
    /body \.liveProcessTimeline > \.progressCommentary\.streaming[^,]*,\s*body \.liveProcessTimeline > \.activityCluster\.streaming > summary \.activityClusterText\s*\{[^}]*var\(--primary\)[^}]*background-size:\s*220% 100%;[^}]*animation:\s*liveProcessFlow 4\.8s linear infinite/s,
  );
  assert.match(uiStyles, /@media \(hover: none\)[\s\S]*?\.activityCluster \.activityItem:not\(\[data-current="true"\]\):not\(\[open\]\)[^}]*opacity:\s*0\.5/s);
  assert.match(uiStyles, /\.editedFilesResult\.withPlan > \.turnResultHead\s*\{[^}]*min-height:\s*36px/s);
  assert.match(uiStyles, /\.turnPlanProgressRing\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px;[^}]*flex:\s*0 0 12px/s);
  assert.match(uiStyles, /\.turnPlanProgressRing::after\s*\{[^}]*inset:\s*2px/s);
  assert.match(uiStyles, /conic-gradient\(#339cff var\(--turn-plan-progress\), #2b3c4f 0\)/);
  assert.match(uiStyles, /body \.composer > \.editedFilesResult\.live\s*\{[^}]*align-self:\s*center;[^}]*margin:\s*0 auto 8px/s);
  assert.match(uiStyles, /body \.composer > \.editedFilesResult\.live:not\(\[open\]\)\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*100%/s);
  assert.match(uiStyles, /\.turnResultHead > \.turnResultFileLabel\s*\{[^}]*flex:\s*0 0 auto;[^}]*overflow:\s*visible;[^}]*text-overflow:\s*clip/s);
  assert.doesNotMatch(uiStyles, /\.liveProcessTimeline > \.editedFilesResult\.live/);
  assert.equal((inlineScript.match(/fileChanges:msg\.fileChanges/g) || []).length, 2);
});

test('the prompt queue stays visible in Web while retaining its backing actions', () => {
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
  assert.match(queueRule, /Above the input capsule/);
  assert.doesNotMatch(queueRule, /Nested inside \.box/);
  assert.doesNotMatch(queueRule, /grid-column:\s*1 \/ -1/);
  assert.match(queueRule, /width:\s*min\(680px, calc\(var\(--composer-width\) - 48px\), calc\(100% - 108px\)\)/);
  assert.match(queueRule, /max-width:\s*min\(680px, calc\(var\(--composer-width\) - 48px\), calc\(100% - 108px\)\)/);
  assert.match(queueRule, /margin:\s*0 auto 8px(?:;|$)/);
  assert.match(queueRule, /border-radius:\s*16px(?:;|$)/);
  assert.match(queueRule, /background:\s*color-mix\(in srgb, var\(--surface\)/);
  assert.doesNotMatch(queueRule, /grid-row:\s*1(?:;|$)/);
  assert.doesNotMatch(queueRule, /margin-bottom:\s*-\d/);
  assert.match(inlineScript, /composer\.insertBefore\(promptQueuePanel,queueAnchor\)/);
  assert.match(inlineScript, /Queue sits above the input capsule/);
  assert.match(inlineScript, /const queueAnchor=dropZone/);
  assert.match(ruleBody('.promptQueueRow:hover'), /background:\s*transparent(?:;|$)/);
  assert.match(ruleBody('.promptQueueRow.sending'), /background:\s*transparent(?:;|$)/);
  assert.match(ruleBody('.promptQueueRow.failed'), /background:\s*transparent(?:;|$)/);
  assert.match(uiStyles, /body\[data-chat-bg="skin"\] \.promptQueue\s*\{[^}]*border-color:/s);

  assert.match(ruleBody('.promptQueueHead'), /display:\s*none(?:;|$)/);
  assert.match(
    uiStyles,
    /\.promptQueueRow\s*\{[^}]*grid-template-columns:\s*22px minmax\(0, 1fr\) auto 28px 28px;[^}]*gap:\s*2px[^}]*\}\s*\.promptQueueRow\.appOwned\s*\{[^}]*grid-template-columns:\s*22px minmax\(0, 1fr\) auto 28px/s,
  );

  const queueStart = inlineScript.indexOf('function renderPromptQueue(){');
  const queueEnd = inlineScript.indexOf('function enqueuePrompt', queueStart);
  assert.ok(queueStart >= 0 && queueEnd > queueStart, 'missing prompt queue renderer source');
  const queueRenderer = inlineScript.slice(queueStart, queueEnd);
  assert.match(queueRenderer, /const showInWeb=Boolean\(threadId&&items\.length\)/);
  assert.match(queueRenderer, /classList\.toggle\('hidden',!showInWeb\)/);
  assert.match(queueRenderer, /if\(!showInWeb\)/);
  assert.doesNotMatch(queueRenderer, /queueActionButton\('pencil'/);
  assert.match(queueRenderer, /queueActionButton\('ellipsis','队列操作'/);
  assert.match(queueRenderer, /body\.addEventListener\('click',\(\)=>restoreQueuedPrompt\(threadId,item\.id\)\)/);
  assert.match(queueRenderer, /body\.disabled=busy/);
  assert.match(queueRenderer, /const retryable=queueFailures\.has\(item\.id\)&&!appOwned/);
  assert.match(queueRenderer, /guide\.disabled=busy\|\|\(!webRunActive&&!retryable\)/);
  assert.match(queueRenderer, /remove\.disabled=busy/);
  assert.match(queueRenderer, /more\.disabled=busy/);
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
    if (Number.isInteger(options?.nativeMessageSeq)) element.dataset.nativeMessageSeq = String(options.nativeMessageSeq);
    addCalls.push({ role, text, options, element });
    return element;
  };
  const renderAssistantMarkdown = (body, text) => {
    body.textContent = text;
    rendered.push(text);
  };
  let chatScrollTop = 600;
  let chatScrollWrites = 0;
  let chatScrollListener = null;
  const chat = {
    scrollHeight: 1000,
    clientHeight: 400,
    get scrollTop() { return chatScrollTop; },
    set scrollTop(value) { chatScrollTop = value; chatScrollWrites += 1; },
    setScrollTop(value) { chatScrollTop = value; },
    emitScroll() { chatScrollListener?.(); },
    addEventListener(type, listener) {
      if (type === 'scroll') chatScrollListener = listener;
    },
    querySelectorAll(selector) {
      if (selector !== '.msg.assistant') return [];
      return addCalls.map((call) => call.element);
    },
  };
  const api = new Function(
    'setTimeout',
    'clearTimeout',
    'addMsg',
    'renderAssistantMarkdown',
    'scrollChatToLatest',
    'chat',
    `
      let nativeGeneration = 4;
      let nativeCompletionSync = null;
      let nativeLiveItems = new Map();
      let nativeRuntimeStreamTurnIds = new Set();
      let nativeRenderedMessageKeys = new Set();
      let nativeLiveScrollTimer = null;
      let nativeLiveFollowBottom = true;
      let nativeLiveScrollTrackingBound = false;
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
  )(fakeSetTimeout, fakeClearTimeout, addMsg, renderAssistantMarkdown, () => {}, chat);

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
  // final_answer / message also stream from snapshots while the turn is active (desktop-ipc has no token deltas).
  assert.equal(api.shouldStream({ ...message, kind: 'final_answer' }, conversation), true);
  assert.equal(api.shouldStream({ ...message, kind: 'message' }, conversation), true);
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
  assert.equal([...timers.values()][0].delay, 60, 'live text should use the faster balanced render cadence');

  runNextTimer();
  assert.ok(message.content.startsWith(first.text));
  assert.notEqual(first.text, message.content);
  assert.ok(first.text.length <= 64, 'persisted snapshot should advance in bounded steps');
  assert.equal(first.element.dataset.messageText, first.text);
  assert.equal(first.element.classList.contains('streaming'), true);
  assert.deepEqual([...timers.values()].map((timer) => timer.delay).sort((a, b) => a - b), [60, 120]);

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
  assert.ok(chatScrollWrites > 0, 'near-bottom live output should follow with a coalesced scroll');

  assert.equal(api.upsert(extended, conversation), null);
  assert.equal(addCalls.length, 1);
  assert.equal(timers.size, 0);

  chat.setScrollTop(0);
  chat.emitScroll();
  const writesBeforeAwayRender = chatScrollWrites;
  const pending = api.upsert({ ...message, seq: 8, content: `${message.content}尚未逐字完成。` }, conversation);
  assert.equal(timers.size, 1);
  runNextTimer();
  assert.ok([...timers.values()].every((timer) => timer.delay === 60), 'away-from-bottom output must not queue a scroll');
  api.finishAll();
  assert.equal(timers.size, 0);
  assert.equal(chatScrollWrites, writesBeforeAwayRender, 'manual scrolling must not be overridden');
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
  assert.match(liveSource, /kind:'live_progress',autoScroll:false/);
  assert.doesNotMatch(liveSource, /scrollChatToLatest\(/);
  assert.match(inlineScript, /if\(nearBottom&&syncMessages\.length\)scheduleNativeLiveScroll\(\)/);
});

test('runtime stream and snapshot message adopt into one assistant bubble', () => {
  const liveSource = sourceBetween('function isNativeSnapshotStreamingMessage', 'async function copyText');
  const rendered = [];
  const addCalls = [];
  const createElement = () => {
    const classes = new Set(['msg', 'assistant', 'streaming']);
    return {
      dataset: { messageKind: 'live_progress' },
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
    if (options?.kind) element.dataset.messageKind = String(options.kind);
    if (options?.turnId) element.dataset.turnId = String(options.turnId);
    if (Number.isInteger(options?.nativeMessageSeq)) element.dataset.nativeMessageSeq = String(options.nativeMessageSeq);
    addCalls.push({ role, text, options, element });
    return element;
  };
  const renderAssistantMarkdown = (body, text) => {
    body.textContent = text;
    rendered.push(text);
  };
  const chat = {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 600,
    addEventListener() {},
    querySelectorAll(selector) {
      if (selector !== '.msg.assistant') return [];
      return addCalls.map((call) => call.element);
    },
  };
  const api = new Function(
    'setTimeout',
    'clearTimeout',
    'addMsg',
    'renderAssistantMarkdown',
    'scrollChatToLatest',
    'chat',
    `
      let nativeGeneration = 4;
      let nativeCompletionSync = null;
      let nativeLiveItems = new Map();
      let nativeRuntimeStreamTurnIds = new Set();
      let nativeRenderedMessageKeys = new Set();
      let nativeLiveScrollTimer = null;
      let nativeLiveFollowBottom = true;
      let nativeLiveScrollTrackingBound = false;
      let activeNativeTurnId = 'turn-active';
      let latestAssistantElement = null;
      let latestFinalAssistantElement = null;
      let collectingTurnProcess = false;
      let turnProcessElapsedTurnId = '';
      let turnProcessStartedAt = 0;
      let turnProcessElapsedLabel = null;
      const statusEl = { textContent: '', classList: { add() {}, remove() {} } };
      function beginTurnProcessCollection() {}
      function ensureTurnProcessElapsedRunning() {}
      function turnProcessElapsedMatches() { return true; }
      function activateTurnProcessElement() {}
      function removeNativeRunningElement() {}
      ${liveSource}
      return {
        updateDelta: updateNativeLiveDelta,
        finishItem: finishNativeLiveItem,
        finishAll: finishAllNativeLiveItems,
        adopt: adoptRuntimeLiveForSnapshotMessage,
        upsert: upsertNativeSnapshotLiveMessage,
        addMsg,
        state: () => ({ nativeLiveItems, nativeRuntimeStreamTurnIds, nativeRenderedMessageKeys, latestAssistantElement }),
      };
    `,
  )(() => 1, () => {}, addMsg, renderAssistantMarkdown, () => {}, chat);

  const content = '明白了：不是日程禁止嘟嘴，而是别让参考像把每张图都带成嘟嘴。';
  api.updateDelta({ itemId: 'item-1', turnId: 'turn-active', delta: content, updatedAt: '2026-07-26T12:00:00.000Z' });
  assert.equal(addCalls.length, 1);
  api.finishItem('item-1', 'turn-active');
  api.finishAll();
  assert.equal(addCalls.length, 1);

  const message = {
    seq: 12,
    role: 'assistant',
    kind: 'message',
    turnId: 'turn-active',
    content,
    at: '2026-07-26T12:00:01.000Z',
  };
  assert.ok(api.adopt(message));
  assert.equal(addCalls.length, 1, 'snapshot must adopt runtime bubble instead of creating a twin');
  assert.equal(addCalls[0].element.dataset.nativeMessageSeq, '12');
  assert.equal(addCalls[0].element.dataset.messageText, content);
  assert.equal(api.upsert(message, { status: 'running', activeTurnId: 'turn-active', generation: 4 }), null);
  assert.equal(addCalls.length, 1);

  // Residual same-text insert after adoption should not create another bubble when using real addMsg path.
  // (Here we only assert the runtime→snapshot adoption path used by live sync.)
  assert.equal(addCalls[0].element.dataset.messageKind, 'message');
  assert.equal(api.state().nativeRenderedMessageKeys.size >= 1, true);
});

test('streaming output has no blinking text caret', () => {
  assert.doesNotMatch(uiStyles, /streamCaret/);
  assert.doesNotMatch(uiStyles, /streamRail/);
  assert.doesNotMatch(uiStyles, /\.msg\.assistant\.streaming[^{}]*::before\s*\{/s);
  assert.doesNotMatch(uiStyles, /\.msg\.assistant\.streaming[^{}]*::after\s*\{/s);
});

test('streaming output uses the faster balanced render pace', () => {
  assert.match(inlineScript, /function scheduleNativeLiveRender\(live\)[\s\S]*?\},60\);/);
  assert.match(inlineScript, /function nativeLiveRenderStep\(live,remaining\)\{\s*if\(live\.source==='snapshot'\)return remaining>1200\?64:remaining>480\?25:remaining>160\?11:remaining>60\?6:2;\s*return remaining>1500\?128:remaining>600\?54:remaining>180\?20:remaining>60\?9:4;/);
});

test('queue send and explicit guide are mutually exclusive', () => {
  const sendStart = inlineScript.indexOf('async function send(){');
  assert.ok(sendStart >= 0, 'missing send source');
  const sendSource = inlineScript.slice(sendStart);
  const steerSource = sourceBetween('async function steerQueuedPrompt', 'async function dispatchNextQueuedPrompt');
  const dispatchSource = sourceBetween('async function dispatchNextQueuedPrompt', 'function closeComposerPopovers');
  assert.match(sendSource, /if\(existingId&&webRunActive\)\{\s*enqueuePrompt\(text,attachments\);\s*return;/);
  assert.doesNotMatch(sendSource, /promptQueueMode|steerQueuedPrompt\(existingId/);
  assert.doesNotMatch(inlineScript, /PROMPT_QUEUE_MODE_KEY|setPromptQueueMode|readPromptQueueMode/);
  assert.match(steerSource, /queueItemId:item\.id/);
  assert.match(steerSource, /applyServerPromptQueue\(threadId,data\.queue\)/);
  assert.match(steerSource, /removeQueuedPromptLocal\(threadId,item,\{persist:false,dismiss:!isAppOwnedQueuedPrompt\(item\)\}\)/);
  assert.doesNotMatch(steerSource, /removeQueuedPromptLocal\(threadId,item,\{persist:true\}\)/);
  assert.ok(steerSource.indexOf('await flushPromptQueueToServer(threadId)') < steerSource.indexOf("fetch('/api/native-sessions/"));
  assert.ok(steerSource.indexOf("fetch('/api/native-sessions/") < steerSource.indexOf('applyServerPromptQueue(threadId,data.queue)'));
  assert.ok(steerSource.indexOf('applyServerPromptQueue(threadId,data.queue)') < steerSource.indexOf('showNativeSteerOptimistically(item)'));
  assert.doesNotMatch(steerSource, /const previousItems=|const stillMissing=/);
  assert.match(dispatchSource, /queueGuidingItems\.has\(item\.id\)\|\|steerSubmitting/);
  assert.match(inlineScript, /Array\.isArray\(data\.items\)&&!promptQueueServerSyncPending\.has\(id\)/);
  assert.match(inlineScript, /while\(promptQueueServerSyncInflight\.has\(id\)\)await promptQueueServerSyncInflight\.get\(id\)/);
});

test('queued prompts preserve the Fast service tier through dispatch and restore', () => {
  const normalizeSource = sourceBetween('function normalizeQueuedPrompt', 'function isAppOwnedQueuedPrompt');
  const queuePayloadSource = sourceBetween('function createQueuedPrompt', 'function applyServerPromptQueue');
  const restoreSource = sourceBetween('async function restoreQueuedPrompt', 'function schedulePromptQueueDispatch');

  assert.match(normalizeSource, /serviceTier/);
  assert.match(normalizeSource, /normalizeComposerServiceTier/);
  assert.match(queuePayloadSource, /serviceTier:composerServiceTier/);
  assert.match(queuePayloadSource, /serviceTier:item\.serviceTier/);
  assert.match(restoreSource, /composerServiceTier/);
  assert.match(restoreSource, /renderComposerFastToggle|reconcileComposerFastSupport/);
});

test('Codex App queue entries keep direct actions but are never dispatched or moved by Web', () => {
  const renderer = sourceBetween('function renderPromptQueue', 'function enqueuePrompt');
  const applyQueue = sourceBetween('function applyPromptQueueLocal', 'function setPromptQueue');
  const remove = sourceBetween('async function deleteQueuedPrompt', 'function moveQueuedPrompt');
  const move = sourceBetween('function moveQueuedPrompt', 'let promptQueueDragState');
  const sideChat = sourceBetween('async function openQueuedPromptInSideChat', 'async function sendSideChatMessage');
  const restoreQueued = sourceBetween('async function restoreQueuedPrompt', 'async function saveAppQueueEdit');
  const restore = sourceBetween('async function restoreQueuedPrompt', 'function schedulePromptQueueDispatch');
  const schedule = sourceBetween('function schedulePromptQueueDispatch', 'function showNativePromptOptimistically');
  const steer = sourceBetween('async function steerQueuedPrompt', 'async function dispatchNextQueuedPrompt');
  const dispatch = sourceBetween('async function dispatchNextQueuedPrompt', 'function closeComposerPopovers');
  const loadConversation = sourceBetween('async function loadConversation', 'function updateConversationStatus');

  assert.match(inlineScript, /function isAppOwnedQueuedPrompt\(item\)\{return item\?\.source==='codex-app'\}/);
  assert.match(renderer, /const appOwned=isAppOwnedQueuedPrompt\(item\)/);
  assert.match(renderer, /if\(!appOwned\)bindPromptQueueDrag\(row,threadId,item\.id\)/);
  assert.match(renderer, /meta\.textContent='Codex App'/);
  assert.match(renderer, /body\.addEventListener\('click',\(\)=>restoreQueuedPrompt\(threadId,item\.id\)\)/);
  assert.match(renderer, /const busy=dispatching\|\|guiding\|\|steerSubmitting\|\|appQueueEditSaving/);
  assert.match(renderer, /row\.appendChild\(guide\);\s*row\.appendChild\(remove\);\s*if\(!appOwned\)\{/);
  assert.doesNotMatch(renderer, /if\(appOwned\)\{\s*promptQueueList\.appendChild\(row\);\s*return;/);
  assert.match(applyQueue, /if\(appQueueEditDraft\?\.threadId===threadId&&!appQueueEditSaving&&!clean\.some\(\(item\)=>item\.id===appQueueEditDraft\.itemId\)\)\{/);
  assert.match(applyQueue, /appQueueEditDraft=null;[\s\S]*?input\.value='';[\s\S]*?clearPendingAttachments\(\);[\s\S]*?该队列消息已在 Codex App 处理/);
  assert.doesNotMatch(remove, /blockAppOwnedQueueAction/);
  assert.match(remove, /if\(!isAppOwnedQueuedPrompt\(victim\)\)rememberQueueDismissed\(threadId,victim\)/);
  assert.match(remove, /if\(firstId===itemId&&!webRunActive&&!isAppOwnedQueuedPrompt\(victim\)\)schedulePromptQueueDispatch\(threadId,100\)/);
  assert.match(move, /if\(blockAppOwnedQueueAction\(items\[fromIndex\]\)\)return false/);
  assert.match(sideChat, /if\(blockAppOwnedQueueAction\(item\)\)return/);
  assert.doesNotMatch(restore, /blockAppOwnedQueueAction/);
  assert.match(restore, /if\(isAppOwnedQueuedPrompt\(item\)\)\{[\s\S]*?appQueueEditDraft=\{threadId,itemId,originalMessage:item\.message\}[\s\S]*?return;/);
  assert.ok(restore.indexOf('if(isAppOwnedQueuedPrompt(item))') < restore.indexOf('consumeQueuedPromptOnServer(threadId,itemId)'));
  assert.ok(restoreQueued.indexOf('await consumeQueuedPromptOnServer(threadId,itemId)') < restoreQueued.indexOf('appQueueEditDraft=null'));
  assert.match(restore, /method:'PATCH'/);
  assert.match(restore, /context.*保留原附件|保留原附件/);
  assert.match(restore, /const stillEditingDraft=appQueueEditDraft===draft/);
  assert.match(restore, /if\(stillEditingDraft&&currentConversationSource==='codex'&&currentConversationId===draft\.threadId\)/);
  assert.match(restore, /if\(appQueueEditDraft===draft&&currentConversationSource==='codex'&&currentConversationId===draft\.threadId\)/);
  assert.match(schedule, /isAppOwnedQueuedPrompt\(promptQueueFor\(threadId\)\[0\]\)/);
  assert.doesNotMatch(steer, /blockAppOwnedQueueAction/);
  assert.match(steer, /if\(isAppOwnedQueuedPrompt\(item\)\)\{statusEl\.textContent='任务运行时才可发送引导';return\}/);
  assert.match(steer, /dismiss:!isAppOwnedQueuedPrompt\(item\)/);
  assert.match(dispatch, /!item\|\|isAppOwnedQueuedPrompt\(item\)\|\|queueDispatchingThreads/);
  assert.match(loadConversation, /if\(conversationChanged&&appQueueEditSaving\)\{statusEl\.textContent='正在保存队列修改，请稍后切换会话';return false\}/);
  assert.match(loadConversation, /if\(conversationChanged&&appQueueEditDraft\)\{appQueueEditDraft=null;input\.value='';input\.style\.height='auto';clearPendingAttachments\(\)\}/);
  assert.match(uiStyles, /\.promptQueueRow\.appOwned\s*\{[^}]*grid-template-columns:\s*22px minmax\(0, 1fr\) auto (?:30|28)px/s);
  assert.doesNotMatch(uiStyles, /\.promptQueueRow\.appOwned \.promptQueueBody:disabled/);
});

test('queue fallback removes only the matching id when messages are identical', () => {
  const dismissalSource = sourceBetween('function promptQueueFor', 'function promptQueueFingerprint');
  const removeSource = sourceBetween('function removeQueuedPromptLocal', 'async function steerQueuedPrompt');
  const api = new Function(
    'initialItems',
    `
      let currentConversationId='thread-1';
      let promptQueues={'thread-1':initialItems};
      let queueDismissedKeys=new Map();
      ${dismissalSource}
      function setPromptQueue(threadId,items){promptQueues[threadId]=items;}
      function applyPromptQueueLocal(threadId,items){promptQueues[threadId]=items;}
      ${removeSource}
      return {
        removeQueuedPromptLocal,
        items:()=>promptQueues['thread-1'],
        dismissed:()=>[...queueDismissKeySet('thread-1')],
      };
    `,
  )([
    { id: 'queue-a', message: 'same prompt', createdAt: '2026-07-26T10:00:00.000Z' },
    { id: 'queue-b', message: 'same prompt', createdAt: '2026-07-26T10:00:01.000Z' },
  ]);

  api.removeQueuedPromptLocal(
    'thread-1',
    { id: 'queue-a', message: 'same prompt', createdAt: '2026-07-26T10:00:00.000Z' },
    { persist: false },
  );

  assert.deepEqual(api.items().map((item) => item.id), ['queue-b']);
  assert.deepEqual(api.dismissed(), ['id:queue-a']);

  api.removeQueuedPromptLocal(
    'thread-1',
    { id: 'queue-b', message: 'same prompt', createdAt: '2026-07-26T10:00:01.000Z' },
    { persist: false, dismiss: false },
  );

  assert.deepEqual(api.items(), []);
  assert.deepEqual(api.dismissed(), ['id:queue-a']);
});

test('pasted attachments render as a scrollable chip row inside the composer', () => {
  assert.match(inlineScript, /dropZone\.insertBefore\(attachmentTray,input\)/);
  assert.equal((inlineScript.match(/addEventListener\('paste',handleAttachmentPaste\)/g) || []).length, 1);
  assert.match(uiStyles, /\.attachmentTray\s*\{[^}]*display:\s*flex;[^}]*grid-row:\s*1;[^}]*grid-column:\s*1 \/ -1;[^}]*width:\s*calc\(100% - 12px\);[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden;[^}]*scroll-snap-type:\s*x proximity/s);
  assert.match(uiStyles, /body \.box:has\(> \.attachmentTray:not\(\.hidden\)\)\s*\{[^}]*grid-template-rows:\s*auto minmax\(50px, auto\) 34px/s);
  assert.match(uiStyles, /body\[data-theme\] \.attachmentChip\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*min\(300px,[^}]*min-height:\s*48px;[^}]*grid-template-columns:\s*40px minmax\(0, auto\) 28px;[^}]*border-radius:\s*14px;[^}]*background:\s*var\(--surface-hover\)/s);
  assert.match(uiStyles, /body \.attachmentChip img,[^}]*width:\s*40px;[^}]*height:\s*40px/s);
  assert.match(uiStyles, /body \.attachmentChip button\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*border-radius:\s*50%;[^}]*background:\s*var\(--text-muted\)/s);
  assert.match(inlineScript, /name\.title=name\.textContent/);
});

test('dynamic queue clearance keeps the latest message above the composer', () => {
  const observerSource = sourceBetween('function enhanceComposerOverlayInset', 'function enhanceComposerKeyboardLift');
  const insetSource = sourceBetween('function updateComposerOverlayInset', 'function scrollChatToLatest');
  const scrollSource = sourceBetween('function scrollChatToLatest', 'async function loadConversation');
  assert.match(observerSource, /updateComposerOverlayInset\(\{scroll:true\}\)/);
  assert.match(observerSource, /composer\?\.addEventListener\('transitionend',\(event\)=>\{if\(event\.propertyName==='bottom'\)schedule\(\)\}\)/);
  assert.match(insetSource, /const pinned=distance<=Math\.max\(72,prev\+48\)/);
  assert.match(insetSource, /options\.scroll&&chat&&pinned/);
  assert.match(scrollSource, /chat\.scrollTop=chat\.scrollHeight/);
  assert.doesNotMatch(scrollSource, /scrollIntoView/);
  assert.match(uiStyles, /body\.keyboardOpen \.chat\s*\{[^}]*--composer-overlay-height/s);
  assert.match(uiStyles, /\.editedFilesResult\.live\.withPlan\) > \.chat\s*\{[^}]*--composer-overlay-height/s);
});

test('mobile hidden live plan card does not reserve extra chat clearance', () => {
  const start = uiStyles.indexOf('/* Float composer over chat with transparent rail');
  const end = uiStyles.indexOf('body .composer {', start);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(uiStyles.slice(start, end), /editedFilesResult\.live\.withPlan/);
  assert.match(uiStyles, /@media \(max-width: 820px\)[\s\S]*body \.composer > \.editedFilesResult\.live\s*\{[^}]*display:\s*none/s);
});

test('live process timeline keeps note then tools order while streaming', () => {
  assert.match(inlineScript, /const alreadyPlaced=turnProcessElements\.includes\(element\)\|\|element.parentNode===turnProcessTimeline/);
  assert.match(inlineScript, /if\(inTimeline&&!beforeTools\)return element/);
  assert.match(inlineScript, /appendTurnProcessTimelineElement\(element,\{beforeTools:false\}\)/);
  assert.match(inlineScript, /const kept=\[\]/);
  assert.match(inlineScript, /contains\('activityCluster'\)\|\|item\?.classList\?.contains\('agentActivityGroup'\)/);
});

test('task_complete keeps progress commentary and steering in chronological order', () => {
  assert.match(inlineScript, /Keep assistant progress commentary in the completion timeline instead of dropping it\./);
  assert.match(inlineScript, /Interleave note -> tools -> note -> tools in chronological artifact order/);
  assert.match(inlineScript, /const flushPendingTools=\(\)=>\{/);
  assert.match(inlineScript, /const kept=\[\]/);
  assert.match(inlineScript, /processElements\.push\(\.\.\.kept, \.\.\.regroupTurnToolArtifacts\(loose\)\)/);
  assert.doesNotMatch(inlineScript, /processElements\.push\(\.\.\.progressElements, \.\.\.regroupTurnToolArtifacts\(toolBucket\)\)/);
  assert.match(inlineScript, /function appendTurnProcessTimelineElement/);
  assert.match(inlineScript, /appendTurnProcessTimelineElement\(element,\{beforeTools:false\}\)/);
  assert.doesNotMatch(inlineScript, /for\(const item of artifacts\)\{if\(isProgressArtifact\(item\)&&item\.parentNode\)item\.remove\(\)\}/);
  assert.match(inlineScript, /const completion=createCompletionMessage\(text,processElements,options\.turnId,elapsedSeconds,options\.tokenUsage\)/);
  assert.match(inlineScript, /if\(collapsible\)el\.open=false/);
  assert.doesNotMatch(inlineScript, /if\(processElements\.some\([\s\S]*?\)\)completion\.open=true/);
  assert.doesNotMatch(inlineScript, /if\(processKeep\.length\)completion\.open=true/);
  const completedSteeringSource=sourceBetween('function completionTimelineForTurn', 'function consumeNativeOptimisticSteering');
  assert.doesNotMatch(completedSteeringSource, /completion\.open=true/);
  const tokenLabelSource = sourceBetween('function turnTokenUsageLabel', 'function liveProcessElapsedTitle');
  const turnTokenUsageLabel = new Function(`${tokenLabelSource}; return turnTokenUsageLabel;`)();
  assert.equal(turnTokenUsageLabel({ totalTokens: 12345 }), '本轮累计 12,345 tokens');
});

test('composerCollapsed defaults to a capsule input', () => {
  assert.match(inlineScript, /function prefersCollapsedComposer\(\)\{/);
  assert.match(inlineScript, /function composerShouldStayExpanded\(\)\{/);
  assert.match(inlineScript, /if\(!prefersCollapsedComposer\(\)\)return true/);
  assert.match(inlineScript, /dropZone\.classList\.toggle\('composerCollapsed',!next\)/);
  assert.match(inlineScript, /setComposerExpanded\(!prefersCollapsedComposer\(\)\|\|composerShouldStayExpanded\(\)\,\{force:true\}\)/);
  assert.match(inlineScript, /composerMicBtn/);
  assert.match(inlineScript, /function composerPopoverOpen\(\)\{/);
  assert.match(inlineScript, /input\.placeholder=queueStarting\?'正在发送队列消息\.\.\.':steerSubmitting\?'正在发送引导\.\.\.':webRunActive&&native\?'跟进':'向 Codex 提问'/);
  assert.doesNotMatch(sourceBetween('function composerShouldStayExpanded', 'function setComposerExpanded'), /threadGoalBar/);
  assert.match(inlineScript, /向 Codex 提问/);
  assert.match(uiStyles, /body \.box\.composerCollapsed/);
  assert.match(uiStyles, /border-radius:\s*999px !important/);
  assert.match(uiStyles, /body \.box\.composerCollapsed\.runActive > \.cancelButton/);
  assert.match(uiStyles, /body \.box\.composerExpanded > \.composerMicBtn/);
});

test('blue capsule reasoning slider matches reference chrome', () => {
  assert.match(uiStyles, /\.composerReasoningRangeWrap[\s\S]*border-radius:\s*999px/);
  assert.match(uiStyles, /\.composerReasoningRange::-webkit-slider-runnable-track[\s\S]*#2f7bff/);
  assert.match(uiStyles, /\.composerReasoningRange::-webkit-slider-thumb[\s\S]*background:\s*#ffffff/);
  assert.match(inlineScript, /mark\.classList\.toggle\('filled'/);
});

test('assistant message kind is treated as turn process progress', () => {
  assert.match(inlineScript, /function isProgressStyleAssistantText\(text\)\{/);
  assert.match(inlineScript, /function isTurnProcessMessage\(role,kind,text=''\)\{/);
  assert.match(inlineScript, /\['commentary','live_progress'\]\.includes\(messageKind\)/);
  assert.match(inlineScript, /isTurnProcessMessage\(role,kind,text\)\)el\.classList\.add\('progressCommentary'\)/);
  assert.match(inlineScript, /Prefer explicit final_answer; otherwise promote the last non-progress-style assistant bubble/);
  assert.match(inlineScript, /const progressAssistant=child\.classList\.contains\('assistant'\)/);
  assert.match(inlineScript, /!options\.hydrating&&turnProcessElapsedTurnId/);
});

test('generation resets reconcile live messages without rebuilding the conversation', () => {
  const syncSource = sourceBetween('async function syncCurrentNativeConversationOnce', 'function nativeTerminalPersisted');
  assert.match(inlineScript, /function nativeResetMessagesForIncrementalSync\(conversation\)/);
  assert.match(inlineScript, /function reconcileNativeResetMessage\(message\)/);
  assert.match(inlineScript, /function refreshNativeResetImage\(message\)/);
  assert.match(syncSource, /let syncMessages=conversation\.messages\|\|\[\]/);
  assert.match(syncSource, /syncMessages=nativeResetMessagesForIncrementalSync\(conversation\)/);
  assert.match(syncSource, /if\(!syncMessages\)\{await loadConversation\(id,'codex'\);return\}/);
  assert.doesNotMatch(syncSource, /if\(conversation\.status==='running'\)[\s\S]*?loadConversation/);
  assert.match(syncSource, /for\(const msg of syncMessages\)/);
  assert.match(inlineScript, /\['','message','commentary','final_answer'\]\.includes\(kind\)/);
  assert.match(inlineScript, /const syncDelay=webRunActive&&currentConversationSource==='codex'\?80:260/);
  assert.match(inlineScript, /dataset\.nativeMessageSeq/);
  const completionSyncSource = sourceBetween('async function reconcileNativeCompletion', 'function syncNativeAfterPageResume');
  assert.match(completionSyncSource, /await syncCurrentNativeConversation\(\)/);
  assert.doesNotMatch(completionSyncSource, /loadConversation/);
});

test('rolled-back retry collapse invalidates the open page before appending the latest attempt', () => {
  assert.match(nativeSessionSource, /case 'thread_rolled_back':[\s\S]*?pendingThreadRollbackTurnId/);
  assert.match(nativeSessionSource, /function collapseRolledBackRetryTurn[\s\S]*?cache\.contentMutated = true/);
  const syncSource = sourceBetween('async function syncCurrentNativeConversationOnce', 'function nativeTerminalPersisted');
  assert.ok(syncSource.indexOf('if(conversation.reset)') < syncSource.indexOf('for(const msg of syncMessages)'));
  assert.match(inlineScript, /const staleVisible=[\s\S]*?!sequences\.has\(sequence\)/);
  assert.match(syncSource, /if\(!syncMessages\)\{await loadConversation\(id,'codex'\);return\}/);
});

test('message action chrome stays hidden until hover or touch selection', () => {
  assert.match(uiStyles, /body \.msg\.assistant\.actionsOpen > \.msgActions/);
  assert.match(uiStyles, /body \.msg\.user\.actionsOpen \.msgActions/);
  assert.match(uiStyles, /Touch devices: hide action chrome until the bubble is tapped/);
  assert.match(uiStyles, /@media \(hover: none\)[\s\S]*body \.msg\.user:hover \.msgActions[\s\S]*opacity:\s*0/);
  assert.doesNotMatch(uiStyles, /body \.msg\.user \.msgActions \{[\s\S]{0,120}opacity:\s*0\.72/);
  assert.match(inlineScript, /function clearMessageActionsOpen/);
  assert.match(inlineScript, /function bindMessageActionToggle/);
  assert.match(inlineScript, /isCoarsePointer\(\)/);
  assert.match(inlineScript, /bindMessageActionToggle\(el\)/);
});

test('composer capsule inherits session wallpaper on mobile and desktop', () => {
  assert.match(uiStyles, /Session wallpaper\/skin must own the capsule fill on mobile too/);
  assert.match(uiStyles, /Session canvas wins over theme-only capsule fills/);
  assert.match(uiStyles, /body\[data-chat-bg="skin"\] \.box\.composerCollapsed/);
  assert.match(uiStyles, /body\[data-chat-bg="custom"\] \.box\.composerCollapsed/);
  assert.match(uiStyles, /body\[data-chat-bg="skin"\] \.composer:has\(> \.composerProjectPicker\.hidden\) > \.box/);
});

test('mobile keyboard opens on first composer tap', () => {
  assert.match(inlineScript, /Focus synchronously inside the user gesture so mobile keyboards open on the first tap/);
  assert.match(inlineScript, /try\{input\.focus\(\{preventScroll:true\}\)\}catch\{input\.focus\(\)\}/);
  assert.match(inlineScript, /event\.target\.closest\('button,a,select,label,\.composerPopover'\)/);
  assert.doesNotMatch(inlineScript, /event\.target\.closest\('button,a,input,select,textarea,label,\.composerPopover'\)/);
  assert.match(uiStyles, /Keep caret visible so the first mobile tap can open the keyboard immediately/);
});

test('keyboard lift keeps composer above the soft keyboard', () => {
  assert.match(inlineScript, /function keepComposerAboveKeyboard/);
  assert.match(inlineScript, /function composerKeyboardInset/);
  assert.match(inlineScript, /function enhanceComposerKeyboardLift/);
  assert.match(inlineScript, /visualViewport/);
  assert.match(inlineScript, /--keyboard-inset/);
  assert.match(inlineScript, /__composerOverlayInsetKeyboardRaf=requestAnimationFrame\(\(\)=>updateComposerOverlayInset\(\{scroll:true\}\)\)/);
  assert.match(inlineScript, /__composerOverlayInsetSettleTimer=window\.setTimeout\(\(\)=>updateComposerOverlayInset\(\{scroll:true\}\),160\)/);
  assert.match(uiStyles, /bottom: var\(--keyboard-inset/);
  assert.match(uiStyles, /body\.keyboardOpen \.composer/);
  assert.match(serverSource, /interactive-widget=resizes-content/);
});

test('model toggle stays chromeless without a pill background', () => {
  assert.match(uiStyles, /Model\/effort control stays chromeless/);
  assert.match(uiStyles, /composerModelToggle:hover,[\s\S]*background: transparent/);
  assert.doesNotMatch(uiStyles, /composerModelToggle:hover,\s*\.composerModelToggle\[aria-expanded="true"\] \{\s*background: var\(--surface-active\)/);
});

test('internal Chinese handoff summaries stay hidden without hiding normal status reports', () => {
  const helperSource = sourceBetween('function isHandoffSummaryText', 'function isProgressStyleAssistantText');
  const isHandoffSummaryText = new Function(helperSource + '; return isHandoffSummaryText;')();
  assert.equal(isHandoffSummaryText([
    '## 当前状态',
    '',
    '最新需求：目标状态条保留目标正文。',
    '当前源码仍是上一轮的极简版本。',
    '上一轮已完成并需保留：真实页面验证。',
    '',
    '## 下一步',
    '1. 补齐内部交接过滤。',
    '',
    '工作树有大量用户已有修改和备份文件，禁止清理或回滚。相关位置主要是 server.mjs。',
  ].join('\n')), true);
  assert.equal(isHandoffSummaryText([
    '## 当前状态',
    '',
    '最新需求：目标状态条已经修复，服务健康。',
    '',
    '## 下一步',
    '',
    '工作树有大量用户已有修改，因此没有清理或回滚；等待用户验收。',
  ].join('\n')), false);
});


test('thread goal status bar exposes native edit, pause, resume, and clear controls', () => {
  const normalizeGoalSource = sourceBetween('function normalizeThreadGoalClient', 'function sameThreadGoalClient');
  const normalizeThreadGoalClient = new Function(
    `${normalizeGoalSource}; return normalizeThreadGoalClient;`,
  )();
  assert.match(rawInlineScript, /replace\(\/\[\\\\s_-\]\+\/g,''\)/);
  assert.equal(normalizeThreadGoalClient({ objective: 'Keep the goal visible', status: 'paused' })?.status, 'paused');
  assert.equal(normalizeThreadGoalClient({ objective: 'Keep the goal visible', status: 'usage_limited' })?.status, 'usage_limited');
  assert.match(serverSource, /function ensureThreadGoalBar\(/);
  assert.match(serverSource, /function renderThreadGoalBar\(/);
  assert.match(serverSource, /setThreadGoal\(conversation\.goal/);
  assert.match(serverSource, /threadGoalBar=document\.createElement\('section'\)/);
  assert.match(serverSource, /composerGoalIndicator=document\.createElement\('span'\)/);
  assert.match(serverSource, /composerGoalIcon\.setAttribute\('data-lucide','target'\)/);
  assert.match(serverSource, /function renderComposerGoalIndicator\(\)/);
  assert.match(serverSource, /setThreadGoal\(goal\)[\s\S]*renderComposerGoalIndicator\(\)/);
  assert.doesNotMatch(serverSource, /threadGoalBar=document\.createElement\('button'\)/);
  assert.match(serverSource, /threadGoalBar\.className='threadGoalBar hidden'/);
  assert.match(serverSource, /目标进行中/);
  assert.match(serverSource, /目标受阻/);
  assert.match(serverSource, /summary\.className='threadGoalSummary'/);
  assert.match(serverSource, /threadGoalActionButton\('pencil','编辑目标'/);
  assert.match(serverSource, /threadGoalActionButton\(toggling\?'pause':'play'/);
  assert.match(serverSource, /threadGoalActionButton\('trash-2','清除目标'/);
  assert.match(serverSource, /updateCurrentThreadGoal\(\s*\{objective,status:'active'\},\s*goal\.status==='active'\?'目标已更新':'目标已更新并恢复'/s);
  assert.match(serverSource, /threadGoalBar\.append\(lead,body,time,actions,mobile\)/);
  assert.match(serverSource, /\/api\/native-sessions\/'\+encodeURIComponent\(threadId\)\+'\/goal'/);
  assert.match(serverSource, /appServerClient\.request\('thread\/goal\/set'/);
  assert.match(serverSource, /appServerClient\.request\('thread\/goal\/clear'/);
  assert.match(serverSource, /webRunActive&&native\?'跟进':'向 Codex 提问'/);
  assert.match(uiStyles, /\.threadGoalBar\s*\{/);
  assert.match(uiStyles, /body \.composer > \.threadGoalBar/);
  assert.match(uiStyles, /\.threadGoalBar\s*\{[^}]*display:\s*grid;[^}]*min-height:\s*42px;[^}]*margin:\s*0 auto 14px;[^}]*border-radius:\s*999px/s);
  assert.match(uiStyles, /\.threadGoalSummary\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.match(uiStyles, /\.composerGoalIndicator\s*\{[^}]*grid-column:\s*3;[^}]*border-left:\s*1px solid[^}]*pointer-events:\s*none/s);
  assert.match(uiStyles, /\.composerGoalIndicator \.lucide\s*\{[^}]*width:\s*18px;[^}]*height:\s*18px/s);
  assert.match(uiStyles, /body \.threadGoalAction,[\s\S]*?body \.threadGoalAction:focus\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s);
  assert.match(uiStyles, /body \.threadGoalAction:hover\s*\{\s*color:\s*var\(--text\);/s);
});

test('mobile run controls combine goal, plan, and agent pills with tap details', () => {
  const mobileGoalStyles = uiStyles.slice(uiStyles.lastIndexOf('@media (max-width: 820px)'));
  assert.match(inlineScript, /function toggleThreadRunMobilePanel\(panel\)/);
  assert.match(inlineScript, /function createThreadRunGoalDetail\(goal\)/);
  assert.match(inlineScript, /function createThreadRunPlanDetail\(progress\)/);
  assert.match(inlineScript, /function createThreadRunMobile\(goal\)/);
  assert.match(inlineScript, /threadRunMobileScrollLeft=viewport\.scrollLeft/);
  assert.match(inlineScript, /viewport\.scrollLeft=threadRunMobileScrollLeft/);
  assert.match(inlineScript, /mobileThreadGoalStatusLabel\(goal\.status\)/);
  assert.match(inlineScript, /progress\.current\+'\/'\+progress\.total/);
  assert.match(inlineScript, /agentCount\+' 个智能体'/);
  assert.match(inlineScript, /threadGoalActionButton\('pencil','编辑目标',editCurrentThreadGoal,'threadRunGoalAction'\)/);
  assert.match(inlineScript, /threadGoalActionButton\(active\?'pause':'play',active\?'暂停目标':'恢复目标'/);
  assert.match(inlineScript, /threadGoalActionButton\('trash-2','清除目标',[\s\S]*?'threadRunGoalAction isDanger'\)/);
  assert.match(mobileGoalStyles, /\.threadRunPillsViewport\s*\{[^}]*overflow-x:\s*auto;[^}]*scrollbar-width:\s*none/s);
  assert.match(mobileGoalStyles, /\.threadRunPills\s*\{[^}]*display:\s*flex;[^}]*width:\s*max-content;[^}]*gap:\s*8px/s);
  assert.match(mobileGoalStyles, /\.threadRunPills\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s);
  assert.match(mobileGoalStyles, /body \.threadRunPill,[\s\S]*?body \.threadRunPill:focus\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s);
  assert.match(mobileGoalStyles, /body \.threadRunPill\.isSelected,[\s\S]*?background:\s*var\(--text\);[^}]*color:\s*var\(--canvas\)/s);
  assert.match(mobileGoalStyles, /\.threadRunDetail\s*\{[^}]*width:\s*min\(680px, calc\(100% - 20px\)\);[^}]*border-radius:\s*20px/s);
  assert.match(mobileGoalStyles, /\.threadRunGoalActions\s*\{[^}]*justify-content:\s*flex-end/s);
  assert.match(mobileGoalStyles, /\.threadRunPlanStep\s*\{[^}]*grid-template-columns:\s*22px 25px minmax\(0, 1fr\)/s);
  assert.match(mobileGoalStyles, /body \.composer > \.editedFilesResult\.live\s*\{\s*display:\s*none;/s);
  assert.match(serverSource, /ui\.css\?v=goal-indicator-20260729e/);
});

test('completed thread goals render a subtle hint after the final reply', () => {
  const helperSource = sourceBetween('function formatThreadGoalCompletionElapsed', 'function currentThreadGoalElapsedSeconds');
  const chat = { querySelectorAll: () => [] };
  const helperApi = new Function(
    'chat',
    'webRunActive',
    `${helperSource}; return { formatCompletionElapsed: formatThreadGoalCompletionElapsed, completionTarget: threadGoalCompletionTarget };`,
  )(chat, false);
  const formatCompletionElapsed = helperApi.formatCompletionElapsed;
  assert.equal(formatCompletionElapsed(7291), '2h 1m 31s');
  assert.equal(formatCompletionElapsed(65), '1m 5s');
  const completedAt = Date.parse('2026-07-29T04:29:46.000Z');
  const before = { parentNode: chat, dataset: { messageAt: '2026-07-29T04:20:00.000Z' } };
  const expected = { parentNode: chat, dataset: { messageAt: '2026-07-29T04:30:10.475Z' } };
  const later = { parentNode: chat, dataset: { messageAt: '2026-07-29T04:46:54.064Z' } };
  chat.querySelectorAll = () => [before, expected, later];
  assert.equal(helperApi.completionTarget({ updatedAtMs: completedAt }), expected);
  assert.match(inlineScript, /function renderThreadGoalCompletionHint\(/);
  assert.match(inlineScript, /querySelectorAll\('\.threadGoalCompletionHint'\)[\s\S]*?hint\.remove\(\)/);
  assert.match(inlineScript, /goal\?\.status!=='complete'/);
  assert.match(inlineScript, /function threadGoalCompletionTarget\(/);
  assert.match(inlineScript, /item\.at>=completedAt&&item\.at-completedAt<=maxDelayMs/);
  assert.match(inlineScript, /icon\.setAttribute\('data-lucide','circle-check'\)/);
  assert.match(inlineScript, /label\.textContent='已在 '\+formatThreadGoalCompletionElapsed\(goal\.timeUsedSeconds\)\+' 内达成目标'/);
  assert.match(inlineScript, /body\.appendChild\(hint\)/);
  assert.match(inlineScript, /else refreshThreadGoalElapsed\(\);\s*renderThreadGoalCompletionHint\(\)/);
  assert.match(uiStyles, /\.threadGoalCompletionHint\s*\{[^}]*display:\s*inline-flex;[^}]*color:\s*var\(--text-subtle\);[^}]*font-size:\s*11\.5px/s);
  assert.doesNotMatch(uiStyles, /\.threadGoalCompletionHint\s*\{[^}]*background:/s);
});
