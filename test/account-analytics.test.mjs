import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAccountAnalyticsReader, normalizeAccountAnalytics } from '../account-analytics.mjs';

const now=Date.parse('2026-09-08T13:00:00Z');
const window={reset_at:Date.parse('2026-09-15T01:00:00Z')/1000,limit_window_seconds:604800,used_percent:30};
const payload={balance_unit:'credit',group_by:'day',data:[{date:'2026-09-08',totals:{credits:15026.213426,cached_text_input_tokens:228130432,uncached_text_input_tokens:8621784,text_output_tokens:483154,text_total_tokens:237235370,turns:0}}]};

test('native official totals match Meter conventions and do not confuse spent value with projected value',()=>{
  const value=normalizeAccountAnalytics(payload,window,now);
  assert.equal(value.totalTokens,237235370);
  assert.equal(value.creditEquivalentUsd.toFixed(2),'601.05');
  assert.equal(value.projectedUsd.toFixed(2),'2003.50');
  assert.equal(value.cacheHitPercent.toFixed(2),'96.36');
  assert.equal(value.startDate,'2026-09-08');
  const noSpend=normalizeAccountAnalytics(payload,{...window,used_percent:0},now);
  assert.equal(noSpend.projectedCredits,null);
  const missing=normalizeAccountAnalytics({...payload,data:[{date:'2026-09-08',totals:{credits:1}}]},window,now);
  assert.equal(missing.totalTokens,null);assert.equal(missing.cacheHitPercent,null);
  assert.throws(()=>normalizeAccountAnalytics({...payload,data:[...payload.data,...payload.data]},window,now),/格式/);
  assert.throws(()=>normalizeAccountAnalytics({...payload,balance_unit:'USD'},window,now),/格式/);
});

test('official reader uses only server credentials, caches per account and refuses switched identity',async()=>{
  const home=await mkdtemp(path.join(tmpdir(),'account-analytics-'));
  const auth=id=>writeFile(path.join(home,'auth.json'),JSON.stringify({tokens:{account_id:id,access_token:'dummy-secret-'+id}}));
  let calls=0, switchDuringDaily=false;
  try{
    await auth('A');
    const read=createAccountAnalyticsReader(home,{now:()=>now,fetchImpl:async(url,options)=>{
      calls++;
      assert.equal(new URL(url).origin,'https://chatgpt.com');
      assert.equal(options.redirect,'error');
      const id=options.headers['ChatGPT-Account-Id'];
      assert.equal(options.headers.Authorization,'Bearer dummy-secret-'+id);
      if(url.endsWith('/usage'))return Response.json({account_id:id,rate_limit:{primary_window:window}});
      assert.match(url,/start_date=2026-09-08/);
      if(switchDuringDaily)await auth('B');
      return Response.json(payload);
    }});
    const first=await read();assert.equal(first.available,true);assert.equal(calls,2);
    await read();assert.equal(calls,2);
    assert.doesNotMatch(JSON.stringify(first),/dummy-secret|Authorization|account_id/);
    switchDuringDaily=true;
    const switched=await read({refresh:true});assert.equal(switched.available,false);assert.match(switched.error,/账号已切换/);
    switchDuringDaily=false;
    const second=await read();assert.equal(second.available,true);assert.equal(calls,6);
    const denied=createAccountAnalyticsReader(home,{now:()=>now,fetchImpl:async()=>new Response('dummy-secret-A',{status:401})});
    const failure=await denied();assert.equal(failure.available,false);assert.match(failure.error,/401/);assert.doesNotMatch(failure.error,/dummy-secret/);
  }finally{await rm(home,{recursive:true,force:true});}
});
