import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createCycleUsageReader, usageDelta } from '../cycle-usage.mjs';

test('usage deltas deduplicate snapshots and handle counter resets', () => {
  const old = {input_tokens:100,output_tokens:20,cached_input_tokens:50};
  assert.deepEqual(usageDelta(old,old),{input:0,output:0,cached:0});
  assert.deepEqual(usageDelta(old,{input_tokens:150,output_tokens:30,cached_input_tokens:70}),{input:50,output:10,cached:20});
  assert.deepEqual(usageDelta(old,{input_tokens:10,output_tokens:2,cached_input_tokens:5}),{input:10,output:2,cached:5});
});

test('cycle-only accounting, fork inheritance, provider filtering, warm cache and full-quota reset', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'codex-cycle-'));
  const cache=path.join(root,'cache.json');
  const start=Math.floor(Date.now()/1000)*1000-3600000;
  const quota={valid:true,windows:[{id:'codex',remainingPercent:93,windowDurationMins:10080,resetsAt:(start+604800000)/1000}]};
  const line = e=>JSON.stringify(e)+'\n';
  const token=(at,input,cached,output)=>line({type:'event_msg',timestamp:new Date(at).toISOString(),payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:output}}}});
  const context=line({type:'turn_context',payload:{model:'gpt-6-astra'}});
  try {
    await mkdir(path.join(root,'sessions'));await mkdir(path.join(root,'archived_sessions'));
    const parent=line({type:'session_meta',payload:{id:'parent',model_provider:'openai'}})+context+token(start-1000,100,20,10)+token(start+1000,150,40,20)+token(start+2000,150,40,20);
    await writeFile(path.join(root,'sessions','parent.jsonl'),parent);
    await writeFile(path.join(root,'archived_sessions','parent.jsonl'),parent);
    const fork=line({type:'session_meta',payload:{id:'child',forked_from_id:'parent',timestamp:new Date(start+3000).toISOString(),model_provider:'openai'}})+context+token(start+1000,150,40,20)+token(start+4000,170,50,25);
    await writeFile(path.join(root,'sessions','child.jsonl'),fork);
    await writeFile(path.join(root,'sessions','proxy.jsonl'),line({type:'session_meta',payload:{id:'proxy',model_provider:'custom'}})+context+token(start+1000,999999,1,10));
    const read=createCycleUsageReader(root,cache);
    assert.equal(read(quota).loading,true);
    await read.settled();
    const result=read(quota);
    assert.equal(result.totalTokens,85);
    assert.equal(result.cachedInputTokens,30);
    assert.equal(result.estimatedUsd,(40*10+30+15*50)/1e6);
    const warm=createCycleUsageReader(root,cache);
    assert.equal(warm(quota).totalTokens,85);
    await warm.settled();
    const full={...quota,windows:[{...quota.windows[0],remainingPercent:100}]};
    assert.equal(warm(full).totalTokens,0);
    await warm.settled();
    const stored=JSON.parse(await readFile(cache,'utf8'));
    assert.deepEqual(stored.files,[]);
    assert.equal(stored.value.totalTokens,0);
    const newCycle={...quota,windows:[{...quota.windows[0],resetsAt:quota.windows[0].resetsAt+604800}]};
    warm(newCycle);await warm.settled();assert.equal(warm(newCycle).totalTokens,0);
  } finally {await rm(root,{recursive:true,force:true});}
});
