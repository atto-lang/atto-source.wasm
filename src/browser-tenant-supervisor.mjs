/**
 * Parent-owned, fail-closed browser tenant supervisor (experimental v0).
 *
 * One supervisor owns one Web Worker. Its caller MUST be trusted same-origin
 * application code, and MUST supply a reviewed, pinned build-time manifest.
 * A digest proves identity only: this API cannot attest the compiler or stop
 * hostile JavaScript running in the same origin from constructing its own host.
 *
 * Tokens are opaque WeakMap capabilities, not forgeable {id, generation}
 * objects. On ANY uncertain Worker failure/deadline, the entire tenant is
 * quarantined and terminate() is requested. Browser Worker.terminate() does
 * not provide a physical termination receipt.
 */
const MAX_ACTORS = 16;
const MAX_PENDING = 64;
const MAX_PENDING_BYTES = 2_400_000;
const MAX_ARTIFACT_BYTES = 1_048_576;
const MIN_I64 = -(1n << 63n), MAX_I64 = (1n << 63n) - 1n;

function validId(id) {
  return Number.isSafeInteger(id) && id > 0 && id <= 0x7fffffff;
}
function freshGeneration() {
  const values = new Uint8Array(16);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, x => x.toString(16).padStart(2, '0')).join('');
}
function message(error) {
  return error instanceof Error ? error : new Error(String(error));
}

export class BrowserTenantSupervisor {
  #worker;
  #manifest = new Map();
  #refs = new WeakMap();
  #actors = new Map();
  #pending = new Map();
  #pendingBytes = 0;
  #nextTicket = 0;
  #closed = false;
  #reason = null;
  #deadlineMs;

  constructor({workerUrl, manifest, WorkerClass = globalThis.Worker,
    deadlineMs = 3000} = {}) {
    if (typeof WorkerClass !== 'function' || !workerUrl)
      throw Error('tenant supervisor needs a browser module Worker');
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000)
      throw Error('invalid supervisor request deadline');
    if (!Array.isArray(manifest) || !manifest.length || manifest.length > 64)
      throw Error('trusted application must supply a pinned artifact manifest');
    for (const item of manifest) {
      if (typeof item?.name !== 'string' ||
          !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(item.name) ||
          !/^[0-9a-f]{64}$/.test(item.sha256) ||
          !(item.bytes instanceof Uint8Array) ||
          !(item.bytes.buffer instanceof ArrayBuffer) ||
          item.bytes.byteLength < 8 || item.bytes.byteLength > MAX_ARTIFACT_BYTES ||
          this.#manifest.has(item.name))
        throw Error('invalid or duplicate trusted manifest entry');
      // Snapshot before any async operation; never use caller-controlled bytes
      // for a subsequent spawn after manifest admission.
      this.#manifest.set(item.name, {
        sha256: item.sha256, bytes: Uint8Array.from(item.bytes)
      });
    }
    this.#deadlineMs = deadlineMs;
    this.#worker = new WorkerClass(workerUrl, {type: 'module'});
    this.#worker.onmessage = event => this.#receive(event?.data);
    this.#worker.onerror = () => this.#quarantine(Error('tenant Worker error'));
    this.#worker.onmessageerror = () => this.#quarantine(Error('tenant Worker message decoding failed'));
  }

  get closed() { return this.#closed; }
  get activeActors() {
    return Array.from(this.#actors.values()).filter(x => x.state === 'active').length;
  }

  #quarantine(why) {
    if (this.#closed) return;
    this.#closed = true;
    this.#reason = message(why);
    this.#actors.clear();
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(this.#reason);
    }
    this.#pending.clear();
    this.#pendingBytes = 0;
    try { this.#worker.terminate(); } catch { /* fail closed regardless */ }
  }

  close() {
    this.#quarantine(Error('tenant supervisor closed; Worker termination requested'));
  }

  #issue(kind, actor, extra = {}, cost = 256) {
    if (this.#closed) return Promise.reject(this.#reason);
    if (this.#pending.size >= MAX_PENDING ||
        cost > MAX_PENDING_BYTES - this.#pendingBytes)
      return Promise.reject(Error('tenant parent mailbox budget exceeded'));
    if (this.#nextTicket >= Number.MAX_SAFE_INTEGER) {
      this.#quarantine(Error('tenant ticket space exhausted'));
      return Promise.reject(this.#reason);
    }
    const ticket = ++this.#nextTicket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#quarantine(
        Error('tenant Worker deadline expired; all actor state untrusted')), this.#deadlineMs);
      this.#pending.set(ticket, {
        resolve, reject, timer, cost, kind, actor
      });
      this.#pendingBytes += cost;
      try {
        this.#worker.postMessage({
          ticket, id: actor.id, incarnation: actor.incarnation, kind, ...extra
        });
      } catch (error) {
        this.#quarantine(Error('tenant Worker postMessage failed: ' + String(error)));
      }
    });
  }

  #receive(reply) {
    if (this.#closed) return;
    if (!reply || typeof reply !== 'object' ||
        !Number.isSafeInteger(reply.ticket)) {
      this.#quarantine(Error('malformed tenant Worker response'));
      return;
    }
    const entry = this.#pending.get(reply.ticket);
    if (!entry || reply.id !== entry.actor.id ||
        reply.incarnation !== entry.actor.incarnation ||
        !['ack', 'rejected', 'actor_fault', 'fatal'].includes(reply.kind)) {
      this.#quarantine(Error('forged, replayed or mismatched tenant Worker receipt'));
      return;
    }
    if (reply.kind === 'fatal') {
      this.#quarantine(Error('tenant Worker reported fatal: ' + String(reply.reason).slice(0,160)));
      return;
    }
    if (reply.kind === 'actor_fault' && entry.kind !== 'send') {
      this.#quarantine(Error('invalid actor fault receipt'));
      return;
    }
    if (reply.kind === 'ack' &&
        ((entry.kind === 'send' && typeof reply.result !== 'bigint') ||
         (entry.kind !== 'send' && reply.result !== null))) {
      this.#quarantine(Error('tenant Worker response ABI mismatch'));
      return;
    }
    clearTimeout(entry.timer);
    this.#pending.delete(reply.ticket);
    this.#pendingBytes -= entry.cost;
    if (reply.kind === 'rejected') {
      entry.reject(Error('tenant Worker rejected operation: ' + String(reply.reason).slice(0,160)));
    } else if (reply.kind === 'actor_fault') {
      const current = this.#actors.get(entry.actor.id);
      if (current === entry.actor) {
        this.#actors.delete(entry.actor.id);
        this.#refs.delete(entry.actor.ref);
      }
      entry.reject(Error('actor-local Wasm unreachable; actor incarnation retired'));
    } else {
      entry.resolve(reply.result);
    }
  }

  async spawn(id, artifactName) {
    if (this.#closed) throw this.#reason;
    if (!validId(id) || this.#actors.has(id) || this.#actors.size >= MAX_ACTORS)
      throw Error('invalid, duplicate or over-quota actor ID');
    const artifact = this.#manifest.get(artifactName);
    if (!artifact) throw Error('artifact is not in trusted application manifest');
    const ref = Object.freeze(Object.create(null));
    const actor = {id, incarnation: freshGeneration(), ref, state: 'spawning'};
    this.#actors.set(id, actor); // Reserve before first suspension.
    this.#refs.set(ref, actor);
    try {
      await this.#issue('spawn', actor, {
        bytes: artifact.bytes, approvedSha256: artifact.sha256, trusted: true
      }, artifact.bytes.byteLength + 256);
      if (this.#closed) throw this.#reason;
      actor.state = 'active';
      return ref;
    } catch (error) {
      if (this.#actors.get(id) === actor) this.#actors.delete(id);
      this.#refs.delete(ref);
      throw error;
    }
  }

  #actorFrom(ref) {
    const actor = ref && typeof ref === 'object' ? this.#refs.get(ref) : null;
    if (!actor || actor.state !== 'active' || this.#actors.get(actor.id) !== actor)
      throw Error('unknown, stale or non-active actor capability');
    if (this.#closed) throw this.#reason;
    return actor;
  }

  send(ref, value) {
    const actor = this.#actorFrom(ref);
    if (typeof value !== 'bigint' || value < MIN_I64 || value > MAX_I64)
      throw Error('actor messages must be signed i64, not functions or objects');
    return this.#issue('send', actor, {value});
  }

  async stop(ref) {
    const actor = this.#actorFrom(ref);
    actor.state = 'stopping'; // No new sends may race with teardown.
    try {
      await this.#issue('stop', actor);
      if (this.#actors.get(actor.id) === actor) this.#actors.delete(actor.id);
      this.#refs.delete(ref);
    } catch (error) {
      if (!this.#closed && this.#actors.get(actor.id) === actor)
        actor.state = 'active'; // Worker explicitly rejected before teardown.
      throw error;
    }
  }
}
