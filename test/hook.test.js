"use strict";

// Runs the real Python hook: once as a library for the redaction rules, once
// end to end against a live hub so the wire format is checked too.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHub } = require('../server');

const HOOK = path.join(__dirname, '..', 'hooks', 'cc_board_hook.py');
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

test('the hook posts a redacted tool target to the hub', { skip }, async () => {
  const hub = createHub({
    port: 0, host: '127.0.0.1', secret: SECRET,
    staleMin: 10, hideMin: 60, blockedMaxH: 24, quietHours: '23:00-07:00', stateFile: '',
  });
  await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  // A fresh HOME & TMPDIR: no real ~/.config/cc-board/env, no throttle stamp from an earlier run.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-board-hook-'));
  try {
    const hookInput = {
      hook_event_name: 'PostToolUse',
      session_id: 'hook-e2e',
      cwd: path.join(__dirname, '..'),
      tool_name: 'Bash',
      tool_input: { command: 'export API_TOKEN=sk-abcdefghijklmnop1234 && ./deploy.sh' },
    };
    const run = spawnSync('python3', [HOOK], {
      input: JSON.stringify(hookInput),
      env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, CC_BOARD_URL: base, CC_BOARD_SECRET: SECRET, CC_BOARD_HOST: 'testbox' },
      timeout: 10000,
    });
    assert.equal(run.status, 0, String(run.stderr));

    const p = await (await fetch(base + '/sessions')).json();
    assert.equal(p.sessions.length, 1);
    const s = p.sessions[0];
    assert.equal(s.host, 'testbox');
    assert.equal(s.project, 'cc-session-board');
    assert.equal(s.state, 'working');
    assert.equal(s.tool, 'Bash');
    assert.equal(s.target, 'export API_TOKEN=*** && ./deploy.sh');
    assert.doesNotMatch(JSON.stringify(p), /sk-abcdefghijklmnop1234/);
  } finally {
    hub.server.closeAllConnections();
    await new Promise((resolve) => hub.server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
