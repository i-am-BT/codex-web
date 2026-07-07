import express from 'express';
import cors from 'cors';
import { Codex } from '@openai/codex-sdk';
import { randomUUID } from 'crypto';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = parseInt(process.env.PORT || '8008', 10);
const HOST = process.env.HOST || '0.0.0.0';

const codex = new Codex();
const threads = {};

app.post('/api/chat', async (req, res) => {
  const { message, thread_id } = req.body;
  const tid = thread_id || randomUUID();

  if (!threads[tid]) {
    threads[tid] = codex.startThread();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const { events } = await threads[tid].runStreamed(message);
    for await (const event of events) {
      if (event.type === 'item.completed' && event.item?.type === 'response') {
        const text = event.item.content?.find(c => c.type === 'output_text')?.text || '';
        if (text) {
          res.write(`data: ${JSON.stringify({ type: 'text', content: text, thread_id: tid })}\n\n`);
        }
      }
      if (event.type === 'turn.completed') {
        res.write(`data: ${JSON.stringify({ type: 'done', thread_id: tid })}\n\n`);
      }
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
});

app.get('/api/threads', (_, res) => {
  res.json({ threads: Object.keys(threads).length });
});

app.get('/', (_, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Codex Web</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,sans-serif;background:#0d1117;color:#c9d1d9;height:100vh;display:flex;flex-direction:column}
header{padding:12px 20px;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;gap:10px}
header h1{font-size:15px;font-weight:600;color:#f0f6fc}
header .badge{font-size:11px;background:#238636;color:#fff;padding:2px 8px;border-radius:10px}
#chat{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:85%;padding:10px 14px;border-radius:8px;line-height:1.6;font-size:14px;white-space:pre-wrap;word-break:break-word}
.msg.user{background:#1f6feb;color:#fff;align-self:flex-end}
.msg.assistant{background:#161b22;border:1px solid #30363d;align-self:flex-start}
.msg.assistant .thinking{color:#8b949e;font-style:italic;font-size:13px}
.msg.error{background:#3d0000;border:1px solid #f85149;align-self:flex-start;color:#f85149}
#footer{padding:12px 20px;background:#161b22;border-top:1px solid #30363d}
#form{display:flex;gap:8px}
#form textarea{flex:1;padding:10px 14px;border:1px solid #30363d;border-radius:6px;background:#0d1117;color:#c9d1d9;font-size:14px;resize:none;outline:none;min-height:44px;max-height:120px;font-family:inherit}
#form textarea:focus{border-color:#58a6ff}
#form button{padding:10px 22px;background:#238636;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:500}
#form button:disabled{opacity:.5;cursor:not-allowed}
</style>
</head>
<body>
<header><h1>Codex Web</h1><span class="badge">gpt-5.5</span></header>
<div id="chat"></div>
<div id="footer">
<div id="form">
<textarea id="input" rows="1" placeholder="输入消息..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send()}"></textarea>
<button id="btn" onclick="send()">发送</button>
</div>
</div>
<script>
let tid = localStorage.getItem('codex_tid') || crypto.randomUUID();
localStorage.setItem('codex_tid', tid);
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const btn = document.getElementById('btn');

function addMsg(role, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.textContent = text;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

async function send() {
  const text = input.value.trim();
  if (!text || btn.disabled) return;
  input.value = '';
  input.style.height = 'auto';
  addMsg('user', text);
  btn.disabled = true;

  const el = addMsg('assistant', '');
  const thinking = document.createElement('div');
  thinking.className = 'thinking';
  thinking.textContent = '思考中...';
  el.appendChild(thinking);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ message: text, thread_id: tid }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream:true});
      for (const line of buffer.split('\\n').filter(l=>l.startsWith('data: ')&&!l.includes('[DONE]'))) {
        try {
          const json = JSON.parse(line.slice(6));
          if (json.type === 'text') {
            thinking.remove();
            el.textContent = json.content;
          }
          if (json.type === 'error') {
            el.className = 'msg error';
            el.textContent = '错误: ' + json.error;
          }
        } catch(e) {}
      }
    }
    if (!el.textContent && !el.querySelector('.thinking')) {
      el.textContent = '(无返回)';
    }
    if (el.querySelector('.thinking')) {
      thinking.textContent = '完成';
    }
  } catch(e) {
    el.className = 'msg error';
    el.textContent = '连接失败: ' + e.message;
  }
  btn.disabled = false;
  input.focus();
}
</script>
</body></html>`);
});

app.listen(PORT, HOST, () => {
  console.log(`Codex Web UI listening on http://${HOST}:${PORT}`);
});
