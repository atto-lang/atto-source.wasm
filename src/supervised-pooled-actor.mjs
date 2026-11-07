import {createHash} from "node:crypto";
import {PooledWasmActors} from "./pooled-actor-host.mjs";
import {snapshotGuestBytes} from "./snapshot-guest-bytes.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const terminalCode = "STACK_BUDGET_EXHAUSTED_V1";
const stale = () => Error("STALE_ACTOR_GENERATION: handle is no longer current");

/**
 * Host-side bounded supervisor for one trusted compiled Wasm actor.
 *
 * The pool emits ACTOR_TERMINAL_CONTROL only after it independently validates
 * the Worker ticket/incarnation AND the actor's final frame-retirement receipt.
 * This class never sends guest closures through channels or into a Worker.
 *
 * Source actor identity is incarnation-scoped. The supervisor object is the
 * stable authority; current() returns a revocable generation-bound handle.
 * Restart is bounded and never falls back to interpreting an ordinary i64
 * result or an arbitrary Worker/carrier failure as a supervised actor fault.
 */
export class SupervisedPooledActor {
  #pool;
  #bytes;
  #digest;
  #maxRestarts;
  #onControl;
  #generation = 0;
  #restarts = 0;
  #phase = "initializing";
  #current = null;
  #raw = null;
  #replacement = null;
  #waiters = new Set();
  #lastControl = null;
  #closed = false;

  constructor(pool, bytes, {expectedSha256, maxRestarts = 1, onControl} = {}) {
    if (!(pool instanceof PooledWasmActors))
      throw new TypeError("a trusted PooledWasmActors carrier is required");
    if (typeof expectedSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(expectedSha256))
      throw new TypeError("supervisor requires exact Wasm artifact SHA-256");
    if (!Number.isSafeInteger(maxRestarts) ||
        maxRestarts < 0 || maxRestarts > 4)
      throw new RangeError("supervisor restart budget must be 0..4");
    if (onControl !== undefined && typeof onControl !== "function")
      throw new TypeError("supervisor CONTROL observer must be a host callback");
    const owned = snapshotGuestBytes(bytes, 1024 * 1024);
    if (sha256(owned) !== expectedSha256)
      throw Error("supervisor actor artifact digest mismatch");
    this.#pool = pool;
    this.#bytes = owned;
    this.#digest = expectedSha256;
    this.#maxRestarts = maxRestarts;
    this.#onControl = onControl;
  }

  static async start(pool, bytes, options) {
    const controller = new SupervisedPooledActor(pool, bytes, options);
    await controller.#spawnNext();
    return controller;
  }

  get status() {
    return Object.freeze({
      phase: this.#phase,
      generation: this.#generation,
      restarts: this.#restarts,
      maxRestarts: this.#maxRestarts,
      closed: this.#closed,
      lastControl: this.#lastControl
    });
  }

  current() {
    if (this.#closed || this.#phase !== "active" || !this.#current)
      throw Error("supervised actor is not active");
    return this.#current;
  }

  async whenReady() {
    if (this.#closed) throw Error("supervised actor closed");
    if (this.#phase === "active") return this.#current;
    if (!this.#replacement) throw Error("supervised actor has no permitted restart");
    return await this.#replacement;
  }

  waitForGeneration(afterGeneration) {
    if (!Number.isSafeInteger(afterGeneration) || afterGeneration < 0 ||
        afterGeneration > this.#generation)
      return Promise.reject(new RangeError("invalid awaited actor generation"));
    if (this.#closed)
      return Promise.reject(Error("supervised actor closed"));
    if (this.#phase === "active" && this.#generation > afterGeneration)
      return Promise.resolve(this.#current);
    if (!["active", "restarting"].includes(this.#phase))
      return Promise.reject(Error("supervisor cannot publish another generation"));
    if (this.#waiters.size >= 64)
      return Promise.reject(Error("supervisor waiter quota exceeded"));
    return new Promise((resolve, reject) => {
      this.#waiters.add({afterGeneration, resolve, reject});
    });
  }

  #rejectWaiters(reason) {
    for (const waiter of this.#waiters) waiter.reject(reason);
    this.#waiters.clear();
  }

  #authorize(generation, raw) {
    if (this.#closed || this.#phase !== "active" ||
        this.#generation !== generation || this.#raw !== raw)
      throw stale();
  }

  #makeHandle(generation, raw) {
    return Object.freeze({
      generation,
      send: async value => {
        this.#authorize(generation, raw);
        return await raw.send(value);
      },
      stop: async () => {
        this.#authorize(generation, raw);
        // Explicit manual STOP is not a terminal compiler stack failure and
        // must not consume or create a new supervisor restart generation.
        this.#phase = "stopping";
        try {
          await raw.stop();
          if (!this.#closed && this.#generation === generation) {
            this.#phase = "stopped";
            this.#raw = null;
            this.#current = null;
          }
        } catch (error) {
          if (!this.#closed) this.#phase = "stop-failed";
          throw error;
        }
      }
    });
  }

  async #spawnNext() {
    if (this.#closed) throw Error("supervised actor closed");
    const candidate = this.#generation + 1;
    // Never reuse a logical actor generation or the underlying pool's
    // host-minted random incarnation. A previous generation's handle can
    // neither send to nor STOP the replacement actor.
    const raw = await this.#pool.spawn(this.#bytes, {
      trusted: true,
      expectedSha256: this.#digest,
      onTerminalControl: control => this.#terminal(control, candidate)
    });
    if (this.#closed) {
      // Close raced with INIT. Never publish a post-close generation.
      try { await raw.stop(); } catch {}
      throw Error("supervised actor closed during restart");
    }
    if (this.#generation + 1 !== candidate)
      throw Error("supervisor generation advanced during INIT");
    this.#generation = candidate;
    this.#raw = raw;
    this.#current = this.#makeHandle(candidate, raw);
    this.#phase = "active";
    for (const waiter of this.#waiters) {
      if (candidate > waiter.afterGeneration) {
        this.#waiters.delete(waiter);
        waiter.resolve(this.#current);
      }
    }
    return this.#current;
  }

  #terminal(control, generation) {
    if (this.#closed || this.#phase !== "active" ||
        this.#generation !== generation || !this.#raw)
      return; // duplicate or late event cannot trigger a second restart
    if (!control || control.schemaVersion !== 1 ||
        control.kind !== "ACTOR_TERMINAL_CONTROL" ||
        ![terminalCode, "WASM_UNREACHABLE_V1"].includes(control.reason) ||
        control.actorRetired !== true ||
        control.frameQuiescent !== true ||
        control.carrierRetained !== true ||
        !Number.isSafeInteger(control.actorId) || control.actorId <= 0 ||
        !Number.isSafeInteger(control.terminalTicket) || control.terminalTicket <= 0) {
      // An invalid host CONTROL observation never authorizes restart.
      this.#phase = "invalid-control";
      this.#current = null;
      this.#raw = null;
      this.#rejectWaiters(Error("invalid authoritative terminal CONTROL"));
      return;
    }

    const typed = control.reason === terminalCode;
    const mayRestart = typed && this.#restarts < this.#maxRestarts;
    const receipt = Object.freeze({
      schemaVersion: 1,
      kind: "SUPERVISOR_TERMINAL_CONTROL",
      faultCode: control.reason,
      failedGeneration: generation,
      actorId: control.actorId,
      terminalTicket: control.terminalTicket,
      quiescent: true,
      carrierRetained: true,
      restartAuthorized: mayRestart,
      nextGeneration: mayRestart ? generation + 1 : null
    });
    this.#lastControl = receipt;
    // Revoke the old generation BEFORE scheduling any restart and before
    // notifying observers. The host pool has already retired the physical
    // old actor and rejected its outstanding DATA/STOP work.
    this.#raw = null;
    this.#current = null;
    if (mayRestart) {
      ++this.#restarts;
      this.#phase = "restarting";
      this.#replacement = this.#spawnNext().catch(error => {
        if (!this.#closed) this.#phase = "restart-failed";
        this.#rejectWaiters(error);
        throw error;
      });
      // There may be no awaiter yet: avoid an unhandled rejection while
      // retaining the exact failure for an explicit whenReady() caller.
      this.#replacement.catch(() => {});
    } else {
      this.#phase = typed ? "restart-budget-exhausted" : "unhandled-terminal";
      this.#replacement = null;
      this.#rejectWaiters(Error(typed
        ? "supervisor restart budget exhausted"
        : "unhandled guest actor terminal fault: WASM_UNREACHABLE_V1"));
    }
    if (this.#onControl) {
      queueMicrotask(() => {
        try {
          const observed = this.#onControl(receipt);
          if (observed && typeof observed.then === "function")
            Promise.resolve(observed).catch(() => {});
        } catch {}
      });
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#phase = "closing";
    this.#rejectWaiters(Error("supervised actor closed"));
    const inFlight = this.#replacement;
    const raw = this.#raw;
    this.#current = null;
    this.#raw = null;
    // The replacement's #spawnNext() independently checks #closed after
    // awaiting INIT and revokes any late actor. Do not close the shared pool
    // or affect unrelated actors on the same physical Worker.
    if (inFlight) {
      try {await inFlight;} catch {}
    }
    if (raw) {
      try {await raw.stop();} catch (error) {
        this.#phase = "close-failed";
        throw error;
      }
    }
    this.#phase = "closed";
  }
}
