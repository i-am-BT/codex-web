import { Codex } from '@openai/codex-sdk';

// Monkey-patch to see what's happening
const origExec = Codex.prototype.startThread;
Codex.prototype.startThread = function(opts) {
  console.log('startThread options:', JSON.stringify(opts));
  return origExec.call(this, opts);
};

const codex = new Codex();
const thread = codex.startThread({ skipGitRepoCheck: true, sandboxMode: 'danger-full-access' });
console.log('thread created, id:', thread.id);

try {
  const { events } = await thread.runStreamed('say hello');
  let count = 0;
  for await (const event of events) {
    console.log('event:', JSON.stringify(event).slice(0, 200));
    count++;
  }
  console.log('total events:', count);
} catch(e) {
  console.error('ERROR:', e.message);
}
