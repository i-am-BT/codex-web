import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('queue events deferred during writes remove consumed items and reject stale revisions', async () => {
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('const deferredPromptQueueEvents='),source.indexOf('function createQueuedPrompt('));
  const busy=new Map([['thread',true]]),revisions=new Map(),timers=[],renders=[];
  const apply=new Function('promptQueueServerSyncInflight','promptQueueServerSyncTimers','promptQueueOrderSyncing','promptQueueOrderIntents','promptQueueServerRevisions','setTimeout','setPromptQueuePauseLocal','applyPromptQueueLocal',
    'let promptQueueRemoteSyncing=false;'+code+';return applyRemotePromptQueueEvent;')(
    busy,new Map(),new Map(),new Map(),revisions,fn=>timers.push(fn),()=>{},(_id,items)=>renders.push(items));
  apply({threadId:'thread',revision:8,items:[{id:'old'}]});
  apply({threadId:'thread',revision:9,items:[]});
  assert.equal(timers.length,1);assert.equal(renders.length,0);
  busy.clear();timers.shift()();
  assert.deepEqual(renders,[[]]);assert.equal(revisions.get('thread'),9);
  apply({threadId:'thread',revision:8,items:[{id:'old'}]});
  assert.deepEqual(renders,[[]]);
});
