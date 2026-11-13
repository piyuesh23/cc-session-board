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
const PERMISSION = path.join(__dirname, '..', 'hooks', 'cc_board_permission.py');
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
  const authed = (p, init = {}) => fetch(base + p, { ...init, headers: { 'content-type': 'application/json', 'x-board-secret': SECRET } });
  try {
    await fn({ base, env, board, authed });
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

const permissionInput = {
  hook_event_name: 'PermissionRequest',
  session_id: 'perm-e2e',
  cwd: path.join(__dirname, '..'),
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'export API_TOKEN=sk-abcdefghijklmnop1234 && ./deploy.sh' },
};

// Start the permission hook, wait for its request to reach the hub, answer it
// remotely and return what the hook printed.
async function answerRemotely({ env, authed }, decision) {
  const hook = run('python3', [PERMISSION], { input: JSON.stringify(permissionInput), env });
  let pending = [];
  for (let i = 0; i < 50 && !pending.length; i++) {
    await new Promise((r) => setTimeout(r, 100));
    pending = (await (await authed('/permissions')).json()).pending;
  }
  assert.equal(pending.length, 1, 'the hook posted its request');
  assert.equal(pending[0].tool, 'Bash');
  assert.equal(pending[0].target, 'export API_TOKEN=*** && ./deploy.sh');
  assert.equal(pending[0].project, 'cc-session-board');
  assert.equal(pending[0].host, 'testbox');
  const res = await authed(`/permission/${pending[0].id}/decide`, { method: 'POST', body: JSON.stringify(decision) });
  assert.equal(res.status, 200);
  const done = await hook;
  assert.equal(done.status, 0, done.stderr);
  return done.stdout;
}

test('the permission hook prints allow when the remote allows', { skip }, async () => {
  await withHubAndScratch(async (ctx) => {
    const out = await answerRemotely(ctx, { decision: 'allow' });
    assert.deepEqual(JSON.parse(out), {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });
});

test('the permission hook prints deny with the remote message, or a default one', { skip }, async () => {
  await withHubAndScratch(async (ctx) => {
    const out = await answerRemotely(ctx, { decision: 'deny', message: 'Not on a Friday' });
    assert.deepEqual(JSON.parse(out).hookSpecificOutput.decision, { behavior: 'deny', message: 'Not on a Friday' });
    const plain = await answerRemotely(ctx, { decision: 'deny' });
    assert.deepEqual(JSON.parse(plain).hookSpecificOutput.decision, { behavior: 'deny', message: 'Denied from the remote' });
  });
});

test('with no answer the permission hook cancels and prints nothing', { skip }, async () => {
  await withHubAndScratch(async ({ env, authed, board }) => {
    const started = Date.now();
    const done = await run('python3', [PERMISSION], { input: JSON.stringify(permissionInput), env: { ...env, CC_BOARD_APPROVE_WAIT: '1' } });
    assert.equal(done.status, 0, done.stderr);
    assert.equal(done.stdout, '', 'nothing printed: Claude Code shows its own prompt');
    assert.ok(Date.now() - started < 8000);
    assert.deepEqual((await (await authed('/permissions')).json()).pending, [], 'cancelled on the hub');
    assert.equal((await board()).permissions, 0);
  });
});

test('the permission hook stays out of the way when off or when the hub is down', { skip }, async () => {
  await withHubAndScratch(async ({ env, authed }) => {
    const off = await run('python3', [PERMISSION], { input: JSON.stringify(permissionInput), env: { ...env, CC_BOARD_APPROVE_WAIT: '0' } });
    assert.deepEqual([off.status, off.stdout], [0, '']);
    assert.deepEqual((await (await authed('/permissions')).json()).pending, [], 'off means nothing is posted');

    const down = await run('python3', [PERMISSION], { input: JSON.stringify(permissionInput), env: { ...env, CC_BOARD_URL: 'http://127.0.0.1:9' } });
    assert.deepEqual([down.status, down.stdout, down.stderr], [0, '', '']);

    const junk = await run('python3', [PERMISSION], { input: 'not json', env });
    assert.deepEqual([junk.status, junk.stdout], [0, '']);
  });
});

test('the permission hook answers AskUserQuestion with the original question text', { skip }, async () => {
  await withHubAndScratch(async ({ env, authed }) => {
    // The first question carries a credential: the hub only ever sees it masked,
    // so the hook must key the answer by Claude's original text, not the hub's.
    const tool_input = {
      questions: [
        { question: 'Use API_TOKEN=abc123secretvalue for staging?', header: 'Token', multiSelect: false,
          options: [{ label: 'Yes', description: 'use it' }, { label: 'No', description: 'ask me' }] },
        { question: 'Which checks?', header: 'Checks', multiSelect: true,
          options: [{ label: 'Lint', description: '' }, { label: 'Unit', description: '' }, { label: 'E2E', description: '' }] },
      ],
    };
    const hook = run('python3', [PERMISSION], {
      input: JSON.stringify({ ...permissionInput, session_id: 'ask-e2e', tool_name: 'AskUserQuestion', tool_input }),
      env,
    });
    let pending = [];
    for (let i = 0; i < 50 && !pending.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      pending = (await (await authed('/permissions')).json()).pending;
    }
    assert.equal(pending.length, 1);
    assert.equal(pending[0].questions[0].question, 'Use API_TOKEN=*** for staging?');
    const res = await authed(`/permission/${pending[0].id}/decide`, {
      method: 'POST', body: JSON.stringify({ decision: 'allow', answers: ['No', ['E2E', 'Lint']] }),
    });
    assert.equal(res.status, 200);
    const done = await hook;
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(JSON.parse(done.stdout).hookSpecificOutput.decision, {
      behavior: 'allow',
      updatedInput: {
        ...tool_input,
        answers: { 'Use API_TOKEN=abc123secretvalue for staging?': 'No', 'Which checks?': 'Lint, E2E' },
      },
    });
  });
});
