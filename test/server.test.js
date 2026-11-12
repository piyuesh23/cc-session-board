'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHub, resolveHost, bindWarning } = require('../server');

const SECRET = 'test-secret';

async function withHub(fn, extra = {}) {
  const hub = createHub({
    port: 0, host: '127.0.0.1', secret: SECRET,
    staleMin: 10, hideMin: 60, quietHours: '23:00-07:00', stateFile: '',
    ...extra,
  });
  await new Promise((resolve) => hub.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const post = (path, body, secret = SECRET) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'x-board-secret': secret } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  try {
    await fn({ base, post });
  } finally {
    hub.server.closeAllConnections();
    await new Promise((resolve) => hub.server.close(resolve));
  }
}

test('refuses to start without a secret', () => {
  assert.throws(() => createHub({ secret: '' }), /BOARD_SECRET/);
});

test('HOST=tailscale resolves through the tailscale CLI, anything else passes through', () => {
  assert.equal(resolveHost('127.0.0.1'), '127.0.0.1');
  assert.equal(resolveHost('tailscale', () => '100.64.0.7\n'), '100.64.0.7');
  assert.throws(() => resolveHost('tailscale', () => 'no ip'), /returned/);
  assert.throws(() => resolveHost('tailscale', () => { throw new Error('ENOENT'); }), /failed/);
});

test('binding to every interface is called out', () => {
  assert.match(bindWarning('0.0.0.0'), /every interface/);
  assert.match(bindWarning(''), /every interface/);
  assert.equal(bindWarning('100.64.0.7'), null);
});

test('events need the shared secret', async () => {
  await withHub(async ({ post }) => {
    const body = { session_id: 'a', event: 'prompt', project: 'demo' };
    assert.equal((await post('/event', body, '')).status, 401);
    assert.equal((await post('/event', body, 'wrong')).status, 401);
    assert.equal((await post('/event', body)).status, 200);
  });
});

test('bad input gets a 400, not a crash', async () => {
  await withHub(async ({ post }) => {
    assert.equal((await post('/event', '{not json')).status, 400);
    assert.equal((await post('/event', { session_id: 'a', event: 'nope' })).status, 400);
    assert.equal((await post('/event', 'x'.repeat(70 * 1024))).status, 413);
  });
});

test('events show up on /sessions, ack and hide work', async () => {
  await withHub(async ({ base, post }) => {
    await post('/event', { session_id: 'a', event: 'notification', project: 'demo', branch: 'main', message: 'Allow Edit?' });
    await post('/vitals', { host: 'devbox', cpu: 34, ram_used_gb: 18, ram_total_gb: 48 });

    let p = await (await fetch(base + '/sessions')).json();
    assert.equal(p.sessions[0].state, 'needs_input');
    assert.equal(p.sessions[0].project, 'demo');
    assert.deepEqual(p.counts, { waiting: 1, total: 1 });
    assert.equal(p.vitals.cpu, 34);

    assert.equal((await post('/ack', { id: 'a' }, '')).status, 200);
    p = await (await fetch(base + '/sessions')).json();
    assert.equal(p.sessions[0].acked, true);

    assert.equal((await post('/hide', { id: 'a' }, '')).status, 200);
    p = await (await fetch(base + '/sessions')).json();
    assert.equal(p.sessions.length, 0);

    assert.equal((await post('/ack', { id: 'missing' }, '')).status, 404);
  });
});

test('/live sends the board, pushes changes and pings so a dead socket can be told apart', async () => {
  await withHub(async ({ base, post }) => {
    const res = await fetch(base + '/live');
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // One SSE frame: { event, data }. A frame without an event line is a board payload.
    const nextFrame = async () => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const lines = buffer.slice(0, end).split('\n');
          buffer = buffer.slice(end + 2);
          const field = (name) => lines.filter((l) => l.startsWith(name + ': ')).map((l) => l.slice(name.length + 2)).join('\n');
          if (!field('data')) continue; // the initial "retry:" line
          return { event: field('event') || 'message', data: JSON.parse(field('data')) };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
      }
    };
    const nextOf = async (event) => {
      for (;;) {
        const frame = await nextFrame();
        if (frame.event === event) return frame.data;
      }
    };

    assert.equal((await nextOf('message')).sessions.length, 0);
    await post('/event', { session_id: 'a', event: 'prompt', project: 'demo' });
    assert.equal((await nextOf('message')).sessions[0].state, 'working');
    assert.deepEqual(await nextOf('ping'), {});
    await reader.cancel();
  }, { keepAliveMs: 50 });
});

test('the board page is served', async () => {
  await withHub(async ({ base }) => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Session Board/);
  });
});
