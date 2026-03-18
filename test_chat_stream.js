const http = require('http');
const body = JSON.stringify({
  model: 'deepseek-r1:7b',
  messages: [{ role: 'user', content: '1+1=? (just answer)' }],
  stream: true,
  think: true
});
const req = http.request({
  hostname: 'localhost', port: 11434, path: '/api/chat', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
}, res => {
  let buf = '', n = 0;
  res.setEncoding('utf8');
  res.on('data', d => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim(); if (!t) continue;
      try {
        const j = JSON.parse(t);
        const msg = j.message || {};
        const keys = Object.keys(msg).join(',');
        const thinking = (msg.thinking || '').substring(0, 40);
        const content = (msg.content || '').substring(0, 40);
        if (n < 20) {
          process.stdout.write(`[${n}] keys=${keys} thinking=${JSON.stringify(thinking)} content=${JSON.stringify(content)}\n`);
        }
        n++;
      } catch {}
    }
  });
  res.on('end', () => { process.stdout.write(`DONE total=${n}\n`); });
});
req.setTimeout(60000);
req.write(body);
req.end();
