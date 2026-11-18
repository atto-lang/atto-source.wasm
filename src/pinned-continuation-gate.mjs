/**
 * HOST-ONLY experimental admission ledger matching the LLVM pinned-continuation
 * state transitions. This does NOT pin WebAssembly guest memory, prove physical
 * actor-frame lifetime, implement callbacks, or grant a guest `await` feature.
 *
 * Trusted host code must establish broker quiescence and scheduler-only resume
 * authority; this object is not a cryptographic capability or isolation wall.
 * A single Node event loop serializes methods; this is not a multithreaded CAS
 * or hard-real-time implementation.
 */
const TERMINALS = new Set(["success", "failure", "cancelled", "timed_out", "closed"]);
const LOANS = new Set(["shared", "exclusive"]);
const MAX_RECEIPTS = 64;

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}
// Tickets are authority-bearing values. Inspect only enumerable own DATA
// descriptors; a getter or inherited key may switch the identity between
// validation and the physical resume/STOP transition.
function ticketData(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const proto=Object.getPrototypeOf(value);
  if (proto!==Object.prototype && proto!==null) return null;
  const names=["actorId","generation","operationId"];
  const keys=Reflect.ownKeys(value);
  if(keys.length!==names.length || keys.some(key=>!names.includes(key)))
    return null;
  const snapshot=Object.create(null);
  for(const key of names){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor?.enumerable || !Object.hasOwn(descriptor,"value") ||
       !positiveId(descriptor.value)) return null;
    snapshot[key]=descriptor.value;
  }
  return snapshot;
}

export class PinnedContinuationGate {
  #ticket;
  #receipts = new Map();
  #shared = 0;
  #exclusive = false;
  #terminal = null;
  #brokerQuiesced = false;
  #resumeClaimed = false;
  #resumeFinished = false;
  #retired = false;

  constructor(ticket) {
    const identity=ticketData(ticket);
    if (!identity) throw new TypeError("invalid continuation ticket");
    this.#ticket = Object.freeze(identity);
  }

  #valid(ticket) {
    const identity=ticketData(ticket);
    return !!identity && identity.actorId === this.#ticket.actorId &&
      identity.generation === this.#ticket.generation &&
      identity.operationId === this.#ticket.operationId;
  }

  get terminal() { return this.#terminal; }
  get retired() { return this.#retired; }
  get liveReceipts() { return this.#receipts.size; }
  get loanState() { return Object.freeze({shared: this.#shared, exclusive: this.#exclusive}); }

  acquire(ticket, borrowerId, mode) {
    if (!this.#valid(ticket) || !positiveId(borrowerId) ||
        !LOANS.has(mode) || this.#terminal !== null || this.#retired ||
        this.#receipts.size === MAX_RECEIPTS) return null;
    if (mode === "exclusive" ? this.#exclusive || this.#shared !== 0 : this.#exclusive)
      return null;
    // Opaque object identity, not a re-usable numeric slot or caller-owned ID.
    const receipt = Object.freeze(Object.create(null));
    this.#receipts.set(receipt, {borrowerId, mode});
    if (mode === "exclusive") this.#exclusive = true;
    else ++this.#shared;
    return receipt;
  }

  release(ticket, borrowerId, receipt) {
    if (!this.#valid(ticket) || !positiveId(borrowerId) ||
        !this.#receipts.has(receipt)) return false;
    const entry = this.#receipts.get(receipt);
    if (entry.borrowerId !== borrowerId) return false;
    this.#receipts.delete(receipt);
    if (entry.mode === "exclusive") this.#exclusive = false;
    else --this.#shared;
    return true;
  }

  settle(ticket, terminal) {
    if (!this.#valid(ticket) || !TERMINALS.has(terminal) ||
        this.#terminal !== null || this.#retired) return false;
    this.#terminal = terminal;
    return true;
  }
  brokerAcknowledge(ticket) {
    if (!this.#valid(ticket) || this.#terminal === null || this.#brokerQuiesced)
      return false;
    this.#brokerQuiesced = true;
    return true;
  }
  claimResume(ticket) {
    if (!this.#valid(ticket) || !this.#brokerQuiesced || this.#resumeClaimed)
      return false;
    this.#resumeClaimed = true;
    return true;
  }
  finishResume(ticket) {
    if (!this.#valid(ticket) || !this.#resumeClaimed || this.#resumeFinished)
      return false;
    this.#resumeFinished = true;
    return true;
  }
  tryRetire(ticket) {
    if (!this.#valid(ticket) || this.#retired || !this.#brokerQuiesced ||
        !this.#resumeFinished || this.#receipts.size !== 0 ||
        this.#shared !== 0 || this.#exclusive) return false;
    this.#retired = true;
    return true;
  }
}
