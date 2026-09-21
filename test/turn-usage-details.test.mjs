import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NativeSessionStore } from '../native-sessions.mjs';
import { estimateTokenCost } from '../cycle-usage.mjs';

test('API equivalent pricing excludes cached input from normal input and refuses missing data',()=>{
  assert.equal(estimateTokenCost('gpt-6-astra',1000,800,200),.0128);
  assert.equal(estimateTokenCost('unknown',1000,800,200),null);
  assert.equal(estimateTokenCost('gpt-6-astra',1000,null,200),null);
  assert.equal(estimateTokenCost('gpt-6-astra',1000,1001,200),null);
});

test('each completed turn retains its own model, cache details and estimate',async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'turn-usage-'));
  const id='019fa850-285e-7fb0-9734-13aa71810dc6';
  let store;
  const records=[];
  const add=(type,payload)=>records.push(JSON.stringify({type,payload,timestamp:new Date().toISOString()}));
  const start=(turn,model)=>{add('event_msg',{type:'task_started',turn_id:turn});add('turn_context',{turn_id:turn,model});};
  const usage=(input,cached,output,total)=>{
    const last={input_tokens:input,output_tokens:output,total_tokens:input+output};
    if(cached!==null)last.cached_input_tokens=cached;
    add('event_msg',{type:'token_count',info:{last_token_usage:last,total_token_usage:total}});
  };
  try{
    await mkdir(path.join(home,'sessions'));
    add('session_meta',{id,source:'vscode',cwd:home,model_provider:'openai'});
    start('one','gpt-6-astra');
    usage(1000,800,200,{input_tokens:1000,cached_input_tokens:800,output_tokens:200,total_tokens:1200});
    add('event_msg',{type:'task_complete',turn_id:'one'});
    start('two','gpt-5.6-terra');
    usage(100,20,30,{input_tokens:1100,cached_input_tokens:820,output_tokens:230,total_tokens:1330});
    add('event_msg',{type:'task_complete',turn_id:'two'});
    start('three','gpt-6-astra');
    usage(100,null,10,{input_tokens:1200,output_tokens:240,total_tokens:1440});
    add('event_msg',{type:'turn_aborted',turn_id:'three'});
    start('four','gpt-6-astra');
    usage(100,10,10,{input_tokens:1300,cached_input_tokens:830,output_tokens:250,total_tokens:1550});
    add('turn_context',{turn_id:'four',model:'gpt-5.6-terra'});
    usage(100,10,10,{input_tokens:1400,cached_input_tokens:840,output_tokens:260,total_tokens:1660});
    add('event_msg',{type:'task_complete',turn_id:'four'});
    await writeFile(path.join(home,'sessions','rollout-'+id+'.jsonl'),records.join('\n')+'\n');
    store=new NativeSessionStore(home,{watchChanges:false});
    const messages=store.get(id).messages;
    const details=turn=>messages.find(m=>m.turnId===turn&&['task_complete','turn_aborted'].includes(m.kind)).tokenUsageDetails;
    assert.equal(details('one').estimatedUsd,.0128);
    assert.equal(details('one').cacheHitPercent,80);
    assert.deepEqual(details('one').models,['gpt-6-astra']);
    assert.equal(details('two').inputTokens,100);
    assert.equal(details('two').estimatedUsd,.000524);
    assert.equal(details('three').cachedInputTokens,null);
    assert.equal(details('three').estimatedUsd,null);
    assert.equal(details('four').models.length,2);
    assert.equal(details('four').estimatedUsd,null);
  }finally{store?.stop();await rm(home,{recursive:true,force:true});}
});
