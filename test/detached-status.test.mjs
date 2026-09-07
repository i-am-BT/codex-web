import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('detached status lookup is read-only and ignores a newer turn', async () => {
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  const start=source.indexOf('async function reconcileDetachedNativeTurn(');
  const end=source.indexOf('\nasync function respondToNativeRequest(',start);
  const code=source.slice(start,end);
  let current={status:'running',latestTurnId:'turn-a'};
  const calls=[];
  const read=new Function('nativeConversationHasFreshRunningActivity','CodexAppServerClient','CODEX_BIN','CODEX_PROCESS_HOME','buildCodexProcessEnvironment','NATIVE_TURN_STATUS_SYNC_TIMEOUT_MS','nativeSessions','appServerLoadedThreads','nativeTurnStatus','applyAppServerTurnStatus',code+';return reconcileDetachedNativeTurn;')(
    ()=>false,function(){return {request:async method=>{calls.push(method);return{data:[{id:'turn-a',status:'interrupted'}]}},close:async()=>calls.push('close')}},'codex','/tmp',()=>({}),1000,
    {get:()=>current},new Map(),status=>status,(_id,_turn,_latest,options)=>{calls.push(options);return true});
  assert.equal(await read('thread',current),true);
  assert.deepEqual(calls,['thread/turns/list','close',{passive:true}]);
  calls.length=0;
  const previous=current;current={status:'running',latestTurnId:'turn-b'};
  assert.equal(await read('thread',previous),false);
  assert.deepEqual(calls,['thread/turns/list','close']);
});
