// Trusted host-only logical FIFO queues. No guest ABI, persistence or sandbox.
// Ticket WeakMap metadata prevents forged/reconstructed JS tickets.
const positive = (value, name) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`invalid ${name}`);
};
export class DurableLockQueues {
  #generation;
  #limits;
  #lanes = new Map();
  #operations = new Set();
  #running = new Set();
  #tickets = new WeakMap();
  #sequence = 1;
  #count = 0;
  #bytes = 0;
  #accepting = true;
  constructor(generation, {maxLocks = 1024, maxEntries = 8192,
      maxPerLock = 128, maxBytes = 16 * 1024 * 1024} = {}) {
    positive(generation, 'generation');
    for (const [name, v] of Object.entries({maxLocks, maxEntries, maxPerLock, maxBytes})) positive(v, name);
    this.#generation = generation;
    this.#limits = {maxLocks, maxEntries, maxPerLock, maxBytes};
  }
  #resolve(ticket) {
    const entry = ticket !== null && typeof ticket === 'object' ? this.#tickets.get(ticket) : undefined;
    if (!entry || entry.ticket !== ticket || entry.generation !== this.#generation || !entry.live)
      throw new Error('stale or foreign durable queue ticket');
    return entry;
  }
  #head(ticket) {
    const entry = this.#resolve(ticket);
    if (this.#lanes.get(entry.lockId)?.[0] !== entry) throw new Error('not FIFO head');
    return entry;
  }
  enqueue({actorId, actorGeneration, lockId, operationId, bytes}) {
    for (const [name, value] of Object.entries({actorId, actorGeneration, lockId, operationId, bytes})) positive(value, name);
    if (!this.#accepting) throw new Error('quiescing');
    if (this.#operations.has(operationId)) throw new Error('duplicate outstanding operation');
    const old = this.#lanes.get(lockId);
    if (this.#count >= this.#limits.maxEntries || bytes > this.#limits.maxBytes - this.#bytes ||
        (!old && this.#lanes.size >= this.#limits.maxLocks) ||
        (old && old.length >= this.#limits.maxPerLock)) throw new RangeError('queue capacity exceeded');
    if (!Number.isSafeInteger(this.#sequence + 1)) throw new RangeError('sequence exhausted');
    const ticket = Object.freeze({isolateGeneration: this.#generation, lockId,
      sequence: this.#sequence++, operationId, actorId, actorGeneration});
    const entry = {ticket, generation: this.#generation, actor: `${actorId}:${actorGeneration}`,
      lockId, operationId, bytes, claimed: false, live: true};
    const lane = old ?? [];
    const head = lane.length === 0;
    lane.push(entry);
    if (!old) this.#lanes.set(lockId, lane);
    this.#operations.add(operationId);
    this.#tickets.set(ticket, entry);
    this.#count++;
    this.#bytes += bytes;
    return {ticket, head};
  }
  claim(ticket) {
    if (!this.#accepting) throw new Error('quiescing: new claims forbidden');
    const entry = this.#head(ticket);
    if (entry.claimed) throw new Error('double claim');
    if (this.#running.has(entry.actor)) return false;
    entry.claimed = true;
    this.#running.add(entry.actor);
    return true;
  }
  #removeHead(entry) {
    const lane = this.#lanes.get(entry.lockId);
    lane.shift();
    if (lane.length === 0) this.#lanes.delete(entry.lockId);
    entry.live = false;
    this.#operations.delete(entry.operationId);
    this.#count--;
    this.#bytes -= entry.bytes;
    return lane[0]?.ticket ?? null;
  }
  finish(ticket) {
    const entry = this.#head(ticket);
    if (!entry.claimed || !this.#running.has(entry.actor)) throw new Error('unclaimed finish');
    this.#running.delete(entry.actor);
    return this.#removeHead(entry);
  }
  cancelHead(ticket) {
    const entry = this.#head(ticket);
    if (entry.claimed) throw new Error('claimed head cannot cancel');
    return this.#removeHead(entry);
  }
  cancelWaiter(ticket) {
    const entry = this.#resolve(ticket);
    const lane = this.#lanes.get(entry.lockId);
    const index = lane.indexOf(entry);
    if (index <= 0) throw new Error('not a waiting ticket');
    lane.splice(index, 1);
    entry.live = false;
    this.#operations.delete(entry.operationId);
    this.#count--;
    this.#bytes -= entry.bytes;
  }
  hasActor(actorId, actorGeneration) {
    positive(actorId, 'actorId'); positive(actorGeneration, 'actorGeneration');
    const actor = `${actorId}:${actorGeneration}`;
    return [...this.#lanes.values()].some(lane => lane.some(entry => entry.actor === actor));
  }
  readyHeads() {
    if (!this.#accepting) return [];
    return [...this.#lanes.values()].filter(lane => !lane[0].claimed &&
      !this.#running.has(lane[0].actor)).map(lane => lane[0].ticket);
  }
  quiesce() { this.#accepting = false; }
  get drained() { return !this.#accepting && this.#count === 0 && this.#running.size === 0; }
  snapshot() { return Object.freeze({generation: this.#generation, entries: this.#count,
      locks: this.#lanes.size, bytes: this.#bytes, runningActors: this.#running.size,
      accepting: this.#accepting}); }
}
