'use strict';

// Fill the board with four sample sessions, one per state, so the layout can
// be checked without wiring any hooks.
//
//   BOARD_SECRET=... node scripts/simulate.js [http://localhost:8787]

const base = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
const secret = process.env.BOARD_SECRET;
if (!secret) {
  console.error('BOARD_SECRET is not set');
  process.exit(1);
}

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board-secret': secret },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
}

const HOSTS = { 'sim-1': 'mac', 'sim-2': 'mac', 'sim-3': 'fedora', 'sim-4': 'fedora' };
const event = (session_id, project, branch, rest) =>
  post('/event', { session_id, project, branch, host: HOSTS[session_id], ...rest });

(async () => {
  await event('sim-1', 'alldata-commerce', 'feat/zuora-sync', { event: 'prompt' });
  await event('sim-1', 'alldata-commerce', 'feat/zuora-sync', { event: 'tool', tool: 'Edit', target: 'billing/sync.ts' });
  await event('sim-1', 'alldata-commerce', 'feat/zuora-sync', {
    event: 'notification',
    notification_type: 'permission_prompt',
    message: 'Claude needs your permission to use Edit',
  });

  await event('sim-2', 'harness-lab', 'main', { event: 'prompt' });
  await event('sim-2', 'harness-lab', 'main', { event: 'tool', tool: 'Bash', target: 'pytest -q' });

  await event('sim-3', 'eventhorizon', 'fix/indexer', { event: 'prompt' });
  await event('sim-3', 'eventhorizon', 'fix/indexer', {
    event: 'stop',
    message: 'Refactored the indexer across 3 files. Tests pass.',
  });

  await event('sim-4', 'sd-wiki', 'main', { event: 'session_start' });

  console.log(`4 sample sessions posted to ${base}`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
