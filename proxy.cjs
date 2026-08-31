// cobalt on Maritime: PID-1 supervisor + contract adapter + key-gated proxy.
//   GET  /health  -> 200 "ok"        (Maritime health check)
//   POST /chat    -> contract reply  (Maritime chat contract)
//   GET  /debug   -> tail of logs (key required) — remote debugging without exec
//   ANY  /*        -> transparent proxy to cobalt API on 127.0.0.1:9000 (X-Key gated)
// cobalt api runs as a supervised child process; respawns 3s after exit.
// PID 1 must NEVER exit: uncaught exceptions are logged, not fatal.

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const PORT = parseInt(process.env.PORT || '18789', 10);
const GATEWAY_KEY = process.env.GATEWAY_KEY || '';
const COBALT_PORT = parseInt(process.env.API_PORT || '9000', 10);
const UPSTREAM = 'http://127.0.0.1:' + COBALT_PORT;

const DATA_DIR = fs.existsSync('/data') ? '/data' : '/tmp';
function LOG(msg) {
  const line = new Date().toISOString() + ' | ' + msg + '\n';
  try { fs.appendFileSync(DATA_DIR + '/gateway.log', line); } catch {}
  console.log(msg);
}
function tailFile(path, n) {
  try {
    const data = fs.readFileSync(path, 'utf8');
    return data.split('\n').slice(-n).join('\n');
  } catch (e) { return '(no log: ' + e.message + ')'; }
}

// ---------- cobalt api as supervised child ----------
let cobaltProc = null;
function startCobalt() {
  let out;
  try { out = fs.openSync(DATA_DIR + '/cobalt.log', 'a'); }
  catch { out = 2; } // fallback: inherit stderr so it shows in agent logs
  try {
    cobaltProc = spawn(process.execPath, ['src/cobalt'], {
      cwd: '/app',
      env: process.env,
      stdio: ['ignore', out, out],
    });
    LOG('[supervisor] cobalt spawned, pid=' + cobaltProc.pid);
    cobaltProc.on('exit', (code, sig) => {
      LOG('[supervisor] cobalt exited code=' + code + ' sig=' + sig + '; respawn in 3s');
      setTimeout(startCobalt, 3000);
    });
  } catch (e) {
    LOG('[supervisor] spawn failed: ' + e.message + '; retry in 10s');
    setTimeout(startCobalt, 10000);
  }
}
startCobalt();

// ---------- http ----------
function authorized(req) {
  if (!GATEWAY_KEY) return true; // dev mode: open
  const h = req.headers['x-key'] || '';
  const auth = req.headers['authorization'] || '';
  const q = new URL(req.url, 'http://x').searchParams.get('key') || '';
  return h === GATEWAY_KEY || auth === 'Bearer ' + GATEWAY_KEY || q === GATEWAY_KEY;
}

const server = http.createServer((req, res) => {
  try {
    const path = req.url.split('?')[0];
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    if (path === '/chat' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          response: 'cobalt gateway up. POST / with {"url":"..."} + X-Key header.',
          cobalt_alive: !!(cobaltProc && cobaltProc.exitCode === null),
        }));
      });
      return;
    }
    if (path === '/debug') {
      if (!authorized(req)) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(
        '== gateway.log ==\n' + tailFile(DATA_DIR + '/gateway.log', 40) +
        '\n\n== cobalt.log ==\n' + tailFile(DATA_DIR + '/cobalt.log', 60)
      );
    }
    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'error', error: { code: 'unauthorized' } }));
    }
    const u = new URL(UPSTREAM);
    const opts = {
      hostname: u.hostname,
      port: u.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: u.host },
    };
    delete opts.headers['x-key'];
    const up = http.request(opts, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: { code: 'proxy.upstream', message: String(e) } }));
    });
    req.pipe(up);
  } catch (e) {
    try {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: { code: 'gateway', message: String(e) } }));
    } catch {}
  }
});

server.on('error', (e) => LOG('[gateway] server error: ' + e.message));
process.on('uncaughtException', (e) => LOG('[gateway] uncaught: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => LOG('[gateway] unhandledRejection: ' + e));

server.listen(PORT, '0.0.0.0', () => {
  LOG('[gateway] listening on :' + PORT + ' -> ' + UPSTREAM + ' (key: ' + (GATEWAY_KEY ? 'ON' : 'OFF') + ')');
});
