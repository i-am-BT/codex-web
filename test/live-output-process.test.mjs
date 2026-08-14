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

test('live input context, user questions, and browser comments stay before a live panel while steering keeps its send position', () => {
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

test('hydrated history preserves the stored turn order around a process panel', () => {
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
  const priorReply = { kind: 'prior-reply' };
  chat.children.push(priorReply, livePanel);
  const appendConversationElement = new Function(
    'chat',
    'turnProcessHeader',
    `${appendSource}; return appendConversationElement;`,
  )(chat, livePanel);
  const historicalUser = { kind: 'historical-user' };
  const historicalReply = { kind: 'historical-reply' };
  const historicalContext = { kind: 'historical-context' };

  appendConversationElement(historicalUser, 'user', { hydrating: true });
  appendConversationElement(historicalReply, 'assistant', { hydrating: true });
  appendConversationElement(historicalContext, 'context', { hydrating: true });

  assert.deepEqual(chat.children, [priorReply, livePanel, historicalUser, historicalReply, historicalContext]);
});

test('a hydrated native input stays before an empty active process panel', () => {
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
  const livePanel = { kind: 'live-panel', parentNode: chat, querySelectorAll: () => [] };
  chat.children.push(livePanel);
  const appendConversationElement = new Function(
    'chat',
    'turnProcessHeader',
    `${appendSource}; return appendConversationElement;`,
  )(chat, livePanel);
  const activeInput = { kind: 'active-input', dataset: { nativeMessageSeq: '12' } };

  appendConversationElement(activeInput, 'user', { hydrating: true, turnId: 'active-turn' });

  assert.deepEqual(chat.children, [activeInput, livePanel]);
});

test('only the active native turn may insert new input ahead of its live panel', () => {
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
  const delayedHistory = { kind: 'delayed-history' };
  const activeInput = { kind: 'active-input' };

  appendConversationElement(delayedHistory, 'user', { turnId: 'older-turn', activeTurn: false });
  appendConversationElement(activeInput, 'user', { turnId: 'active-turn', activeTurn: true });

  assert.deepEqual(chat.children, [activeInput, livePanel, delayedHistory]);
});

test('steering stays chronological and input image helpers avoid duplicate uploads', () => {
  assert.match(inlineScript, /function normalizeInputImageSrc\(source\)/);
  assert.match(inlineScript, /function inputImageIdentity\(source\)/);
  assert.match(inlineScript, /function isOptimisticUploadImageSrc\(source\)/);
  assert.match(inlineScript, /function isServerSessionImageSrc\(source\)/);
  assert.match(inlineScript, /function cleanSteeringMessageDuplicates\(element\)/);
  assert.match(inlineScript, /const hydrating=Boolean\(options\.hydrating\);/);
  assert.match(inlineScript, /const hasNativeTurnId=Boolean\(options\.turnId\);/);
  assert.match(inlineScript, /const hydrationInputBeforeLive=hydrating&&hasNativeTurnId&&\['user','context'\]\.includes\(role\)&&turnProcessHeader\?\.parentNode===chat/);
  assert.match(inlineScript, /const beforeLiveProcess=hydrationInputBeforeLive\|\|\(!hydrating&&\(!hasNativeTurnId\|\|Boolean\(options\.activeTurn\)\)&&\(role==='context'\|\|\(role==='user'&&!steering\)\)\)/);
  assert.match(inlineScript, /const midTurnUser=role==='user'&&\['steering_user','steering_browser_comment'\]\.includes\(kind\)/);
  assert.match(inlineScript, /const steeringUser=role==='user'&&kind==='steering_user'/);
  assert.match(inlineScript, /appendConversationElement\(el,role,\{steering:steeringUser,hydrating:Boolean\(options\.hydrating\),turnId:options\.turnId,activeTurn:activeTurnMessage\}\)/);
  assert.match(inlineScript, /if\(steeringUser\|\|browserCommentUser\)cleanSteeringMessageDuplicates\(el\)/);
  assert.match(inlineScript, /function reconcileNativeSteeringElement\(element,options=\{\}\)/);
  assert.match(inlineScript, /Number\.isInteger\(options\.nativeMessageSeq\)\)element\.dataset\.nativeMessageSeq/);
  assert.match(inlineScript, /consumeNativeOptimisticSteering\(text,options\)\|\|findExistingNativeSteering\(text,options\)/);
  assert.match(inlineScript, /Historical steers should remain visible as input bubbles/);
  assert.match(inlineScript, /if\(!completedSteeringTimeline\)activateTurnProcessElement\(el\)/);
  assert.doesNotMatch(inlineScript, /pinSteeringMessageToBottom|pinOpenSteeringMessages|ensureSteeringPinObserver/);
  assert.match(inlineScript, /Rebind either direction instead of creating a second copy/);
  assert.match(inlineScript, /const singleImageInput=userElement\.classList\.contains\('steeringUser'\);/);
  assert.doesNotMatch(inlineScript, /const singleImageInput=userElement\.classList\.contains\('steeringUser'\)[\s\S]{0,100}browserCommentSteering/);
  assert.match(inlineScript, /if\(singleImageInput&&stack\.children\.length>=1\)/);
  assert.match(inlineScript, /function cleanSteeringMessageDuplicates\(element\)\{[\s\S]*?const singleImageInput=element\.classList\.contains\('steeringUser'\);[\s\S]*?if\(stack&&singleImageInput\)/s);
  assert.match(inlineScript, /Keep historical user\/steer bubbles in the main chat stream/);
  assert.doesNotMatch(inlineScript, /if\(browserCommentUser\)[\s\S]{0,120}classList\.add\('steeringUser'\)/);
});

test('browser comment attachment cards cannot collapse inside the chat scroll column', () => {
  assert.match(uiStyles, /body \.msg\.user\.browserCommentSteering\s*,\s*body \.msg\.user\.hasInputImage\.browserCommentSteering\s*\{[^}]*display:\s*flex;[^}]*flex:\s*0 0 auto/s);
  assert.match(uiStyles, /body \.chat > \.msg\.user\.browserCommentSteering,[\s\S]*?body \.chat > \.msg\.user\.hasInputImage\.browserCommentSteering\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*min\(280px, 88%\)/s);
  assert.match(uiStyles, /\.browserCommentSteering \.userAttachmentStack\s*\{[^}]*width:\s*min\(220px, 100%\);[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(uiStyles, /\.browserCommentSteering \.userAttachmentStack\.single\s*\{[^}]*width:\s*100px;[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  const railRuleIndex = uiStyles.indexOf('body .chat > :is(.msg.user, .msg.image.inputImage)');
  const browserOverrideIndex = uiStyles.indexOf('body .chat > .msg.user.browserCommentSteering');
  assert.ok(railRuleIndex >= 0 && browserOverrideIndex > railRuleIndex);
  assert.match(uiStyles, /body \.chat > \.msg\.user\.browserCommentSteering > \.msgBody\.browserCommentSource,[^}]*width:\s*fit-content;[^}]*border-radius:\s*16px;[^}]*padding:\s*8px 12px;[^}]*white-space:\s*normal/s);
  assert.match(uiStyles, /body \.chat > \.msg\.user\.browserCommentSteering > \.msgBody\.browserCommentSource > p\s*\{[^}]*margin:\s*0/s);
});

test('browser design annotations use hover on desktop and toggle on touch devices', () => {
  const annotationSource = sourceBetween('function browserAnnotationChangeMarkdown', 'function renderBrowserAnnotationCard');
  const { browserAnnotationChangeMarkdown } = new Function(`${annotationSource}; return { browserAnnotationChangeMarkdown };`)();
  assert.equal(browserAnnotationChangeMarkdown('界面批注\n- margin-top: 0px → 20px'), '- margin-top: 0px → 20px');
  assert.equal(browserAnnotationChangeMarkdown('界面批注'), '');
  assert.equal(browserAnnotationChangeMarkdown('普通浏览器评论\n- margin-top: 0px → 20px'), '');
  assert.match(inlineScript, /function queueBrowserAnnotationPointerUpdate\(x,y\)\{[\s\S]*?requestAnimationFrame\(\(\)=>\{[\s\S]*?browserAnnotationCardAtPointer\(point\.x,point\.y\)/s);
  assert.match(inlineScript, /function clearBrowserAnnotationPointerCard\(\)\{[\s\S]*?cancelAnimationFrame\(browserAnnotationPointerFrame\);[\s\S]*?setBrowserAnnotationPointerCard\(null\);/s);
  assert.match(inlineScript, /function ensureBrowserAnnotationPointerTracking\(\)\{[\s\S]*?queueBrowserAnnotationPointerUpdate\(event\.clientX,event\.clientY\);[\s\S]*?window\.addEventListener\('pointermove',updateFromPointer,true\);[\s\S]*?window\.addEventListener\('mousemove',updateFromPointer,true\);/s);
  assert.match(inlineScript, /function renderBrowserAnnotationCard\(body,changes\)\{[\s\S]*?card\.className='browserAnnotationCard';[\s\S]*?summary\.className='browserAnnotationTrigger';[\s\S]*?label\.textContent='注释';[\s\S]*?detail\.className='browserAnnotationDetails'/s);
  assert.match(inlineScript, /function renderBrowserCommentMessageBody\(body,text\)\{[\s\S]*?const annotation=browserAnnotationChangeMarkdown\(source\);[\s\S]*?body\.classList\.remove\('browserAnnotationSource','markdownBody'\);[\s\S]*?if\(annotation\)\{[\s\S]*?renderBrowserAnnotationCard\(body,annotation\);[\s\S]*?refreshIcons\(body\);[\s\S]*?renderMessageMarkdown\(body,source\)/s);
  assert.match(inlineScript, /if\(browserCommentUser\)renderBrowserCommentMessageBody\(body,text\)/);
  assert.match(inlineScript, /message\.role==='user'&&existing\.classList\.contains\('browserCommentSteering'\)\)renderBrowserCommentMessageBody\(existing\._messageBody,text\)/);
  assert.match(uiStyles, /\.browserAnnotationDetails\s*\{[^}]*display:\s*block;[^}]*position:\s*absolute;[^}]*opacity:\s*0;[^}]*visibility:\s*hidden;[^}]*pointer-events:\s*none/s);
  assert.match(uiStyles, /\.browserAnnotationDetails\s*\{[^}]*bottom:\s*100%/s);
  assert.match(uiStyles, /@media \(hover: hover\) and \(pointer: fine\)\s*\{[\s\S]*?\.browserAnnotationCard:hover > \.browserAnnotationDetails,[\s\S]*?\.browserAnnotationCard\.browserAnnotationPointerOver > \.browserAnnotationDetails,[\s\S]*?\.browserAnnotationTrigger:focus-visible \+ \.browserAnnotationDetails\s*\{[^}]*opacity:\s*1;[^}]*visibility:\s*visible/s);
  const touchMediaIndex = uiStyles.indexOf('@media (hover: none), (pointer: coarse)');
  const touchOpenIndex = uiStyles.indexOf('.browserAnnotationCard[open] > .browserAnnotationDetails');
  assert.ok(touchMediaIndex >= 0 && touchOpenIndex > touchMediaIndex);
  assert.match(uiStyles, /@media \(hover: none\), \(pointer: coarse\)\s*\{[\s\S]*?\.browserAnnotationTrigger\s*\{[^}]*min-height:\s*40px[\s\S]*?\.browserAnnotationCard\[open\] > \.browserAnnotationDetails\s*\{[^}]*pointer-events:\s*auto/s);
  assert.match(uiStyles, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.browserAnnotationDetails\s*\{[^}]*transition:\s*none/s);
});

test('response annotations render as hover details and touch toggles', () => {
  const annotationSource = sourceBetween('function responseAnnotationItemsFromText', 'function browserAnnotationChangeMarkdown');
  const { responseAnnotationItemsFromText, normalizeResponseAnnotationItems } = new Function(
    `${annotationSource}; return { responseAnnotationItemsFromText, normalizeResponseAnnotationItems };`,
  )();
  const replacementSource = sourceBetween('function responseAnnotationReplacementFragment', 'function removeEmptyResponseAnnotationWrappers');
  const fakeDocument = {
    createDocumentFragment() {
      return {
        childNodes: [],
        appendChild(node) {
          this.childNodes.push(node);
          return node;
        },
      };
    },
    createTextNode(value) {
      return { nodeType: 3, textContent: value };
    },
  };
  const responseAnnotationReplacementFragment = new Function(
    'document',
    'createResponseAnnotationCard',
    `${replacementSource}; return responseAnnotationReplacementFragment;`,
  )(
    fakeDocument,
    (index, item) => ({ nodeType: 1, className: 'responseAnnotationCard', index, item }),
  );
  const source = [
    '普通上下文',
    '<response-annotations>',
    '[{"text":"已同步当前会话","annotation":"这里指的是开始和暂停状态"}]',
    '</response-annotations>',
  ].join('\n');
  assert.deepEqual(responseAnnotationItemsFromText(source), [
    { text: '已同步当前会话', annotation: '这里指的是开始和暂停状态' },
  ]);
  assert.deepEqual(responseAnnotationItemsFromText('<response-annotations>{bad}</response-annotations>'), []);
  assert.deepEqual(responseAnnotationItemsFromText('<response-annotations>{}</response-annotations>'), []);
  assert.deepEqual(normalizeResponseAnnotationItems([{ text: '  已同步  ', annotation: '  已暂停  ' }]), [
    { text: '已同步', annotation: '已暂停' },
  ]);
  const missing = responseAnnotationReplacementFragment(':codex-annotation{index="1"} 还没有完成重启。', []);
  assert.equal(missing.replaced, false);
  assert.deepEqual(missing.fragment.childNodes.map((node) => node.textContent), [' 还没有完成重启。']);
  assert.doesNotMatch(missing.fragment.childNodes.map((node) => node.textContent).join(''), /codex-annotation/);
  const outOfRange = responseAnnotationReplacementFragment('前文 :codex-annotation{index=2} 后文', [
    { text: '已同步当前会话', annotation: '这里指的是开始和暂停状态' },
  ]);
  assert.equal(outOfRange.replaced, false);
  assert.deepEqual(outOfRange.fragment.childNodes.map((node) => node.textContent), ['前文 ', ' 后文']);
  const valid = responseAnnotationReplacementFragment('已修复。:codex-annotation{index="1"} 后续说明', [
    { text: '已同步当前会话', annotation: '这里指的是开始和暂停状态' },
  ]);
  assert.equal(valid.replaced, true);
  assert.equal(valid.fragment.childNodes[1].className, 'responseAnnotationCard');
  assert.equal(valid.fragment.childNodes[1].index, 1);
  assert.equal(valid.fragment.childNodes[2].textContent, ' 后续说明');
  assert.match(inlineScript, /let responseAnnotationsByTurn\s*=\s*new Map\(\)/);
  assert.match(inlineScript, /function rememberResponseAnnotationItems\(turnId,items\)\{[\s\S]*?responseAnnotationsByTurn\.set\(key,normalized\);[\s\S]*?message\.dataset\.turnId!==key[\s\S]*?renderAssistantMarkdown\(message\._messageBody,message\.dataset\.messageText\|\|''\)/s);
  assert.match(inlineScript, /function rememberResponseAnnotations\(turnId,text\)\{\s*return rememberResponseAnnotationItems\(turnId,responseAnnotationItemsFromText\(text\)\);/s);
  assert.match(inlineScript, /function createResponseAnnotationCard\(index,item\)\{[\s\S]*?card\.className='responseAnnotationCard';[\s\S]*?trigger\.className='responseAnnotationTrigger';[\s\S]*?trigger\.textContent='注释 '\+index;[\s\S]*?appendField\('所选文本',item\?\.text\);[\s\S]*?appendField\('用户评论',item\?\.annotation\)/s);
  assert.match(inlineScript, /function enhanceResponseAnnotationDirectives\(body,annotations\)\{\s*if\(!body\)return;\s*const items=Array\.isArray\(annotations\)\?annotations:\[\];/s);
  assert.match(inlineScript, /function enhanceResponseAnnotationDirectives\(body,annotations\)\{[\s\S]*?querySelectorAll\('code'\)[\s\S]*?responseAnnotationReplacementFragment\(source,items\)[\s\S]*?createTreeWalker\(body,NodeFilter\.SHOW_TEXT\)[\s\S]*?responseAnnotationReplacementFragment\(node\.nodeValue,items\)/s);
  assert.match(inlineScript, /function removeEmptyResponseAnnotationWrappers\(node,body\)\{[\s\S]*?current\.remove\(\)/s);
  assert.doesNotMatch(inlineScript, /function enhanceResponseAnnotationDirectives\(body,annotations\)\{\s*if\(!body\|\|!Array\.isArray\(annotations\)\|\|!annotations\.length\)return/);
  assert.match(inlineScript, /function renderAssistantMarkdown\(body,text,turnId=''\)\{[\s\S]*?const messageTurnId=String\(turnId\|\|body\?\.closest\?\.\('\.msg'\)\?\.dataset\?\.turnId\|\|''\);[\s\S]*?enhanceResponseAnnotationDirectives\(body,responseAnnotationsForTurn\(messageTurnId\)\);/s);
  assert.match(inlineScript, /function addMsg\(role,text,options=\{\}\)\{[\s\S]*?if\(role==='user'\)rememberResponseAnnotations\(options\.turnId,text\);[\s\S]*?if\(options\.responseAnnotations\)rememberResponseAnnotationItems\(options\.turnId,options\.responseAnnotations\);/s);
  assert.match(inlineScript, /function reconcileNativeResetMessage\(message\)\{[\s\S]*?if\(message\.role==='user'\)rememberResponseAnnotations\(message\.turnId,text\);[\s\S]*?if\(message\.responseAnnotations\)rememberResponseAnnotationItems\(message\.turnId,message\.responseAnnotations\);/s);
  assert.equal((inlineScript.match(/responseAnnotations:msg\.responseAnnotations/g) || []).length, 2);
  assert.match(inlineScript, /responseAnnotations:message\.responseAnnotations/);
  assert.match(inlineScript, /function adoptRuntimeLiveForSnapshotMessage\(message\)\{[\s\S]*?rememberResponseAnnotationItems\(pausedTurnId,message\.responseAnnotations\)/s);
  assert.match(inlineScript, /addMsg\('assistant','',\{streaming:true,kind:'live_progress',turnId:runtimeTurnId,autoScroll:false\}\)/);
  assert.match(inlineScript, /function newChat\(\)[\s\S]*?responseAnnotationsByTurn=new Map\(\)/);
  assert.match(inlineScript, /function loadConversation\(id,source='web',options=\{\}\)\{[\s\S]*?clearNativeLiveItems\(\);\s*responseAnnotationsByTurn=new Map\(\);/s);
  assert.match(inlineScript, /document\.querySelectorAll\('\.browserAnnotationCard,\.responseAnnotationCard'\)/);
  assert.match(uiStyles, /\.responseAnnotationDetails\s*\{[^}]*position:\s*absolute;[^}]*bottom:\s*calc\(100% \+ 8px\);[^}]*max-width:\s*min\(340px, calc\(100vw - 28px\)\);[^}]*opacity:\s*0;[^}]*visibility:\s*hidden/s);
  assert.match(uiStyles, /@media \(hover: hover\) and \(pointer: fine\)\s*\{[\s\S]*?\.responseAnnotationCard:hover > \.responseAnnotationDetails,[\s\S]*?\.responseAnnotationCard\.browserAnnotationPointerOver > \.responseAnnotationDetails,[\s\S]*?\.responseAnnotationTrigger:focus-visible \+ \.responseAnnotationDetails\s*\{[^}]*opacity:\s*1;[^}]*visibility:\s*visible/s);
  assert.match(uiStyles, /@media \(hover: none\), \(pointer: coarse\)\s*\{[\s\S]*?\.responseAnnotationCard\.open > \.responseAnnotationDetails\s*\{[^}]*pointer-events:\s*auto/s);
  assert.match(uiStyles, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.responseAnnotationDetails\s*\{[^}]*transition:\s*none/s);
});

test('runtime text deltas leave sidebar rebuilding to the coalesced session snapshot', () => {
  const runtimeHistoryHelperSource = inlineScript.match(/function nativeRuntimeNeedsHistoryRefresh\(type\)\{[^}]*\}/)?.[0];
  assert.ok(runtimeHistoryHelperSource, 'missing native runtime history refresh helper');
  const runtimeHandlerSource = sourceBetween('function connectSessionEvents', 'function nativeMessageElementBySequence');
  const { nativeRuntimeNeedsHistoryRefresh } = new Function(`${runtimeHistoryHelperSource}; return { nativeRuntimeNeedsHistoryRefresh };`)();

  assert.equal(nativeRuntimeNeedsHistoryRefresh('delta'), false);
  assert.equal(nativeRuntimeNeedsHistoryRefresh('item-started'), false);
  assert.equal(nativeRuntimeNeedsHistoryRefresh('item-completed'), false);
  assert.equal(nativeRuntimeNeedsHistoryRefresh('turn'), true);
  assert.equal(nativeRuntimeNeedsHistoryRefresh('turn-cleared'), true);
  assert.equal(nativeRuntimeNeedsHistoryRefresh('connection-error'), true);
  assert.match(runtimeHandlerSource, /\/\/ Text deltas[\s\S]*?if\(nativeRuntimeNeedsHistoryRefresh\(runtime\.type\)\)scheduleHistoryRefreshFromSession\(\);/);
  assert.doesNotMatch(runtimeHandlerSource, /try\{runtime=JSON\.parse\(event\.data\|\|'\{\}'\)\}catch\(e\)\{\}\s*refreshHistory\(\);/);
});

test('native connection retries and terminal upstream errors render inside the conversation', () => {
  const textSource = sourceBetween('function nativeConnectionStatusText', 'function clearNativeConnectionStatus');
  const { nativeConnectionStatusText } = new Function(
    `${textSource}; return { nativeConnectionStatusText };`,
  )();
  const errorTitleSource = sourceBetween('function terminalErrorMessageTitle', 'let longUserMessageSerial');
  const terminalErrorMessageTitle = new Function(`${errorTitleSource}; return terminalErrorMessageTitle;`)();
  const messageElementSource = sourceBetween('function createConversationMessageElement', 'function addMsg');
  const runtimeHandlerSource = sourceBetween('function connectSessionEvents', 'function nativeMessageElementBySequence');

  assert.equal(
    nativeConnectionStatusText({ willRetry: true, message: 'Reconnecting... 5/5' }),
    '正在重新连接 5/5',
  );
  assert.equal(
    nativeConnectionStatusText({
      willRetry: false,
      message: 'unexpected status 405, url: http://127.0.0.1:8090/v1/responses',
    }),
    'unexpected status 405, url: http://127.0.0.1:8090/v1/responses',
  );
  assert.match(inlineScript, /let nativeConnectionStatusElement = null;/);
  assert.match(runtimeHandlerSource, /runtime\.type==='connection-error'[\s\S]*?upsertNativeConnectionStatus\(runtime\)/);
  assert.match(inlineScript, /if\(terminalProcess\)clearNativeConnectionStatus\(options\.turnId\)/);
  assert.equal(terminalErrorMessageTitle("You've hit your usage limit. Try again later."), '额度已达上限');
  assert.equal(terminalErrorMessageTitle('last status: 429 Too Many Requests'), '请求过于频繁');
  assert.equal(terminalErrorMessageTitle('401 Unauthorized'), '认证失败');
  assert.equal(terminalErrorMessageTitle('request timed out'), '请求超时');
  assert.equal(terminalErrorMessageTitle('provider unavailable'), '任务失败');
  assert.match(messageElementSource, /const terminalError=role==='process'&&\['task_error','error'\]\.includes\(kind\)/);
  assert.match(messageElementSource, /terminalError\?' terminalError':''/);
  assert.match(messageElementSource, /icon\.className='terminalErrorIcon'/);
  assert.match(messageElementSource, /title\.textContent=terminalErrorMessageTitle\(text\)/);
  assert.match(messageElementSource, /if\(\['process','log'\]\.includes\(role\)&&!terminalError\)/);
  assert.match(uiStyles, /\.msg\.process\.nativeConnectionStatus[\s\S]*?white-space:\s*pre-wrap/s);
  assert.match(uiStyles, /\.msg\.process\.terminalError\s*\{[^}]*grid-template-columns:\s*30px minmax\(0, 1fr\) 30px;[^}]*border-left:\s*3px solid var\(--danger\);[^}]*border-radius:\s*7px/s);
  assert.match(uiStyles, /\.terminalErrorIcon\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*background:\s*var\(--danger-soft\)/s);
  assert.match(uiStyles, /\.terminalErrorTitle\s*\{[^}]*color:\s*var\(--danger\);[^}]*font-size:\s*11px/s);
  assert.match(uiStyles, /\.msg\.process\.terminalError > \.msgActions\s*\{[^}]*min-height:\s*28px;[^}]*margin:\s*-1px 0 0/s);
  assert.match(uiStyles, /@media \(min-width:\s*821px\)\s*\{\s*\.terminalErrorContent\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*baseline;[^}]*gap:\s*8px;[^}]*\}\s*\.terminalErrorTitle\s*\{[^}]*white-space:\s*nowrap/s);
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
  // A stop request must leave the live state intact until Codex App reports its
  // terminal event; clearing it optimistically used to make a still-running task
  // look complete and allowed its queued follow-up to dispatch too early.
  const cancelSource = sourceBetween('async function cancelRun', 'async function send');
  assert.match(cancelSource, /statusEl\.textContent='Codex App · 正在停止…'/);
  assert.match(cancelSource, /已请求停止当前任务，等待 Codex App 确认。/);
  assert.doesNotMatch(cancelSource, /clearLiveTurnProgress\(\)/);
  assert.match(inlineScript, /if\(\['error','interrupted'\]\.includes\(runtime\.status\)\)clearLiveTurnProgress\(\)/);
});

test('a later turn keeps the previous terminal error visible', () => {
  const beginSource = sourceBetween('function beginTurnProcessCollection', 'function collapseCurrentActivityCluster');
  const api = new Function(`
    const classList = (...names) => {
      const values = new Set(names);
      return {
        contains: (name) => values.has(name),
        remove: (...items) => items.forEach((item) => values.delete(item)),
      };
    };
    const chat = {
      children: [],
      querySelectorAll() { return []; },
      appendChild(element) {
        const current = this.children.indexOf(element);
        if (current >= 0) this.children.splice(current, 1);
        this.children.push(element);
        element.parentNode = this;
      },
      insertBefore(element, reference) {
        const current = this.children.indexOf(element);
        if (current >= 0) this.children.splice(current, 1);
        const index = this.children.indexOf(reference);
        if (index < 0) throw new Error('missing reference');
        this.children.splice(index, 0, element);
        element.parentNode = this;
      },
    };
    const timeline = {};
    const terminal = {
      isConnected: true,
      parentNode: timeline,
      dataset: { messageKind: 'task_error' },
      classList: classList('process'),
      remove() { this.parentNode = null; },
    };
    const header = { parentNode: chat, classList: classList('liveProcessPanel') };
    chat.children.push(header);
    let completionText = '';
    let turnProcessHeader = header;
    let turnProcessCollectionTurnId = 'turn-429';
    let turnProcessElapsedTurnId = '';
    let collectingTurnProcess = true;
    let turnProcessElements = [terminal];
    let latestFinalAssistantElement = null;
    let currentActivityCluster = null;
    let currentAgentActivityGroup = null;
    let pendingAgentActivityBatches = [];
    let pendingActivityReasoning = [];
    function isTurnProcessMessage() { return false; }
    function createCompletionMessage(text) {
      completionText = text;
      return { dataset: {}, classList: classList('completionSummary'), parentNode: null };
    }
    function clearTurnProcessHeader() {
      const index = chat.children.indexOf(turnProcessHeader);
      if (index >= 0) chat.children.splice(index, 1);
      turnProcessHeader = null;
    }
    function startTurnProcessElapsed() {}
    function renderThreadGoalBar() {}
    ${beginSource}
    return {
      run: () => beginTurnProcessCollection('', false, 'turn-next'),
      state: () => ({ chat, terminal, completionText, turnProcessCollectionTurnId }),
    };
  `)();

  api.run();

  assert.equal(api.state().completionText, '任务失败');
  assert.strictEqual(api.state().chat.children[1], api.state().terminal);
  assert.strictEqual(api.state().terminal.parentNode, api.state().chat);
  assert.equal(api.state().turnProcessCollectionTurnId, 'turn-next');
});

test('completion summaries label failed and interrupted turns honestly', () => {
  const titleSource = sourceBetween('function completionMessageTitle', 'function turnTokenUsageLabel');
  const completionMessageTitle = new Function(
    'processedMessageTitle',
    `${titleSource}; return completionMessageTitle;`,
  )(() => '已处理');

  assert.equal(completionMessageTitle('任务失败'), '任务失败');
  assert.equal(completionMessageTitle('任务已暂停'), '已暂停');
  assert.equal(completionMessageTitle('任务中断'), '已暂停');
  assert.equal(completionMessageTitle('任务完成'), '已处理');
});

test('a stop request freezes visible streaming without unlocking the running turn', () => {
  const pauseSource = sourceBetween('function pauseNativeLivePresentationForCancel', 'let turnProcessElapsedFrozen');
  const immediate = [];
  const finalized = [];
  const makeLive = (turnId, { text = 'visible', targetText = 'visible tail', complete = false } = {}) => {
    const classes = new Set(['streaming']);
    return {
      turnId,
      text,
      targetText,
      complete,
      renderTimer: 7,
      element: {
        _messageBody: { textContent: '' },
        classList: {
          add: (...names) => names.forEach((name) => classes.add(name)),
          remove: (...names) => names.forEach((name) => classes.delete(name)),
          contains: (name) => classes.has(name),
        },
      },
    };
  };
  const api = new Function(
    'renderNativeLiveItemImmediately',
    'renderNativeLiveItemMarkdown',
    `
      let currentConversationId = 'thread-a';
      let activeNativeTurnId = 'turn-a';
      const nativeLiveItems = new Map([
        ['matching', ${JSON.stringify({})}],
      ]);
      ${pauseSource}
      return {
        items: nativeLiveItems,
        pause: pauseNativeLivePresentationForCancel,
        resume: resumeNativeLivePresentationForCancel,
      };
    `,
  )(
    (live) => {
      live.renderTimer = null;
      live.text = live.targetText;
      immediate.push(live.turnId);
    },
    (live) => finalized.push(live.text),
  );
  const matching = makeLive('turn-a');
  const other = makeLive('turn-b');
  api.items.clear();
  api.items.set('matching', matching);
  api.items.set('other', other);

  api.pause('thread-a', 'turn-a');
  assert.equal(matching.text, matching.targetText, 'the already-received tail catches up once before freezing');
  assert.equal(matching.cancelVisualPaused, true);
  assert.equal(matching.element.classList.contains('streaming'), false);
  assert.equal(other.cancelVisualPaused, undefined);
  assert.deepEqual(immediate, ['turn-a']);
  assert.deepEqual(finalized, ['visible tail'], 'the frozen text must receive its final Markdown render');

  matching.targetText = 'visible tail received while the stop request was pending';
  api.resume('thread-a', 'turn-a');
  assert.equal(matching.cancelVisualPaused, false);
  assert.equal(matching.text, matching.targetText, 'a failed interrupt catches up from the authoritative reload path');
  assert.equal(matching.element.classList.contains('streaming'), true);

  const cancelSource = sourceBetween('async function cancelRun', 'async function send');
  const deltaSource = sourceBetween('function updateNativeLiveDelta', 'function scheduleNativeLiveRender');
  const snapshotSource = sourceBetween('function adoptRuntimeLiveForSnapshotMessage', 'function nativeRuntimeLiveKey');
  const scheduleSource = sourceBetween('function scheduleNativeLiveRender', 'function nativeLiveRenderStep');
  assert.match(cancelSource, /nativeCancelPending=\{threadId,turnId\};\s*pauseNativeLivePresentationForCancel\(threadId,turnId\);[\s\S]*?fetch\('/);
  assert.match(cancelSource, /clearNativeCancelPending\(threadId,turnId\);\s*resumeNativeLivePresentationForCancel\(threadId,turnId\);/);
  assert.match(cancelSource, /void loadConversation\(threadId,'codex'\)/);
  assert.doesNotMatch(cancelSource, /freezeTurnProcessElapsed\(|clearLiveTurnProgress\(|webRunActive=false|activeNativeTurnId=''/);
  assert.match(deltaSource, /const cancelPending=nativeCancelPendingMatches\(currentConversationId,runtimeTurnId\);/);
  assert.match(deltaSource, /if\(!live&&cancelPending\)return;/);
  assert.match(deltaSource, /const nextDelta=nativeRuntimeDeltaText\(live,delta\);\s*if\(!nextDelta\)return;\s*live\.targetText\+=nextDelta;/);
  assert.match(pauseSource, /renderNativeLiveItemImmediately\(live\);\s*renderNativeLiveItemMarkdown\(live\);/);
  assert.match(scheduleSource, /if\(live\?\.cancelVisualPaused\)return;/);
  assert.match(snapshotSource, /if\(live\.cancelVisualPaused&&nativeCancelPendingMatches\(currentConversationId,pausedTurnId\)\)\{/);
  assert.match(snapshotSource, /if\(cancelPending\)\{[\s\S]*?return null;/);
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
  assert.match(uiStyles, /@media \(max-width:\s*820px\)[\s\S]*?\.promptQueue,[\s\S]*?max-height:\s*calc\(3 \* 40px \+ 10px\);[^}]*overflow:\s*hidden;[\s\S]*?\.promptQueueList\s*\{[^}]*max-height:\s*calc\(3 \* 40px\);[^}]*overflow:\s*hidden auto;[^}]*scrollbar-width:\s*none;[^}]*overscroll-behavior:\s*contain/s);
  assert.match(uiStyles, /\.promptQueueList::-webkit-scrollbar\s*\{[^}]*display:\s*none/s);

  assert.match(ruleBody('.promptQueueHead'), /display:\s*none(?:;|$)/);
  assert.match(
    uiStyles,
    /\.promptQueueRow\s*\{[^}]*grid-template-columns:\s*22px minmax\(0, 1fr\) 30px auto 30px 30px;[^}]*gap:\s*4px/s,
  );
  assert.match(
    uiStyles,
    /@media \(max-width:\s*820px\)[\s\S]*?\.promptQueueRow\s*\{[^}]*grid-template-columns:\s*22px minmax\(0, 1fr\) auto 28px 28px;[^}]*gap:\s*2px/s,
  );
  assert.match(
    uiStyles,
    /@media \(max-width:\s*820px\)[\s\S]*?\.promptQueueEditButton\s*\{[^}]*display:\s*none/s,
  );
  assert.doesNotMatch(uiStyles, /\.promptQueueRow\.appOwned\s*\{[^}]*grid-template-columns:/s);

  const queueStart = inlineScript.indexOf('function renderPromptQueue(){');
  const queueEnd = inlineScript.indexOf('function enqueuePrompt', queueStart);
  assert.ok(queueStart >= 0 && queueEnd > queueStart, 'missing prompt queue renderer source');
  const queueRenderer = inlineScript.slice(queueStart, queueEnd);
  const queueMenu = sourceBetween('function openPromptQueueMenu', 'function ensureSideChatTabs');
  assert.match(queueRenderer, /const showInWeb=Boolean\(threadId&&items\.length\)/);
  assert.match(queueRenderer, /classList\.toggle\('hidden',!showInWeb\)/);
  assert.match(queueRenderer, /if\(!showInWeb\)/);
  assert.match(queueRenderer, /queueActionButton\('pencil','编辑队列消息'/);
  assert.match(queueRenderer, /edit\.classList\.add\('promptQueueEditButton'\)/);
  assert.match(queueRenderer, /queueActionButton\('ellipsis','队列操作'/);
  assert.match(queueMenu, /menu\.appendChild\(promptQueueMenuItem\('编辑消息',\(\)=>restoreQueuedPrompt\(threadId,item\.id\)\)\)/);
  assert.ok(
    queueMenu.indexOf("menu.appendChild(promptQueueMenuItem('编辑消息'") < queueMenu.indexOf('if(!isAppOwnedQueuedPrompt(item))'),
    'mobile menu editing must also be available for Codex App queue rows',
  );
  assert.match(queueRenderer, /bindPromptQueueDrag\(row,threadId,item\.id\)/);
  assert.match(inlineScript, /state\.scrollContainer=promptQueueList\|\|null/);
  assert.match(queueRenderer, /body\.title='长按拖动调整顺序；使用编辑按钮修改消息'/);
  assert.doesNotMatch(queueRenderer, /body\.addEventListener\('click',\(\)=>restoreQueuedPrompt\(threadId,item\.id\)\)/);
  assert.match(queueRenderer, /body\.disabled=busy/);
  assert.match(queueRenderer, /edit\.disabled=busy/);
  assert.match(queueRenderer, /queueFailures\.has\(item\.id\)\|\|item\.dispatchState==='uncertain'/);
  assert.match(queueRenderer, /const retryable=\(queueFailures\.has\(item\.id\)\|\|item\.dispatchState==='uncertain'\)&&!appOwned/);
  assert.match(queueRenderer, /guide\.disabled=busy\|\|\(!webRunActive&&!retryable\)/);
  assert.match(queueRenderer, /remove\.disabled=busy/);
  assert.match(queueRenderer, /more\.disabled=busy/);
  assert.deepEqual(
    [...queueRenderer.matchAll(/row\.appendChild\((edit|guide|remove|more)\)/g)].map((match) => match[1]),
    ['edit', 'guide', 'remove', 'more'],
  );
});

test('mobile queue handoff uses an idempotent one-item beacon before backgrounding', async () => {
  const beaconStart = inlineScript.indexOf('const promptQueueBeaconItemIds=new Map();');
  const beaconEnd = inlineScript.indexOf('function schedulePromptQueueServerSync', beaconStart);
  const enqueueStart = inlineScript.indexOf('function enqueuePrompt(');
  const enqueueEnd = inlineScript.indexOf('async function deleteQueuedPrompt', enqueueStart);
  const backgroundStart = inlineScript.indexOf('function flushPromptQueuesBeforeBackground(');
  const backgroundEnd = inlineScript.indexOf('function connectSessionEvents', backgroundStart);
  assert.ok(beaconStart >= 0 && beaconEnd > beaconStart, 'missing background queue beacon helper');
  assert.ok(enqueueStart >= 0 && enqueueEnd > enqueueStart, 'missing queue enqueue helper');
  assert.ok(backgroundStart >= 0 && backgroundEnd > backgroundStart, 'missing background queue flush helper');

  const sent = [];
  class BeaconBlob {
    constructor(parts, options) {
      this.text = parts.join('');
      this.size = this.text.length;
      this.type = options?.type || '';
    }
  }
  const beaconApi = new Function(
    'navigator',
    'Blob',
    'isAppOwnedQueuedPrompt',
    `${inlineScript.slice(beaconStart, beaconEnd)}; return { appendPromptQueueItemViaBeacon, missingUnconfirmedWebPromptQueueItemIds, mergePromptQueueSyncConflict };`,
  )(
    { sendBeacon: (url, payload) => { sent.push({ url, payload }); return true; } },
    BeaconBlob,
    (item) => item?.source === 'codex-app',
  );

  assert.equal(beaconApi.appendPromptQueueItemViaBeacon('thread-a', { id: 'web-1', source: 'web', message: 'queued' }, { trackPending: true }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/prompt-queues/thread-a/append-beacon');
  assert.equal(sent[0].payload.type, 'application/json');
  assert.deepEqual(JSON.parse(sent[0].payload.text), { item: { id: 'web-1', source: 'web', message: 'queued' } });
  assert.deepEqual(
    beaconApi.mergePromptQueueSyncConflict(
      'thread-a',
      [{ id: 'web-1' }],
      [{ id: 'other-client' }, { id: 'web-1' }],
    ).map((item) => item.id),
    ['other-client', 'web-1'],
    'a beacon that reaches the server first cannot let a stale full sync reorder the queue',
  );
  assert.deepEqual(
    beaconApi.mergePromptQueueSyncConflict(
      'thread-a',
      [{ id: 'already-consumed' }, { id: 'still-undelivered' }],
      [{ id: 'other-client' }],
      ['already-consumed'],
    ).map((item) => item.id),
    ['still-undelivered', 'other-client'],
    'a server tombstone removes only the beacon item already consumed by the worker',
  );
  assert.deepEqual(
    beaconApi.missingUnconfirmedWebPromptQueueItemIds(
      [
        { id: 'local-only', source: 'web' },
        { id: 'server-known', source: 'web' },
        { id: 'dismissed', source: 'web' },
        { id: 'app-owned', source: 'codex-app' },
      ],
      new Set(['server-known']),
      ['dismissed'],
    ),
    ['local-only'],
    'a reloaded mobile page keeps a durable Web outbox even after its in-memory beacon tracking is gone',
  );
  assert.deepEqual(
    beaconApi.mergePromptQueueSyncConflict(
      'thread-a',
      [
        { id: 'stale-app', source: 'codex-app' },
        { id: 'offline-web', source: 'web' },
      ],
      [],
    ).map((item) => item.id),
    ['offline-web'],
    'an App-owned mirror absent from the server must not survive in mobile local storage',
  );
  const serverUncertain = beaconApi.mergePromptQueueSyncConflict(
    'thread-status',
    [{ id: 'uncertain-item', source: 'web', autoDispatch: true }],
    [{ id: 'uncertain-item', source: 'web', autoDispatch: false, dispatchState: 'uncertain', dispatchError: 'request outcome unknown' }],
  );
  assert.deepEqual(serverUncertain, [{
    id: 'uncertain-item', source: 'web', autoDispatch: false, dispatchState: 'uncertain', dispatchError: 'request outcome unknown',
  }], 'the server-owned uncertain state replaces a stale optimistic browser copy');
  assert.equal(beaconApi.appendPromptQueueItemViaBeacon('thread-a', { id: 'app-1', source: 'codex-app' }), false);
  assert.equal(beaconApi.appendPromptQueueItemViaBeacon('thread-a', { id: 'large', source: 'web', message: 'x'.repeat(70 * 1024) }), false);
  assert.equal(sent.length, 1, 'App-owned and oversized entries stay on the normal sync path');

  const unavailableBeaconApi = new Function(
    'navigator',
    'Blob',
    'isAppOwnedQueuedPrompt',
    `${inlineScript.slice(beaconStart, beaconEnd)}; return { appendPromptQueueItemViaBeacon, promptQueueBeaconItemIds };`,
  )(
    {},
    BeaconBlob,
    (item) => item?.source === 'codex-app',
  );
  assert.equal(unavailableBeaconApi.appendPromptQueueItemViaBeacon('thread-b', { id: 'fallback-1', source: 'web', message: 'queued' }, { trackPending: true }), false);
  assert.equal(unavailableBeaconApi.promptQueueBeaconItemIds.get('thread-b')?.has('fallback-1'), true, 'unsupported beacon transport still enters the background fetch fallback');

  const enqueueSource = inlineScript.slice(enqueueStart, enqueueEnd);
  const backgroundSource = inlineScript.slice(backgroundStart, backgroundEnd);
  assert.ok(
    enqueueSource.indexOf('appendPromptQueueItemViaBeacon(threadId,item,{trackPending:true})') < enqueueSource.indexOf('void flushPromptQueueToServer(threadId)'),
    'a queued mobile message must enter the background-safe transport before the normal fetch reconciliation',
  );
  assert.match(backgroundSource, /event\?\.type!=='pagehide'&&document\.visibilityState==='visible'/);
  assert.match(backgroundSource, /const beaconBudget=\{remaining:PROMPT_QUEUE_BEACON_MAX_BYTES\};\s*for\(const threadId of Object\.keys\(promptQueues\)\)/);
  assert.match(backgroundSource, /pending\?\.has\(String\(item\?\.id\|\|''\)\)/);
  assert.match(backgroundSource, /appendPromptQueueItemViaBeacon\(threadId,item,\{budget:beaconBudget\}\)/);
  assert.match(backgroundSource, /if\(needsFetchFallback\)void flushPromptQueueToServer\(threadId\)/);
  assert.match(inlineScript, /mergePromptQueueSyncConflict\(id,local,remote,dismissedItemIds\)/);
  assert.match(inlineScript, /const missingLocalWebItemIds=missingUnconfirmedWebPromptQueueItemIds\(localItems,remoteIds,dismissedItemIds\)/);
  assert.match(inlineScript, /mergePromptQueueSyncConflict\(id,localItems,items,dismissedItemIds,\{preferRemoteOrder:missingLocalWebItemIds\.length>0\}\)/);
  assert.match(inlineScript, /if\(hasMissingPending\|\|missingLocalWebItemIds\.length\)schedulePromptQueueServerSync\(id\)/);
  assert.match(inlineScript, /acknowledgePromptQueueBeaconItemIds\(id,dismissedItemIds\)/);
  assert.match(inlineScript, /sessionEvents\.addEventListener\('open',async\(\)=>\{[\s\S]*?pullPromptQueueFromServer\(currentConversationId,\{render:true,preferServer:true\}\)/s);

  const fingerprintStart = inlineScript.indexOf('function promptQueueFingerprint(items){');
  const fingerprintEnd = inlineScript.indexOf('function applyPromptQueueLocal', fingerprintStart);
  assert.ok(fingerprintStart >= 0 && fingerprintEnd > fingerprintStart, 'missing queue state fingerprint');
  const fingerprintApi = new Function(`${inlineScript.slice(fingerprintStart, fingerprintEnd)}; return { promptQueueFingerprint };`)();
  assert.notEqual(
    fingerprintApi.promptQueueFingerprint([{ id: 'uncertain-item', source: 'web', autoDispatch: true, dispatchState: '', dispatchError: '' }]),
    fingerprintApi.promptQueueFingerprint([{ id: 'uncertain-item', source: 'web', autoDispatch: false, dispatchState: 'uncertain', dispatchError: 'request outcome unknown' }]),
    'a server state change must not be discarded as an unchanged queue row',
  );

  const scheduleStart = inlineScript.indexOf('function schedulePromptQueueDispatch(');
  const scheduleEnd = inlineScript.indexOf('function showNativePromptOptimistically', scheduleStart);
  const dispatchStart = inlineScript.indexOf('async function dispatchNextQueuedPrompt(');
  const dispatchEnd = inlineScript.indexOf('function closeComposerPopovers', dispatchStart);
  assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart, 'missing queue auto-dispatch gate');
  assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart, 'missing queue dispatch implementation');
  assert.match(inlineScript.slice(scheduleStart, scheduleEnd), /item\.autoDispatch===false\|\|item\.dispatchState==='uncertain'/);
  assert.match(inlineScript.slice(dispatchStart, dispatchEnd), /if\(\(item\.autoDispatch===false\|\|item\.dispatchState==='uncertain'\)&&!force\)return false/);

  const pullStart = inlineScript.indexOf('async function pullPromptQueueFromServer(');
  const pullEnd = inlineScript.indexOf('async function hydratePromptQueuesFromServer', pullStart);
  assert.ok(pullStart >= 0 && pullEnd > pullStart, 'missing queue recovery pull');
  const recoveredLocal = [{ id: 'survived-page-discard', source: 'web', message: 'must be sent after reload' }];
  const applied = [];
  const rescheduled = [];
  const recoveredRevisions = new Map();
  const recoveryApi = new Function(
    'fetch',
    'promptQueueServerRevisions',
    'normalizeQueuedPrompt',
    'promptQueueBeaconItemIds',
    'promptQueueFor',
    'missingUnconfirmedWebPromptQueueItemIds',
    'mergePromptQueueSyncConflict',
    'acknowledgePromptQueueBeaconItems',
    'acknowledgePromptQueueBeaconItemIds',
    'applyPromptQueueLocal',
    'schedulePromptQueueServerSync',
    'promptQueueRemoteSyncing',
    `${inlineScript.slice(pullStart, pullEnd)}; return { pullPromptQueueFromServer };`,
  )(
    async () => ({ ok: true, json: async () => ({ revision: 17, items: [], dismissedItemIds: [] }) }),
    recoveredRevisions,
    (item) => item,
    new Map(),
    () => recoveredLocal,
    beaconApi.missingUnconfirmedWebPromptQueueItemIds,
    (_threadId, local, remote, _dismissed, options) => options?.preferRemoteOrder ? [...remote, ...local] : [...local, ...remote],
    () => {},
    () => {},
    (threadId, items) => applied.push({ threadId, items }),
    (threadId) => rescheduled.push(threadId),
    false,
  );
  await recoveryApi.pullPromptQueueFromServer('thread-reload');
  assert.deepEqual(applied, [{ threadId: 'thread-reload', items: recoveredLocal }]);
  assert.deepEqual(rescheduled, ['thread-reload'], 'an item that survived a mobile page discard is PUT again without waiting for foreground dispatch');
  assert.equal(recoveredRevisions.get('thread-reload'), 17);
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
  const fakeDocument = { visibilityState: 'visible' };
  const api = new Function(
    'setTimeout',
    'clearTimeout',
    'addMsg',
    'renderAssistantMarkdown',
    'scrollChatToLatest',
    'chat',
    'document',
    `
      let nativeGeneration = 4;
      let nativeCompletionSync = null;
      let nativeLiveItems = new Map();
      let nativeRuntimeStreamTurnIds = new Set();
      let nativeRenderedMessageKeys = new Set();
      let nativeLiveScrollTimer = null;
      let nativeLiveFollowBottom = true;
      let nativeLiveReadingHistory = false;
      let nativeLiveTowardLatestUntil = 0;
      let nativeLiveScrollTrackingBound = false;
      let currentConversationId = 'thread-active';
      let activeNativeTurnId = 'turn-active';
      function nativeCancelPendingMatches() { return false; }
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
  )(fakeSetTimeout, fakeClearTimeout, addMsg, renderAssistantMarkdown, () => {}, chat, fakeDocument);

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
  assert.equal(rendered.length, 0, 'typewriter ticks should not repeatedly parse the whole Markdown body');
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
  assert.equal(rendered.length, 1, 'completed output should receive one authoritative Markdown render');
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

  fakeDocument.visibilityState = 'hidden';
  const hiddenSnapshot = api.upsert({ ...message, seq: 10, content: '后台期间已完成的输出应立即完整显示。' }, conversation);
  assert.equal(timers.size, 0, 'hidden output must not queue a typewriter timer');
  assert.equal(hiddenSnapshot.text, hiddenSnapshot.targetText);
  assert.equal(hiddenSnapshot.element.dataset.messageText, hiddenSnapshot.targetText);
  assert.equal(hiddenSnapshot.element.classList.contains('streaming'), false);
  fakeDocument.visibilityState = 'visible';
  const foregroundSnapshot = api.upsert({ ...message, seq: 11, content: '回到前台后的新输出仍可保持逐字效果。' }, conversation);
  assert.equal(foregroundSnapshot.text, '');
  assert.equal(timers.size, 1, 'a new foreground snapshot should keep the typewriter');
  api.clear();

  assert.match(inlineScript, /loadConversation[\s\S]*hydrating:true/);
  assert.match(inlineScript, /nativeRuntimeStreamTurnIds\.has\(String\(msg\.turnId\|\|''\)\)/);
  assert.doesNotMatch(inlineScript, /nativeLiveItems\.size&&\['assistant','thinking'\]/);
  assert.match(liveSource, /kind:'live_progress',turnId:runtimeTurnId,autoScroll:false/);
  assert.doesNotMatch(liveSource, /scrollChatToLatest\(/);
  assert.match(liveSource, /function nativeLiveDocumentHidden\(\)/);
  assert.match(liveSource, /if\(!nativeLiveTypewriterEnabled\(\)\)\{\s*renderNativeLiveItemImmediately\(live\);/);
  assert.match(liveSource, /function renderNativeLiveItem\(live\)\{[\s\S]*?_messageBody\.textContent=live\.text/);
  assert.match(liveSource, /function renderNativeLiveItemMarkdown\(live\)\{[\s\S]*?renderAssistantMarkdown\(body,live\.text\);/);
  assert.match(liveSource, /function settleNativeLiveItem\(live\)\{\s*renderNativeLiveItemMarkdown\(live\);/);
  assert.match(inlineScript, /function handleNativeVisibilityChange\(\)[\s\S]*?nativeSnapshotResumeCatchup=true;[\s\S]*?flushNativeLiveItemsToTarget\(\);/);
  assert.match(inlineScript, /if\(nearBottom&&syncMessages\.length\)scheduleNativeLiveScroll\(\)/);
});

test('running native output offers a non-disruptive jump-to-latest control', () => {
  const followSource = sourceBetween('function nativeLiveNearBottom', 'function clearNativeLiveScroll');
  const classes = new Set(['hidden']);
  const scrollCalls = [];
  let scrollListener = null;
  const mainClasses = new Set();
  let chatScrollTop = 0;
  const main = { classList: { contains: (name) => mainClasses.has(name) } };
  const chat = {
    scrollHeight: 1200,
    clientHeight: 400,
    classList: { contains: () => false },
    get scrollTop() { return chatScrollTop; },
    set scrollTop(value) { chatScrollTop = value; },
    closest: () => main,
    addEventListener(type, listener) { if (type === 'scroll') scrollListener = listener; },
    scrollTo(options) {
      scrollCalls.push(options);
      chatScrollTop = options.top;
      scrollListener?.();
    },
  };
  const jumpToLatest = { classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } };
  const api = new Function(
    'chat',
    'jumpToLatest',
    'document',
    'window',
    `
      let activeMainView = 'chat';
      let currentConversationSource = 'codex';
      let webRunActive = true;
      let nativeLiveFollowBottom = false;
      let nativeLiveItems = new Map();
      let nativeLiveScrollTimer = null;
      let nativeLiveScrollTrackingBound = false;
      let nativeLiveReadingHistory = false;
      let nativeLiveTowardLatestUntil = 0;
      ${followSource}
      return {
        bind: bindNativeLiveScrollTracking,
        update: updateJumpToLatestButton,
        scroll: scrollToLatestOutput,
        setReading(value) { setNativeLiveReadingHistory(value); },
        setRunning(value) { webRunActive = value; },
        setView(value) { activeMainView = value; },
        state: () => ({ follow: nativeLiveFollowBottom, reading: nativeLiveReadingHistory }),
      };
    `,
  )(chat, jumpToLatest, { querySelector: () => main }, { matchMedia: () => ({ matches: false }) });

  api.update();
  assert.equal(classes.has('hidden'), false, 'away-from-bottom running output should expose the control');

  api.bind();
  api.scroll();
  assert.deepEqual(scrollCalls, [{ top: 1200, behavior: 'smooth' }]);
  assert.equal(api.state().follow, true, 'the normal scroll listener should restore live following at the bottom');
  assert.equal(classes.has('hidden'), true, 'the control hides once the latest output is reached');

  chatScrollTop = 0;
  scrollListener();
  assert.equal(classes.has('hidden'), false, 'manual upward scrolling should show the control again without forcing a scroll');
  api.setReading(true);
  chatScrollTop = 800;
  scrollListener();
  assert.deepEqual(api.state(), { follow: false, reading: true }, 'a programmatic bottom position must not take ownership while history is being read');
  api.scroll();
  assert.deepEqual(api.state(), { follow: true, reading: false }, 'the explicit jump action resumes bottom following');
  api.setRunning(false);
  api.update();
  assert.equal(classes.has('hidden'), true, 'completed turns never retain the control');
  api.setRunning(true);
  api.setView('archive');
  api.update();
  assert.equal(classes.has('hidden'), true, 'non-chat views never retain the control');
});

test('runtime stream and snapshot message adopt into one assistant bubble', () => {
  const liveSource = sourceBetween('function isNativeSnapshotStreamingMessage', 'async function copyText');
  const runningStatusSource = sourceBetween('function nativeRunningStatusTimestamp', 'function updateConversationStatus');
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
      let nativeLiveReadingHistory = false;
      let nativeLiveTowardLatestUntil = 0;
      let nativeLiveScrollTrackingBound = false;
      let currentConversationId = 'thread-active';
      let activeNativeTurnId = 'turn-active';
      function nativeCancelPendingMatches() { return false; }
      let latestAssistantElement = null;
      let latestFinalAssistantElement = null;
      let collectingTurnProcess = false;
      let turnProcessElapsedTurnId = '';
      let turnProcessStartedAt = 0;
      let turnProcessElapsedLabel = null;
      const statusEl = { textContent: '', classList: { add() {}, remove() {} } };
      ${runningStatusSource}
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

test('late runtime delta adopts an already rendered snapshot bubble', () => {
  const liveSource = sourceBetween('function isNativeSnapshotStreamingMessage', 'async function copyText');
  const runningStatusSource = sourceBetween('function nativeRunningStatusTimestamp', 'function updateConversationStatus');
  const addCalls = [];
  const createElement = () => {
    const classes = new Set(['msg', 'assistant', 'streaming']);
    return {
      dataset: { messageKind: 'commentary' },
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
      let nativeLiveReadingHistory = false;
      let nativeLiveTowardLatestUntil = 0;
      let nativeLiveScrollTrackingBound = false;
      let currentConversationId = 'thread-active';
      let activeNativeTurnId = 'turn-active';
      function nativeCancelPendingMatches() { return false; }
      let latestAssistantElement = null;
      let latestFinalAssistantElement = null;
      let collectingTurnProcess = false;
      let turnProcessElapsedTurnId = '';
      let turnProcessStartedAt = 0;
      let turnProcessElapsedLabel = null;
      const statusEl = { textContent: '', classList: { add() {}, remove() {} } };
      ${runningStatusSource}
      function beginTurnProcessCollection() {}
      function ensureTurnProcessElapsedRunning() {}
      function turnProcessElapsedMatches() { return true; }
      function activateTurnProcessElement() {}
      function removeNativeRunningElement() {}
      ${liveSource}
      return {
        updateDelta: updateNativeLiveDelta,
        finishItem: finishNativeLiveItem,
        upsert: upsertNativeSnapshotLiveMessage,
        state: () => ({ nativeLiveItems, nativeRuntimeStreamTurnIds, nativeRenderedMessageKeys }),
      };
    `,
  )(() => 1, () => {}, addMsg, (body, text) => { body.textContent = text; }, () => {}, chat);

  const content = '我会按目前这张 RTX 2060 Super 8GB 来筛选，并核对近期模型的官方显存要求与量化方案。';
  const message = {
    seq: 44,
    role: 'assistant',
    kind: 'commentary',
    turnId: 'turn-active',
    content,
    at: '2026-08-14T07:04:04.513Z',
  };
  api.upsert(message, { status: 'running', activeTurnId: 'turn-active', generation: 4 }, { renderImmediately: true });
  assert.equal(addCalls.length, 1, 'snapshot renders the first and only bubble');
  assert.equal(api.state().nativeLiveItems.size, 0, 'settled snapshots leave only their DOM bubble');

  api.updateDelta({ itemId: 'item-late', turnId: 'turn-active', delta: content, updatedAt: message.at });
  assert.equal(addCalls.length, 1, 'late runtime replay must reuse the snapshot DOM bubble');
  assert.equal(api.state().nativeLiveItems.size, 1);
  const [live] = api.state().nativeLiveItems.values();
  assert.equal(live.source, 'runtime');
  assert.equal(live.element, addCalls[0].element);
  assert.equal(live.targetText, content, 'runtime replay must not append the authoritative snapshot text');

  api.finishItem('item-late', 'turn-active');
  assert.equal(live.targetText, content, 'an incomplete replay probe must not duplicate snapshot text on completion');
});

test('runtime stream suppresses a replayed long message without dropping normal repeated text', () => {
  const deltaTextSource = sourceBetween('function nativeRuntimeDeltaText', 'function updateNativeLiveDelta');
  const { nativeRuntimeDeltaText, flushNativeRuntimeReplay } = new Function(
    `${deltaTextSource}; return { nativeRuntimeDeltaText, flushNativeRuntimeReplay };`,
  )();
  const content = '我先定位这条会话对应的服务日志和会话记录，确认重复内容来自实时消息重放，而不是模型真的生成了两次。';
  const live = { targetText: content, runtimeReplay: null };

  assert.equal(nativeRuntimeDeltaText(live, content.slice(0, 18)), '');
  assert.equal(nativeRuntimeDeltaText(live, content.slice(18)), '');
  assert.equal(live.runtimeReplay, null, 'a complete replay should be consumed');

  const suffix = '接下来继续检查前端合并逻辑。';
  assert.equal(nativeRuntimeDeltaText(live, content + suffix), suffix);

  const mismatch = { targetText: content, runtimeReplay: null };
  const prefix = content.slice(0, 10);
  assert.equal(nativeRuntimeDeltaText(mismatch, prefix), '');
  assert.equal(nativeRuntimeDeltaText(mismatch, '这是新的正文'), prefix + '这是新的正文');

  const partial = { targetText: content, runtimeReplay: null };
  assert.equal(nativeRuntimeDeltaText(partial, prefix), '');
  flushNativeRuntimeReplay(partial);
  assert.equal(partial.targetText, content + prefix, 'an incomplete probe must restore buffered text');

  const short = { targetText: '是', runtimeReplay: null };
  assert.equal(nativeRuntimeDeltaText(short, '是'), '是');
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

test('running composer queues follow-ups and keeps steer as an explicit queue action', () => {
  const sendStart = inlineScript.indexOf('async function send(){');
  assert.ok(sendStart >= 0, 'missing send source');
  const sendSource = inlineScript.slice(sendStart);
  const submitSource = sourceBetween('function syncComposerSubmitControl', 'function syncComposerInputState');
  const steerSource = sourceBetween('async function steerQueuedPrompt', 'async function dispatchNextQueuedPrompt');
  const dispatchSource = sourceBetween('async function dispatchNextQueuedPrompt', 'function closeComposerPopovers');
  assert.match(sendSource, /if\(existingId&&webRunActive\)\{\s*enqueuePrompt\(text,attachments\);\s*return;\s*\}/);
  assert.doesNotMatch(sendSource, /sendNativeSteer\(existingId/);
  assert.match(submitSource, /const action=webRunActive&&native\?'queue':resumeInterrupted\?'resume':'send'/);
  assert.match(submitSource, /const label=action==='queue'\?'加入队列':action==='resume'\?'继续队列':'发送'/);
  assert.match(inlineScript, /webRunActive&&native\?'排队消息':'向 Codex 提问'/);
  assert.doesNotMatch(inlineScript, /async function sendNativeSteer/);
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

test('interrupted Codex App queues resume in place without sending a synthetic turn', () => {
  const resumeSource = sourceBetween('function hasInterruptedAppQueue', 'function syncComposerSubmitControl');
  const makeResumeCheck = (source, id, active, draft, items) => new Function(
    'currentConversationSource',
    'currentConversationId',
    'webRunActive',
    'appQueueEditDraft',
    'promptQueueFor',
    'isAppOwnedQueuedPrompt',
    `${resumeSource}; return canResumeInterruptedNativeTask;`,
  )(source, id, active, draft, () => items, (item) => item?.source === 'codex-app');
  const interruptedQueue = [{ source: 'codex-app', pauseState: 'interrupted' }];
  assert.equal(makeResumeCheck('codex', 'thread-a', false, null, interruptedQueue)(), true);
  assert.equal(makeResumeCheck('codex', 'thread-a', true, null, interruptedQueue)(), false);
  assert.equal(makeResumeCheck('codex', 'thread-a', false, {}, interruptedQueue)(), false);
  assert.equal(makeResumeCheck('codex', 'thread-a', false, null, [{ source: 'codex-app', pauseState: '' }])(), false);
  assert.equal(makeResumeCheck('codex', 'thread-a', false, null, [{ source: 'web', pauseState: 'interrupted' }])(), false);
  assert.equal(makeResumeCheck('web', 'thread-a', false, null, interruptedQueue)(), false);

  const submitSource = sourceBetween('function syncComposerSubmitControl', 'function syncComposerInputState');
  const resumeActionSource = sourceBetween('async function resumeInterruptedAppQueue', 'function syncComposerSubmitControl');
  const loadSource = sourceBetween('async function loadConversation', 'function updateConversationStatus');
  const statusSource = sourceBetween('function updateConversationStatus', 'async function applyNativeConversationMetadata');
  const runtimeStart = inlineScript.indexOf("sessionEvents.addEventListener('native-runtime'");
  const runtimeEnd = inlineScript.indexOf("sessionEvents.addEventListener('native-request'", runtimeStart);
  assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart, 'missing native runtime listener source');
  const runtimeSource = inlineScript.slice(runtimeStart, runtimeEnd);
  const sendStart = inlineScript.indexOf('async function send(){');
  const sendSource = inlineScript.slice(sendStart);
  assert.match(submitSource, /const resumeInterrupted=canResumeInterruptedNativeTask\(\)&&!hasPayload/);
  assert.match(submitSource, /action==='resume'\?'继续队列':'发送'/);
  assert.match(submitSource, /const icon=action==='resume'\?'play':'arrow-up'/);
  assert.match(submitSource, /sendBtn\.disabled=blocked\|\|\(!hasPayload&&!resumeInterrupted\)/);
  assert.match(resumeActionSource, /\/api\/prompt-queues\/'\+encodeURIComponent\(threadId\)\+'\/resume-interrupted/);
  assert.match(resumeActionSource, /applyServerPromptQueue\(threadId,data\)/);
  assert.match(resumeActionSource, /队列已继续，等待启动/);
  assert.match(loadSource, /currentNativeRunStatus=currentConversationSource==='codex'\?String\(conversation\.status\|\|''\):''/);
  assert.match(statusSource, /conversation\.status==='interrupted'\?'已暂停'/);
  assert.match(runtimeSource, /currentNativeRunStatus=String\(runtime\.status\|\|''\)/);
  assert.match(runtimeSource, /runtime\.status==='interrupted'\?'Codex App · 已暂停'/);
  assert.match(sendSource, /const resumeInterrupted=canResumeInterruptedNativeTask\(\)&&!text&&!attachments\.length/);
  assert.match(sendSource, /if\(resumeInterrupted\)\{await resumeInterruptedAppQueue\(\);return\}/);
  assert.doesNotMatch(sendSource, /resumeInterrupted\?'继续'/);
  assert.ok(
    sendSource.indexOf('if(resumeInterrupted){await resumeInterruptedAppQueue();return}') < sendSource.indexOf('waitForLatestComposerProviderChange'),
    'queue resume must bypass model loading and turn creation',
  );
  assert.match(sendSource, /JSON\.stringify\(\{message,attachments,provider:/);
});

test('queued dispatch waits for the matching terminal turn', () => {
  const queueGateSource = sourceBetween('const promptQueueTurnLocks', 'function showNativePromptOptimistically');
  const dispatchSource = sourceBetween('async function dispatchNextQueuedPrompt', 'function closeComposerPopovers');
  const timers = [];
  let dispatches = 0;
  const api = new Function(
    'promptQueueFor',
    'isAppOwnedQueuedPrompt',
    'dispatchNextQueuedPrompt',
    'setTimeout',
    'nativeTerminalPersisted',
    `${queueGateSource}; return { markPromptQueueTurnRunning, settlePromptQueueTurn, promptQueueTurnLocked, schedulePromptQueueDispatch };`,
  )(
    () => [{ id: 'next-item' }],
    () => false,
    () => { dispatches += 1; },
    (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    () => false,
  );

  assert.equal(api.markPromptQueueTurnRunning('thread-a', 'turn-first'), true);
  api.schedulePromptQueueDispatch('thread-a', 180);
  assert.equal(timers.length, 0, 'a running queue turn cannot schedule its successor');
  assert.equal(api.settlePromptQueueTurn('thread-a', 'turn-stale'), false);
  assert.equal(api.promptQueueTurnLocked('thread-a'), true);
  api.schedulePromptQueueDispatch('thread-a', 180);
  assert.equal(timers.length, 0, 'a terminal event for another turn cannot unlock the queue');
  assert.equal(api.settlePromptQueueTurn('thread-a', 'turn-first'), true);
  api.schedulePromptQueueDispatch('thread-a', 180);
  assert.equal(timers.length, 1);
  api.markPromptQueueTurnRunning('thread-a', 'turn-next');
  timers.shift().callback();
  assert.equal(dispatches, 0, 'a delayed dispatch rechecks the lock before sending');
  assert.equal(api.settlePromptQueueTurn('thread-a', 'turn-next'), true);
  api.schedulePromptQueueDispatch('thread-a', 180);
  timers.shift().callback();
  assert.equal(dispatches, 1, 'the successor is dispatched after its exact predecessor completes');

  assert.match(dispatchSource, /webRunActive\|\|promptQueueTurnLocked\(threadId\)\|\|steerSubmitting/);
  assert.match(inlineScript, /else if\(!settlePromptQueueTurn\(currentConversationId,runtimeTurnId\)\)return/);
  assert.match(inlineScript, /webRunActive=!promptQueueLock\.terminal&&\(conversation\.status==='running'\|\|Boolean\(lockedTurnId\)\)/);
});

test('persisted terminal snapshots settle only their matching queue lock', () => {
  const queueGateSource = sourceBetween('const promptQueueTurnLocks', 'function showNativePromptOptimistically');
  const terminalSource = sourceBetween('function nativeTerminalPersisted', 'function clearNativeCompletionSync');
  const nativeTerminalPersisted = new Function(`${terminalSource}; return nativeTerminalPersisted;`)();
  const api = new Function(
    'nativeTerminalPersisted',
    `${queueGateSource}; return { markPromptQueueTurnRunning, promptQueueTurnLock, promptQueueTurnLocked, reconcilePromptQueueTurnLock };`,
  )(nativeTerminalPersisted);
  const terminal = (turnId) => ({
    status: 'running',
    activeTurnId: turnId,
    messages: [{ turnId, role: 'process', kind: 'task_error' }],
  });

  api.markPromptQueueTurnRunning('thread-a', 'turn-old');
  assert.deepEqual(api.reconcilePromptQueueTurnLock('thread-a', terminal('turn-old')), { turnId: '', terminal: true });
  assert.equal(api.promptQueueTurnLocked('thread-a'), false, 'the exact persisted terminal record unlocks the queue');

  api.markPromptQueueTurnRunning('thread-a', 'turn-old');
  assert.deepEqual(api.reconcilePromptQueueTurnLock('thread-a', {
    status: 'error',
    terminalTurnId: 'turn-old',
    messages: [],
  }), { turnId: '', terminal: true });
  assert.equal(api.promptQueueTurnLocked('thread-a'), false, 'the matching server-side terminal override survives a missed SSE event');

  api.markPromptQueueTurnRunning('thread-a', 'turn-old');
  const newerRunning = terminal('turn-old');
  newerRunning.activeTurnId = 'turn-new';
  assert.deepEqual(api.reconcilePromptQueueTurnLock('thread-a', newerRunning), { turnId: 'turn-new', terminal: false });
  assert.equal(api.promptQueueTurnLock('thread-a'), 'turn-new', 'a newer active turn keeps the queue locked');

  const noTerminalRecord = { status: 'done', activeTurnId: '', messages: [] };
  assert.deepEqual(api.reconcilePromptQueueTurnLock('thread-a', noTerminalRecord), { turnId: 'turn-new', terminal: false });
  assert.equal(api.promptQueueTurnLocked('thread-a'), true, 'an unscoped idle snapshot cannot unlock a queued turn');
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

test('Codex App queue entries keep their message ownership while Web can persist their order', () => {
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
  assert.match(renderer, /bindPromptQueueDrag\(row,threadId,item\.id\)/);
  assert.match(renderer, /meta\.textContent=item\.pauseState==='interrupted'\?'Codex App · 已暂停':'Codex App'/);
  assert.match(renderer, /body\.title='长按拖动调整顺序；使用编辑按钮修改消息'/);
  assert.doesNotMatch(renderer, /body\.addEventListener\('click',\(\)=>restoreQueuedPrompt\(threadId,item\.id\)\)/);
  assert.match(renderer, /const busy=dispatching\|\|guiding\|\|steerSubmitting\|\|appQueueEditSaving/);
  assert.match(renderer, /row\.appendChild\(edit\);[\s\S]*?row\.appendChild\(guide\);\s*row\.appendChild\(remove\);[\s\S]*?row\.appendChild\(more\);/);
  assert.doesNotMatch(renderer, /if\(appOwned\)\{\s*promptQueueList\.appendChild\(row\);\s*return;/);
  assert.match(applyQueue, /if\(appQueueEditDraft\?\.threadId===threadId&&!appQueueEditSaving&&!clean\.some\(\(item\)=>item\.id===appQueueEditDraft\.itemId\)\)\{/);
  assert.match(applyQueue, /appQueueEditDraft=null;[\s\S]*?input\.value='';[\s\S]*?clearPendingAttachments\(\);[\s\S]*?该队列消息已在 Codex App 处理/);
  assert.doesNotMatch(remove, /blockAppOwnedQueueAction/);
  assert.match(remove, /if\(!isAppOwnedQueuedPrompt\(victim\)\)rememberQueueDismissed\(threadId,victim\)/);
  assert.match(remove, /if\(firstId===itemId&&!webRunActive&&!isAppOwnedQueuedPrompt\(victim\)\)schedulePromptQueueDispatch\(threadId,100\)/);
  assert.doesNotMatch(move, /blockAppOwnedQueueAction/);
  assert.match(move, /void persistPromptQueueOrder\(threadId,items\)/);
  assert.doesNotMatch(sideChat, /blockAppOwnedQueueAction/);
  assert.match(sideChat, /body:JSON\.stringify\(\{\.\.\.queuedPromptPayload\(item\),sideChat:true,sourceThreadId:threadId\}\)/);
  assert.doesNotMatch(restore, /blockAppOwnedQueueAction/);
  assert.match(restore, /if\(isAppOwnedQueuedPrompt\(item\)\)\{[\s\S]*?appQueueEditDraft=\{threadId,itemId,originalMessage:item\.message\}[\s\S]*?return;/);
  assert.ok(restore.indexOf('if(isAppOwnedQueuedPrompt(item))') < restore.indexOf('consumeQueuedPromptOnServer(threadId,itemId)'));
  assert.ok(restoreQueued.indexOf('await consumeQueuedPromptOnServer(threadId,itemId)') < restoreQueued.indexOf('appQueueEditDraft=null'));
  assert.match(restore, /method:'PATCH'/);
  assert.match(restore, /context.*保留原附件|保留原附件/);
  assert.match(restore, /const stillEditingDraft=appQueueEditDraft===draft/);
  assert.match(restore, /if\(stillEditingDraft&&currentConversationSource==='codex'&&currentConversationId===draft\.threadId\)/);
  assert.match(restore, /if\(appQueueEditDraft===draft&&currentConversationSource==='codex'&&currentConversationId===draft\.threadId\)/);
  assert.match(schedule, /const item=promptQueueFor\(threadId\)\[0\];/);
  assert.match(schedule, /isAppOwnedQueuedPrompt\(item\)/);
  assert.match(schedule, /item\.autoDispatch===false\|\|item\.dispatchState==='uncertain'/);
  assert.doesNotMatch(steer, /blockAppOwnedQueueAction/);
  assert.match(steer, /if\(isAppOwnedQueuedPrompt\(item\)\)\{statusEl\.textContent='任务运行时才可发送引导';return\}/);
  assert.match(steer, /dismiss:!isAppOwnedQueuedPrompt\(item\)/);
  assert.match(dispatch, /!item\|\|isAppOwnedQueuedPrompt\(item\)\|\|queueDispatchingThreads/);
  assert.match(loadConversation, /if\(conversationChanged&&appQueueEditSaving\)\{statusEl\.textContent='正在保存队列修改，请稍后切换会话';return false\}/);
  assert.match(loadConversation, /if\(conversationChanged&&appQueueEditDraft\)\{appQueueEditDraft=null;input\.value='';input\.style\.height='auto';clearPendingAttachments\(\)\}/);
  assert.doesNotMatch(uiStyles, /\.promptQueueRow\.appOwned\s*\{[^}]*grid-template-columns:/s);
  assert.doesNotMatch(uiStyles, /\.promptQueueRow\.appOwned \.promptQueueBody:disabled/);
  assert.doesNotMatch(uiStyles, /\.promptQueueRow\.appOwned \.promptQueueLead/);
});

test('native histories load upward in real pages without an obstructive history control', () => {
  const historyPagingSource = sourceBetween('function normalizeNativeHistoryPageLimit', 'function clearNativeHistoryDeferredSync');
  const loadEarlierNativeHistoryPage = sourceBetween('async function loadEarlierNativeHistoryPage', 'async function loadConversation');
  const loadConversation = sourceBetween('async function loadConversation', 'function updateConversationStatus');
  const renderSideChatMessages = sourceBetween('function renderSideChatMessages', 'async function syncSideChatConversation');
  const syncSideChatConversation = sourceBetween('async function syncSideChatConversation', 'function updateSideChatHeadState');
  const syncCurrentNativeConversationOnce = sourceBetween('async function syncCurrentNativeConversationOnce', 'function nativeTerminalPersisted');
  const nativeScrollTracking = sourceBetween('function bindNativeLiveScrollTracking', 'function captureNativeLiveFollowBottom');
  const { nativeHistoryNextBatchCount } = new Function(`
    const NATIVE_HISTORY_PAGE_SIZE=60;
    const NATIVE_HISTORY_PAGE_MAX_REQUEST_BATCHES=2;
    const NATIVE_HISTORY_PAGE_OVERFLOW=24;
    ${historyPagingSource}
    return { nativeHistoryNextBatchCount };
  `)();
  const maxPageBatches=12;

  assert.match(inlineScript, /let deferredIconRefreshDepth=0;/);
  assert.match(inlineScript, /function refreshIcons\(root=document\)\{if\(deferredIconRefreshDepth>0\|\|/);
  assert.match(inlineScript, /const NATIVE_HISTORY_PAGE_SIZE = 60;/);
  assert.match(inlineScript, /const NATIVE_HISTORY_MANUAL_MAX_BATCHES = 1;/);
  assert.match(inlineScript, /const NATIVE_HISTORY_INITIAL_MAX_BATCHES = 24;/);
  assert.match(inlineScript, /const NATIVE_HISTORY_PAGE_MAX_REQUEST_BATCHES = 2;/);
  assert.match(inlineScript, /let nativeHistoryNextPageLimit = NATIVE_HISTORY_PAGE_SIZE;/);
  assert.match(inlineScript, /function nativeHistoryViewportFilled\(container\)/);
  assert.match(inlineScript, /function nativeHistoryPageGrowthTarget\(container\)/);
  assert.match(inlineScript, /Math\.min\(height,1200\)\*0\.75/);
  assert.match(inlineScript, /function nativeHistoryPageGrowthGoal\(container,initialHeight,fillViewport\)/);
  assert.match(inlineScript, /function nativeHistoryNextBatchCount\(growth,growthTarget,loadedBatches,maxBatches\)/);
  assert.match(inlineScript, /function historyNodeHasLayout\(node\)/);
  assert.match(inlineScript, /function captureHistoryScrollAnchor\(container\)/);
  assert.match(inlineScript, /function restoreHistoryScrollAnchor\(container,anchor\)/);
  assert.match(serverSource, /const earlierHistoryPage = req\.query\.history === 'page' && req\.query\.paging === 'earlier';/);
  assert.match(serverSource, /if \(!earlierHistoryPage\) await reconcileNativeTurnStatusFromAppServer\(conversation\.id, conversation\);/);
  let emptyGrowthBatches=0;
  let emptyGrowthRequests=0;
  while(emptyGrowthBatches<maxPageBatches){
    const batchCount=nativeHistoryNextBatchCount(0,675,emptyGrowthBatches,maxPageBatches);
    assert.ok(batchCount>=1&&batchCount<=2);
    emptyGrowthBatches+=batchCount;
    emptyGrowthRequests+=1;
  }
  assert.equal(emptyGrowthRequests,7);
  let visualGrowth=0;
  let visualGrowthBatches=0;
  let visualGrowthRequests=0;
  while(visualGrowth<675&&visualGrowthBatches<maxPageBatches){
    const batchCount=nativeHistoryNextBatchCount(
      visualGrowth,
      675,
      visualGrowthBatches,
      maxPageBatches,
    );
    visualGrowthBatches+=batchCount;
    visualGrowth+=350*batchCount;
    visualGrowthRequests+=1;
  }
  assert.equal(visualGrowthRequests,2);
  assert.ok(visualGrowth>=675&&visualGrowth<=1350);
  assert.match(loadConversation, /const deferHistoryIcons=Boolean\(options\.historyScrollAnchor\)\|\|messages\.length>=NATIVE_HISTORY_PAGE_SIZE;[\s\S]*?beginDeferredIconRefresh\(\);[\s\S]*?finally\{[\s\S]*?endDeferredIconRefresh\(chat\)/);
  assert.match(loadConversation, /const nativeHistoryQuery=currentConversationSource==='codex'[\s\S]*?'\?images=external&history=page&latest=complete&limit='\+nativeHistoryPageLimit/);
  assert.match(loadConversation, /const nativeHistoryPagingQuery=currentConversationSource==='codex'&&options\.historyPaging===true\?'&paging=earlier':''/);
  assert.match(loadConversation, /const requestUrl=endpoint\+encodeURIComponent\(id\)\+nativeHistoryQuery\+nativeHistoryPagingQuery/);
  assert.match(loadEarlierNativeHistoryPage, /const batchCount=nativeHistoryNextBatchCount\(growth,growthTarget,loadedBatches,maxBatches\)/);
  assert.match(loadEarlierNativeHistoryPage, /if\(!batchCount\)break/);
  assert.match(loadEarlierNativeHistoryPage, /const adaptiveLimit=lastSuccessfulLimit\+NATIVE_HISTORY_PAGE_SIZE\*batchCount/);
  assert.match(loadEarlierNativeHistoryPage, /const hintedLimit=normalizeNativeHistoryPageLimit\(nativeHistoryNextPageLimit\)/);
  assert.match(loadEarlierNativeHistoryPage, /const requestedLimit=fillViewport\?adaptiveLimit:Math\.max\(adaptiveLimit,hintedLimit\)/);
  assert.match(loadEarlierNativeHistoryPage, /loadedBatches\+=fillViewport\?requestedBatches:1/);
  assert.match(loadEarlierNativeHistoryPage, /historyScrollAnchor:anchor/);
  assert.match(loadEarlierNativeHistoryPage, /historyPaging:true/);
  assert.match(loadEarlierNativeHistoryPage, /const preserveFollowBottom=fillViewport&&!nativeLiveReadingHistory&&nativeLiveFollowBottom/);
  assert.match(loadEarlierNativeHistoryPage, /preserveHistoryFollowBottom:preserveFollowBottom/);
  assert.match(loadEarlierNativeHistoryPage, /fillViewport\?NATIVE_HISTORY_INITIAL_MAX_BATCHES:NATIVE_HISTORY_MANUAL_MAX_BATCHES/);
  assert.match(loadEarlierNativeHistoryPage, /nativeHistorySyncDeferred=true/);
  assert.match(loadEarlierNativeHistoryPage, /clearNativeHistoryDeferredSync\(\)/);
  assert.match(loadEarlierNativeHistoryPage, /if\(sameConversation&&syncDeferred\)scheduleDeferredNativeHistorySync\(id\)/);
  assert.match(loadEarlierNativeHistoryPage, /fillViewport\?nativeHistoryViewportFilled\(chat\):growth>=growthTarget/);
  assert.match(loadConversation, /await restoreHistoryScrollAnchor\(chat,options\.historyScrollAnchor\)/);
  assert.match(loadConversation, /const preserveHistoryFollowBottom=Boolean\(options\.historyScrollAnchor\)&&options\.preserveHistoryFollowBottom===true/);
  assert.match(loadConversation, /if\(options\.historyScrollAnchor&&!preserveHistoryFollowBottom\)setNativeLiveReadingHistory\(true\);\s*else resumeNativeLiveFollowBottom\(\);/);
  assert.match(loadConversation, /await restoreHistoryScrollAnchor\(chat,options\.historyScrollAnchor\);\s*if\(preserveHistoryFollowBottom\)resumeNativeLiveFollowBottom\(\);\s*else setNativeLiveReadingHistory\(true\)/);
  assert.match(loadConversation, /loadEarlierNativeHistoryPage\(\{fillViewport:true\}\)/);
  assert.match(nativeScrollTracking, /addEventListener\('wheel'[\s\S]*?event\.deltaY<0/);
  assert.match(nativeScrollTracking, /let historyTouchPageTriggered=false;[\s\S]*?addEventListener\('touchmove'[\s\S]*?!historyTouchPageTriggered[\s\S]*?currentY-historyTouchStartY>=28[\s\S]*?historyTouchPageTriggered=true/);
  assert.match(nativeScrollTracking, /addEventListener\('touchend',resetHistoryTouch/);
  assert.match(nativeScrollTracking, /addEventListener\('touchcancel',resetHistoryTouch/);
  assert.match(syncSideChatConversation, /const pagingQuery=options\.historyPaging===true\?'&paging=earlier':''/);
  assert.match(syncSideChatConversation, /fetch\('\/api\/native-sessions\/'\+encodeURIComponent\(syncId\)\+'\?images=external&history=page&latest=complete&limit='\+historyLimit\+pagingQuery\)/);
  assert.match(renderSideChatMessages, /const deferIcons=Boolean\(context\.historyScrollAnchor\)\|\|list\.length>=NATIVE_HISTORY_PAGE_SIZE/);
  assert.match(syncSideChatConversation, /tab\.historyNextLimit=normalizeNativeHistoryPageLimit/);
  assert.match(syncSideChatConversation, /fillViewport\?NATIVE_HISTORY_INITIAL_MAX_BATCHES:NATIVE_HISTORY_MANUAL_MAX_BATCHES/);
  assert.match(syncSideChatConversation, /const batchCount=nativeHistoryNextBatchCount\(growth,growthTarget,loadedBatches,maxBatches\)/);
  assert.match(syncSideChatConversation, /if\(!batchCount\)break/);
  assert.match(syncSideChatConversation, /const hintedLimit=normalizeNativeHistoryPageLimit\(tab\.historyNextLimit\)/);
  assert.match(syncSideChatConversation, /tab\.historyLimit=requestedLimit/);
  assert.match(syncSideChatConversation, /loadedBatches\+=fillViewport\?requestedBatches:1/);
  assert.match(syncSideChatConversation, /historyScrollAnchor:anchor,followBottom:false,historyPaging:true/);
  assert.match(syncSideChatConversation, /fillInitialSideChatHistoryPage\(\)/);
  assert.match(syncCurrentNativeConversationOnce, /'\?images=external&history=page&latest=complete&limit='\+nativeHistoryPageLimit\+'&after='\+nativeCursor\+'&generation='\+nativeGeneration/);
  assert.match(syncCurrentNativeConversationOnce, /if\(deferNativeSyncForHistoryPage\(\)\)return/);
  assert.match(syncCurrentNativeConversationOnce, /nativeHistoryNextPageLimit=normalizeNativeHistoryPageLimit\(Math\.max/);
  assert.match(syncCurrentNativeConversationOnce, /historyPageLimit:nativeHistoryPageLimit/);
  assert.match(syncCurrentNativeConversationOnce, /nativeLiveFollowBottom&&nativeLiveNearBottom\(\)\?null:captureHistoryScrollAnchor\(chat\)/);
  assert.match(syncCurrentNativeConversationOnce, /historyScrollAnchor,/);
  assert.match(loadConversation, /chat\.innerHTML='';\s*const messages=conversation\.messages\|\|\[\];/);
  assert.match(loadConversation, /Number\(conversation\.nextHistoryPageLimit\)\|\|0/);
  assert.doesNotMatch(inlineScript, /addNativeHistoryLoadButton|nativeHistoryLoadEarlier|加载完整记录/);
  assert.doesNotMatch(uiStyles, /nativeHistoryLoadEarlier/);
});

test('history anchor restoration completes in frames and yields to user scrolling', async () => {
  const anchorSource = sourceBetween('function historyNodeHasLayout', 'function upsertSideChatTab');
  const frames = [];
  let scrollTop = 0;
  let nodeTop = 900;
  const node = {
    dataset: { nativeMessageSeq: '42' },
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({
      top: nodeTop - scrollTop,
      bottom: nodeTop - scrollTop + 40,
      width: 100,
      height: 40,
    }),
  };
  const container = {
    isConnected: true,
    scrollHeight: 1600,
    querySelectorAll: () => [node],
    getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
  };
  Object.defineProperty(container, 'scrollTop', {
    get: () => scrollTop,
    set: (value) => { scrollTop = Number(value); },
  });
  const restoreHistoryScrollAnchor = new Function(
    'requestAnimationFrame',
    `${anchorSource}; return restoreHistoryScrollAnchor;`,
  )((callback) => {
    frames.push(callback);
    return frames.length;
  });

  const settled = restoreHistoryScrollAnchor(container, {
    sequence: 42,
    offset: 100,
    scrollTop: 0,
    scrollHeight: 800,
  });
  assert.equal(scrollTop, 800);
  nodeTop = 920;
  frames.shift()();
  assert.equal(scrollTop, 820);
  frames.shift()();
  await settled;
  assert.equal(scrollTop, 820);

  nodeTop = 980;
  const userControlled = restoreHistoryScrollAnchor(container, {
    sequence: 42,
    offset: 100,
    scrollTop,
    scrollHeight: 1600,
  });
  assert.equal(scrollTop, 880);
  scrollTop = 840;
  frames.shift()();
  await userControlled;
  assert.equal(scrollTop, 840);
  assert.equal(frames.length, 0);
  assert.doesNotMatch(anchorSource, /setTimeout/);
});

test('deferred native history sync clears its pending state before catch-up', () => {
  const deferredSource = sourceBetween('function clearNativeHistoryDeferredSync', 'function historyNodeHasLayout');
  const deferred = new Function(`
    let nativeHistoryDeferredSyncTimer=null;
    let nativeHistorySyncDeferred=true;
    let nativeHistoryPageLoading=false;
    let currentConversationSource='codex';
    let currentConversationId='thread-1';
    let syncCalls=0;
    const callbacks=[];
    const clearTimeout=()=>{};
    const setTimeout=(callback)=>{callbacks.push(callback);return callbacks.length};
    const syncCurrentNativeConversation=()=>{syncCalls+=1};
    ${deferredSource}
    return {
      scheduleDeferredNativeHistorySync,
      runNext:()=>callbacks.shift()?.(),
      setLoading:(value)=>{nativeHistoryPageLoading=Boolean(value)},
      state:()=>({deferred:nativeHistorySyncDeferred,syncCalls}),
    };
  `)();

  deferred.scheduleDeferredNativeHistorySync('thread-1');
  deferred.runNext();
  assert.deepEqual(deferred.state(),{deferred:false,syncCalls:1});

  deferred.setLoading(true);
  deferred.scheduleDeferredNativeHistorySync('thread-1');
  deferred.runNext();
  assert.deepEqual(deferred.state(),{deferred:true,syncCalls:1});

  deferred.setLoading(false);
  deferred.scheduleDeferredNativeHistorySync('thread-1');
  deferred.runNext();
  assert.deepEqual(deferred.state(),{deferred:false,syncCalls:2});
});

test('queue reorder uses a long-press floating row and keeps active sends as boundaries', () => {
  const segmentSource = sourceBetween('function promptQueueRows', 'function clearPromptQueueDragMarks');
  const dragSource = sourceBetween('let promptQueueDragState=null;', 'async function restoreQueuedPrompt');
  const makeRow = (id, classes = []) => ({
    dataset: { queueId: id },
    classList: { contains: (name) => classes.includes(name) },
  });
  const rows = [
    makeRow('web-a'),
    makeRow('web-b'),
    makeRow('app-c', ['appOwned']),
    makeRow('web-d'),
    makeRow('web-e', ['sending']),
    makeRow('web-f'),
  ];
  const promptQueueList = { querySelectorAll: () => rows };
  const api = new Function(
    'promptQueueList',
    'desktopQueueReorderAvailable',
    `${segmentSource}; return { promptQueueRowCanReorder, promptQueueMovableSegment };`,
  )(promptQueueList, true);

  assert.deepEqual([...api.promptQueueMovableSegment(rows[1])], ['web-a', 'web-b', 'app-c', 'web-d']);
  assert.deepEqual([...api.promptQueueMovableSegment(rows[3])], ['web-a', 'web-b', 'app-c', 'web-d']);
  assert.deepEqual([...api.promptQueueMovableSegment(rows[5])], ['web-f']);
  assert.deepEqual([...api.promptQueueMovableSegment(rows[2])], ['web-a', 'web-b', 'app-c', 'web-d']);
  assert.equal(api.promptQueueRowCanReorder(rows[4]), false);

  let reorderList;
  const makeReorderRow = (id, classes = []) => {
    const classNames = new Set(classes);
    const row = {
      dataset: { queueId: id },
      isConnected: true,
      style: {},
      classList: {
        add: (...names) => names.forEach((name) => classNames.add(name)),
        remove: (...names) => names.forEach((name) => classNames.delete(name)),
        contains: (name) => classNames.has(name),
        toggle: (name, force) => {
          if (force === undefined) {
            if (classNames.has(name)) classNames.delete(name);
            else classNames.add(name);
          } else if (force) classNames.add(name);
          else classNames.delete(name);
          return classNames.has(name);
        },
      },
      getBoundingClientRect: () => ({
        top: reorderList.children.indexOf(row) * 40,
        height: 40,
      }),
    };
    Object.defineProperty(row, 'nextSibling', {
      get: () => reorderList.children[reorderList.children.indexOf(row) + 1] || null,
    });
    return row;
  };
  const reorderRows = [makeReorderRow('web-a'), makeReorderRow('web-b'), makeReorderRow('web-c'), makeReorderRow('app-d', ['appOwned'])];
  reorderList = {
    children: reorderRows,
    querySelectorAll(selector) {
      if (selector === '.promptQueueRow') return this.children;
      if (selector === '.promptQueueRow.dragOver') return this.children.filter((row) => row.classList.contains('dragOver'));
      return [];
    },
    insertBefore(row, reference) {
      const existing = this.children.indexOf(row);
      if (existing >= 0) this.children.splice(existing, 1);
      const index = reference === null ? this.children.length : this.children.indexOf(reference);
      assert.notEqual(index, -1);
      this.children.splice(index, 0, row);
    },
  };
  const reorderSource = sourceBetween('function promptQueueRows', 'function updatePromptQueueDragFromPoint');
  const reorderApi = new Function(
    'promptQueueList',
    'desktopQueueReorderAvailable',
    `${reorderSource}; return { promptQueueMovableSegment, movePromptQueueDragSource };`,
  )(reorderList, true);
  const reorderState = {
    row: reorderRows[1],
    movableIds: reorderApi.promptQueueMovableSegment(reorderRows[1]),
    fromIndex: 1,
    changed: false,
  };
  reorderApi.movePromptQueueDragSource(reorderState, 999);
  assert.deepEqual(reorderList.children.map((row) => row.dataset.queueId), ['web-a', 'web-c', 'app-d', 'web-b']);
  assert.equal(reorderState.changed, true);
  reorderApi.movePromptQueueDragSource(reorderState, -1);
  assert.deepEqual(reorderList.children.map((row) => row.dataset.queueId), ['web-b', 'web-a', 'web-c', 'app-d']);

  assert.match(dragSource, /const PROMPT_QUEUE_DRAG_HOLD_MS=350/);
  assert.match(dragSource, /state\.holdTimer=setTimeout\(\(\)=>beginPromptQueuePointerDrag\(state\),PROMPT_QUEUE_DRAG_HOLD_MS\)/);
  assert.match(dragSource, /document\.body\.appendChild\(ghost\)/);
  assert.match(dragSource, /ghost\.classList\.add\('promptQueueDragGhost'\)/);
  assert.match(dragSource, /state\.row\.classList\.add\('dragSource','promptQueueDropPlaceholder'\)/);
  assert.match(dragSource, /closest\?\.\('\.promptQueueLead,\.promptQueueBody'\)/);
  assert.match(dragSource, /promptQueueDragSuppressedClickUntil=Date\.now\(\)\+750/);
  assert.match(dragSource, /window\.addEventListener\('pointercancel',cancelPromptQueuePointerDrag,true\)/);
  assert.match(dragSource, /if\(event\.key!=='Escape'\|\|!promptQueueDragState\)return/);
  assert.match(dragSource, /if\(!shouldCommit&&state\.active\)restorePromptQueueDragSourceOrder\(state\)/);
  assert.match(dragSource, /const tolerance=event\.pointerType==='touch'\?PROMPT_QUEUE_DRAG_CANCEL_DISTANCE\*2\.4:PROMPT_QUEUE_DRAG_CANCEL_DISTANCE;\s*if\(distance>tolerance\)cancelPromptQueuePointerDrag\(event\)/);
  assert.match(uiStyles, /\.promptQueueDragGhost\s*\{[^}]*position:\s*fixed;[^}]*pointer-events:\s*none;[^}]*box-shadow:/s);
  assert.match(uiStyles, /\.promptQueueRow\.dragSource > \*\s*\{[^}]*visibility:\s*hidden/s);
  assert.match(uiStyles, /\.promptQueueBody\s*\{[^}]*touch-action:\s*manipulation;[^}]*-webkit-touch-callout:\s*none/s);
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
  assert.match(observerSource, /const schedule=\(\)=>scheduleComposerOverlayInset\(\{scroll:true\}\)/);
  assert.match(observerSource, /const scheduleViewport=\(\)=>scheduleComposerViewportSync\(\)/);
  assert.match(observerSource, /composer\?\.addEventListener\('transitionend',\(event\)=>\{if\(event\.propertyName==='bottom'\)schedule\(\)\}\)/);
  assert.match(insetSource, /const pinned=distance<=Math\.max\(72,prev\+48\)/);
  assert.match(insetSource, /const shouldFollowLatest=options\.followLatest===true\|\|pinned/);
  assert.match(insetSource, /options\.scroll&&chat&&shouldFollowLatest/);
  assert.match(scrollSource, /chat\.scrollTop=chat\.scrollHeight/);
  assert.doesNotMatch(scrollSource, /scrollIntoView/);
  assert.match(inlineScript, /enhanceComposerKeyboardLift\(\);\s*enhanceComposerOverlayInset\(\);\s*keepComposerAboveKeyboard\(\);/);
  assert.match(insetSource, /const height=Math\.max\(72, Math\.min\(measured \+ 8, maxHeight\)\)/);
  assert.match(uiStyles, /body\.keyboardOpen \.chat\s*\{[^}]*--composer-overlay-height/s);
  assert.match(uiStyles, /\.editedFilesResult\.live\.withPlan\) > \.chat\s*\{[^}]*--composer-overlay-height/s);
  assert.match(uiStyles, /@media \(max-width: 820px\)[\s\S]*?body \.composer:has\(> \.box\.composerCollapsed\)\s*\{[^}]*padding-bottom:\s*calc\(env\(safe-area-inset-bottom, 0px\) \+ 16px\)/s);
  assert.match(uiStyles, /@media \(max-width: 820px\)[\s\S]*?body \.chat\s*\{[^}]*padding-bottom:\s*max\(calc\(84px \+ env\(safe-area-inset-bottom, 0px\)\), calc\(var\(--composer-overlay-height, calc\(72px \+ env\(safe-area-inset-bottom, 0px\)\)\) \+ 12px\)\)/s);
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

test('task_complete folds progress commentary with tool history', () => {
  const organizeSource = sourceBetween('function organizeTurnArtifactsForCompletion', 'function createCompletionMessage');
  assert.match(organizeSource, /Completed progress commentary belongs with tool\/process history/);
  assert.match(organizeSource, /const visibleElements=\[\]/);
  assert.match(organizeSource, /processElements\.push\(item\)/);
  assert.match(organizeSource, /processElements\.push\(\.\.\.kept, \.\.\.regroupTurnToolArtifacts\(loose\)\)/);
  const organizeTurnArtifactsForCompletion = new Function(
    'isProgressStyleAssistantText',
    'regroupTurnToolArtifacts',
    `${organizeSource}; return organizeTurnArtifactsForCompletion;`,
  )(
    () => true,
    (items) => items,
  );
  const artifact = (classes, kind, text) => {
    const values = new Set(classes);
    return {
      classList: {
        contains: (value) => values.has(value),
        remove: (value) => values.delete(value),
      },
      dataset: { messageKind: kind, messageText: text },
      textContent: text,
      parentNode: null,
    };
  };
  const firstTool = artifact(['activityBatch'], 'tool_activity', 'read');
  const firstProgress = artifact(['assistant', 'progressCommentary', 'streaming'], 'commentary', 'first note');
  const imageActivity = artifact(['activityBatch'], 'image_view_activity', 'view image');
  const secondTool = artifact(['activityBatch'], 'tool_activity', 'search');
  const secondProgress = artifact(['assistant', 'progressCommentary'], 'live_progress', 'second note');
  const finalAnswer = artifact(['assistant'], 'final_answer', 'done');
  const organized = organizeTurnArtifactsForCompletion(
    [firstTool, firstProgress, imageActivity, secondTool, secondProgress, finalAnswer],
    finalAnswer,
  );
  assert.deepEqual(organized.processElements, [firstTool, firstProgress, secondTool, secondProgress]);
  assert.deepEqual(organized.visibleElements, [imageActivity]);
  assert.deepEqual(organized.visibleActivities, [imageActivity]);
  assert.equal(firstProgress.classList.contains('streaming'), false);
  assert.match(inlineScript, /function appendTurnProcessTimelineElement/);
  assert.match(inlineScript, /appendTurnProcessTimelineElement\(element,\{beforeTools:false\}\)/);
  assert.match(inlineScript, /const completion=createCompletionMessage\(text,organized\.processElements,options\.turnId,elapsedSeconds,options\.tokenUsage\)/);
  assert.match(inlineScript, /for\(const item of organized\.visibleElements\)chat\.insertBefore\(item,anchor\)/);
  assert.match(inlineScript, /for\(const item of organized\.visibleElements\)target\.insertBefore\(item,anchor\)/);
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
  assert.match(inlineScript, /input\.placeholder=queueStarting\?'正在发送队列消息\.\.\.':steerSubmitting\?'正在发送引导\.\.\.':cancelPending\?'正在停止当前任务\.\.\.':webRunActive&&native\?'排队消息':'向 Codex 提问'/);
  assert.doesNotMatch(sourceBetween('function composerShouldStayExpanded', 'function setComposerExpanded'), /threadGoalBar/);
  assert.match(inlineScript, /向 Codex 提问/);
  assert.match(uiStyles, /body \.box\.composerCollapsed/);
  assert.match(uiStyles, /border-radius:\s*999px !important/);
  assert.match(uiStyles, /body \.box\.composerCollapsed\.runActive > \.cancelButton/);
  assert.match(uiStyles, /body \.box\.composerExpanded > \.composerMicBtn/);
});

test('active composer swaps stop for send in one action slot', () => {
  assert.match(
    uiStyles,
    /body \.box\.runActive:has\(> \.send:not\(\.cancelButton\):not\(:disabled\)\) > \.cancelButton\s*\{[^}]*display:\s*none !important/s,
  );
  assert.doesNotMatch(uiStyles, /grid-template-columns:[^;\n]*34px 34px 34px/);
  assert.doesNotMatch(uiStyles, /grid-template-columns:[^;\n]*42px 42px 42px/);
  assert.doesNotMatch(uiStyles, /grid-template-columns:[^;\n]*38px 38px 38px/);
  assert.doesNotMatch(uiStyles, /\.runActive:has\([^}]+\)\s*\{[^}]*grid-template-columns/s);
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
  assert.match(syncSource, /const renderSnapshotImmediately=nativeLiveDocumentHidden\(\)\|\|nativeSnapshotResumeCatchup/);
  assert.match(syncSource, /syncMessages=nativeResetMessagesForIncrementalSync\(conversation\)/);
  assert.match(syncSource, /if\(!syncMessages\)\{[\s\S]*?await loadConversation\(id,'codex',\{[\s\S]*?historyPageLimit:nativeHistoryPageLimit,[\s\S]*?historyScrollAnchor,[\s\S]*?\}\);[\s\S]*?return;/);
  assert.doesNotMatch(syncSource, /if\(conversation\.status==='running'\)[\s\S]*?loadConversation/);
  assert.match(syncSource, /for\(const msg of syncMessages\)/);
  assert.match(inlineScript, /\['','message','commentary','final_answer'\]\.includes\(kind\)/);
  assert.match(syncSource, /upsertNativeSnapshotLiveMessage\(msg,conversation,\{renderImmediately:renderSnapshotImmediately\}\)/);
  assert.match(inlineScript, /const syncDelay=webRunActive&&currentConversationSource==='codex'\?80:260/);
  assert.match(inlineScript, /dataset\.nativeMessageSeq/);
  const completionSyncSource = sourceBetween('async function reconcileNativeCompletion', 'function syncNativeAfterPageResume');
  assert.match(completionSyncSource, /await syncCurrentNativeConversation\(\)/);
  assert.doesNotMatch(completionSyncSource, /loadConversation/);
});

test('same-conversation refresh keeps the visible status instead of flashing Loading', () => {
  const loadConversation = sourceBetween('async function loadConversation', 'function updateConversationStatus');
  assert.match(loadConversation, /const conversationChanged=id!==currentConversationId\|\|nextConversationSource!==currentConversationSource/);
  assert.match(loadConversation, /if\(conversationChanged\)statusEl\.textContent='Loading\.\.\.'/);
  assert.doesNotMatch(loadConversation, /updateActiveHistory\(\);\s*statusEl\.textContent='Loading\.\.\.'/);
});

test('running Codex App status shows only the update time', () => {
  const helperSource = sourceBetween('function nativeRunningStatusTimestamp', 'function updateConversationStatus');
  const statusSource = sourceBetween('function updateConversationStatus', 'async function applyNativeConversationMetadata');
  const statusEl = {
    textContent: '',
    classList: { add() {} },
  };
  const { showNativeRunningTimestamp } = new Function(
    'statusEl',
    `${helperSource}; return { showNativeRunningTimestamp };`,
  )(statusEl);
  const updatedAt = '2026-08-11T00:58:00.000Z';

  showNativeRunningTimestamp(updatedAt);
  assert.equal(statusEl.textContent, new Date(updatedAt).toLocaleString());
  assert.doesNotMatch(statusEl.textContent, /Codex App|运行中|正在处理/);
  assert.match(statusSource, /if\(running\)showNativeRunningTimestamp\(conversation\.updatedAt\|\|conversation\.createdAt\)/);
  assert.match(inlineScript, /else showNativeRunningTimestamp\(runtime\.updatedAt\)/);
  assert.match(inlineScript, /showNativeRunningTimestamp\(Date\.now\(\)\)/);
  assert.doesNotMatch(inlineScript, /statusEl\.textContent='Codex App · 正在处理'/);
});

test('rolled-back retry collapse invalidates the open page before appending the latest attempt', () => {
  assert.match(nativeSessionSource, /case 'thread_rolled_back':[\s\S]*?pendingThreadRollbackTurnId/);
  assert.match(nativeSessionSource, /function collapseRolledBackRetryTurn[\s\S]*?cache\.contentMutated = true/);
  const syncSource = sourceBetween('async function syncCurrentNativeConversationOnce', 'function nativeTerminalPersisted');
  assert.ok(syncSource.indexOf('if(conversation.reset)') < syncSource.indexOf('for(const msg of syncMessages)'));
  assert.match(inlineScript, /const staleVisible=[\s\S]*?!sequences\.has\(sequence\)/);
  assert.match(syncSource, /if\(!syncMessages\)\{[\s\S]*?await loadConversation\(id,'codex',\{[\s\S]*?historyPageLimit:nativeHistoryPageLimit,[\s\S]*?historyScrollAnchor,[\s\S]*?\}\);[\s\S]*?return;/);
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

test('mobile composer capsules avoid backdrop blur rasterization', () => {
  const mobileStart = uiStyles.indexOf('@media (max-width: 820px) {', uiStyles.indexOf('body .composer > .box'));
  const mobileEnd = uiStyles.indexOf('@media (prefers-reduced-motion: reduce)', mobileStart);
  assert.ok(mobileStart >= 0 && mobileEnd > mobileStart, 'missing primary mobile composer styles');
  const mobileStyles = uiStyles.slice(mobileStart, mobileEnd);
  const ruleAfter = (selector) => {
    const selectorStart = mobileStyles.indexOf(selector);
    assert.ok(selectorStart >= 0, `missing mobile selector: ${selector}`);
    const open = mobileStyles.indexOf('{', selectorStart);
    const close = mobileStyles.indexOf('}', open);
    return mobileStyles.slice(open + 1, close);
  };
  for (const selector of [
    'body[data-theme="light"] .composer > .box,',
    'body[data-theme="dark"] .composer > .box,',
    'body[data-chat-bg="skin"] .composer > .box,',
    'body[data-chat-bg="custom"] .composer > .box,',
  ]) {
    const body = ruleAfter(selector);
    assert.match(body, /backdrop-filter:\s*none/);
    assert.match(body, /-webkit-backdrop-filter:\s*none/);
    assert.doesNotMatch(body, /blur\(/);
  }
  assert.match(
    uiStyles,
    /@media \(max-width:\s*820px\)[\s\S]*?\.main\.sideChatOpen > \.sideChatPane \.sideChatComposerBox\s*\{[^}]*backdrop-filter:\s*none;[^}]*-webkit-backdrop-filter:\s*none/s,
  );
});

test('mobile composer expands before opening the keyboard', () => {
  const expandedSource = sourceBetween('function setComposerExpanded', 'function scheduleComposerKeyboardFocusSync');
  const clickSource = sourceBetween("dropZone\\.addEventListener\\('click'", "document\\.addEventListener\\('click'");
  assert.match(inlineScript, /Focus synchronously inside the user gesture so mobile keyboards open without a delayed reflow/);
  assert.match(inlineScript, /try\{input\.focus\(\{preventScroll:true\}\)\}catch\{input\.focus\(\)\}/);
  assert.match(expandedSource, /if\(next&&focus&&input&&!input\.disabled&&document\.activeElement!==input\)/);
  assert.match(clickSource, /document\.activeElement===input/);
  assert.match(inlineScript, /__composerExpandClickGuard[\s\S]{0,520}event\.stopImmediatePropagation\(\)/);
  assert.match(inlineScript, /const wasCollapsed=dropZone\.classList\.contains\('composerCollapsed'\)/);
  assert.match(inlineScript, /const wasCollapsed=dropZone\.classList\.contains\('composerCollapsed'\);[\s\S]{0,520}if\(event\.target\.closest\('button,a,select,label,\.composerPopover'\)\)\{[\s\S]{0,120}if\(!wasCollapsed\)expandComposer\(\)/);
  assert.match(inlineScript, /if\(wasCollapsed\)\{[\s\S]{0,220}event\.preventDefault\(\);[\s\S]{0,120}expandComposer\(\);[\s\S]{0,80}\}else\{[\s\S]{0,100}expandComposer\(\{focus:true\}\)/);
  assert.match(inlineScript, /suppressClick:true/);
  assert.match(inlineScript, /if\(dropZone\.classList\.contains\('composerCollapsed'\)\)expandComposer\(\);[\s\S]{0,100}else expandComposer\(\{focus:true\}\)/);
  assert.match(inlineScript, /function toggleComposerSpeech\(\)\{[\s\S]{0,260}expandComposer\(\);/);
  assert.match(inlineScript, /event\.target\.closest\('button,a,select,label,\.composerPopover'\)/);
  assert.doesNotMatch(inlineScript, /event\.target\.closest\('button,a,input,select,textarea,label,\.composerPopover'\)/);
  assert.match(uiStyles, /Keep the caret available for the deliberate input tap after expansion/);
  assert.match(uiStyles, /pointer-events: none/);
});

test('keyboard lift keeps composer above the soft keyboard', () => {
  const overlaySource = sourceBetween('function updateComposerOverlayInset', 'function chatHasLayout');
  const visualViewportSource = sourceBetween('function composerVisualViewportBottom', 'function keepComposerAboveKeyboard');
  assert.match(inlineScript, /function keepComposerAboveKeyboard/);
  assert.match(visualViewportSource, /function composerVisualViewportBottom\(\)/);
  assert.match(visualViewportSource, /function syncComposerVisualViewport\(\)/);
  assert.match(inlineScript, /function composerKeyboardInset/);
  assert.match(inlineScript, /function enhanceComposerKeyboardLift/);
  assert.match(inlineScript, /visualViewport/);
  assert.match(inlineScript, /--keyboard-inset/);
  assert.match(inlineScript, /--composer-visual-viewport-bottom/);
  assert.match(inlineScript, /function scheduleComposerKeyboardFocusSync\(\)/);
  assert.match(inlineScript, /function scheduleComposerOverlayInset\(options=\{\}\)/);
  assert.match(inlineScript, /function scheduleComposerViewportSync\(\)/);
  assert.match(inlineScript, /__composerOverlayInsetOptions=\{/);
  assert.match(inlineScript, /__composerOverlayInsetSettleTimer=window\.setTimeout\(\(\)=>updateComposerOverlayInset\(\{scroll:true\}\),160\)/);
  assert.match(inlineScript, /followLatest:wasFollowing/);
  assert.match(overlaySource, /const chatBottom=chatRect&&chat\.clientHeight>0\?chatRect\.top\+chat\.clientHeight:viewportBottom/);
  assert.match(overlaySource, /const visibleOutput=Math\.max\(112,Math\.min\(180,Math\.round\(visualHeight\*0\.18\)\)\)/);
  assert.match(overlaySource, /document\.body\.classList\.contains\('keyboardOpen'\)/);
  assert.match(uiStyles, /bottom: var\(--keyboard-inset/);
  assert.match(uiStyles, /body\.keyboardOpen \.composer/);
  assert.match(uiStyles, /@media \(max-width: 820px\)[\s\S]*?body\.keyboardOpen \.chat\s*\{[^}]*--composer-overlay-height/s);
  assert.doesNotMatch(uiStyles, /@media \(max-width: 820px\)[\s\S]*?body\.keyboardOpen \.chat\s*\{[^}]*var\(--keyboard-inset/s);
  assert.match(uiStyles, /@media \(max-width: 820px\)[\s\S]*?body\.keyboardOpen \.app,\s*body\.keyboardOpen \.main\s*\{[^}]*height:\s*var\(--composer-visual-viewport-bottom, 100dvh\)/s);
  assert.match(uiStyles, /@media \(max-width: 820px\)[\s\S]*?body\.keyboardOpen \.main:not\(\.sideChatOpen\) > \.composer\s*\{[^}]*bottom:\s*0;[^}]*transition:\s*none/s);
  assert.match(uiStyles, /@media \(max-width: 820px\)[\s\S]*?body\.keyboardOpen \.main\.sideChatOpen > \.composer\s*\{[^}]*bottom:\s*0 !important;[^}]*transition:\s*none/s);
  assert.match(serverSource, /interactive-widget=resizes-content/);

  const visualStyles = new Map();
  let visualViewportWrites = 0;
  const syncVisualViewport = new Function(
    'document',
    'window',
    `${visualViewportSource}; return syncComposerVisualViewport;`,
  )(
    { body: { style: {
      getPropertyValue: (name) => visualStyles.get(name) || '',
      setProperty: (name, value) => { visualViewportWrites += 1; visualStyles.set(name, value); },
    } } },
    { innerHeight: 852, visualViewport: { offsetTop: 20, height: 506 } },
  );
  assert.equal(syncVisualViewport(), 526);
  assert.equal(visualStyles.get('--composer-visual-viewport-bottom'), '526px');
  assert.equal(syncVisualViewport(), 526);
  assert.equal(visualViewportWrites, 1);

  const makeOverlayHarness = (chatHeight) => {
    const styles = new Map([['--composer-overlay-height', '0']]);
    const body = {
      classList: { contains: (name) => name === 'keyboardOpen' },
      dataset: {},
      style: {
        getPropertyValue: (name) => styles.get(name) || '',
        setProperty: (name, value) => styles.set(name, value),
      },
    };
    const chat = {
      clientHeight: chatHeight,
      scrollHeight: 4000,
      scrollTop: 3900,
      getBoundingClientRect: () => ({ top: 100 }),
    };
    const composer = {
      offsetHeight: 280,
      getBoundingClientRect: () => ({ top: 520 }),
    };
    const update = new Function(
      'document',
      'dropZone',
      'chat',
      'window',
      'scrollChatToLatest',
      `${overlaySource}; return updateComposerOverlayInset;`,
    )(
      { body, querySelector: () => null },
      { parentElement: composer },
      chat,
      { innerHeight: 1500, visualViewport: { offsetTop: 0, height: 800 } },
      () => {},
    );
    return { height: update({ scroll: false }), chatHeight };
  };
  const resized = makeOverlayHarness(700);
  const unresized = makeOverlayHarness(1400);
  assert.equal(resized.height, 288);
  assert.equal(unresized.height, 988);
  assert.ok(resized.chatHeight - resized.height >= 112);
  assert.ok(unresized.chatHeight - unresized.height >= 112);
});

test('keyboard viewport resize keeps a following long chat pinned to its latest output', () => {
  const overlaySource = sourceBetween('function updateComposerOverlayInset', 'function chatHasLayout');
  const styles = new Map([['--composer-overlay-height', '190']]);
  let scrollCalls = 0;
  const body = {
    classList: { contains: (name) => name === 'keyboardOpen' },
    dataset: {},
    style: {
      getPropertyValue: (name) => styles.get(name) || '',
      setProperty: (name, value) => styles.set(name, value),
    },
  };
  const chat = {
    clientHeight: 470,
    scrollHeight: 3000,
    scrollTop: 2000,
    getBoundingClientRect: () => ({ top: 56 }),
  };
  const composer = {
    offsetHeight: 182,
    getBoundingClientRect: () => ({ top: 344 }),
  };
  const update = new Function(
    'document',
    'dropZone',
    'chat',
    'window',
    'scrollChatToLatest',
    `${overlaySource}; return updateComposerOverlayInset;`,
  )(
    { body, querySelector: () => null },
    { parentElement: composer },
    chat,
    { innerHeight: 852, visualViewport: { offsetTop: 0, height: 526 } },
    () => { scrollCalls += 1; },
  );

  assert.equal(update({ scroll: true }), 190);
  assert.equal(scrollCalls, 0);
  assert.equal(update({ scroll: true, followLatest: true }), 190);
  assert.equal(scrollCalls, 1);
});

test('mobile keyboard lift coalesces repeated viewport callbacks', () => {
  const keyboardSource = sourceBetween('function keepComposerAboveKeyboard', 'function enhanceComposerOverlayInset');
  const focusSyncSource = sourceBetween('function scheduleComposerKeyboardFocusSync', 'function scheduleComposerOverlayInset');
  const overlayRafSource = sourceBetween('function scheduleComposerOverlayInset', 'function scheduleComposerViewportSync');
  const viewportSyncSource = sourceBetween('function scheduleComposerViewportSync', 'function composerVisualViewportBottom');
  const overlayEnhancerSource = sourceBetween('function enhanceComposerOverlayInset', 'function enhanceComposerKeyboardLift');
  const keyboardLiftSource = sourceBetween('function enhanceComposerKeyboardLift', 'function expandComposer');
  assert.match(keyboardSource, /const previousInset=Number\.isFinite\(Number\(window\.__composerKeyboardInsetValue\)\)/);
  assert.match(keyboardSource, /if\(next===previousInset&&active===previousActive\)\{/);
  assert.match(keyboardSource, /syncComposerVisualViewport\(\);/);
  assert.match(keyboardSource, /const wasFollowing=distance<=Math\.max\(72,previousOverlay\+48\)/);
  assert.match(keyboardSource, /scheduleComposerOverlayInset\(\{scroll:true,followLatest:wasFollowing\}\)/);
  assert.match(keyboardSource, /scheduleComposerOverlayInset\(\{scroll:true,followLatest:true\}\)/);
  assert.match(viewportSyncSource, /if\(window\.__composerViewportSyncRaf\)return/);
  assert.match(overlayEnhancerSource, /window\.visualViewport\?\.addEventListener\('resize', scheduleViewport/);
  assert.doesNotMatch(keyboardLiftSource, /visualViewport\?\.addEventListener/);
  assert.doesNotMatch(keyboardSource, /scrollIntoView/);

  const scheduled = new Map();
  const updates = [];
  let nextRaf = 0;
  const scheduleOverlayInset = new Function(
    'window',
    'requestAnimationFrame',
    'updateComposerOverlayInset',
    `${overlayRafSource}; return scheduleComposerOverlayInset;`,
  )(
    {},
    (callback) => { const id = ++nextRaf; scheduled.set(id, callback); return id; },
    (options) => { updates.push(options); },
  );
  scheduleOverlayInset({ scroll: true });
  scheduleOverlayInset({ scroll: true, followLatest: true });
  assert.equal(scheduled.size, 1);
  scheduled.get(1)();
  assert.deepEqual(updates, [{ scroll: true, followLatest: true }]);

  const focusRafs = new Map();
  const focusTimers = new Map();
  const cancelledFocusRafs = [];
  const clearedFocusTimers = [];
  const focusSyncCalls = [];
  let nextFocusTask = 0;
  const focusedInput = {};
  const scheduleFocusSync = new Function(
    'window',
    'input',
    'document',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'keepComposerAboveKeyboard',
    `${focusSyncSource}; return scheduleComposerKeyboardFocusSync;`,
  )(
    {
      clearTimeout: (id) => { if(id){ clearedFocusTimers.push(id); focusTimers.delete(id); } },
      setTimeout: (callback) => { const id = ++nextFocusTask; focusTimers.set(id, callback); return id; },
    },
    focusedInput,
    { activeElement: focusedInput },
    (callback) => { const id = ++nextFocusTask; focusRafs.set(id, callback); return id; },
    (id) => { cancelledFocusRafs.push(id); focusRafs.delete(id); },
    (options) => { focusSyncCalls.push(options); },
  );
  scheduleFocusSync();
  scheduleFocusSync();
  assert.deepEqual(cancelledFocusRafs, [1]);
  assert.deepEqual(clearedFocusTimers, [2]);
  assert.equal(focusRafs.size, 1);
  assert.equal(focusTimers.size, 1);
  focusRafs.get(3)();
  focusTimers.get(4)();
  assert.deepEqual(focusSyncCalls, [{ force: true }, { force: true }]);

  const styles = new Map();
  let scrollCalls = 0;
  let refreshCalls = 0;
  let visualViewportSyncs = 0;
  let followLatest = null;
  const body = {
    classList: { toggle: () => {} },
    style: {
      getPropertyValue: (name) => styles.get(name) || '',
      setProperty: (name, value) => styles.set(name, value),
    },
  };
  const input = {};
  const keepComposerAboveKeyboard = new Function(
    'document',
    'dropZone',
    'chat',
    'window',
    'composerKeyboardInset',
    'composerChromeContains',
    'input',
    'syncComposerVisualViewport',
    'scheduleComposerOverlayInset',
    `${keyboardSource}; return keepComposerAboveKeyboard;`,
  )(
    { body, activeElement: input },
    { parentElement: {}, scrollIntoView: () => { scrollCalls += 1; } },
    { clientHeight: 400, scrollHeight: 1200, scrollTop: 800 },
    { clearTimeout: () => {}, setTimeout: () => 1 },
    () => 280,
    () => false,
    input,
    () => { visualViewportSyncs += 1; },
    (options) => { refreshCalls += 1; followLatest = options.followLatest; },
  );

  keepComposerAboveKeyboard({ force: true });
  keepComposerAboveKeyboard({ force: true });
  assert.equal(styles.get('--keyboard-inset'), '280px');
  assert.equal(scrollCalls, 0);
  assert.equal(refreshCalls, 1);
  assert.equal(followLatest, true);
  assert.equal(visualViewportSyncs, 2);
});

test('composer typing avoids full conversation redraws and stale command menu renders', () => {
  const inputListenerSource = sourceBetween("sendBtn\\?\\.addEventListener\\('click', send\\);", "attachFile\\?\\.addEventListener\\('click'");
  const submitSource = sourceBetween('function syncComposerSubmitControl', 'function syncComposerInputState');
  const inputStateSource = sourceBetween('function syncComposerInputState', 'function applyConversationMode');
  const slashSource = sourceBetween('async function syncComposerSlashMenuFromInput', 'function handleComposerSlashKeydown');
  const atSource = sourceBetween('async function syncComposerAtMenuFromInput', 'function handleComposerAtKeydown');

  assert.match(inputListenerSource, /syncComposerInputState\(\);syncComposerSlashMenuFromInput\(\);syncComposerAtMenuFromInput\(\)/);
  assert.doesNotMatch(inputListenerSource, /applyConversationMode\(\)/);
  assert.match(inputStateSource, /syncComposerSubmitControl\(\)/);
  assert.match(submitSource, /sendBtn\.disabled=/);
  assert.doesNotMatch(inputStateSource, /renderPromptQueue|renderThreadGoalBar|syncComposerChrome|updateComposerOverlayInset/);
  assert.match(slashSource, /const syncRevision=\+\+composerSlashSyncRevision/);
  assert.match(slashSource, /if\(composerSlashLoadedAt&&Date\.now\(\)-composerSlashLoadedAt<15000\)return/);
  assert.match(slashSource, /if\(syncRevision!==composerSlashSyncRevision\|\|!composerSlashMenuOpen\(\)\)return/);
  assert.match(atSource, /const syncRevision=\+\+composerAtSyncRevision/);
  assert.match(atSource, /if\(syncRevision!==composerAtSyncRevision\|\|!composerAtMenuOpen\(\)\)return/);
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
  assert.match(serverSource, /webRunActive&&native\?'排队消息':'向 Codex 提问'/);
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
  const agentSource = sourceBetween('function threadRunAgentItems', 'function mobileThreadGoalStatusLabel');
  const activeAgentApi = new Function(
    'turnProcessElements',
    `${agentSource}; return { threadRunActiveAgentItems };`,
  )([{
    classList: { contains: (name) => name === 'agentActivityGroup' },
    _agentActivityItems: [
      { dataset: { agentKey: 'reviewer', subagentThreadId: 'agent-uuid', traceState: 'done' } },
      { dataset: { agentKey: 'starting', traceState: 'starting' } },
      { dataset: { agentKey: '/root/reviewer', traceState: 'running' } },
      { dataset: { agentKey: 'ready', traceState: 'ready' } },
      { dataset: { agentKey: 'updated', traceState: 'updated' } },
      { dataset: { agentKey: 'done', traceState: 'done' } },
      { dataset: { agentKey: 'error', traceState: 'error' } },
      { dataset: { agentKey: 'interrupted', traceState: 'interrupted' } },
    ],
  }]);
  assert.deepEqual(activeAgentApi.threadRunActiveAgentItems().map((item) => item.dataset.agentKey), ['starting', '/root/reviewer']);
  const agentStatusSource = sourceBetween('function setSubagentTraceSummaryStatus', 'function setSubagentTraceNotice');
  let statusRenders = 0;
  const setSubagentTraceSummaryStatus = new Function(
    'updateAgentActivityGroupStatus',
    'renderThreadGoalBar',
    `${agentStatusSource}; return setSubagentTraceSummaryStatus;`,
  )(() => {}, () => { statusRenders += 1; });
  const traceState = {
    status: { textContent: '正在工作', dataset: { traceState: 'running' } },
    item: { dataset: { traceState: 'running' }, _agentActivityGroup: null },
  };
  setSubagentTraceSummaryStatus(traceState, '正在工作', 'running');
  assert.equal(statusRenders, 0);
  setSubagentTraceSummaryStatus(traceState, '已完成', 'done');
  assert.equal(statusRenders, 1);
  assert.match(inlineScript, /function toggleThreadRunMobilePanel\(panel\)/);
  assert.match(inlineScript, /toggleThreadRunMobilePanel\(panel\)[\s\S]*?renderThreadGoalBar\(\{scroll:false\}\)/);
  assert.match(inlineScript, /function renderThreadGoalBar\(options=\{\}\)/);
  assert.match(inlineScript, /function threadRunMobileFocusedPillClass\(\)/);
  assert.match(inlineScript, /function restoreThreadRunMobileFocus\(className\)/);
  assert.match(inlineScript, /const focusedPillClass=threadRunMobileFocusedPillClass\(\)/);
  assert.equal((inlineScript.match(/restoreThreadRunMobileFocus\(focusedPillClass\)/g) || []).length, 2);
  assert.match(inlineScript, /function createThreadRunGoalDetail\(goal\)/);
  assert.match(inlineScript, /function createThreadRunPlanDetail\(progress\)/);
  assert.match(inlineScript, /progress\.items\.forEach\(\(item,index\)=>\{/);
  assert.match(inlineScript, /function createThreadRunFilesDetail\(files\)/);
  assert.match(inlineScript, /function createThreadRunAgentsDetail\(agents\)/);
  assert.match(inlineScript, /function createThreadRunMobile\(goal\)/);
  assert.match(inlineScript, /threadRunMobileScrollLeft=viewport\.scrollLeft/);
  assert.match(inlineScript, /viewport\.scrollLeft=threadRunMobileScrollLeft/);
  assert.match(inlineScript, /if\(goal\)\{[\s\S]*?mobileThreadGoalStatusLabel\(goal\.status\)/);
  assert.match(inlineScript, /progress\.current\+'\/'\+progress\.total/);
  assert.match(inlineScript, /planPill\.setAttribute\('aria-controls','threadRunPlanDetail'\)/);
  assert.match(inlineScript, /threadRunMobilePanel==='plan'[\s\S]*?mobile\.appendChild\(createThreadRunPlanDetail\(progress\)\)/);
  assert.match(inlineScript, /const files=webRunActive\?editedFilesFromTurnArtifacts\(turnProcessElements\):\[\]/);
  assert.match(inlineScript, /threadRunMobilePill\('file-pen-line',files\.length\+' 个文件已更改','threadRunFilesPill',\{selected:filesSelected,expanded:filesSelected,handler:/);
  assert.match(inlineScript, /threadRunMobilePill\('bot',agentCount\+' 个智能体','threadRunAgentPill',\{selected:agentsSelected,expanded:agentsSelected,handler:/);
  assert.match(inlineScript, /filePill\.setAttribute\('aria-controls','threadRunFilesDetail'\)/);
  assert.match(inlineScript, /agentPill\.setAttribute\('aria-controls','threadRunAgentsDetail'\)/);
  assert.match(inlineScript, /const agents=webRunActive\?threadRunActiveAgentItems\(\):\[\]/);
  assert.match(inlineScript, /const runtimeOnly=webRunActive&&!showGoal&&Boolean\(progress\.total\|\|files\.length\|\|agentCount\)/);
  assert.match(inlineScript, /const show=showGoal\|\|runtimeOnly/);
  assert.match(inlineScript, /threadGoalBar\.classList\.toggle\('runtimeOnly',runtimeOnly\)/);
  assert.match(inlineScript, /if\(runtimeOnly\)\{[\s\S]*?threadGoalBar\.appendChild\(createThreadRunMobile\(null\)\)/);
  assert.match(inlineScript, /threadGoalActionButton\('pencil','编辑目标',editCurrentThreadGoal,'threadRunGoalAction'\)/);
  assert.match(inlineScript, /threadGoalActionButton\(active\?'pause':'play',active\?'暂停目标':'恢复目标'/);
  assert.match(inlineScript, /threadGoalActionButton\('trash-2','清除目标',[\s\S]*?'threadRunGoalAction isDanger'\)/);
  assert.match(mobileGoalStyles, /\.threadRunPillsViewport\s*\{[^}]*overflow-x:\s*auto;[^}]*scrollbar-width:\s*none/s);
  assert.match(mobileGoalStyles, /\.threadRunPills\s*\{[^}]*display:\s*flex;[^}]*width:\s*max-content;[^}]*gap:\s*6px/s);
  assert.match(mobileGoalStyles, /\.threadRunPills\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s);
  assert.match(mobileGoalStyles, /body \.threadRunPill,[\s\S]*?body \.threadRunPill:focus\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s);
  assert.match(mobileGoalStyles, /body \.threadRunPill\.isSelected,[\s\S]*?background:\s*var\(--text\);[^}]*box-shadow:\s*none;[^}]*color:\s*var\(--canvas\)/s);
  assert.match(mobileGoalStyles, /\.threadRunMobile\s*\{[^}]*position:\s*relative/s);
  assert.match(mobileGoalStyles, /body \.threadRunPill,[\s\S]*?height:\s*34px;[^}]*font-size:\s*11\.5px/s);
  assert.match(mobileGoalStyles, /\.threadRunDetail\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*3;[^}]*bottom:\s*calc\(100% \+ 10px\);[^}]*width:\s*min\(560px, calc\(100% - 36px\)\);[^}]*border-radius:\s*14px/s);
  assert.match(mobileGoalStyles, /\.threadRunGoalDetail\s*\{[^}]*min-height:\s*72px;[^}]*padding:\s*10px 10px 6px 12px/s);
  assert.match(mobileGoalStyles, /\.threadRunGoalActions\s*\{[^}]*justify-content:\s*flex-end/s);
  assert.match(mobileGoalStyles, /\.threadRunPlanDetail\s*\{[^}]*max-height:\s*min\(32vh, 200px\);[^}]*padding:\s*8px 10px/s);
  assert.match(mobileGoalStyles, /\.threadRunPlanStep\s*\{[^}]*min-height:\s*30px;[^}]*grid-template-columns:\s*18px 21px minmax\(0, 1fr\)/s);
  assert.match(mobileGoalStyles, /\.threadRunFilesDetail,[\s\S]*?\.threadRunAgentsDetail\s*\{[^}]*max-height:\s*min\(32vh, 200px\);[^}]*overflow:\s*hidden auto/s);
  assert.match(mobileGoalStyles, /\.threadRunFileRow,[\s\S]*?\.threadRunAgentRow\s*\{[^}]*grid-template-columns:\s*18px minmax\(0, 1fr\) auto/s);
  assert.match(mobileGoalStyles, /@media \(max-width:\s*360px\)[\s\S]*?\.threadRunDetail\s*\{[^}]*width:\s*min\(560px, calc\(100% - 20px\)\)/s);
  assert.match(mobileGoalStyles, /@media \(max-width:\s*360px\)[\s\S]*?\.threadRunPills\s*\{[^}]*padding-inline:\s*6px/s);
  assert.match(mobileGoalStyles, /body \.composer > \.editedFilesResult\.live\s*\{\s*display:\s*none;/s);
  assert.match(uiStyles, /\.threadGoalBar\.runtimeOnly\s*\{\s*display:\s*none;/s);
  assert.match(mobileGoalStyles, /body \.composer > \.threadGoalBar\.runtimeOnly,[\s\S]*?display:\s*block;/s);
  const refreshFilesSource = sourceBetween('function refreshLiveEditedFilesResult', 'function createWebPreviewResultCard');
  assert.equal((refreshFilesSource.match(/renderThreadGoalBar\(\)/g) || []).length, 2);
  assert.match(serverSource, /ui\.css\?v=quota-header-align-20260808b/);
});

test('desktop live plan stays a compact pill with an on-demand detail popup', () => {
  assert.match(inlineScript, /head\.setAttribute\('aria-label','任务步骤'\)/);
  assert.doesNotMatch(inlineScript, /tooltip\.setAttribute\('role','tooltip'\)/);
  assert.match(uiStyles, /\.editedFilesResult\.withPlan\s*\{[^}]*width:\s*max-content;[^}]*overflow:\s*visible/s);
  assert.match(uiStyles, /\.editedFilesResult\.withPlan > \.turnResultHead\s*\{[^}]*position:\s*relative;[^}]*display:\s*inline-flex;[^}]*width:\s*max-content/s);
  assert.match(uiStyles, /\.turnPlanTooltip\s*\{[^}]*position:\s*absolute;[^}]*bottom:\s*calc\(100% \+ 8px\);[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;[^}]*visibility:\s*hidden/s);
  assert.match(uiStyles, /\.editedFilesResult\.withPlan:hover \.turnPlanTooltip,[\s\S]*?\.editedFilesResult\.withPlan:focus-within \.turnPlanTooltip\s*\{[^}]*opacity:\s*1;[^}]*visibility:\s*visible/s);
  assert.doesNotMatch(uiStyles, /body \.composer > \.editedFilesResult\.live\.withPlan \.turnPlanTooltip\s*\{[^}]*position:\s*static/s);
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

test('conversation load defers bottom alignment until the chat is laid out and pins through late height growth', () => {
  const layoutSource = sourceBetween('function chatHasLayout', 'function scrollChatToLatest');
  const alignSource = sourceBetween('function alignChatToBottomStable', 'async function loadConversation');
  const loadConversation = sourceBetween('async function loadConversation', 'function updateConversationStatus');
  assert.match(loadConversation, /scrollChatToLatest\(\{force:true\}\);\s*alignChatToBottomStable\(12,seq\)/);
  assert.doesNotMatch(loadConversation, /\[120,320,800\]/);
  let visible = false;
  let height = 0;
  let scrollTopValue = 0;
  const writes = [];
  const rafQueue = [];
  const timerQueue = [];
  const chat = {
    classList: { contains: () => !visible },
    getBoundingClientRect: () => (visible ? { width: 800, height: 600 } : { width: 0, height: 0 }),
    get scrollHeight() { return height; },
    set scrollTop(value) { scrollTopValue = value; writes.push(value); },
    get scrollTop() { return scrollTopValue; },
  };
  const api = new Function(
    'chat',
    'requestAnimationFrame',
    'setTimeout',
    'updateComposerOverlayInset',
    `let nativeLiveFollowBottom = true;\n${layoutSource}\n${alignSource}\nreturn { align: alignChatToBottomStable, setFollow(value){ nativeLiveFollowBottom = value; } };`,
  )(chat, (cb) => rafQueue.push(cb), (cb) => timerQueue.push(cb), () => {}, );
  const drain = (count) => {
    for (let i = 0; i < count; i += 1) {
      const cb = rafQueue.shift() || timerQueue.shift();
      if (!cb) break;
      cb();
    }
  };

  api.align();
  assert.deepEqual(writes, [], 'hidden chat must not receive a scrollTop write');
  drain(1);
  assert.deepEqual(writes, [], 'still hidden: alignment keeps deferring');
  visible = true;
  height = 500;
  drain(1);
  assert.equal(scrollTopValue, 500, 'visible chat aligns to the current bottom');
  height = 1000;
  drain(1);
  assert.equal(scrollTopValue, 1000, 'late height growth is re-pinned to the bottom');
  drain(2);
  const afterStable = writes.length;
  drain(2);
  assert.equal(writes.length, afterStable, 'stable height stops further scroll writes');

  writes.length = 0;
  rafQueue.length = 0;
  timerQueue.length = 0;
  scrollTopValue = 0;
  visible = true;
  height = 800;
  api.align();
  drain(1);
  assert.equal(scrollTopValue, 800);
  api.setFollow(false);
  height = 1200;
  drain(1);
  assert.equal(writes.length, 1, 'user scrolling away stops the alignment loop');
});
