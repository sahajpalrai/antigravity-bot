// Antigravity v2 — Event Bus
// In-memory ring buffer of decision/bar/entry/exit events. Drives the Trading
// Floor Terminal's live event stream pane via polling (/api/events?after=seq).
//
// Events are sequential (monotonic seq number). Dashboard sends `after=N` and
// receives every event with seq > N. New connections start with the last 200.

'use strict';

const RING_SIZE = 500;
const ring = new Array(RING_SIZE).fill(null);
let nextSeq = 1;
let writeIdx = 0;

const TYPES = {
  BAR: 'BAR',                 // new closed bar received
  DECISION: 'DECISION',       // model produced a probability + verdict
  ENTRY: 'ENTRY',             // paper or live entry placed
  EXIT: 'EXIT',               // position closed (SL/TP/manual)
  BE_MOVE: 'BE_MOVE',         // stop moved to breakeven
  TRAIL_MOVE: 'TRAIL_MOVE',   // trailing stop advanced
  REGIME_CHANGE: 'REGIME_CHANGE',
  BLOCKED: 'BLOCKED',         // signal fired but blocked (in-position, gated, etc.)
  ERROR: 'ERROR',
  INFO: 'INFO'
};

function emit(type, symbol, message, data = {}) {
  const ev = {
    seq: nextSeq++,
    ts: Date.now(),
    type,
    symbol: symbol || null,
    message: message || '',
    data
  };
  ring[writeIdx] = ev;
  writeIdx = (writeIdx + 1) % RING_SIZE;
  return ev;
}

// Returns events with seq > after, optionally filtered by symbol or types.
// `limit` caps the number returned (most-recent N if no after, else all matching).
function getEvents(after = 0, opts = {}) {
  const filterSym = opts.symbol || null;
  const filterTypes = opts.types || null;   // array of TYPES values
  const limit = opts.limit || 250;
  const errorsOnly = !!opts.errorsOnly;

  const out = [];
  // Walk the ring in seq order. Cheaper than re-sorting: iterate full ring,
  // include events that match, then sort by seq at the end and slice to limit.
  for (let i = 0; i < RING_SIZE; i++) {
    const ev = ring[i];
    if (!ev) continue;
    if (ev.seq <= after) continue;
    if (filterSym && ev.symbol !== filterSym) continue;
    if (filterTypes && !filterTypes.includes(ev.type)) continue;
    if (errorsOnly && ev.type !== TYPES.ERROR) continue;
    out.push(ev);
  }
  out.sort((a, b) => a.seq - b.seq);
  // Keep the most recent N (the dashboard renders newest-first)
  return out.slice(-limit);
}

function currentSeq() { return nextSeq - 1; }

function clear() {
  ring.fill(null);
  writeIdx = 0;
  nextSeq = 1;
}

module.exports = {
  emit,
  getEvents,
  currentSeq,
  clear,
  TYPES
};
