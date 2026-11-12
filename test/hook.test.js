"use strict";

// Runs the real Python hook: once as a library for the redaction rules, once
// end to end against a live hub so the wire format is checked too.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');

// The hub runs in this process, so a child that talks to it must not be
// awaited synchronously: a blocking wait would stall the event loop and the
// hub could never answer. Resolves with { status, stdout, stderr }.
function run(cmd, args, { input, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}
const { createHub } = require('../server');

const HOOK = path.join(__dirname, '..', 'hooks', 'cc_board_hook.py');
const USAGE = path.join(__dirname, '..', 'hooks', 'cc_board_usage.py');
const WRAPPER = path.join(__dirname, '..', 'hooks', 'cc_board_statusline.sh');
const SECRET = 'test-secret';

function hasPython() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skip = hasPython() ? false : 'python3 is not installed';

function redactAll(inputs) {
  const code = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(path.dirname(HOOK))})`,
    'from cc_board_hook import redact',
    'print(json.dumps([redact(x) for x in json.load(sys.stdin)]))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-I', '-c', code], { input: JSON.stringify(inputs) }));
}

test('credentials are masked, ordinary commands are not', { skip }, () => {
  const cases = [
    ['export GITHUB_TOKEN=ghp_abcdefghijklmnop1234 && gh pr list', 'export GITHUB_TOKEN=*** && gh pr list'],
    ['curl -H "Authorization: Bearer abcdef1234567890" https://api.example.com', 'curl -H "Authorization: Bearer ***" https://api.example.com'],
    ['psql postgres://app:hunter2@db.local/app', 'psql postgres://app:***@db.local/app'],
    ['mysql --password=hunter2 -u root', 'mysql --password=***'.concat(' -u root')],
    ['https://hub/api?token=abc123&page=2', 'https://hub/api?token=***&page=2'],
    ['{"api_key": "abc123"}', '{"api_key": "***"}'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'AWS_SECRET_ACCESS_KEY=***'],
    ['git checkout 3f2a9c1e5b7d4a6f8e0c2b1d3a5f7e9c1b3d5f7a', 'git checkout ***'],
    ['mkdir -p build && npm test', 'mkdir -p build && npm test'],
    ['Edit · lib/store.js', 'Edit · lib/store.js'],
    ['Claude needs your permission to use Bash', 'Claude needs your permission to use Bash'],
    ['', ''],
  ];
  assert.deepEqual(redactAll(cases.map(([raw]) => raw)), cases.map(([, masked]) => masked));
});

async function withHubAndScratch(fn) {
  const hub = createHub({
    port: 0, host: '127.0.0.1', secret: SECRET,
    staleMin: 10, hideMin: 60, blockedMaxH: 24, quietHours: '23:00-07:00', stateFile: '',
  });
  await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  // A fresh HOME & TMPDIR: no real ~/.config/cc-board/env, no throttle stamp from an earlier run.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-board-hook-'));
  const env = { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, CC_BOARD_URL: base, CC_BOARD_SECRET: SECRET, CC_BOARD_HOST: 'testbox' };
  const board = async () => (await fetch(base + '/sessions')).json();
  try {
    await fn({ base, env, board });
  } finally {
    hub.server.closeAllConnections();
    await new Promise((resolve) => hub.server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test('the hook posts a redacted tool target to the hub', { skip }, async () => {
  await withHubAndScratch(async ({ env, board }) => {
    const hookInput = {
      hook_event_name: 'PostToolUse',
      session_id: 'hook-e2e',
      cwd: path.join(__dirname, '..'),
      tool_name: 'Bash',
      tool_input: { command: 'export API_TOKEN=sk-abcdefghijklmnop1234 && ./deploy.sh' },
    };
    const hook = await run('python3', [HOOK], { input: JSON.stringify(hookInput), env });
    assert.equal(hook.status, 0, hook.stderr);

    const p = await board();
    assert.equal(p.sessions.length, 1);
    const s = p.sessions[0];
    assert.equal(s.host, 'testbox');
    assert.equal(s.project, 'cc-session-board');
    assert.equal(s.state, 'working');
    assert.equal(s.tool, 'Bash');
    assert.equal(s.target, 'export API_TOKEN=*** && ./deploy.sh');
    assert.doesNotMatch(JSON.stringify(p), /sk-abcdefghijklmnop1234/);
  });
});

const statusLine = (fiveHour, sevenDay) => ({
  model: { display_name: 'Opus' },
  cwd: '/tmp/x',
  context_window: { remaining_percentage: 61 },
  rate_limits: { five_hour: fiveHour, seven_day: sevenDay },
});

test('the usage pusher sends only the rate limits, once per change', { skip }, async () => {
  await withHubAndScratch(async ({ env, board }) => {
    const push = (input) => run('python3', [USAGE], { input: JSON.stringify(input), env: { ...env, CC_BOARD_DEBUG: '1' } });

    assert.equal((await push({ model: { display_name: 'Opus' } })).status, 0);
    assert.equal((await board()).usage, null, 'no rate_limits means nothing is posted');

    const first = statusLine({ used_percentage: 23.5, resets_at: 1738425600 }, { used_percentage: 41.2, resets_at: 1738857600 });
    assert.equal((await push(first)).stderr, '');
    let u = (await board()).usage;
    assert.equal(u.host, 'testbox');
    assert.deepEqual(u.five_hour, { usedPct: 23.5, resetsAt: 1738425600e3 });
    assert.deepEqual(u.seven_day, { usedPct: 41.2, resetsAt: 1738857600e3 });
    const firstAt = u.at;

    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await push(first)).stderr, '');
    assert.equal((await board()).usage.at, firstAt, 'unchanged numbers are not re-sent');

    assert.equal((await push(statusLine({ used_percentage: 30, resets_at: 1738425600 }, undefined))).stderr, '');
    u = (await board()).usage;
    assert.equal(u.five_hour.usedPct, 30);
    assert.equal(u.seven_day, undefined, 'a window Claude Code dropped is dropped here too');
    assert.ok(u.at > firstAt);
  });
});

test('the status line wrapper passes the JSON through and pushes in the background', { skip }, async () => {
  await withHubAndScratch(async ({ env, board }) => {
    const input = JSON.stringify(statusLine({ used_percentage: 88, resets_at: 1738425600 }, undefined));
    const wrapped = await run('bash', [WRAPPER, 'node', '-e', 'process.stdin.pipe(process.stdout)'], { input, env });
    assert.equal(wrapped.status, 0, wrapped.stderr);
    assert.equal(wrapped.stdout, input, 'the wrapped status line sees the same JSON');

    // the push is detached, so give it a moment
    let usage = null;
    for (let i = 0; i < 40 && !usage; i++) {
      await new Promise((r) => setTimeout(r, 100));
      usage = (await board()).usage;
    }
    assert.equal(usage && usage.five_hour.usedPct, 88);

    const quiet = await run('bash', [WRAPPER], { input, env });
    assert.equal(quiet.status, 0);
    assert.equal(quiet.stdout, '', 'no wrapped command, no output');
  });
});
