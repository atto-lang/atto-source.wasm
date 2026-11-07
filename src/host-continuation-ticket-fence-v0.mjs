/**
 * Host-only, generation-fenced continuation *admission* v0.
 *
 * No guest suspension/resume exists in the current wasm32 scalar actor ABI.
 * A claimed ticket is NOT permission to enter a WebAssembly.Instance, invoke
 * a continuation, or retain an actor-owned frame after its turn. This module
 * provides the cancellation/replay/quota identity substrate for later
 * compiler-generated suspended frames without claiming guest execution.
 *
 * Tickets are opaque unforgeable JS object identities; never marshal them
 * over channels, expose a guest pointer, encode in a JSON payload, or use
 * caller-chosen strings/numbers as resume authority.
 */
const MAX_PENDING_LIMIT = 64;
const validGeneration = generation =>
  Number.isSafeInteger(generation) && generation > 0;

export class HostContinuationTicketFenceV0 {
  #generation = 0;
  #retired = true;
  #maxPending;
  #records = new WeakMap();
  #pending = new Set();

  constructor({maxPending = MAX_PENDING_LIMIT} = {}) {
    if (!Number.isSafeInteger(maxPending) ||
        maxPending < 1 || maxPending > MAX_PENDING_LIMIT)
      throw new RangeError("host continuation ticket quota must be 1..64");
    this.#maxPending = maxPending;
  }

  get generation() {return this.#generation;}
  get pendingCount() {return this.#pending.size;}
  get retired() {return this.#retired;}

  activate(generation) {
    if (!validGeneration(generation) || !this.#retired ||
        generation !== this.#generation + 1)
      throw Error("HOST_CONTINUATION_GENERATION_NOT_ADMITTED");
    this.#generation = generation;
    this.#retired = false;
  }

  #requireCurrent(generation) {
    if (!validGeneration(generation) || this.#retired ||
        generation !== this.#generation)
      throw Error("STALE_ACTOR_GENERATION: host continuation generation retired");
  }

  mint(generation) {
    this.#requireCurrent(generation);
    if (this.#pending.size >= this.#maxPending)
      throw Error("HOST_CONTINUATION_TICKET_QUOTA_EXCEEDED");
    // No enumerable actor ID, generation, random token or host closure is
    // carried in the ticket. Structured cloning cannot transfer its identity.
    const ticket = Object.freeze(Object.create(null));
    this.#records.set(ticket, {generation, state: "pending"});
    this.#pending.add(ticket);
    return ticket;
  }

  #record(ticket) {
    if ((typeof ticket !== "object" || ticket === null) &&
        typeof ticket !== "function")
      throw Error("INVALID_HOST_CONTINUATION_TICKET");
    const record = this.#records.get(ticket);
    if (!record) throw Error("INVALID_HOST_CONTINUATION_TICKET");
    if (record.state !== "pending")
      throw Error("STALE_OR_REPLAYED_HOST_CONTINUATION_TICKET");
    return record;
  }

  claimHostOnly(ticket, generation) {
    // Fail closed; do not consume a ticket on foreign-generation claims.
    const record = this.#record(ticket);
    this.#requireCurrent(generation);
    if (record.generation !== generation)
      throw Error("STALE_ACTOR_GENERATION: host continuation ticket");
    record.state = "claimed";
    this.#pending.delete(ticket);
    // This is accounting only. There is intentionally no guest resume call
    // here and no ability to recover host closures or native stack frames.
    return Object.freeze({
      schemaVersion: 0,
      kind: "HOST_CONTINUATION_ACCOUNTING_ONLY",
      generation,
      guestResumeAuthorized: false
    });
  }

  cancel(ticket, generation) {
    const record = this.#record(ticket);
    this.#requireCurrent(generation);
    if (record.generation !== generation)
      throw Error("STALE_ACTOR_GENERATION: host continuation ticket");
    record.state = "canceled";
    this.#pending.delete(ticket);
    return true;
  }

  retire(generation) {
    if (!validGeneration(generation) || generation !== this.#generation)
      throw Error("STALE_ACTOR_GENERATION: cannot retire foreign continuation tickets");
    if (this.#retired) return 0; // idempotent cleanup within the same generation
    const revoked = this.#pending.size;
    for (const ticket of this.#pending) {
      const record = this.#records.get(ticket);
      if (record) record.state = "retired";
    }
    this.#pending.clear();
    this.#retired = true;
    return revoked;
  }

  resumeGuest() {
    // A compatible host ticket does NOT imply a valid compiler-generated
    // suspension frame/ownership root/return-PC. Prevent any placeholder
    // route from silently claiming guest continuation support.
    throw Error("ATTO_GUEST_SUSPEND_RESUME_NOT_IMPLEMENTED");
  }
}
