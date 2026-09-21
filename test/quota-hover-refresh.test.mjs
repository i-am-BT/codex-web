import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('hover refresh runs at most once per minute, including repeated entries',async()=>{
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('let lastSubQuotaHoverRefreshAt='),source.indexOf('function hideSubQuotaPreview(){'));
  let hidden=true,now=0;const calls=[];
  const show=new Function('subQuotaPopover','subQuotaToggle','cancelSubQuotaPreviewHide','startSubQuotaCountdowns','loadSubQuota','Date',code+';return showSubQuotaPreview;')(
    {classList:{contains:()=>hidden,remove:()=>{hidden=false}}},{dataset:{},setAttribute:()=>{}},()=>{},()=>{},options=>calls.push(options),{now:()=>now});
  show();assert.deepEqual(calls,[{refresh:true}]);
  for(const time of [1,1000,59000,59999]){now=time;hidden=true;show();}
  assert.equal(calls.length,1);
  now=60000;hidden=true;show();assert.equal(calls.length,2);
  now=120000;show();assert.equal(calls.length,2,'staying open does not refresh');
  hidden=true;show();assert.equal(calls.length,3);
});
