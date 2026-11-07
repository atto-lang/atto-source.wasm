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
  #terminationTimeoutMs;

  constructor({workers = 2, maxActors = 256, mailboxCapacity = 16,
    timeoutMs = 2000, terminationTimeoutMs = 5000} = {}) {
    bounded(workers, 1, 4, 'worker count');
    this.#maxActors = bounded(maxActors, 1, 4096, 'actor capacity');
    this.#mailboxCapacity = bounded(mailboxCapacity, 1, 1024, 'mailbox capacity');
    this.#timeoutMs = bounded(timeoutMs, 1, 30000, 'deadline');
    this.#terminationTimeoutMs = bounded(terminationTimeoutMs, 10, 30000, 'physical exit deadline');
    for (let i = 0; i < workers; i++) {
      const worker = new Worker(new URL('./pooled-actor-worker.mjs', import.meta.url), {
        type: 'module', execArgv: [], env: {},
        resourceLimits: {maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8}
      });
      const carrier = {worker, ready: [], active: null, timer: null, dead: false,
        termination: null, retirePromise: null, exitObserved: null, exited: false,
        terminationFailed: false, reclaimed: false};
      // Physical exit is an independently observed boundary. The Promise
      // returned by terminate() alone is not proof that guest turns stopped.
      // Register before asynchronous startup or shutdown can emit 'exit'.
      carrier.exitObserved = new Promise(resolve => worker.on('exit', code => {
        // EventEmitter permits arbitrary host-side 'exit' emission. Treat
        // the event as physical evidence only after Node has marked its
        // native Worker thread as gone. A forged event cannot release memory.
        if (worker.threadId !== -1) return;
        if (carrier.exited) return; // Idempotent duplicate notification.
        carrier.exited = true;
        resolve(code);
        // If termination already failed or timed out, a later independent
        // physical exit can retire pinned leases. This does not retroactively
        // turn a failed close()/retirement receipt into a success.
        if (carrier.terminationFailed)
          this.#finalizeExitedCarrier(carrier, Error('actor carrier late physical exit'));
      }));
      worker.on('message', message => this.#onMessage(carrier, message));
      worker.on('error', error => void this.#retireCarrier(carrier, error));
      worker.on('exit', () => {
        // EventEmitter allows synthetic exit events; only Node's native
        // threadId==-1 and the validated exit listener prove quiescence.
        if (!carrier.exited) return;
        if (!this.#closed && !carrier.retirePromise)
          void this.#retireCarrier(carrier, Error('actor carrier exited unexpectedly'));
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
    // One synchronous WebAssembly guest turn must fully unwind its separate,
    // actor-owned managed frame domain BEFORE the pooled carrier ACKs it.
    // This receipt is trusted Worker bookkeeping, not proof that guest locals
    // are compiler-lowered into managed frames or an external attestation.
    if (!message.frame || message.frame.schemaVersion !== 1 ||
        message.frame.frameBytes !== 16 ||
        message.frame.activeExecutions !== 0 ||
        message.frame.frameBytesInUse !== 0 ||
        message.frame.retired !== (op.kind === 'stop'))
      return void this.#retireCarrier(carrier,
        Error('invalid managed actor frame quiescence receipt'));
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
  // Single physical-reclamation authority. A timeout, failed terminate()
  // receipt, or forged EventEmitter exit alone can never invoke this path.
  #finalizeExitedCarrier(carrier, reason) {
    if (!carrier.exited || carrier.worker.threadId !== -1 || carrier.reclaimed)
      return false;
    carrier.reclaimed = true;
    carrier.dead = true;
    clearTimeout(carrier.timer);
    carrier.timer = null;
    for (const actor of this.#actors.values()) {
      if (actor.carrier !== carrier) continue;
      actor.phase = 'retired';
      for (const op of actor.pending) op.reject(reason);
      actor.pending.clear();
      actor.queue.length = 0;
      actor.outstanding = 0;
      this.#actors.delete(actor.id);
    }
    carrier.ready.length = 0;
    carrier.active = null;
    return true;
  }

  // Shared-carrier failure domains: a guest trap, deadline, forged receipt or
  // unexpected Worker exit retires ONLY the actors pinned to that carrier.
  // Accepted work is not settled until physical Worker termination confirms.
  #terminateCarrier(carrier) {
    if (carrier.termination) return carrier.termination;
    // Timer completion is a *failure*, never evidence of physical quiescence.
    // Keep leases and Worker references pinned when exit cannot be observed.
    let deadline;
    const timedOut = new Promise((_, reject) => {
      deadline = setTimeout(() =>
        reject(Error('actor carrier termination unconfirmed: physical exit deadline exceeded')),
        this.#terminationTimeoutMs);
    });
    const completion = Promise.resolve().then(async () => {
      // An independently observed exit already proves quiescence; don't call
      // terminate() again on an exited Worker (which can reject or hang).
      if (carrier.exited) return;
      const receipt = carrier.worker.terminate();
      if (!receipt || typeof receipt.then !== 'function')
        throw Error('actor carrier returned no physical termination receipt');
      // Require BOTH the termination receipt and the real Worker exit event.
      await receipt;
      await carrier.exitObserved;
    });
    carrier.termination = Promise.race([completion, timedOut]).catch(error => {
      carrier.terminationFailed = true;
      // A rejected terminate() receipt is still a failure for the caller.
      // If independently observed exit has occurred, the lease is nevertheless
      // safe to reclaim. If exit occurs later, the listener above recovers it.
      this.#finalizeExitedCarrier(carrier, Error('actor carrier termination unconfirmed'));
      throw error;
    }).finally(() => clearTimeout(deadline));
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
      () => { this.#finalizeExitedCarrier(carrier, error); },
      () => {
        const reason = Error('actor carrier termination unconfirmed');
        // A failed receipt does NOT authorize cleanup. But an independently
        // confirmed physical exit can allow the pinned leases to retire.
        if (!this.#finalizeExitedCarrier(carrier, reason)) {
          for (const actor of this.#actors.values()) {
            if (actor.carrier !== carrier) continue;
            actor.phase = 'retirement-unconfirmed';
            for (const op of actor.pending) op.reject(reason);
            actor.pending.clear();
            actor.queue.length = 0;
          }
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
      const reason = Error('actor carrier termination unconfirmed');
      // Release each physically confirmed carrier independently; do not
      // strand a healthy peer due to another carrier's failed receipt.
      for (let index = 0; index < this.#carriers.length; index++) {
        const carrier = this.#carriers[index];
        if (results[index].status === 'fulfilled') {
          this.#finalizeExitedCarrier(carrier, error);
        } else if (!this.#finalizeExitedCarrier(carrier, reason)) {
          for (const actor of this.#actors.values()) {
            if (actor.carrier !== carrier) continue;
            actor.phase = 'retirement-unconfirmed';
            for (const op of actor.pending) op.reject(reason);
            actor.pending.clear();
            actor.queue.length = 0;
          }
        }
      }
      // An independently observed late exit may clean up after this Promise
      // has rejected, but never changes its fail-closed result.
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
