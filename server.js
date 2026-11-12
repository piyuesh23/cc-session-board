'use strict';

// cc-session-board hub. Zero dependencies, runs on Node 18+ (fine on a Pi 4).
//
//   POST /event     hook events from Claude Code (needs x-board-secret)
//   POST /vitals    devbox CPU / RAM (needs x-board-secret)
//   POST /usage     Claude subscription limits from the status line (needs x-board-secret)
//   GET  /sessions  current board as JSON
//   GET  /live      same payload pushed over Server-Sent Events, plus a ping every 15s
//   POST /ack       board tap: acknowledge a tile
//   POST /hide      board long press: hide a tile until its next event
//   GET  /          the board page

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Store } = require('./lib/store');

const MAX_BODY = 64 * 1024;
const VITALS_FRESH_MS = 2 * 60e3;
const USAGE_WINDOWS = ['five_hour', 'seven_day'];

function readConfig(env = process.env) {
  const minutes = (name, fallback) => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    port: env.PORT === undefined ? 8787 : Number(env.PORT),
    host: env.HOST || '0.0.0.0',
    secret: env.BOARD_SECRET || '',
    staleMin: minutes('STALE_MIN', 10),
    hideMin: minutes('HIDE_MIN', 60),
    blockedMaxH: minutes('BLOCKED_MAX_H', 24),
    quietHours: env.QUIET_HOURS || '23:00-07:00',
    stateFile: env.STATE_FILE === undefined ? path.join(__dirname, 'data', 'state.json') : env.STATE_FILE,
  };
}

// HOST=tailscale binds to this machine's Tailscale IPv4 address, so the hub is
// unreachable from the LAN without anyone having to look the address up.
function resolveHost(host, exec = execFileSync) {
  if (host !== 'tailscale') return host;
  let out;
  try {
    out = String(exec('tailscale', ['ip', '-4'], { timeout: 5000 }));
  } catch (err) {
    throw new Error(`HOST=tailscale but "tailscale ip -4" failed: ${err.message}`);
  }
  const ip = out.trim().split(/\s+/)[0];
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`HOST=tailscale but "tailscale ip -4" returned "${out.trim()}"`);
  return ip;
}

// Everything the board reads (/sessions, /live, /ack, /hide) is unauthenticated,
// so listening on every interface exposes it to whatever network the Pi is on.
function bindWarning(host) {
  if (host !== '0.0.0.0' && host !== '::' && host !== '') return null;
  return `WARNING: HOST=${host || '(empty)'} listens on every interface. /sessions, /live, /ack & /hide need no secret. Set HOST=tailscale or the Tailscale IP.`;
}

// One Claude rate-limit window as the status line reports it: a percentage used
// and an epoch-seconds reset time. Anything malformed drops the window.
function parseWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const used = Number(raw.used_percentage);
  const resets = Number(raw.resets_at);
  if (!Number.isFinite(used) || used < 0 || used > 100) return null;
  if (!Number.isFinite(resets) || resets <= 0) return null;
  return { usedPct: Math.round(used * 10) / 10, resetsAt: Math.round(resets) * 1000 };
}

function parseUsage(body) {
  const windows = {};
  for (const name of USAGE_WINDOWS) {
    const w = parseWindow(body[name]);
    if (w) windows[name] = w;
  }
  if (!Object.keys(windows).length) return null;
  return {
    host: typeof body.host === 'string' ? body.host.slice(0, 64) : '',
    ...windows,
    at: Date.now(),
  };
}

function sameSecret(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (tooBig) return; // keep draining so the 413 can be delivered
      size += chunk.length;
      if (size > MAX_BODY) {
        tooBig = true;
        chunks.length = 0;
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

function createHub(config = readConfig()) {
  if (!config.secret) throw new Error('BOARD_SECRET is not set. Set it on the hub & in the hook env.');

  const store = new Store({
    staleMs: config.staleMin * 60e3,
    hideMs: config.hideMin * 60e3,
    blockedMaxMs: config.blockedMaxH * 60 * 60e3,
  });
  const clients = new Set();
  let vitals = null;
  let usage = null;
  let lastSent = '';
  let saveTimer = null;

  if (config.stateFile) {
    try {
      store.load(JSON.parse(fs.readFileSync(config.stateFile, 'utf8')));
    } catch {
      // first run or unreadable snapshot: start empty
    }
  }

  function payload() {
    const sessions = store.list();
    const fresh = vitals && Date.now() - vitals.at < VITALS_FRESH_MS ? vitals : null;
    return {
      now: Date.now(),
      sessions,
      counts: {
        waiting: sessions.filter((s) => s.state === 'needs_input').length,
        total: sessions.length,
      },
      vitals: fresh,
      usage,
      config: { quietHours: config.quietHours },
    };
  }

  // Everything except the clock, so the ticker only pushes real changes.
  function fingerprint(p) {
    return JSON.stringify([p.sessions, p.counts, p.vitals, p.usage]);
  }

  function broadcast(force = false) {
    const p = payload();
    const print = fingerprint(p);
    if (!force && print === lastSent) return;
    lastSent = print;
    const frame = `data: ${JSON.stringify(p)}\n\n`;
    for (const res of clients) res.write(frame);
  }

  function saveSoon() {
    if (!config.stateFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
        const tmp = config.stateFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(store.dump()));
        fs.renameSync(tmp, config.stateFile);
      } catch (err) {
        console.error('could not save state:', err.message);
      }
    }, 1000);
    saveTimer.unref();
  }

  function changed() {
    broadcast();
    saveSoon();
  }

  const boardHtml = path.join(__dirname, 'public', 'index.html');

  async function handle(req, res) {
    const url = new URL(req.url, 'http://hub');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /' || route === 'GET /index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      fs.createReadStream(boardHtml).pipe(res);
      return;
    }

    if (route === 'GET /sessions') return send(res, 200, payload());

    if (route === 'GET /healthz') return send(res, 200, { ok: true });

    if (route === 'GET /live') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`retry: 5000\ndata: ${JSON.stringify(payload())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (route === 'POST /event' || route === 'POST /vitals' || route === 'POST /usage') {
      if (!sameSecret(req.headers['x-board-secret'], config.secret)) {
        return send(res, 401, { ok: false, error: 'bad or missing x-board-secret' });
      }
      const body = await readJson(req);
      if (route === 'POST /event') {
        const result = store.apply(body);
        if (!result.ok) return send(res, 400, result);
        changed();
        return send(res, 200, { ok: true });
      }
      if (route === 'POST /usage') {
        const parsed = parseUsage(body);
        if (!parsed) return send(res, 400, { ok: false, error: 'no valid five_hour or seven_day window' });
        usage = parsed;
        broadcast();
        return send(res, 200, { ok: true });
      }
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
      vitals = {
        host: typeof body.host === 'string' ? body.host.slice(0, 64) : '',
        cpu: num(body.cpu),
        ramUsedGb: num(body.ram_used_gb),
        ramTotalGb: num(body.ram_total_gb),
        at: Date.now(),
      };
      broadcast();
      return send(res, 200, { ok: true });
    }

    // Board actions. No secret: the page cannot keep one, so the hub must only
    // be reachable over the tailnet (see README).
    if (route === 'POST /ack' || route === 'POST /hide') {
      const body = await readJson(req);
      const ok = route === 'POST /ack' ? store.ack(body.id) : store.hide(body.id);
      if (!ok) return send(res, 404, { ok: false, error: 'no such session' });
      changed();
      return send(res, 200, { ok: true });
    }

    send(res, 404, { ok: false, error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err.status === 413) {
        res.setHeader('connection', 'close');
        res.on('finish', () => req.destroy());
      }
      send(res, err.status || 500, { ok: false, error: err.message });
    });
  });

  // Stale / auto-hide transitions happen with no incoming event, so re-check
  // on a timer. The ping is a named event, not a comment, so the page can see
  // it and tell a quiet board from a dead socket (iOS drops them silently).
  const ticker = setInterval(() => {
    for (const res of clients) res.write('event: ping\ndata: {}\n\n');
    broadcast();
  }, config.keepAliveMs || 15e3);
  ticker.unref();

  server.on('close', () => {
    clearInterval(ticker);
    for (const res of clients) res.end();
  });

  return { server, store, config };
}

if (require.main === module) {
  let hub;
  try {
    hub = createHub();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  let host;
  try {
    host = resolveHost(hub.config.host);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const warning = bindWarning(host);
  if (warning) console.error(warning);
  hub.server.listen(hub.config.port, host, () => {
    console.log(`cc-session-board hub on http://${host}:${hub.config.port}`);
  });
}

module.exports = { createHub, readConfig, resolveHost, bindWarning, parseUsage };
