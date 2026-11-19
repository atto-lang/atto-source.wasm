import {randomBytes} from 'node:crypto';

// Capture collection authority before less-trusted host/guest code can
// replace mutable prototype methods. These defend an in-realm registry only;
// they are not a substitute for isolating untrusted native or JS code.
const PrimordialWeakMap = WeakMap;
const PrimordialMap = Map;
const PrimordialSet = Set;
const weakGet = Function.prototype.call.bind(WeakMap.prototype.get);
const weakSet = Function.prototype.call.bind(WeakMap.prototype.set);
const mapGet = Function.prototype.call.bind(Map.prototype.get);
const mapSet = Function.prototype.call.bind(Map.prototype.set);
const mapDelete = Function.prototype.call.bind(Map.prototype.delete);
const mapClear = Function.prototype.call.bind(Map.prototype.clear);
const mapValues = Function.prototype.call.bind(Map.prototype.values);
const mapSize = Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(Map.prototype, 'size').get);
const setAdd = Function.prototype.call.bind(Set.prototype.add);
const setDelete = Function.prototype.call.bind(Set.prototype.delete);
const setValues = Function.prototype.call.bind(Set.prototype.values);
// Do not trust later-replaced iterator prototypes during shutdown. A poisoned
// Set/Map iterator could omit in-flight reservations or live actor handles.
const mapIteratorNext = Function.prototype.call.bind(
  Object.getPrototypeOf(new PrimordialMap().values()).next);
const setIteratorNext = Function.prototype.call.bind(
  Object.getPrototypeOf(new PrimordialSet().values()).next);
function snapshotAdmissions(set) {
  const snapshot = [];
  const iterator = setValues(set);
  for (;;) {
    const item = setIteratorNext(iterator);
    if (item.done) return snapshot;
    snapshot.push(item.value);
  }
}
function forEachActor(map, callback) {
  const iterator = mapValues(map);
  for (;;) {
    const item = mapIteratorNext(iterator);
    if (item.done) return;
    callback(item.value);
  }
}


const MIN = -(1n << 63n), MAX = (1n << 63n) - 1n;
// Bound both CPU work for ancestry validation and lifetime grant metadata.
const MAX_GRANT_DEPTH = 64;
const MAX_GRANTS_PER_INCARNATION = 4096;
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
  #refs = new PrimordialWeakMap();
  #actors = new PrimordialMap();
  #closed = false;
  #closePromise = null;
  #maxPending;
  #maxActors;
  #starting = 0;
  #rotating = 0;
  #inflightAdmissions = new PrimordialSet();
  #postCloseRetirementUnconfirmed = false;

  // A close barrier must include every asynchronous spawn/rotation that was
  // admitted before #closed flipped. Settling pool.close() alone is not proof
  // that an overlapping pool.spawn() cannot return a fresh live handle.
  #reserveAdmission() {
    let settle;
    const settled = new Promise(resolve => { settle = resolve; });
    setAdd(this.#inflightAdmissions, settled);
    return () => {
      setDelete(this.#inflightAdmissions, settled);
      settle();
    };
  }

  constructor({pool, maxPendingPerActor = 16, maxActors = 4096} = {}) {
    if (!pool || typeof pool.spawn !== 'function' || typeof pool.close !== 'function')
      throw TypeError('an exclusive pooled WASM actor runtime is required');
    this.#pool = pool;
    this.#maxPending = bounded(maxPendingPerActor, 1, 1024, 'actor pending limit');
    this.#maxActors = bounded(maxActors, 1, 4096, 'registry actor limit');
  }
  get actorCount() { return mapSize(this.#actors); }

  #mint(actor, rights, parent = null) {
    const depth = parent === null ? 0 : parent.depth + 1;
    if (depth > MAX_GRANT_DEPTH)
      throw RangeError('ActorRef attenuation depth exceeded');
    if (actor.grants >= MAX_GRANTS_PER_INCARNATION)
      throw RangeError('ActorRef grant capacity exceeded');
    // No own fields: no serializable address, capability token, nonce or owner.
    const ref = Object.freeze(Object.create(null));
    weakSet(this.#refs, ref, {actorId: actor.id, generation: actor.generation,
      incarnation: actor.incarnation, rights, parent, revoked: false, depth});
    // Lifetime cap is intentional: GC and ancestor revocation cannot be
    // trusted as a synchronous reclamation or quota-refund signal.
    actor.grants++;
    return ref;
  }
  #resolve(ref, right) {
    if (this.#closed) throw Error('actor registry closed');
    const record = ref !== null && typeof ref === 'object' ? weakGet(this.#refs, ref) : null;
    if (!record) throw Error('unrecognized or forged ActorRef');
    let current = record;
    while (current) {
      if (current.revoked) throw Error('revoked ActorRef');
      current = current.parent;
    }
    if (right && !record.rights[right]) throw Error('ActorRef permission denied');
    const actor = mapGet(this.#actors, record.actorId);
    if (!actor || actor.generation !== record.generation ||
        actor.incarnation !== record.incarnation || actor.state === 'retired')
      throw Error('stale ActorRef generation');
    return {record, actor};
  }
  #newActor(id, generation, handle) {
    const actor = {id, generation, incarnation: randomBytes(16).toString('hex'),
      handle, state: 'active', lastTicket: 0n, pending: 0, grants: 0,
      stopPromise: null, rotating: false};
    mapSet(this.#actors, id, actor);
    return actor;
  }

  async spawn(bytes, {expectedSha256, trusted = false} = {}) {
    if (this.#closed) throw Error('actor registry closed');
    if (mapSize(this.#actors) + this.#starting + this.#rotating >= this.#maxActors)
      throw Error('registry actor capacity exceeded');
    this.#starting++; // Reserve admission before the first await.
    const finishAdmission = this.#reserveAdmission();
    try {
      // We intentionally do not accept callers' identity or generation fields.
      const handle = await this.#pool.spawn(bytes, {expectedSha256, trusted});
      if (this.#closed) {
        // A late pool.spawn may have returned *after* pool.close resolved.
        // Refuse publication and demand independently confirmed teardown.
        try { await handle.stop(); }
        catch (cause) {
          const uncertain = this.#newActor(randomBytes(24).toString('hex'), 1, handle);
          uncertain.state = 'retirement-unconfirmed';
          this.#postCloseRetirementUnconfirmed = true;
          throw Error('late spawned actor retirement unconfirmed', {cause});
        }
        throw Error('actor registry closed while spawning');
      }
      const id = randomBytes(24).toString('hex');
      return this.#mint(this.#newActor(id, 1, handle),
        Object.freeze({send: true, stop: true}));
    } finally {
      this.#starting--;
      finishAdmission();
    }
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
    const record = ref !== null && typeof ref === 'object' ? weakGet(this.#refs, ref) : null;
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
        mapDelete(this.#actors, actor.id);
      }, error => {
        // Stop was not confirmed. Never claim physical reclamation.
        actor.state = 'retirement-unconfirmed';
        throw error;
      });
    actor.stopPromise.catch(() => {});
    return actor.stopPromise;
  }

  async rotate(ref, bytes, {expectedSha256, trusted = false} = {}) {
    const {record, actor} = this.#resolve(ref, 'stop');
    // Rotation mints fresh full rights: delegated stop-only or attenuated
    // references must never escalate to supervisor/root authority.
    if (record.parent !== null || !record.rights.send)
      throw Error('ActorRef rotation requires root supervisor authority');
    if (actor.state !== 'active' || actor.rotating)
      throw Error('actor generation rotation already pending');
    actor.rotating = true;
    this.#rotating++; // Preserve capacity while old guest retires.
    const finishAdmission = this.#reserveAdmission();
    try {
      // Never overlap old/new guest authority. Stop ACK precedes new spawn.
      await this.stop(ref);
      if (this.#closed || record.revoked)
        throw Error('actor registry closed or ActorRef revoked during rotation');
      const handle = await this.#pool.spawn(bytes, {expectedSha256, trusted});
      if (this.#closed || record.revoked) {
        // If authority is revoked while spawning, never publish the successor.
        // Confirm teardown, or retain a quarantined unconfirmed instance.
        try { await handle.stop(); }
        catch (error) {
          const uncertain = this.#newActor(actor.id, actor.generation + 1, handle);
          uncertain.state = 'retirement-unconfirmed';
          if (this.#closed) this.#postCloseRetirementUnconfirmed = true;
          throw Error('revoked successor retirement unconfirmed', {cause: error});
        }
        throw Error('ActorRef revoked or registry closed during rotation');
      }
      const next = this.#newActor(actor.id, actor.generation + 1, handle);
      return this.#mint(next, Object.freeze({send: true, stop: true}));
    } finally {
      this.#rotating--;
      finishAdmission();
    }
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true; // revoke all DATA/CONTROL capability admission first
    forEachActor(this.#actors, actor => {
      if (actor.state === 'active') actor.state = 'closing';
    });
    // Capture admitted work synchronously, before its first await. It is
    // legal for pool.close() to finish before one of those spawns resolves.
    const admissions = snapshotAdmissions(this.#inflightAdmissions);
    this.#closePromise = Promise.allSettled([
      Promise.resolve().then(() => this.#pool.close()),
      ...admissions
    ]).then(results => {
      const poolResult = results[0];
      if (poolResult.status !== 'fulfilled' ||
          this.#postCloseRetirementUnconfirmed) {
        forEachActor(this.#actors, actor => {
          actor.state = 'retirement-unconfirmed';
        });
        if (poolResult.status !== 'fulfilled') throw poolResult.reason;
        throw Error('registry close cannot prove late-spawn retirement');
      }
      forEachActor(this.#actors, actor => { actor.state = 'retired'; });
      mapClear(this.#actors);
    });
    this.#closePromise.catch(() => {});
    return this.#closePromise;
  }
}
