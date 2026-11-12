'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../lib/store');

function makeStore(opts = {}) {
  const clock = { t: 1_000_000 };
  const store = new Store({ now: () => clock.t, ...opts });
  const ev = (session_id, event, rest = {}) => store.apply({ session_id, event, project: session_id, ...rest });
  const advance = (min) => { clock.t += min * 60e3; };
  return { store, ev, advance, clock };
}

test('rejects bad events', () => {
  const { store } = makeStore();
  assert.equal(store.apply(null).ok, false);
  assert.equal(store.apply({ event: 'stop' }).ok, false);
  assert.equal(store.apply({ session_id: 'a', event: 'nope' }).ok, false);
  assert.equal(store.list().length, 0);
});

test('events map to board states', () => {
  const { store, ev } = makeStore();
  ev('a', 'session_start');
  assert.equal(store.list()[0].state, 'done');
  ev('a', 'prompt');
  assert.equal(store.list()[0].state, 'working');
  ev('a', 'tool', { tool: 'Bash', target: 'npm test' });
  assert.equal(store.list()[0].tool, 'Bash');
  ev('a', 'notification', { message: 'Allow Edit?' });
  assert.equal(store.list()[0].state, 'needs_input');
  assert.equal(store.list()[0].message, 'Allow Edit?');
  ev('a', 'stop', { message: 'All done' });
  assert.equal(store.list()[0].state, 'done');
  ev('a', 'session_end');
  assert.equal(store.list().length, 0);
});

test('blocked sessions come first, longest wait first', () => {
  const { store, ev, advance } = makeStore();
  ev('done', 'stop');
  ev('working', 'prompt');
  ev('blocked-old', 'notification', { message: 'q1' });
  advance(1);
  ev('blocked-new', 'notification', { message: 'q2' });
  assert.deepEqual(store.list().map((s) => s.id), ['blocked-old', 'blocked-new', 'working', 'done']);
});

test('quiet sessions go stale, then drop off; blocked ones never do', () => {
  const { store, ev, advance } = makeStore();
  ev('w', 'prompt');
  ev('b', 'notification', { message: 'q' });
  advance(11);
  const byId = Object.fromEntries(store.list().map((s) => [s.id, s.state]));
  assert.deepEqual(byId, { b: 'needs_input', w: 'stale' });
  advance(60);
  assert.deepEqual(store.list().map((s) => s.id), ['b']);
});

test('a blocked session is dropped after a day of silence', () => {
  const { store, ev, advance } = makeStore();
  ev('b', 'notification', { message: 'q' });
  advance(23 * 60);
  assert.equal(store.list()[0].state, 'needs_input');
  advance(2 * 60);
  assert.equal(store.list().length, 0);
});

test('the timer restarts only when the state changes', () => {
  const { store, ev, advance, clock } = makeStore();
  ev('a', 'prompt');
  const started = clock.t;
  advance(2);
  ev('a', 'tool', { tool: 'Read' });
  assert.equal(store.list()[0].since, started);
  ev('a', 'stop');
  assert.equal(store.list()[0].since, clock.t);
});

test('ack silences a tile until a new question arrives', () => {
  const { store, ev } = makeStore();
  ev('a', 'notification', { message: 'q1' });
  assert.equal(store.ack('a'), true);
  assert.equal(store.list()[0].acked, true);
  ev('a', 'notification', { message: 'q1' });
  assert.equal(store.list()[0].acked, true);
  ev('a', 'notification', { message: 'q2' });
  assert.equal(store.list()[0].acked, false);
  assert.equal(store.ack('missing'), false);
});

test('a session remembers which machine it runs on', () => {
  const { store, ev } = makeStore();
  ev('a', 'prompt', { host: 'mac' });
  ev('a', 'tool', { tool: 'Read' });
  assert.equal(store.list()[0].host, 'mac');
  ev('b', 'prompt');
  assert.equal(store.list().find((s) => s.id === 'b').host, '');
});

test('hide lasts until the next event from that session', () => {
  const { store, ev } = makeStore();
  ev('a', 'stop');
  store.hide('a');
  assert.equal(store.list().length, 0);
  ev('a', 'prompt');
  assert.equal(store.list().length, 1);
});

test('the idle notification after a finished turn does not turn the tile amber', () => {
  const { store, ev } = makeStore();
  ev('a', 'stop', { message: 'Finished' });
  ev('a', 'notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  const s = store.list()[0];
  assert.equal(s.state, 'done');
  assert.equal(s.message, 'Finished');
  // ...but a permission prompt always does
  ev('a', 'notification', { notification_type: 'permission_prompt', message: 'Allow Bash?' });
  assert.equal(store.list()[0].state, 'needs_input');
});

test('an informational notification keeps the current state', () => {
  const { store, ev } = makeStore();
  ev('a', 'prompt');
  ev('a', 'tool', { tool: 'Bash', target: 'gh auth login' });
  ev('a', 'notification', { notification_type: 'auth_success', message: 'Logged in' });
  let s = store.list()[0];
  assert.equal(s.state, 'working');
  assert.equal(s.tool, 'Bash');
  ev('a', 'stop', { message: 'Finished' });
  ev('a', 'notification', { notification_type: 'auth_success', message: 'Logged in' });
  s = store.list()[0];
  assert.equal(s.state, 'done');
  assert.equal(s.message, 'Finished');
  // an unknown or missing type is still treated as a question
  ev('a', 'notification', { message: 'Allow Bash?' });
  assert.equal(store.list()[0].state, 'needs_input');
});

test('history keeps the last 10 events and long text is clipped', () => {
  const { store, ev } = makeStore();
  for (let i = 0; i < 15; i++) ev('a', 'tool', { tool: 'Bash', target: 'x'.repeat(500) });
  const s = store.list()[0];
  assert.equal(s.history.length, 10);
  assert.ok(s.target.length <= 120);
  assert.equal(s.toolCalls, 15);
});

test('dump and load round-trip', () => {
  const a = makeStore();
  a.ev('x', 'notification', { message: 'q' });
  const b = makeStore();
  b.store.load(JSON.parse(JSON.stringify(a.store.dump())));
  assert.equal(b.store.list()[0].state, 'needs_input');
  b.store.load('garbage');
  b.store.load([{ id: 'bad', base: 'nope' }]);
  assert.equal(b.store.list().length, 1);
});
