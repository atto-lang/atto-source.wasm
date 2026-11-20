// Experimental trusted-host destination mailbox ticket correlation v1.
// This is a bounded HOST MODEL, not compiler-emitted guest send_ack/request,
// a socket, crypto/authentication, a JS Worker scheduler, or a TenantVM wall.
// A gateway MUST authenticate tenant and actor capability before admit();
// identities supplied here are correlation metadata, NOT authorization.
// The real actor runtime, not a guest callback, must call begin/commit/panic.
import {checked_proxy_receipt_identity_v1} from './proxy-receipt-gate-v1.mjs';

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
function i64(v) {
  if (typeof v !== 'bigint' || v < I64_MIN || v > I64_MAX)
    throw Error('E_PROXY_TICKET_I64');
  return v;
}
function boundedPositive(v) {
  return typeof v === 'bigint' && v > 0n && v <= (1n << 64n) - 1n;
}
function owns(target, id) {
  return id.target_actor === target.actor && id.target_incarnation === target.incarnation;
}
export class HostProxyMailboxTicketsV1 {
  #actor;
  #incarnation;
  #capacity;
  #queued = [];
  #current = null;
  #tickets = new WeakMap();
  #closed = false;
  #fenced = false;
  #admitted = 0;
  #processed = 0;
  #failed = 0;
  #abandoned = 0;
  constructor({actor, incarnation, capacity}) {
    if (!boundedPositive(actor) || !boundedPositive(incarnation) ||
        !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096)
      throw Error('E_PROXY_TICKET_TARGET');
    this.#actor = actor;
    this.#incarnation = incarnation;
    this.#capacity = capacity;
  }
  get counters() {
    return Object.freeze({admitted: this.#admitted, processed: this.#processed,
      failed: this.#failed, abandoned: this.#abandoned,
      queued: this.#queued.length, running: this.#current !== null});
  }
  // A production implementation must additionally check actor capability,
  // replay window, tenant policy and runtime-issued incarnation. No
  // authorization follows merely from matching the route fields.
  admit(route, value) {
    let id;
    try { id = checked_proxy_receipt_identity_v1(route); i64(value); }
    catch { return Object.freeze({status: 'invalid', ticket: null}); }
    if (!owns({actor: this.#actor, incarnation: this.#incarnation}, id))
      return Object.freeze({status: 'stale', ticket: null});
    if (this.#closed || this.#fenced)
      return Object.freeze({status: 'closed', ticket: null});
    if (this.#queued.length >= this.#capacity)
      return Object.freeze({status: 'full', ticket: null});
    const ticket = Object.freeze(Object.create(null));
    this.#tickets.set(ticket, {id, value, stage: 'admitted',
      hasResult: false, result: null});
    this.#queued.push(ticket);
    this.#admitted++;
    return Object.freeze({status: 'admitted', ticket});
  }
  snapshot(ticket) {
    const t = this.#tickets.get(ticket);
    if (!t) return null;
    return Object.freeze({stage: t.stage, route: t.id,
      hasResult: t.hasResult, result: t.result});
  }
  // The *trusted scheduler* calls begin when the actual mailbox dequeues.
  // Only one logical continuation per actor is active in this host profile.
  begin() {
    if (this.#fenced || this.#current || this.#queued.length === 0) return null;
    const ticket = this.#queued.shift();
    const state = this.#tickets.get(ticket);
    if (!state || state.stage !== 'admitted')
      throw Error('E_PROXY_TICKET_CONSERVATION');
    state.stage = 'started';
    this.#current = ticket;
    return Object.freeze({ticket, value: state.value});
  }
  // commit only after real handler return; never infer from aggregate counters.
  commit(turn, result) {
    if (!turn || turn.ticket !== this.#current || !this.#current)
      return false;
    const state = this.#tickets.get(turn.ticket);
    if (!state || state.stage !== 'started' || this.#fenced) return false;
    i64(result);
    state.result = result;
    state.hasResult = true;
    state.stage = 'processed';
    this.#processed++;
    this.#current = null;
    return true;
  }
  // A handler exception faults exactly the active mail, then fences and
  // abandons all waiting tickets. CONTROL notification is a separate contract.
  panic(turn) {
    if (!turn || turn.ticket !== this.#current || !this.#current) return false;
    const state = this.#tickets.get(turn.ticket);
    if (!state || state.stage !== 'started') return false;
    state.stage = 'failed';
    this.#failed++;
    this.#current = null;
    this.#fenced = true;
    this.#closed = true;
    for (const ticket of this.#queued) {
      const queued = this.#tickets.get(ticket);
      if (queued.stage !== 'admitted') throw Error('E_PROXY_TICKET_CONSERVATION');
      queued.stage = 'abandoned';
      this.#abandoned++;
    }
    this.#queued.length = 0;
    return true;
  }
  close() { this.#closed = true; } // graceful stop drains previously admitted mail
  check_conservation() {
    const c = this.counters;
    return c.admitted === c.processed + c.failed + c.abandoned +
      c.queued + (c.running ? 1 : 0);
  }
}
