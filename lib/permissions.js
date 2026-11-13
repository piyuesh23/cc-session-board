'use strict';

// Permission prompts waiting for a remote allow / deny. Pure logic, no I/O
// except an injectable id generator, so it can be unit tested with a fake clock.
//
// A request is pending until someone decides it, the hook gives up (cancel) or
// it expires. Settled requests linger briefly so a hook whose long-poll was in
// flight can still read the answer, then they are dropped. Nothing here is
// persisted: after a hub restart the hook just sees a 404 & falls back to the
// normal prompt in the terminal.

const crypto = require('node:crypto');
const { clip } = require('./store');

const DECISIONS = new Set(['allow', 'deny']);
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;

// AskUserQuestion's questions, cut down to what a remote needs to show them.
// Anything malformed is dropped, so a bad payload degrades to a plain prompt.
function cleanQuestions(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const q of raw.slice(0, MAX_QUESTIONS)) {
    if (!q || typeof q !== 'object' || !Array.isArray(q.options)) return null;
    const options = q.options.slice(0, MAX_OPTIONS).map((o) => ({
      label: clip(o && o.label, 60),
      description: clip(o && o.description, 120),
    }));
    if (!clip(q.question, 300) || options.length < 2 || options.some((o) => !o.label)) return null;
    out.push({ question: clip(q.question, 300), header: clip(q.header, 24), multiSelect: q.multiSelect === true, options });
  }
  return out.length ? out : null;
}

// Answers arrive as one entry per question: a label, or a list of labels when
// the question is multi-select. They are kept as option indexes, so the hook
// can map them back to the exact text Claude asked (the hub only sees a
// redacted, clipped copy). Returns { answers } or { error }.
function parseAnswers(questions, raw) {
  if (!Array.isArray(raw) || raw.length !== questions.length) {
    return { error: `answers must be a list with one entry per question (${questions.length})` };
  }
  const answers = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const picked = Array.isArray(raw[i]) ? raw[i] : [raw[i]];
    if (!picked.length || (!q.multiSelect && picked.length > 1)) {
      return { error: `question ${i + 1} needs ${q.multiSelect ? 'at least one label' : 'exactly one label'}` };
    }
    const idx = [];
    for (const label of picked) {
      const n = q.options.findIndex((o) => o.label === label);
      if (n < 0) return { error: `question ${i + 1} has no option "${String(label).slice(0, 60)}"` };
      if (!idx.includes(n)) idx.push(n);
    }
    answers.push(idx.sort((a, b) => a - b));
  }
  return { answers };
}

class Permissions {
  constructor({
    pendingMs = 15 * 60e3,
    keepMs = 60e3,
    now = Date.now,
    newId = () => crypto.randomBytes(8).toString('hex'),
  } = {}) {
    this.pendingMs = pendingMs;
    this.keepMs = keepMs;
    this.now = now;
    this.newId = newId;
    this.requests = new Map();
    this.listeners = new Map(); // id -> Set of callbacks waiting for it to settle
  }

  // A hook is waiting on a permission prompt. Returns { ok, id } or { ok, error }.
  create(body) {
    if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
    const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
    if (!sessionId || sessionId.length > 128) return { ok: false, error: 'session_id is required (max 128 chars)' };
    this.sweep();
    const id = this.newId();
    const questions = cleanQuestions(body.questions);
    this.requests.set(id, {
      id,
      session_id: sessionId,
      project: clip(body.project, 64) || 'unknown',
      host: clip(body.host, 32),
      branch: clip(body.branch, 64),
      tool: clip(body.tool, 48),
      target: clip(body.target, 120),
      ...(questions ? { questions } : {}),
      createdAt: this.now(),
      state: 'pending',
      message: '',
      answers: null,
      settledAt: 0,
    });
    return { ok: true, id };
  }

  // { state, message?, answers? } or null for an unknown (or long gone) id.
  get(id) {
    this.sweep();
    const r = this.requests.get(id);
    return r ? result(r) : null;
  }

  // Pending requests only, oldest first, for whoever is answering them.
  pending() {
    this.sweep();
    const out = [];
    for (const r of this.requests.values()) {
      if (r.state !== 'pending') continue;
      const { id, session_id, project, host, branch, tool, target, questions, createdAt } = r;
      out.push({ id, session_id, project, host, branch, tool, target, ...(questions ? { questions } : {}), createdAt });
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  // Returns { ok, status, error? } so the route can pass the status straight on.
  // Allowing a question means answering it, so answers are required then.
  decide(id, decision, message, rawAnswers) {
    this.sweep();
    if (!DECISIONS.has(decision)) return { ok: false, status: 400, error: 'decision must be "allow" or "deny"' };
    const r = this.requests.get(id);
    if (!r) return { ok: false, status: 404, error: 'no such permission request' };
    if (r.state !== 'pending') return { ok: false, status: 409, error: `already ${r.state}` };
    let answers = null;
    if (decision === 'allow' && r.questions) {
      const parsed = parseAnswers(r.questions, rawAnswers);
      if (parsed.error) return { ok: false, status: 400, error: parsed.error };
      answers = parsed.answers;
    }
    r.answers = answers;
    this.settle(r, decision, clip(message, 200));
    return { ok: true, status: 200 };
  }

  // The hook gave up. Cancelling something already decided is a harmless no-op:
  // the hook may have timed out a moment after the answer arrived.
  cancel(id) {
    this.sweep();
    const r = this.requests.get(id);
    if (!r) return false;
    if (r.state === 'pending') this.settle(r, 'cancelled', '');
    return true;
  }

  // Call fn(state) once the request is no longer pending. Returns an unsubscribe
  // function so a long-poll that times out or disconnects leaves nothing behind.
  onSettle(id, fn) {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size && this.listeners.get(id) === set) this.listeners.delete(id);
    };
  }

  count() {
    return this.pending().length;
  }

  // Expire old pending requests & drop settled ones. Returns true when the
  // pending list changed, so the hub knows to push a new board.
  sweep() {
    const t = this.now();
    let changed = false;
    for (const r of [...this.requests.values()]) {
      if (r.state === 'pending' && t - r.createdAt > this.pendingMs) {
        // Wake any long-poll with "cancelled" before the id disappears.
        this.settle(r, 'cancelled', '');
        this.requests.delete(r.id);
        changed = true;
      } else if (r.state !== 'pending' && t - r.settledAt > this.keepMs) {
        this.requests.delete(r.id);
      }
    }
    return changed;
  }

  settle(r, state, message) {
    r.state = state;
    r.message = message;
    r.settledAt = this.now();
    const set = this.listeners.get(r.id);
    this.listeners.delete(r.id);
    if (!set) return;
    for (const fn of set) fn(result(r));
  }
}

function result(r) {
  const out = { state: r.state };
  if (r.message) out.message = r.message;
  if (r.answers) out.answers = r.answers;
  return out;
}

module.exports = { Permissions, DECISIONS, cleanQuestions, parseAnswers };
