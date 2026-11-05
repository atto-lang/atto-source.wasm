/**
 * Host-only, single-flight STOP receipt ledger for future WASM worker
 * supervision. This does NOT admit source `define supervisor` or expose a
 * guest-callable CONTROL ABI. All child/ticket identities are opaque objects,
 * stored by identity in private maps, not forgeable wire-format strings.
 *
 * Runtime owner must assert physical child finalization and independently
 * verify any externally applied STOP effect before acknowledging it.
 */
const identifierEncoder = new TextEncoder();
const unsafeId = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u;
function validId(value) {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > 128 || unsafeId.test(value)) return false;
  // TextEncoder repairs invalid surrogate pairs. Physical identity must not
  // acquire different bytes when copied to another compiler/backend.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++i >= value.length || value.charCodeAt(i) < 0xdc00 ||
          value.charCodeAt(i) > 0xdfff) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return identifierEncoder.encode(value).length <= 128;
}
const validGeneration = value => Number.isSafeInteger(value) && value > 0;

export class SupervisorStopLedger {
  #supervisor;
  #group;
  #capacity;
  #nextTurn = 1;
  #children = new Map();
  #tickets = new WeakMap();
  #seenActors = new Set();
  #activeTicket = null;

  constructor({supervisor, group, capacity = 1024}) {
    if (!validId(supervisor) || !validId(group) ||
        !Number.isInteger(capacity) || capacity < 1 || capacity > 65_536)
      throw new TypeError("invalid supervisor/group or bounded CONTROL capacity");
    this.#supervisor = supervisor;
    this.#group = group;
    this.#capacity = capacity;
  }

  register({actorId, incarnation}) {
    if (!validId(actorId) || !validGeneration(incarnation))
      throw new TypeError("invalid physical actor identity/generation");
    if (this.#children.size >= this.#capacity)
      throw Error("supervisor child capacity exhausted");
    const physicalKey = JSON.stringify([actorId, incarnation]);
    if (this.#seenActors.has(physicalKey))
      throw Error("duplicate physical actor generation");
    // No enumerable fields, getters or prototype-bearing methods expose
    // supervisor authority. Cloning/serializing never preserves identity.
    const child = Object.freeze(Object.create(null));
    this.#seenActors.add(physicalKey);
    this.#children.set(child, {
      supervisor: this.#supervisor,
      group: this.#group,
      actorId, incarnation, phase: "active", ticket: null,
      turnGeneration: 0, receipt: null, invoked: false
    });
    return child;
  }

  #requireChild(child) {
    const state = this.#children.get(child);
    if (!state) throw Error("foreign or stale supervisor child authority");
    return state;
  }

  #requireTicket(ticket) {
    const state = this.#tickets.get(ticket);
    if (!state || this.#activeTicket !== ticket ||
        state.phase !== "stopping" || state.ticket !== ticket)
      throw Error("foreign, replayed or stale STOP receipt");
    return state;
  }

  snapshot(child) {
    const {phase, actorId, incarnation} = this.#requireChild(child);
    return Object.freeze({phase, actorId, incarnation});
  }

  assert_physically_finalized(child) {
    const state = this.#requireChild(child);
    if (state.phase !== "active")
      throw Error("duplicate or stale physical finalization");
    state.phase = "finalized";
  }

  reserve_stop(child) {
    const state = this.#requireChild(child);
    if (this.#activeTicket !== null)
      throw Error("supervisor CONTROL turn already active");
    if (state.phase !== "finalized")
      throw Error("STOP requires physically finalized child");
    if (!Number.isSafeInteger(this.#nextTurn) ||
        this.#nextTurn >= Number.MAX_SAFE_INTEGER)
      throw Error("supervisor CONTROL turn generation exhausted");
    const ticket = Object.freeze(Object.create(null));
    state.phase = "stopping";
    state.receipt = "pending";
    state.ticket = ticket;
    state.turnGeneration = this.#nextTurn;
    this.#activeTicket = ticket;
    this.#tickets.set(ticket, state);
    this.#nextTurn++;
    return ticket;
  }

  claim_host_invocation(ticket) {
    const state = this.#requireTicket(ticket);
    if (state.invoked || state.receipt !== "pending")
      throw Error("STOP already invoked or classified");
    state.invoked = true;
  }

  mark_applied(ticket) {
    const state = this.#requireTicket(ticket);
    if (!state.invoked || state.receipt !== "pending")
      throw Error("STOP not invoked or previously classified");
    state.receipt = "applied";
  }

  mark_uncertain(ticket) {
    const state = this.#requireTicket(ticket);
    if (!state.invoked) throw Error("STOP was not invoked");
    if (state.receipt === "uncertain") return;
    if (state.receipt !== "pending")
      throw Error("cannot downgrade confirmed STOP");
    state.receipt = "uncertain";
  }

  receipt(ticket) {
    return this.#requireTicket(ticket).receipt;
  }

  // Data-only audit snapshot. The opaque ticket remains a distinct reference;
  // serializing this snapshot cannot authorize a host lifecycle effect.
  receipt_snapshot(ticket) {
    const {actorId, incarnation, turnGeneration, receipt} =
      this.#requireTicket(ticket);
    return Object.freeze({actorId, incarnation, turnGeneration, receipt});
  }

  #finish(ticket, state) {
    state.phase = "stopped";
    state.receipt = "acknowledged";
    state.ticket = null;
    this.#tickets.delete(ticket);
    this.#activeTicket = null;
  }

  acknowledge_applied(ticket) {
    const state = this.#requireTicket(ticket);
    if (state.receipt !== "applied")
      throw Error("host STOP effect not confirmed applied");
    this.#finish(ticket, state);
  }

  /** Trusted host must independently verify the external effect. */
  reconcile_verified_stop(ticket) {
    const state = this.#requireTicket(ticket);
    if (state.receipt !== "uncertain" && state.receipt !== "applied")
      throw Error("STOP not ready for trusted reconciliation");
    this.#finish(ticket, state);
  }
}
