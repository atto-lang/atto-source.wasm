import {randomBytes} from 'node:crypto';

const MIN = -(1n << 63n), MAX = (1n << 63n) - 1n;
const bounded = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw RangeError('invalid ' + label);
  return value;
};

/**
 * Host-only capability registry around a pooled WASM actor runtime.
 * Opaque refs are issued only by this registry and cannot be reconstructed from
 * incoming MessagePack DATA. This is not a cross-process ActorRef wire format.
 * The current guest ABI is restricted to signed i64 messages and replies.
 */
export class NativeWasmActorRegistry {
  #pool;
  #refs = new WeakMap();
  #actors = new Map();
  #closed = false;
  #closePromise = null;
  #maxPending;
  #maxActors;
  #starting = 0;
  #rotating = 0;

  constructor({pool, maxPendingPerActor = 16, maxActors = 4096} = {}) {
    if (!pool || typeof pool.spawn !== 'function' || typeof pool.close !== 'function')
      throw TypeError('an exclusive pooled WASM actor runtime is required');
    this.#pool = pool;
    this.#maxPending = bounded(maxPendingPerActor, 1, 1024, 'actor pending limit');
    this.#maxActors = bounded(maxActors, 1, 4096, 'registry actor limit');
  }
  get actorCount() { return this.#actors.size; }

  #mint(actor, rights, parent = null) {
    // No own fields: no serializable address, capability token, nonce or owner.
    const ref = Object.freeze(Object.create(null));
    this.#refs.set(ref, {actorId: actor.id, generation: actor.generation,
      incarnation: actor.incarnation, rights, parent, revoked: false});
    return ref;
  }
  #resolve(ref, right) {
    if (this.#closed) throw Error('actor registry closed');
    const record = ref !== null && typeof ref === 'object' ? this.#refs.get(ref) : null;
    if (!record) throw Error('unrecognized or forged ActorRef');
    let current = record;
    while (current) {
      if (current.revoked) throw Error('revoked ActorRef');
      current = current.parent;
    }
    if (right && !record.rights[right]) throw Error('ActorRef permission denied');
    const actor = this.#actors.get(record.actorId);
    if (!actor || actor.generation !== record.generation ||
        actor.incarnation !== record.incarnation || actor.state === 'retired')
      throw Error('stale ActorRef generation');
    return {record, actor};
  }
  #newActor(id, generation, handle) {
    const actor = {id, generation, incarnation: randomBytes(16).toString('hex'),
      handle, state: 'active', lastTicket: 0n, pending: 0,
      stopPromise: null, rotating: false};
    this.#actors.set(id, actor);
    return actor;
  }

  async spawn(bytes, {expectedSha256, trusted = false} = {}) {
    if (this.#closed) throw Error('actor registry closed');
    if (this.#actors.size + this.#starting + this.#rotating >= this.#maxActors)
      throw Error('registry actor capacity exceeded');
    this.#starting++; // Reserve admission before the first await.
    try {
      // We intentionally do not accept callers' identity or generation fields.
      const handle = await this.#pool.spawn(bytes, {expectedSha256, trusted});
      if (this.#closed) {
        // Pool close owns physical termination; do not claim reclamation here.
        throw Error('actor registry closed while spawning');
      }
      const id = randomBytes(24).toString('hex');
      return this.#mint(this.#newActor(id, 1, handle),
        Object.freeze({send: true, stop: true}));
    } finally { this.#starting--; }
  }

  attenuate(ref, {send = true, stop = false} = {}) {
    const {record, actor} = this.#resolve(ref);
    if (actor.state !== 'active') throw Error('ActorRef not accepting grants');
    if (typeof send !== 'boolean' || typeof stop !== 'boolean' ||
        (!send && !stop)) throw TypeError('invalid ActorRef rights');
    if ((send && !record.rights.send) || (stop && !record.rights.stop))
      throw Error('ActorRef escalation forbidden');
    return this.#mint(actor, Object.freeze({send, stop}), record);
  }

  revoke(ref) {
    // Only a real, host-minted capability may revoke itself and its descendants.
    const record = ref !== null && typeof ref === 'object' ? this.#refs.get(ref) : null;
    if (!record) throw Error('unrecognized or forged ActorRef');
    record.revoked = true;
  }

  async send(ref, ticket, value) {
    const {actor} = this.#resolve(ref, 'send');
    if (actor.state !== 'active') throw Error('ActorRef not accepting messages');
    if (typeof ticket !== 'bigint' || ticket <= 0n || ticket > MAX)
      throw TypeError('invalid native DATA ticket');
    if (typeof value !== 'bigint' || value < MIN || value > MAX)
      throw TypeError('actor DATA must be signed i64');
    if (ticket <= actor.lastTicket) throw Error('replayed or out-of-order DATA ticket');
    if (actor.pending >= this.#maxPending) throw Error('ActorRef DATA admission full');
    // Atomically reserve before first await. Rejected/uncertain pool sends
    // consume ticket identity: retries cannot duplicate an admitted turn.
    actor.lastTicket = ticket;
    actor.pending++;
    try {
      const result = await actor.handle.send(value);
      if (typeof result !== 'bigint' || result < MIN || result > MAX)
        throw Error('invalid pooled actor i64 receipt');
      return result;
    } finally {
      actor.pending--;
    }
  }

  stop(ref) {
    const {actor} = this.#resolve(ref, 'stop');
    if (actor.stopPromise) return actor.stopPromise;
    if (actor.state !== 'active') return Promise.reject(Error('actor not active'));
    actor.state = 'closing'; // seals DATA and new grants synchronously
    actor.stopPromise = Promise.resolve().then(() => actor.handle.stop()).then(
      () => {
        actor.state = 'retired';
        this.#actors.delete(actor.id);
      }, error => {
        // Stop was not confirmed. Never claim physical reclamation.
        actor.state = 'retirement-unconfirmed';
        throw error;
      });
    actor.stopPromise.catch(() => {});
    return actor.stopPromise;
  }

  async rotate(ref, bytes, {expectedSha256, trusted = false} = {}) {
    const {actor} = this.#resolve(ref, 'stop');
    if (actor.state !== 'active' || actor.rotating)
      throw Error('actor generation rotation already pending');
    actor.rotating = true;
    this.#rotating++; // Preserve capacity while old guest retires.
    try {
      // Never overlap old/new guest authority. Stop ACK precedes new spawn.
      await this.stop(ref);
      if (this.#closed) throw Error('actor registry closed during rotation');
      const handle = await this.#pool.spawn(bytes, {expectedSha256, trusted});
      if (this.#closed) throw Error('actor registry closed during rotation');
      const next = this.#newActor(actor.id, actor.generation + 1, handle);
      return this.#mint(next, Object.freeze({send: true, stop: true}));
    } finally { this.#rotating--; }
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true; // revoke all DATA/CONTROL capability admission first
    for (const actor of this.#actors.values())
      if (actor.state === 'active') actor.state = 'closing';
    this.#closePromise = Promise.resolve().then(() => this.#pool.close()).then(
      () => {
        for (const actor of this.#actors.values()) actor.state = 'retired';
        this.#actors.clear();
      }, error => {
        for (const actor of this.#actors.values())
          actor.state = 'retirement-unconfirmed';
        throw error;
      });
    this.#closePromise.catch(() => {});
    return this.#closePromise;
  }
}
