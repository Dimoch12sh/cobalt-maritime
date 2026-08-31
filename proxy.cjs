// Cobalt processing instance for Maritime.sh micro-VM — supervisor + contract adapter + key-gated proxy.
//   GET  /health                                -> 200 "ok"    (Maritime health)
//   POST /chat                                  -> contract reply
//   GET  /debug (X-Key)                         -> tail of logs (remote debug without exec)
//   ANY  /get_pot (X-Key)                       -> shim to local ysg /token (POST vs GET)
//   ANY  /* (X-Key)                             -> transparent proxy to cobalt api :9000
// child processes:
//   - cobalt api on 127.0.0.1:9000 (respawn on exit)
//   - yt-session-generator on 127.0.0.1:8080 (respawn on exit, /get_pot shim)
// PID 1 = this file; never exits.

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const PORT          = parseInt(process.env.PORT || '18789', 10);
const GATEWAY_KEY   = process.env.GATEWAY_KEY || '';
const COBALT_PORT   = parseInt(process.env.API_PORT || '9000', 10);
const YSG_PORT      = 9998; // NB: 8080/8081/8082 are taken by maritime-init (port fwd/exec/cmd servers)
const DATA_DIR      = fs.existsSync('/data') ? '/data' : '/tmp';
const COBALT_DIR    = fs.existsSync('/app') && fs.existsSync('/app/src/cobalt.js') ? '/app' : '/cobalt';

function LOG(msg) {
  const line = new Date().toISOString() + ' | ' + msg + '\n';
  try { fs.appendFileSync(DATA_DIR + '/gateway.log', line); } catch {}
  console.log(msg);
}
function tailFile(path, n) {
  try { return fs.readFileSync(path, 'utf8').split('\n').slice(-n).join('\n'); }
  catch (e) { return '(no log: ' + e.message + ')'; }
}

function childSupervise(label, cmd, args, cwd, env, logPath, restartMs) {
  let proc = null;
  let stopped = false;
  function start() {
    if (stopped) return;
    let out = 'pipe';
    try { out = fs.openSync(logPath, 'a'); } catch { out = 'inherit'; }
    try {
      proc = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', out, out] });
      LOG(`[${label}] spawned pid=${proc.pid} cmd=${cmd} ${(args || []).join(' ')}`);
      proc.on('exit', (code, sig) => {
        LOG(`[${label}] exited code=${code} sig=${sig}; respawn in ${restartMs}ms`);
        if (!stopped) setTimeout(start, restartMs);
      });
    } catch (e) {
      LOG(`[${label}] spawn failed: ${e.message}; retry in ${restartMs * 2}ms`);
      if (!stopped) setTimeout(start, restartMs * 2);
    }
  }
  start();
  return { stop: () => { stopped = true; try { proc && proc.kill('SIGTERM'); } catch {} } };
}

// 1) cobalt api
const cobalt = childSupervise(
  'cobalt', process.execPath, ['src/cobalt'], COBALT_DIR, {
    API_URL: `http://localhost:${COBALT_PORT}/`,
    API_AUTH_REQUIRED: '0',
    DURATION_LIMIT: '7200',
  },
  DATA_DIR + '/cobalt.log', 3000
);

// 2) yt-session-generator (webserver mode) — тільки якщо /app/yt-session-generator існує
const ysgScript = '/app/yt-session-generator/potoken-generator.py';
const ysgPython = fs.existsSync('/opt/ysg-venv/bin/python3') ? '/opt/ysg-venv/bin/python3' : 'python3';

// Find chrome binary for ysg
const chromeCandidates = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser'];
let ysgChromePath = '';
for (const p of chromeCandidates) { if (fs.existsSync(p)) { ysgChromePath = p; break; } }

// Start Xvfb on :99 if available (ysg uses headless=False and needs an X display)
let xvfbProc = null;
function startXvfb() {
  if (xvfbProc && xvfbProc.exitCode === null) return;
  if (!fs.existsSync('/usr/bin/Xvfb')) {
    LOG('[xvfb] /usr/bin/Xvfb not present; ysg will need headless mode');
    return;
  }
  try {
    xvfbProc = spawn('/usr/bin/Xvfb', [':99', '-ac', '-screen', '0', '1280x720x16', '-nolisten', 'tcp'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    LOG('[xvfb] spawned pid=' + xvfbProc.pid + ' on :99');
    xvfbProc.on('exit', (code) => LOG('[xvfb] exited code=' + code));
  } catch (e) { LOG('[xvfb] spawn failed: ' + e.message); }
}
startXvfb();

let ysgProc = null;
let ysgStartAllowed = false;
let ysgRestartAt = 0;

function startYsg() {
  if (!fs.existsSync(ysgScript)) return;
  if (!ysgStartAllowed) return;
  if (Date.now() < ysgRestartAt) return;
  if (ysgProc && ysgProc.exitCode === null) return;
  const args = [ysgScript, '--bind', '127.0.0.1', '--port', String(YSG_PORT),
                '--update-interval', process.env.YSG_UPDATE_INTERVAL || '300'];
  if (ysgChromePath) args.push('--chrome-path', ysgChromePath);
  let out;
  try { out = fs.openSync(DATA_DIR + '/ysg.log', 'a'); } catch { out = 'inherit'; }
  try {
    ysgProc = spawn(ysgPython, args, {
      cwd: '/app/yt-session-generator',
      env: { ...process.env, DISPLAY: ':99' },
      stdio: ['ignore', out, out],
    });
    LOG('[ysg] spawned pid=' + ysgProc.pid + ' chrome=' + ysgChromePath);
    ysgProc.on('exit', (code, sig) => {
      LOG('[ysg] exited code=' + code + ' sig=' + sig);
      ysgProc = null;
      // backoff: 30s, 60s, 120s, 240s — cap 240
      const backoff = Math.min(240000, 30000 * Math.max(1, Math.floor(Math.random() * 4 + 1)));
      ysgRestartAt = Date.now() + backoff;
      LOG('[ysg] next restart in ' + (backoff / 1000) + 's');
      if (ysgStartAllowed) setTimeout(startYsg, backoff);
    });
  } catch (e) {
    LOG('[ysg] spawn failed: ' + e.message);
    ysgRestartAt = Date.now() + 60000;
  }
}
// give chromium/Xvfb 30s before first attempt
setTimeout(() => { ysgStartAllowed = true; startYsg(); }, 30000);

process.on('exit', () => { try { if (ysgProc) ysgProc.kill('SIGTERM'); } catch {} });

// ---------- http ----------

function authorized(req) {
  if (!GATEWAY_KEY) return true;
  const h = req.headers['x-key'] || '';
  const auth = req.headers['authorization'] || '';
  const q = new URL(req.url, 'http://x').searchParams.get('key') || '';
  return h === GATEWAY_KEY || auth === 'Bearer ' + GATEWAY_KEY || q === GATEWAY_KEY;
}
function proxyUpstream(target, req, res) {
  const u = new URL(target);
  const opts = {
    hostname: u.hostname, port: u.port, method: req.method, path: req.url,
    headers: { ...req.headers, host: u.host },
  };
  delete opts.headers['x-key'];
  const up = http.request(opts, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
  up.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', error: { code: 'proxy.upstream', message: String(e) } }));
  });
  req.pipe(up);
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
          cobalt_alive: true,
        }));
      });
      return;
    }
    if (path === '/debug') {
      if (!authorized(req)) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(
        '== gateway.log ==\n' + tailFile(DATA_DIR + '/gateway.log', 40) +
        '\n\n== cobalt.log ==\n' + tailFile(DATA_DIR + '/cobalt.log', 60) +
        '\n\n== ysg.log ==\n' + tailFile(DATA_DIR + '/ysg.log', 60) +
        '\n\n== cobalt .env ==\n' + tailFile(COBALT_DIR + '/.env', 20) +
        '\n\nps:\n' + tryPs()
      );
    }
    // cobalt -> ysg shim: cobalt POSTs /get_pot (iv-org style); ysg only has GET /token.
    // NOTE: no auth here — cobalt calls it internally from localhost without X-Key.
    if (path === '/get_pot' && fs.existsSync(ysgScript)) {
      const up = http.request({
        hostname: '127.0.0.1', port: YSG_PORT, method: 'GET', path: '/token',
        headers: { 'User-Agent': 'cobalt/11' },
      }, (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      });
      up.on('error', (e) => {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ysg.unreachable', message: String(e) }));
      });
      up.end();
      return;
    }
    // system diagnostics (chrome, RAM, shm)
    if (path === '/debug/sys') {
      if (!authorized(req)) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
      const { execSync } = require('child_process');
      const probes = [
        'id',
        'which google-chrome google-chrome-stable chromium chromium-browser 2>&1',
        'google-chrome --version 2>&1 || true',
        'free -m',
        'df -h /dev/shm /tmp 2>&1',
        'ps -ef | head -25',
      ];
      let txt = '';
      for (const cmd of probes) {
        txt += '\n=== ' + cmd + ' ===\n';
        try { txt += execSync(cmd, { encoding: 'utf8', timeout: 8000 }); }
        catch (e) { txt += '(err: ' + (e.message || e) + ')\n'; }
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(txt);
    }
    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'error', error: { code: 'unauthorized' } }));
    }
    proxyUpstream(`http://127.0.0.1:${COBALT_PORT}`, req, res);
  } catch (e) {
    try {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: { code: 'gateway', message: String(e) } }));
    } catch {}
  }
});

function tryPs() {
  try {
    const { execSync } = require('child_process');
    return execSync('ps -ef | head -30', { encoding: 'utf8' });
  } catch (e) { return '(ps unavailable: ' + e.message + ')'; }
}

server.on('error', (e) => LOG('[gateway] server error: ' + e.message));
process.on('uncaughtException', (e) => LOG('[gateway] uncaught: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => LOG('[gateway] unhandledRejection: ' + e));

server.listen(PORT, '0.0.0.0', () => {
  LOG(`[gateway] listening :${PORT} -> cobalt http://127.0.0.1:${COBALT_PORT}` +
      ` ysg=${fs.existsSync(ysgScript) ? 'ON' : 'OFF'} key=${GATEWAY_KEY ? 'ON' : 'OFF'}`);
});

process.on('exit', () => { try { cobalt.stop(); } catch {} });
