// Maritime contract adapter + cobalt tunnel proxy.
// Listens on $PORT (injected by Maritime).
//   /health -> 200 "ok"                      (Maritime health check)
//   /chat   -> cobalt status echo            (Maritime chat contract)
//   /*      -> transparent proxy to cobalt API on 127.0.0.1:9000
// Keeps Host header correct for cobalt's API_URL validation & tunnels.
const http = require('http');
const https = require('https');

const PORT = parseInt(process.env.PORT || '18789', 10);
const UPSTREAM = process.env.API_UPSTREAM || 'http://127.0.0.1:9000';
const u = new URL(UPSTREAM);

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (req.url === '/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ response: 'cobalt api. POST / with {"url": "..."} to download media.' }));
    });
    return;
  }
  // proxy everything else to cobalt
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: u.host },
  };
  const mod = opts.protocol === 'https:' ? https : http;
  const up = mod.request(opts, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', error: { code: 'proxy.upstream', message: String(e) } }));
  });
  req.pipe(up);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] maritime contract + cobalt proxy on :${PORT} -> ${UPSTREAM}`);
});
