import {Worker} from 'node:worker_threads';
import {createHash, createPublicKey, randomBytes} from 'node:crypto';
import {snapshotGuestBytes} from './snapshot-guest-bytes.mjs';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';
import {assertScalarActorAbi} from '../scripts/actor-scalar-abi.mjs';
import {assertActorFrameReceipt} from './actor-frame-quiescence.mjs';
import {assertActorTaskReceipt} from './actor-task-quiescence.mjs';
import {verifySignedActorProfileApproval} from './actor-profile-approval.mjs';

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
  #threadPolicy;
  #terminationTimeoutMs;
  #profileVerificationKey;

  constructor({workers = 2, maxActors = 256, mailboxCapacity = 16, timeoutMs = 2000,
    threadPolicy = null, profileVerificationKey = null,
    terminationTimeoutMs = 5000} = {}) {
    // Every admitted actor owns private, import-free, non-shared linear memory.
    // A single OS Worker serializes all turns of actors assigned to it;
    // distinct workers may execute disjoint actor memories in parallel.
    if (threadPolicy !== null && threadPolicy !== 'single-threaded')
      throw new TypeError('unsupported WASM actor pool threading policy');
    this.#threadPolicy = threadPolicy;
    // Configured exclusively by trusted host policy; untrusted guest bytes
    // cannot select or replace the profile trust root.
    this.#profileVerificationKey = profileVerificationKey === null ? null :
      (profileVerificationKey?.type === 'public' ? profileVerificationKey :
        createPublicKey(profileVerificationKey));
    if (this.#profileVerificationKey !== null &&
        this.#profileVerificationKey.asymmetricKeyType !== 'ed25519')
      throw TypeError('actor frame profile trust root must be Ed25519');
    bounded(workers, 1, 4, 'worker count');
    this.#maxActors = bounded(maxActors, 1, 4096, 'actor capacity');
    this.#mailboxCapacity = bounded(mailboxCapacity, 1, 1024, 'mailbox capacity');
    this.#timeoutMs = bounded(timeoutMs, 1, 30000, 'deadline');
    this.#terminationTimeoutMs = bounded(terminationTimeoutMs, 10, 30000,
      'physical exit deadline');
    for (let i = 0; i < workers; i++) {
      const worker = new Worker(new URL('./pooled-actor-worker.mjs', import.meta.url), {
        type: 'module', execArgv: [], env: {},
        resourceLimits: {maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8}
      });
      const carrier = {worker, ready: [], active: null, timer: null, dead: false,
        termination: null, retirePromise: null, exitObserved: null, exited: false,
        terminationFailed: false, reclaimed: false};
      // Neither a forged 'exit' event nor a fulfilled terminate() Promise alone
      // proves physical quiescence. Require native Worker.threadId === -1.
      carrier.exitObserved = new Promise(resolve => worker.on('exit', code => {
        if (worker.threadId !== -1 || carrier.exited) return;
        carrier.exited = true;
        resolve(code);
        if (carrier.terminationFailed)
          this.#finalizeExitedCarrier(carrier, Error('actor carrier late physical exit'));
      }));
      worker.on('message', message => this.#onMessage(carrier, message));
      worker.on('error', error => void this.#retireCarrier(carrier, error));
      worker.on('exit', () => {
        if (!carrier.exited) return;
        if (!this.#closed && !carrier.retirePromise)
          void this.#retireCarrier(carrier, Error('actor carrier exited unexpectedly'));
      });
      this.#carriers.push(carrier);
    }
  }
  get threadPolicy() {return this.#threadPolicy;}
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
          ...(op.kind === 'init' ? {
            bytes: op.bytes, expectedSha256: actor.artifactSha256,
            actorFrameProfile: actor.approvedFrameProfile
          } : {}),
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
        message.incarnation !== active.actor.incarnation ||
        (message.kind === 'ack' &&
          message.actorFrameProfile !== active.actor.approvedFrameProfile))
      return void this.#retireCarrier(carrier, Error('invalid or replayed actor carrier receipt'));
    if (message.kind === 'fatal')
      return void this.#retireCarrier(carrier, Error('WASM actor trap: ' + String(message.reason).slice(0, 200)));
    const {actor, op} = active;
    if ((op.kind === 'send' && (typeof message.result !== 'bigint' ||
          message.result < I64_MIN || message.result > I64_MAX)) ||
        (op.kind !== 'send' && message.result !== null))
      return void this.#retireCarrier(carrier, Error('invalid actor result ABI'));
    // #415 is canonical: no ACK may settle without the trusted frame ledger
    // proving that the specific physical turn unwound and STOP retired storage.
    // #416's old bare-ACK protocol is intentionally incompatible.
    try {
      // Both receipts are necessary; no task-only or frame-only ACK downgrade.
      assertActorFrameReceipt(message.frame, op.kind);
      assertActorTaskReceipt(message.task, op.kind);
    } catch {
      return void this.#retireCarrier(carrier,
        Error('invalid actor frame/task quiescence receipt'));
    }
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
  // Physically confirmed retirement is the ONLY resource reclamation authority.
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

  // Shared-carrier failure domains: retire only actors on that physical Worker.
  // A synchronous terminate() throw, rejected Promise, or timeout is NOT exit.
  #terminateCarrier(carrier) {
    if (carrier.termination) return carrier.termination;
    let deadline;
    const timedOut = new Promise((_, reject) => {
      deadline = setTimeout(() =>
        reject(Error('actor carrier termination unconfirmed: physical exit deadline exceeded')),
        this.#terminationTimeoutMs);
    });
    const completion = Promise.resolve().then(async () => {
      if (carrier.exited) return;
      const receipt = carrier.worker.terminate();
      if (!receipt || typeof receipt.then !== 'function')
        throw Error('actor carrier returned no physical termination receipt');
      await receipt;
      await carrier.exitObserved;
    });
    carrier.termination = Promise.race([completion, timedOut]).catch(error => {
      carrier.terminationFailed = true;
      // Independently observed physical exit can reclaim bytes, while the
      // caller's failed termination receipt must remain failed forever.
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
      () => {this.#finalizeExitedCarrier(carrier, error);},
      () => {
        const reason = Error('actor carrier termination unconfirmed');
        if (!this.#finalizeExitedCarrier(carrier, reason)) {
          // Pending requests fail, but authority and host memory stay pinned
          // while OS-thread termination is unconfirmed.
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
    this.#shutdownPromise = Promise.allSettled(
      this.#carriers.map(c => this.#terminateCarrier(c))
    ).then(results => {
      let uncertain = false;
      for (let i = 0; i < this.#carriers.length; i++) {
        const carrier = this.#carriers[i];
        const failed = results[i].status !== 'fulfilled';
        if (failed) uncertain = true;
        const reason = failed ? Error('actor carrier termination unconfirmed') : error;
        if (!this.#finalizeExitedCarrier(carrier, reason)) {
          for (const actor of this.#actors.values()) {
            if (actor.carrier !== carrier) continue;
            actor.phase = 'retirement-unconfirmed';
            for (const op of actor.pending) op.reject(reason);
            actor.pending.clear();
            actor.queue.length = 0;
          }
        }
      }
      if (uncertain) throw Error('actor carrier termination unconfirmed');
    });
    this.#shutdownPromise.catch(() => {});
    return this.#shutdownPromise;
  }

  async spawn(bytes, {expectedSha256, trusted = false, artifactApproval = null} = {}) {
    if (this.#closed) throw Error('actor pool retired');
    // Do not place untrusted or noncooperating code alongside other actors.
    if (trusted !== true) throw Error('pooled WASM actors require trusted guest admission');
    if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256))
      throw Error('pinned actor artifact SHA-256 required');
    if (this.#actors.size >= this.#maxActors) throw Error('actor capacity exhausted');
    const snapshot = snapshotGuestBytes(bytes, 1048576);
    const digest = createHash('sha256').update(snapshot).digest('hex');
    if (digest !== expectedSha256) throw Error('actor artifact digest mismatch');
    // The secure profiled lane requires a host-configured signer and a
    // signature binding exact Wasm bytes to the compiler/source IR hashes.
    // No profile label or guest-controlled manifest can grant this authority.
    let approvedFrameProfile = null;
    if (this.#profileVerificationKey === null) {
      if (artifactApproval !== null)
        throw Error('profiled actor requires configured host verification key');
    } else {
      if (artifactApproval === null)
        throw Error('signed actor profile approval required; no legacy downgrade');
      const verified = verifySignedActorProfileApproval(artifactApproval, digest,
        this.#profileVerificationKey);
      approvedFrameProfile = verified.profile;
    }
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
    const actor = {id, incarnation, carrier, phase: 'starting',
      artifactSha256: digest, approvedFrameProfile, queue: [],
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
