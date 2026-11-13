'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Permissions } = require('../lib/permissions');

function makePermissions(opts = {}) {
  const clock = { t: 1_000_000 };
  let n = 0;
  const perms = new Permissions({ now: () => clock.t, newId: () => `id${++n}`, ...opts });
  const ask = (session_id = 's', rest = {}) => perms.create({ session_id, project: 'demo', tool: 'Bash', target: 'npm test', ...rest }).id;
  const advance = (min) => { clock.t += min * 60e3; };
  return { perms, ask, advance, clock };
}

test('rejects a request without a session', () => {
  const { perms } = makePermissions();
  assert.equal(perms.create(null).ok, false);
  assert.equal(perms.create({ tool: 'Bash' }).ok, false);
  assert.equal(perms.create({ session_id: 'x'.repeat(200) }).ok, false);
  assert.deepEqual(perms.pending(), []);
});

test('pending requests are listed oldest first with clipped fields', () => {
  const { perms, ask, advance, clock } = makePermissions();
  const first = ask('a', { target: 'x'.repeat(500), host: 'mac', branch: 'main' });
  advance(1);
  const second = ask('b');
  const list = perms.pending();
  assert.deepEqual(list.map((r) => r.id), [first, second]);
  assert.deepEqual(Object.keys(list[0]).sort(), ['branch', 'createdAt', 'host', 'id', 'project', 'session_id', 'target', 'tool']);
  assert.ok(list[0].target.length <= 120);
  assert.equal(list[0].host, 'mac');
  assert.equal(list[1].createdAt, clock.t);
  assert.deepEqual(perms.get(first), { state: 'pending' });
  assert.equal(perms.count(), 2);
});

test('the default id is random hex', () => {
  const perms = new Permissions();
  const { id } = perms.create({ session_id: 's' });
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.notEqual(perms.create({ session_id: 's' }).id, id);
});

test('decide settles once and wakes listeners', () => {
  const { perms, ask } = makePermissions();
  const id = ask();
  const heard = [];
  perms.onSettle(id, (r) => heard.push(r));
  assert.deepEqual(perms.decide(id, 'maybe'), { ok: false, status: 400, error: 'decision must be "allow" or "deny"' });
  assert.equal(perms.decide('nope', 'allow').status, 404);
  assert.deepEqual(perms.decide(id, 'deny', 'Not on main'), { ok: true, status: 200 });
  assert.deepEqual(heard, [{ state: 'deny', message: 'Not on main' }]);
  assert.deepEqual(perms.get(id), { state: 'deny', message: 'Not on main' });
  assert.equal(perms.decide(id, 'allow').status, 409);
  assert.deepEqual(perms.pending(), []);
});

test('an unsubscribed listener is not called', () => {
  const { perms, ask } = makePermissions();
  const id = ask();
  let called = false;
  const off = perms.onSettle(id, () => { called = true; });
  off();
  perms.decide(id, 'allow');
  assert.equal(called, false);
  assert.equal(perms.listeners.size, 0);
});

test('cancel takes a request off the list; deciding it then is a conflict', () => {
  const { perms, ask } = makePermissions();
  const id = ask();
  const heard = [];
  perms.onSettle(id, (r) => heard.push(r));
  assert.equal(perms.cancel(id), true);
  assert.deepEqual(heard, [{ state: 'cancelled' }]);
  assert.equal(perms.decide(id, 'allow').status, 409);
  assert.equal(perms.cancel('nope'), false);
  // cancelling after a decision leaves the decision alone
  const other = ask();
  perms.decide(other, 'allow');
  assert.equal(perms.cancel(other), true);
  assert.deepEqual(perms.get(other), { state: 'allow' });
});

test('pending requests expire after 15 minutes and wake their listeners', () => {
  const { perms, ask, advance } = makePermissions();
  const stale = ask('a');
  const heard = [];
  perms.onSettle(stale, (r) => heard.push(r));
  advance(14);
  const fresh = ask('b');
  assert.equal(perms.sweep(), false);
  advance(2);
  assert.equal(perms.sweep(), true, 'an expiry changes the pending list');
  assert.deepEqual(heard, [{ state: 'cancelled' }]);
  assert.equal(perms.get(stale), null);
  assert.deepEqual(perms.pending().map((r) => r.id), [fresh]);
});

test('a decided request is dropped about a minute after the decision', () => {
  const { perms, ask, clock } = makePermissions();
  const id = ask();
  perms.decide(id, 'allow');
  clock.t += 59e3;
  assert.deepEqual(perms.get(id), { state: 'allow' });
  clock.t += 2e3;
  assert.equal(perms.get(id), null);
});

const questions = [
  { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite' }] },
  { question: 'Which extras?', header: 'Extras', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Search' }, { label: 'Billing' }] },
];

test('questions are kept, cleaned and listed; malformed ones are dropped', () => {
  const { perms, ask } = makePermissions();
  const id = ask('s', { tool: 'AskUserQuestion', target: '', questions });
  const [req] = perms.pending();
  assert.equal(req.id, id);
  assert.deepEqual(req.questions[0], {
    question: 'Which database?', header: 'DB', multiSelect: false,
    options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite', description: '' }],
  });
  assert.equal(req.questions[1].multiSelect, true);

  const bad = [null, 'nope', [], [{ question: 'Q', options: [{ label: 'only one' }] }], [{ question: '', options: [{ label: 'a' }, { label: 'b' }] }]];
  for (const q of bad) ask('x', { questions: q });
  assert.equal(perms.pending().filter((r) => r.questions).length, 1, 'only the good one carries questions');
});

test('allowing a question needs one valid answer per question, stored as option indexes', () => {
  const { perms, ask } = makePermissions();
  const id = ask('s', { tool: 'AskUserQuestion', questions });
  const heard = [];
  perms.onSettle(id, (r) => heard.push(r));
  assert.match(perms.decide(id, 'allow').error, /one entry per question/);
  assert.match(perms.decide(id, 'allow', '', ['Postgres']).error, /one entry per question/);
  assert.match(perms.decide(id, 'allow', '', ['MySQL', ['Auth']]).error, /no option "MySQL"/);
  assert.match(perms.decide(id, 'allow', '', [['Postgres', 'SQLite'], ['Auth']]).error, /exactly one label/);
  assert.match(perms.decide(id, 'allow', '', ['Postgres', []]).error, /at least one label/);
  assert.equal(perms.get(id).state, 'pending', 'a bad answer leaves it waiting');

  assert.deepEqual(perms.decide(id, 'allow', '', ['SQLite', ['Billing', 'Auth', 'Auth']]), { ok: true, status: 200 });
  assert.deepEqual(heard, [{ state: 'allow', answers: [[1], [0, 2]] }]);
  assert.deepEqual(perms.get(id), { state: 'allow', answers: [[1], [0, 2]] });
});

test('a question can be skipped with deny, and plain prompts ignore answers', () => {
  const { perms, ask } = makePermissions();
  const q = ask('s', { questions });
  assert.deepEqual(perms.decide(q, 'deny', 'skip'), { ok: true, status: 200 });
  assert.deepEqual(perms.get(q), { state: 'deny', message: 'skip' });
  const plain = ask('t');
  assert.equal(perms.decide(plain, 'allow', '', ['whatever']).ok, true);
  assert.deepEqual(perms.get(plain), { state: 'allow' });
});
