import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('native submit aligns after inserting the message and running placeholder', async () => {
  const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('function showNativePromptOptimistically('),source.indexOf('function showNativeSteerOptimistically('));
  const calls=[];
  const show=new Function('resumeNativeLiveFollowBottom','clearNativeOptimisticElements','addMsg','scrollChatToLatest','alignChatToBottomStable',
    'let nativeOptimisticElements=[],nativeRunningElement;const conversationLoadSeq=7;'+code+';return showNativePromptOptimistically;')(
    ()=>calls.push('follow'),()=>{},role=>{calls.push(role);return{}},options=>calls.push(['scroll',options.force]),(rounds,seq)=>calls.push(['settle',rounds,seq]));
  show({message:'hello',attachments:[]});
  assert.deepEqual(calls,['follow','user','assistant',['scroll',true],['settle',12,7]]);
});
