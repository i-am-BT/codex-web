import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('a late fork response does not redirect another conversation or overwrite its draft',async()=>{
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  const start=source.indexOf('async function forkNativeConversation('),end=source.indexOf('function isCompletedNativeRuntimeTurn(',start);
  let finish;const response=new Promise(resolve=>{finish=resolve});
  const status={textContent:''},input={value:'A draft'},notices=[];
  const env={statusEl:status,input,provider:{value:'p'},model:{value:'m'},reasoningEffort:{value:'low'},composerServiceTier:null,cwd:{value:'/work'},
    composerPermissionPayload:()=>({}),fetch:()=>response,setNativeForkMarker:()=>{},refreshHistory:async()=>{},showForkToast:text=>notices.push(text)};
  const api=new Function(...Object.keys(env),'let currentConversationId="A",currentConversationSource="codex",conversationLoadSeq=1,nativeForkCreating=false;'+source.slice(start,end)+';return {forkNativeConversation,switchAway(){currentConversationId="B";conversationLoadSeq++;input.value="B draft";statusEl.textContent="B ready"},id:()=>currentConversationId};')(...Object.values(env));
  const pending=api.forkNativeConversation(1);api.switchAway();
  finish({ok:true,json:async()=>({threadId:'child',conversation:{messages:[]}})});await pending;
  assert.equal(api.id(),'B');assert.equal(input.value,'B draft');assert.equal(status.textContent,'B ready');assert.match(notices[0],/任务列表/);
});

test('fork a completed boundary while source runs, rejecting current and stale boundaries',async()=>{
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  const start=source.indexOf("app.post('/api/native-sessions/:id/fork'");
  const end=source.indexOf("app.post('/api/native-sessions',",start);
  let handler;const calls=[];
  const thread={status:'running',latestTurnId:'new',metadata:{},messages:[
    {seq:1,role:'assistant',turnId:'old',content:'finished'},
    {seq:2,role:'user',turnId:'new',previousTurnId:'old',content:'draft'},
    {seq:3,role:'assistant',turnId:'new',content:'partial'},
  ]};
  const env={app:{post:(_path,_auth,fn)=>{handler=fn}},requireAuth:()=>{},cleanNativeThreadId:x=>String(x||''),
    nativeSessions:{get:id=>id==='source'?thread:{id:'fork',messages:[]},refresh:()=>{}},
    nativeActiveTurnFor:()=>({status:'running',turnId:'new'}),parseNativeThreadSettings:()=>({cwd:'/work'}),
    requestNativeHistoryFork:async(method,params)=>{calls.push({method,params});return{thread:{id:'fork'}}},
    compactObjectWithServiceTier:params=>params,decorateNativeConversation:x=>x,nativeConversationFromThread:x=>x,
    extractUserDraft:x=>x,nativeAppErrorStatus:()=>500};
  new Function(...Object.keys(env),source.slice(start,end))(...Object.values(env));
  const run=async body=>{const res={statusCode:200,status(n){this.statusCode=n;return this},json(value){this.body=value;return this}};await handler({params:{id:'source'},body},res);return res};
  assert.equal((await run({messageSeq:1,turnId:'old',role:'assistant'})).statusCode,201);
  assert.equal(calls[0].params.lastTurnId,'old');
  assert.equal((await run({messageSeq:3,turnId:'new',role:'assistant'})).statusCode,409);
  assert.equal((await run({messageSeq:1,turnId:'stale',role:'assistant'})).statusCode,409);
  assert.equal(calls.length,1);
  const userFork=await run({messageSeq:2,turnId:'new',role:'user'});
  assert.equal(userFork.statusCode,201);assert.equal(userFork.body.draft,'draft');
});

test('fork uses a dedicated client and unsubscribes only the newly created thread',async()=>{
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  const start=source.indexOf('async function requestNativeHistoryFork('),end=source.indexOf("app.post('/api/native-sessions/:id/fork'",start);
  const calls=[];
  const run=new Function('CodexAppServerClient','CODEX_BIN','CODEX_PROCESS_HOME','buildCodexProcessEnvironment','APP_SERVER_REQUEST_TIMEOUT_MS','cleanNativeThreadId',source.slice(start,end)+';return requestNativeHistoryFork;')(
    class{async request(method,params){calls.push([method,params.threadId]);return{thread:{id:'child'}}}async close(){calls.push(['close'])}},'codex','/tmp',()=>({}),1000,x=>String(x||''));
  await run('thread/fork',{threadId:'parent',lastTurnId:'old'});
  assert.deepEqual(calls,[['thread/fork','parent'],['thread/unsubscribe','child'],['close']]);
});
