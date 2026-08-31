// Maritime contract adapter + cobalt gateway proxy.
// Listens on $PORT (injected by Maritime).
//   GET  /health -> 200 "ok"          (Maritime health check)
//   POST /chat   -> simple echo       (Maritime chat contract)
//   ANY  /*       -> proxy to cobalt API on 127.0.0.1:9000, but ONLY with a valid key:
//                    header "X-Key: $GATEWAY_KEY" or query "?key=..."
//   GET  /       (no key) -> 401 hint
const http = require('http');
const https = require('https');

const PORT = parseInt(process.env.PORT || '18789', 10);
const GATEWAY_KEY = process.env.GATEWAY_KEY || '';
const UPSTREAM = process.env.API_UPSTREAM || 'http://127.0.0.1:9000';
const u = new URL(UPSTREAM);

function authorized(req) {
  if (!GATEWAY_KEY) return true; // no key configured = open (dev only)
  const h = req.headers['x-key'] || req.headers['authorization'] || '';
  const q = new URL(req.url, 'http://x').searchParams.get('key') || '';
  return h === GATEWAY_KEY || h === 'Bearer ' + GATEWAY_KEY || q === GATEWAY_KEY;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (req.url.split('?')[0] === '/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ response: 'cobalt gateway. POST / with {"url": "..."} + X-Key header.' }));
    });
    return;
  }
  if (!authorized(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'error', error: { code: 'unauthorized' } }));
  }
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: u.host },
  };
  delete opts.headers['x-key'];
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
  console.log('[gateway] :%d -> %s (key: %s)', PORT, UPSTREAM, GATEWAY_KEY ? 'ON' : 'OFF');
});
