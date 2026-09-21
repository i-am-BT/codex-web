import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCycleUsageReader } from '../cycle-usage.mjs';
import { createHash } from 'node:crypto';

test('cycle accounting follows provider switches and isolates account changes across restart', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'cycle-attribution-'));
  const start=Date.now()-3600000;
  const quota={valid:true,windows:[{id:'codex',remainingPercent:90,windowDurationMins:10080,resetsAt:Math.floor((start+604800000)/1000)}]};
  const line=(type,payload,at=start+10000)=>JSON.stringify({type,payload,timestamp:new Date(at).toISOString()})+'\n';
  const context=line('turn_context',{model:'gpt-6-astra'});
  const token=(n,at)=>line('event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:n,output_tokens:0,cached_input_tokens:0}}},at);
  const change=(provider,at)=>line('event_msg',{type:'thread_settings_applied',thread_settings:{model_provider:provider}},at);
  const cache=path.join(root,'cache.json');
  try {
    await mkdir(path.join(root,'sessions'));
    await writeFile(path.join(root,'auth.json'),JSON.stringify({tokens:{account_id:'account-a'}}));
    await writeFile(cache,JSON.stringify({key:createHash('sha256').update('account-a').digest('hex')+':'+quota.windows[0].resetsAt*1000}));
    await writeFile(path.join(root,'sessions','first.jsonl'),line('session_meta',{id:'first',model_provider:'openai'})+context
      +token(100,start+20000)+change('custom',start+30000)+token(500,start+40000));
    await writeFile(path.join(root,'sessions','second.jsonl'),line('session_meta',{id:'second',model_provider:'custom'})+context
      +token(50,start+20000)+change('openai',start+30000)+token(70,start+40000));
    // A provider switch preceding the cycle must also determine the initial baseline.
    await writeFile(path.join(root,'sessions','third.jsonl'),line('session_meta',{id:'third',model_provider:'openai'})
      +context+change('custom',start-3000)+token(100,start-2000)+token(500,start+40000));
    const first=createCycleUsageReader(root,cache);first(quota);await first.settled();
    assert.equal(first(quota).totalTokens,120);
    await writeFile(path.join(root,'auth.json'),JSON.stringify({tokens:{account_id:'account-b'}}));
    const restarted=createCycleUsageReader(root,cache);restarted(quota);await restarted.settled();
    assert.equal(restarted(quota).totalTokens,0);
    const sameAccount=createCycleUsageReader(root,cache);sameAccount(quota);await sameAccount.settled();
    assert.equal(sameAccount(quota).totalTokens,0);
    const cold=createCycleUsageReader(root,path.join(root,'unobserved-account-cache.json'));
    cold(quota);await cold.settled();
    assert.equal(cold(quota).totalTokens,0,'unattributed history must not be charged to an account on first observation');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('pre-cycle lookup stops after 2 MiB even when a large tool result hides the context', async () => {
  const source=await readFile(new URL('../cycle-usage.mjs',import.meta.url),'utf8');
  const helpers=source.slice(source.indexOf('const parse ='),source.indexOf('export function usageDelta('));
  const start=source.indexOf('async function findStart(');
  const end=source.indexOf('export function createCycleUsageReader(',start);
  assert.ok(start>=0&&end>start);
  const since=Date.now();
  const line=(type,payload,at)=>JSON.stringify({type,payload,timestamp:new Date(at).toISOString()})+'\n';
  const prefix=Buffer.from(
    line('session_meta',{model_provider:'openai'},since-30000)
    +line('turn_context',{model:'gpt-6-astra',model_provider:'openai'},since-20000)
    +line('response_item',{text:'x'.repeat(4*1024*1024)},since-15000),
  );
  const baseline=Buffer.from(line('event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:100,output_tokens:0}}},since-10000));
  const currentCycle=Buffer.from(line('event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:120,output_tokens:0}}},since+10000));
  const contents=Buffer.concat([prefix,baseline,currentCycle]);
  let bytesRead=0;
  let closed=false;
  const findStart=new Function('open','Buffer',helpers+source.slice(start,end)+';return findStart;')(
    async()=>({
      async read(buffer,offset,count,position){
        const read=contents.copy(buffer,offset,position,position+count);
        bytesRead+=read;
        return {bytesRead:read};
      },
      async close(){closed=true;},
    }),
    Buffer,
  );
  const result=await findStart('memory.jsonl',contents.length,since,'openai');
  assert.deepEqual(result,{offset:prefix.length,provider:''});
  // The mandatory suffix contains the baseline event itself and current-cycle events.
  const suffixBytes=baseline.length+currentCycle.length;
  assert.ok(bytesRead<=2*1024*1024+suffixBytes,`${bytesRead} bytes exceeded the bounded lookup`);
  assert.ok(bytesRead<contents.length,'old tool output must not be scanned back to its context');
  assert.equal(closed,true);
});
