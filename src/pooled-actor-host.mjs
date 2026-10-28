import {Worker} from 'node:worker_threads';
import {createHash, randomBytes} from 'node:crypto';
import {snapshotGuestBytes} from './snapshot-guest-bytes.mjs';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';
import {assertScalarActorAbi} from '../scripts/actor-scalar-abi.mjs';

const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;
const bounded = (n, min, max, name) => {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new RangeError('invalid ' + name);
  return n;
};

/**
 * Experimental, trusted-only WASM actor carrier pool. Actor count is entirely
 * independent of Worker count. This is not a source-level scheduler, untrusted
 * sandbox, or suspend-safe preemptive runtime. Async/host imports fail closed.
 */
export class PooledWasmActors {
  #carriers = [];
  #actors = new Map();
  #nextId = 0;
  #nextTicket = 0;
  #closed = false;
  #shutdownPromise = null;
  #maxActors;
  #mailboxCapacity;
  #timeoutMs;

  constructor({workers = 2, maxActors = 256, mailboxCapacity = 16, timeoutMs = 2000} = {}) {
    bounded(workers, 1, 4, 'worker count');
    this.#maxActors = bounded(maxActors, 1, 4096, 'actor capacity');
    this.#mailboxCapacity = bounded(mailboxCapacity, 1, 1024, 'mailbox capacity');
    this.#timeoutMs = bounded(timeoutMs, 1, 30000, 'deadline');
    for (let i = 0; i < workers; i++) {
      const worker = new Worker(new URL('./pooled-actor-worker.mjs', import.meta.url), {
        type: 'module', execArgv: [], env: {},
        resourceLimits: {maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8}
      });
      const carrier = {worker, ready: [], active: null, timer: null, dead: false,
        termination: null, retirePromise: null, exitObserved: null};
      // Physical exit is an independently observed boundary. The Promise
      // returned by terminate() alone is not proof that guest turns stopped.
      // Register before asynchronous startup or shutdown can emit 'exit'.
      carrier.exitObserved = new Promise(resolve => worker.once('exit', resolve));
      worker.on('message', message => this.#onMessage(carrier, message));
      worker.on('error', error => void this.#retireCarrier(carrier, error));
      worker.on('exit', () => {
        if (!this.#closed) void this.#retireCarrier(carrier, Error('actor carrier exited unexpectedly'));
      });
      this.#carriers.push(carrier);
    }
  }
  get workerCount() {return this.#carriers.length;}
  get actorCount() {return this.#actors.size;}
  get activeWorkerCount() {return this.#carriers.filter(c => !c.dead).length;}

  #enqueue(actor, kind, extra = {}) {
    if (this.#closed || actor.phase === 'retired')
      return Promise.reject(Error('actor pool retired'));
    return new Promise((resolve, reject) => {
      const op = {kind, ticket: ++this.#nextTicket, resolve, reject, ...extra};
      actor.pending.add(op);
      actor.queue.push(op);
      this.#markReady(actor);
      this.#pump(actor.carrier);
    });
  }
  #markReady(actor) {
    if (!actor.queued && actor.queue.length) {
      actor.queued = true;
      actor.carrier.ready.push(actor);
    }
  }
  #pump(carrier) {
    if (this.#closed || carrier.dead || carrier.active) return;
    while (carrier.ready.length) {
      const actor = carrier.ready.shift();
      actor.queued = false;
      if (!actor.queue.length) continue;
      const op = actor.queue.shift();
      // Requeue a busy sender BEHIND other actors: actor-level round robin.
      this.#markReady(actor);
      carrier.active = {actor, op};
      carrier.timer = setTimeout(() => void this.#retireCarrier(carrier, Error('actor execution deadline exceeded')),
        this.#timeoutMs);
      try {
        carrier.worker.postMessage({kind: op.kind, id: actor.id,
          incarnation: actor.incarnation, ticket: op.ticket,
          ...(op.kind === 'init' ? {bytes: op.bytes} : {}),
          ...(op.kind === 'send' ? {value: op.value} : {})});
      } catch (error) {void this.#retireCarrier(carrier, error);}
      return;
    }
  }
  #onMessage(carrier, message) {
    // A quarantined carrier has lost authority to ACK any accepted work.
    // A late receipt cannot race ahead of the physical termination barrier.
    if (this.#closed || carrier.dead) return;
    const active = carrier.active;
    if (!active || !message ||
        !['ack', 'fatal'].includes(message.kind) ||
        message.ticket !== active.op.ticket ||
        message.id !== active.actor.id ||
        message.incarnation !== active.actor.incarnation)
      return void this.#retireCarrier(carrier, Error('invalid or replayed actor carrier receipt'));
    if (message.kind === 'fatal')
      return void this.#retireCarrier(carrier, Error('WASM actor trap: ' + String(message.reason).slice(0, 200)));
    const {actor, op} = active;
    if ((op.kind === 'send' && (typeof message.result !== 'bigint' ||
          message.result < I64_MIN || message.result > I64_MAX)) ||
        (op.kind !== 'send' && message.result !== null))
      return void this.#retireCarrier(carrier, Error('invalid actor result ABI'));
    clearTimeout(carrier.timer);
    carrier.timer = null;
    carrier.active = null;
    actor.pending.delete(op);
    if (op.kind === 'init') actor.phase = 'active';
    if (op.kind === 'send') actor.outstanding--;
    if (op.kind === 'stop') {actor.phase = 'retired'; this.#actors.delete(actor.id);}
    op.resolve(message.result);
    this.#pump(carrier);
  }
  // Shared-carrier failure domains: a guest trap, deadline, forged receipt or
  // unexpected Worker exit retires ONLY the actors pinned to that carrier.
  // Accepted work is not settled until physical Worker termination confirms.
  #terminateCarrier(carrier) {
    if (carrier.termination) return carrier.termination;
    carrier.termination = Promise.resolve().then(() => {
      const receipt = carrier.worker.terminate();
      if (!receipt || typeof receipt.then !== 'function')
        throw Error('actor carrier returned no physical termination receipt');
      // A mocked, accidentally early or otherwise invalid fulfillment must
      // never retire actor leases before the actual Worker exit event.
      return Promise.resolve(receipt).then(() => carrier.exitObserved);
    });
    return carrier.termination;
  }

  #retireCarrier(carrier, error) {
    if (this.#closed) return this.#shutdownPromise;
    if (carrier.retirePromise) return carrier.retirePromise;
    carrier.dead = true;
    clearTimeout(carrier.timer);
    carrier.timer = null;
    for (const actor of this.#actors.values()) {
      if (actor.carrier === carrier) actor.phase = 'quarantining';
    }
    carrier.retirePromise = this.#terminateCarrier(carrier).then(
      () => {
        for (const actor of this.#actors.values()) {
          if (actor.carrier !== carrier) continue;
          actor.phase = 'retired';
          for (const op of actor.pending) op.reject(error);
          actor.pending.clear();
          actor.queue.length = 0;
          this.#actors.delete(actor.id);
        }
        // Memory may be released only after the terminated Worker cannot
        // execute any more guest turns. Drop dead dispatch references here.
        carrier.ready.length = 0;
        carrier.active = null;
      }, () => {
        const reason = Error('actor carrier termination unconfirmed');
        for (const actor of this.#actors.values()) {
          if (actor.carrier !== carrier) continue;
          actor.phase = 'retirement-unconfirmed';
          for (const op of actor.pending) op.reject(reason);
          actor.pending.clear();
          actor.queue.length = 0;
          // Keep actor/instance authority pinned; no safe reclamation proof.
        }
        throw reason;
      }
    );
    carrier.retirePromise.catch(() => {});
    return carrier.retirePromise;
  }

  #shutdown(error = Error('actor pool closed')) {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#closed = true;
    for (const carrier of this.#carriers) {
      clearTimeout(carrier.timer);
      carrier.timer = null;
    }
    // Do not settle accepted work or release actors before physical Worker
    // termination. A rejected terminate() is NOT quiescence evidence.
    this.#shutdownPromise = Promise.allSettled(
      // A terminated Worker may throw synchronously (or return a rejected
      // Promise). Still attempt EVERY carrier and retain unconfirmed leases.
      this.#carriers.map(c => this.#terminateCarrier(c))
    ).then(results => {
      const uncertain = results.some(r => r.status !== 'fulfilled');
      const reason = uncertain ? Error('actor carrier termination unconfirmed') : error;
      for (const actor of this.#actors.values()) {
        actor.phase = uncertain ? 'retirement-unconfirmed' : 'retired';
        for (const op of actor.pending) op.reject(reason);
        actor.pending.clear();
        actor.queue.length = 0;
      }
      // A failed termination is NOT physical quiescence. Keep actor identities
      // and their carrier references pinned; callers must not infer safe reuse
      // or reclamation from a rejected close() or the absence of pending work.
      if (!uncertain) {
        this.#actors.clear();
        for (const carrier of this.#carriers) {
          carrier.ready.length = 0;
          carrier.active = null;
        }
      }
      if (uncertain) throw reason;
    });
    // Event handlers may initiate a terminal shutdown without an awaiting
    // caller; keep an observer for an uncertain termination failure.
    this.#shutdownPromise.catch(() => {});
    return this.#shutdownPromise;
  }

  async spawn(bytes, {expectedSha256, trusted = false} = {}) {
    if (this.#closed) throw Error('actor pool retired');
    // Do not place untrusted or noncooperating code alongside other actors.
    if (trusted !== true) throw Error('pooled WASM actors require trusted guest admission');
    if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256))
      throw Error('pinned actor artifact SHA-256 required');
    if (this.#actors.size >= this.#maxActors) throw Error('actor capacity exhausted');
    const snapshot = snapshotGuestBytes(bytes, 1048576);
    const digest = createHash('sha256').update(snapshot).digest('hex');
    if (digest !== expectedSha256) throw Error('actor artifact digest mismatch');
    // Admission is performed BEFORE occupying a carrier or creating actor
    // authority: malformed artifacts must not terminate healthy peer actors.
    // The Worker rechecks the same independently snapshotted bytes before
    // instantiation; this parent preflight is not a substitute for that gate.
    const admitted = inspectWasmBytes(snapshot, {
      maxModuleBytes: 1048576, maxMemoryPages: 2
    });
    if (admitted.memoryCount !== 1 || !admitted.hasMemoryMaximum ||
        admitted.memoryInitial !== 2 || admitted.memoryMaximum !== 2)
      throw Error('actor requires private fixed two-page memory');
    assertScalarActorAbi(admitted.bytes);
    const id = ++this.#nextId;
    const incarnation = randomBytes(16).toString('hex');
    const live = this.#carriers.filter(c => !c.dead);
    if (!live.length) throw Error('no live actor carriers');
    const carrier = live[(id - 1) % live.length];
    const actor = {id, incarnation, carrier, phase: 'starting', queue: [],
      pending: new Set(), outstanding: 0, queued: false, stopPromise: null};
    this.#actors.set(id, actor);
    await this.#enqueue(actor, 'init', {bytes: snapshot});
    // Opaque, host-minted handle; no actor can access another actor's memory.
    return Object.freeze({
      send: async value => {
        if (actor.phase !== 'active') throw Error('actor not accepting messages');
        if (typeof value !== 'bigint' || value < I64_MIN || value > I64_MAX)
          throw TypeError('message must be signed i64');
        if (actor.outstanding >= this.#mailboxCapacity) throw Error('actor mailbox full');
        actor.outstanding++;
        try {return await this.#enqueue(actor, 'send', {value});}
        catch (error) {throw error;}
      },
      stop: () => {
        if (actor.stopPromise) return actor.stopPromise;
        if (actor.phase !== 'active') return Promise.reject(Error('actor not active'));
        actor.phase = 'stopping';
        actor.stopPromise = this.#enqueue(actor, 'stop');
        return actor.stopPromise;
      }
    });
  }
  close() {return this.#shutdown();}
}
