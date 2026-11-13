'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHub, resolveHost, bindWarning, parseUsage } = require('../server');

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
  const get = (path, secret = SECRET) => fetch(base + path, { headers: secret ? { 'x-board-secret': secret } : {} });
  try {
    await fn({ base, post, get, hub });
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

test('usage windows are validated one by one', () => {
  const good = { five_hour: { used_percentage: 23.46, resets_at: 1738425600 }, seven_day: { used_percentage: 41.2, resets_at: 1738857600 } };
  const u = parseUsage({ host: 'mac', ...good });
  assert.equal(u.host, 'mac');
  assert.deepEqual(u.five_hour, { usedPct: 23.5, resetsAt: 1738425600e3 });
  assert.deepEqual(u.seven_day, { usedPct: 41.2, resetsAt: 1738857600e3 });
  assert.ok(Date.now() - u.at < 1000);
  // one bad window is dropped, the other kept; nothing valid is a refusal
  assert.equal(parseUsage({ five_hour: { used_percentage: 120, resets_at: 1 }, seven_day: good.seven_day }).five_hour, undefined);
  assert.equal(parseUsage({ five_hour: { used_percentage: 'x' } }), null);
  assert.equal(parseUsage({}), null);
});

test('usage needs the secret, lands on /sessions and is pushed live', async () => {
  await withHub(async ({ base, post }) => {
    const body = { host: 'mac', five_hour: { used_percentage: 85, resets_at: 1738425600 } };
    assert.equal((await post('/usage', body, '')).status, 401);
    assert.equal((await post('/usage', { host: 'mac' })).status, 400);
    assert.equal((await post('/usage', body)).status, 200);
    const p = await (await fetch(base + '/sessions')).json();
    assert.equal(p.usage.five_hour.usedPct, 85);
    assert.equal(p.usage.seven_day, undefined);
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

const ask = { session_id: 'a', project: 'demo', host: 'mac', branch: 'main', tool: 'Bash', target: 'npm test' };

test('every permission route needs the secret', async () => {
  await withHub(async ({ post, get, hub }) => {
    assert.equal((await post('/permission', ask, '')).status, 401);
    const id = hub.permissions.create(ask).id;
    assert.equal((await get('/permissions', '')).status, 401);
    assert.equal((await get(`/permission/${id}`, 'wrong')).status, 401);
    assert.equal((await post(`/permission/${id}/decide`, { decision: 'allow' }, '')).status, 401);
    assert.equal((await post(`/permission/${id}/cancel`, {}, '')).status, 401);
    assert.deepEqual((await (await get(`/permission/${id}`)).json()), { ok: true, state: 'pending' });
  });
});

test('a permission request is listed, marks the tile amber and only the count reaches the board', async () => {
  await withHub(async ({ base, post, get }) => {
    assert.equal((await post('/permission', { tool: 'Bash' })).status, 400);
    const created = await (await post('/permission', ask)).json();
    assert.equal(created.ok, true);
    assert.match(created.id, /^[0-9a-f]{16}$/);

    const list = await (await get('/permissions')).json();
    assert.equal(list.ok, true);
    assert.deepEqual(list.pending.map(({ createdAt, ...r }) => r), [{ id: created.id, ...ask }]);
    assert.ok(Number.isFinite(list.pending[0].createdAt));

    const board = await (await fetch(base + '/sessions')).json();
    assert.equal(board.permissions, 1);
    assert.equal(board.sessions[0].state, 'needs_input');
    assert.equal(board.sessions[0].message, 'Allow Bash npm test?');
    assert.doesNotMatch(JSON.stringify(board), new RegExp(created.id));
  });
});

test('a long-poll wakes on decide; deciding twice is a conflict', async () => {
  await withHub(async ({ post, get }) => {
    const { id } = await (await post('/permission', ask)).json();
    const started = Date.now();
    const polled = get(`/permission/${id}?wait=10`).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await post(`/permission/${id}/decide`, { decision: 'maybe' })).status, 400);
    assert.equal((await post(`/permission/${id}/decide`, { decision: 'deny', message: 'Not now' })).status, 200);
    assert.deepEqual(await polled, { ok: true, state: 'deny', message: 'Not now' });
    assert.ok(Date.now() - started < 5000, 'answered on the decision, not the timeout');

    assert.equal((await post(`/permission/${id}/decide`, { decision: 'allow' })).status, 409);
    assert.deepEqual(await (await get(`/permission/${id}?wait=10`)).json(), { ok: true, state: 'deny', message: 'Not now' });
    assert.deepEqual((await (await get('/permissions')).json()).pending, []);
  });
});

test('a long-poll returns pending when the wait runs out and cleans up on disconnect', async () => {
  await withHub(async ({ base, post, get, hub }) => {
    const { id } = await (await post('/permission', ask)).json();
    assert.deepEqual(await (await get(`/permission/${id}?wait=1`)).json(), { ok: true, state: 'pending' });
    assert.equal(hub.permissions.listeners.size, 0);

    const abort = new AbortController();
    const gone = fetch(base + `/permission/${id}?wait=30`, { headers: { 'x-board-secret': SECRET }, signal: abort.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hub.permissions.listeners.size, 1);
    abort.abort();
    await gone;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hub.permissions.listeners.size, 0, 'a dropped long-poll leaves no listener');
  });
});

test('unknown ids are a 404; cancel wakes the long-poll', async () => {
  await withHub(async ({ post, get }) => {
    assert.equal((await get('/permission/abcdef')).status, 404);
    assert.equal((await post('/permission/abcdef/decide', { decision: 'allow' })).status, 404);
    assert.equal((await post('/permission/abcdef/cancel', {})).status, 404);
    assert.equal((await get('/permission/not-hex')).status, 404);

    const { id } = await (await post('/permission', ask)).json();
    const polled = get(`/permission/${id}?wait=10`).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await post(`/permission/${id}/cancel`, {})).status, 200);
    assert.deepEqual(await polled, { ok: true, state: 'cancelled' });
    assert.equal((await post(`/permission/${id}/decide`, { decision: 'allow' })).status, 409);
  });
});

test('pending requests expire after 15 minutes', async () => {
  const clock = { t: Date.now() };
  await withHub(async ({ base, post, get, hub }) => {
    const { id } = await (await post('/permission', ask)).json();
    const polled = get(`/permission/${id}?wait=10`).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 50));
    clock.t += 16 * 60e3;
    hub.permissions.sweep(); // what the ticker does
    assert.deepEqual(await polled, { ok: true, state: 'cancelled' });
    assert.equal((await get(`/permission/${id}`)).status, 404);
    assert.equal((await (await fetch(base + '/sessions')).json()).permissions, 0);
  }, { now: () => clock.t });
});

test('the approve key can list and answer prompts, nothing else', async () => {
  await withHub(async ({ post, get, hub }) => {
    const KEY = 'phone-key';
    assert.equal((await post('/permission', ask, KEY)).status, 401, 'cannot open a prompt');
    assert.equal((await post('/event', { session_id: 'a', event: 'stop' }, KEY)).status, 401, 'cannot post events');
    const id = hub.permissions.create(ask).id;
    assert.equal((await get(`/permission/${id}`, KEY)).status, 401, 'cannot poll');
    assert.equal((await post(`/permission/${id}/cancel`, {}, KEY)).status, 401, 'cannot cancel');
    assert.equal((await get('/permissions', KEY)).status, 200);
    assert.equal((await post(`/permission/${id}/decide`, { decision: 'allow' }, KEY)).status, 200);
    assert.equal((await get('/permissions', 'not-the-key')).status, 401);
  }, { approveSecret: 'phone-key' });
});

test('without APPROVE_SECRET only BOARD_SECRET answers', async () => {
  await withHub(async ({ post, get }) => {
    assert.equal((await get('/permissions', '')).status, 401, 'an empty key never matches an unset one');
    assert.equal((await post('/permission/abcdef/decide', { decision: 'allow' }, '')).status, 401);
  });
});

test('a question is listed with its options, shown on the tile and answered by label', async () => {
  await withHub(async ({ base, post, get }) => {
    const questions = [
      { question: 'Ship it today?', header: 'Release', options: [{ label: 'Yes' }, { label: 'Wait' }] },
      { question: 'Notify who?', header: 'Notify', multiSelect: true, options: [{ label: 'Team' }, { label: 'Ops' }] },
    ];
    const { id } = await (await post('/permission', { ...ask, tool: 'AskUserQuestion', target: '', questions })).json();
    const [req] = (await (await get('/permissions')).json()).pending;
    assert.equal(req.questions.length, 2);
    assert.equal(req.questions[1].options[1].label, 'Ops');
    const board = await (await fetch(base + '/sessions')).json();
    assert.equal(board.sessions[0].message, 'Ship it today? (+1 more)');
    assert.doesNotMatch(JSON.stringify(board), /Notify who/, 'the options stay behind the key');

    const polled = get(`/permission/${id}?wait=10`).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await post(`/permission/${id}/decide`, { decision: 'allow', answers: ['Maybe', ['Team']] })).status, 400);
    assert.equal((await post(`/permission/${id}/decide`, { decision: 'allow', answers: ['Wait', ['Ops', 'Team']] })).status, 200);
    assert.deepEqual(await polled, { ok: true, state: 'allow', answers: [[1], [0, 1]] });
  });
});
