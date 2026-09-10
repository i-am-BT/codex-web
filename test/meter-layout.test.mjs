import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('Meter detail has six reference cards, visible daily totals and working export controls',async()=>{
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function codexMeterCompact('),source.indexOf('async function syncCodexAppCredits('));
  const all=[],downloads=[];let exported;
  const element=tag=>{const el={tag,children:[],style:{},attributes:{},events:{},setAttribute(k,v){this.attributes[k]=v},append(...items){this.children.push(...items)},appendChild(item){this.children.push(item);return item},addEventListener(k,v){this.events[k]=v},click(){downloads.push(this.download)}};all.push(el);return el};
  const api=new Function('document','refreshIcons','setIconLabel','syncCodexAppCredits','URL','Blob','setTimeout',code+';return {renderCodexMeter,codexMeterCompact,exportCodexMeter,appendCodexCycleUsage};')(
    {createElement:element},()=>{},(el,_icon,label)=>{el.textContent=label},async()=>{},
    {createObjectURL:blob=>{exported=blob;return 'blob:test'},revokeObjectURL:()=>{}},Blob,()=>{});
  const stats={available:true,remainingPercent:67,creditsUsed:15026.213426,totalTokens:237235370,inputTokens:236752216,cachedInputTokens:228130432,cacheHitPercent:96.3583,projectedCredits:45533.98,projectedUsd:1821.36,projectionConfidence:'medium',startDate:'2026-09-08',daily:[{date:'2026-09-08',credits:15026.213426,totalTokens:237235370,inputTokens:236752216,cachedInputTokens:228130432,outputTokens:483154,turns:0}]};
  const parent=element('div');api.renderCodexMeter(parent,stats);
  assert.equal(all.filter(el=>el.className==='codexMeterCard').length,6);
  assert.deepEqual(all.filter(el=>el.className==='codexMeterValue').map(el=>el.textContent),['67.0%','15026.21','237.24M','~45534','96.4%','$ 1821.36']);
  assert.ok(all.some(el=>el.tag==='tfoot'));
  assert.equal(all.filter(el=>el.tag==='details').length,0,'daily data must not start collapsed');
  const csv=all.find(el=>el.tag==='button'&&el.textContent==='CSV');csv.events.click();
  assert.equal(downloads[0],'codex-meter-2026-09-08.csv');assert.match(await exported.text(),/"2026-09-08"/);
  all.find(el=>el.tag==='button'&&el.textContent==='JSON').events.click();assert.equal(JSON.parse(await exported.text()).totalTokens,237235370);
  assert.equal(api.codexMeterCompact(null),'--');
  const before=all.length;
  api.appendCodexCycleUsage(element('div'),{...stats,creditEquivalentUsd:601.05});
  assert.deepEqual(all.slice(before).filter(el=>el.tag==='strong').map(el=>el.textContent),['15.03K','237.24M','96.4%','$1821.36']);
  const changed=all.length;
  api.appendCodexCycleUsage(element('div'),{...stats,creditEquivalentUsd:601.05,projectedUsd:1700});
  assert.equal(all.slice(changed).filter(el=>el.tag==='strong').at(-1).textContent,'$1700.00');
});
