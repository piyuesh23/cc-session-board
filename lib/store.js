'use strict';

// Session state for the board. Pure logic, no I/O, so it can be unit tested.

const ORDER = { needs_input: 0, working: 1, done: 2, stale: 3 };

// What each incoming event does to a session's base state.
const EVENT_STATE = {
  session_start: 'done',
  prompt: 'working',
  tool: 'working',
  notification: 'needs_input',
  stop: 'done',
};

const KNOWN_EVENTS = new Set([...Object.keys(EVENT_STATE), 'session_end']);

function clip(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

class Store {
  constructor({ staleMs = 10 * 60e3, hideMs = 60 * 60e3, historySize = 10, now = Date.now } = {}) {
    this.staleMs = staleMs;
    this.hideMs = hideMs;
    this.historySize = historySize;
    this.now = now;
    this.sessions = new Map();
  }

  // Apply one hook event. Returns { ok, error? }.
  apply(evt) {
    if (!evt || typeof evt !== 'object') return { ok: false, error: 'body must be a JSON object' };
    const id = typeof evt.session_id === 'string' ? evt.session_id.trim() : '';
    if (!id || id.length > 128) return { ok: false, error: 'session_id is required (max 128 chars)' };
    if (!KNOWN_EVENTS.has(evt.event)) return { ok: false, error: `unknown event: ${evt.event}` };

    const t = this.now();

    if (evt.event === 'session_end') {
      this.sessions.delete(id);
      return { ok: true };
    }

    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        project: 'unknown',
        branch: '',
        base: 'done',
        message: '',
        tool: '',
        target: '',
        stateSince: t,
        lastEvent: t,
        startedAt: t,
        events: 0,
        toolCalls: 0,
        acked: false,
        hidden: false,
        history: [],
      };
      this.sessions.set(id, s);
    }

    if (evt.project) s.project = clip(evt.project, 64);
    if (typeof evt.branch === 'string') s.branch = clip(evt.branch, 64);

    const message = clip(evt.message, 200);
    let next = EVENT_STATE[evt.event];

    // Claude Code sends an idle notification about a minute after a turn ends.
    // A finished session is already known to be waiting on you, so it stays blue
    // instead of turning amber and chiming again.
    const idleAfterDone =
      evt.event === 'notification' && evt.notification_type === 'idle_prompt' && s.base === 'done';
    if (idleAfterDone) next = 'done';

    if (next !== s.base) {
      s.base = next;
      s.stateSince = t;
      s.acked = false;
    } else if (evt.event === 'notification' && !idleAfterDone && message && message !== s.message) {
      // A new question while still blocked: alert again.
      s.acked = false;
    }

    if (evt.event === 'tool') {
      s.toolCalls += 1;
      s.tool = clip(evt.tool, 48);
      s.target = clip(evt.target, 120);
    } else if (evt.event === 'prompt') {
      s.message = '';
      s.tool = '';
      s.target = '';
    } else if (!idleAfterDone) {
      if (evt.event === 'session_start') s.message = message || 'Session started';
      else if (message) s.message = message;
    }

    s.events += 1;
    s.lastEvent = t;
    s.hidden = false;

    s.history.push({
      at: t,
      event: evt.event,
      text: evt.event === 'tool' ? [s.tool, s.target].filter(Boolean).join(' · ') : message,
    });
    if (s.history.length > this.historySize) s.history.splice(0, s.history.length - this.historySize);

    return { ok: true };
  }

  ack(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.acked = true;
    return true;
  }

  hide(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.hidden = true;
    s.acked = true;
    return true;
  }

  // Visible sessions, in board order, with the derived state.
  list() {
    const t = this.now();
    const out = [];
    for (const [id, s] of this.sessions) {
      const quietFor = t - s.lastEvent;
      const blocked = s.base === 'needs_input';
      if (!blocked && quietFor > this.hideMs) {
        this.sessions.delete(id); // long gone: drop it so memory stays bounded
        continue;
      }
      if (s.hidden) continue;
      const stale = !blocked && quietFor > this.staleMs;
      out.push({
        id: s.id,
        project: s.project,
        branch: s.branch,
        state: stale ? 'stale' : s.base,
        since: stale ? s.lastEvent : s.stateSince,
        message: s.message,
        tool: s.tool,
        target: s.target,
        startedAt: s.startedAt,
        events: s.events,
        toolCalls: s.toolCalls,
        acked: s.acked,
        history: s.history,
      });
    }
    out.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.since - b.since);
    return out;
  }

  dump() {
    return [...this.sessions.values()];
  }

  load(rows) {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (row && typeof row.id === 'string' && EVENT_STATE_VALUES.has(row.base)) {
        this.sessions.set(row.id, row);
      }
    }
  }
}

const EVENT_STATE_VALUES = new Set(Object.values(EVENT_STATE));

module.exports = { Store, KNOWN_EVENTS, clip };
