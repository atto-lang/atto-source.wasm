import {createHash} from "node:crypto";
import {PooledWasmActors} from "./pooled-actor-host.mjs";
import {snapshotGuestBytes} from "./snapshot-guest-bytes.mjs";
import {HostContinuationTicketFenceV0} from "./host-continuation-ticket-fence-v0.mjs";

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
  #lateRaw = null;
  #replacement = null;
  #waiters = new Set();
  #tickets = new HostContinuationTicketFenceV0();
  #lastControl = null;
  #closed = false;
  #closePromise = null;

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
      hostContinuationTicketsPending: this.#tickets.pendingCount,
      guestContinuationResumeImplemented: false,
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

  waitForGeneration(afterGeneration, {signal} = {}) {
    if (!Number.isSafeInteger(afterGeneration) || afterGeneration < 0 ||
        afterGeneration > this.#generation)
      return Promise.reject(new RangeError("invalid awaited actor generation"));
    if (signal !== undefined &&
        !(typeof AbortSignal !== "undefined" && signal instanceof AbortSignal))
      return Promise.reject(new TypeError("host AbortSignal required"));
    if (this.#closed)
      return Promise.reject(Error("supervised actor closed"));
    if (signal?.aborted)
      return Promise.reject(Error("supervisor generation waiter canceled"));
    if (this.#phase === "active" && this.#generation > afterGeneration)
      return Promise.resolve(this.#current);
    if (!["active", "restarting"].includes(this.#phase))
      return Promise.reject(Error("supervisor cannot publish another generation"));
    if (this.#waiters.size >= 64)
      return Promise.reject(Error("supervisor waiter quota exceeded"));
    return new Promise((resolve, reject) => {
      // Remove event listeners on EVERY settlement, including restart,
      // terminal fault, explicit STOP, carrier retirement and close.
      let subscribed = false;
      const cleanup = () => {
        if (subscribed) signal.removeEventListener("abort", onAbort);
        subscribed = false;
      };
      const waiter = {
        afterGeneration,
        resolve: value => {cleanup(); resolve(value);},
        reject: error => {cleanup(); reject(error);}
      };
      const onAbort = () => {
        if (this.#waiters.delete(waiter))
          waiter.reject(Error("supervisor generation waiter canceled"));
      };
      this.#waiters.add(waiter);
      if (signal) {
        subscribed = true;
        signal.addEventListener("abort", onAbort, {once: true});
        // Abort may have occurred between the first check and subscription.
        if (signal.aborted) onAbort();
      }
    });
  }

  #rejectWaiters(reason) {
    for (const waiter of this.#waiters) waiter.reject(reason);
    this.#waiters.clear();
  }

  // Pure host-side accounting API for future compiler-owned continuations.
  // These tickets never carry guest frame storage or authorize guest resume.
  issueHostContinuationTicket() {
    if (this.#closed || this.#phase !== "active")
      throw stale();
    return this.#tickets.mint(this.#generation);
  }

  claimHostContinuationTicket(ticket) {
    if (this.#closed || this.#phase !== "active")
      throw stale();
    return this.#tickets.claimHostOnly(ticket, this.#generation);
  }

  cancelHostContinuationTicket(ticket) {
    if (this.#closed || this.#phase !== "active")
      throw stale();
    return this.#tickets.cancel(ticket, this.#generation);
  }

  resumeGuestContinuation(ticket) {
    // Strict fail-closed admission: even a correctly minted, live host
    // ticket cannot resume a guest until compiler lowering exists.
    return this.#tickets.resumeGuest(ticket, this.#generation);
  }

  #revokeContinuationGeneration(generation) {
    if (this.#tickets.generation === generation && !this.#tickets.retired)
      this.#tickets.retire(generation);
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
        this.#revokeContinuationGeneration(generation);
        try {
          await raw.stop();
          if (!this.#closed && this.#generation === generation) {
            this.#phase = "stopped";
            this.#raw = null;
            this.#current = null;
            this.#rejectWaiters(Error("supervisor explicitly stopped"));
          }
        } catch (error) {
          if (!this.#closed && this.#phase === "stopping")
            this.#phase = "stop-failed";
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
      // Retain this raw handle until STOP is acknowledged. A failed STOP
      // is uncertainty, not evidence of physical actor retirement.
      this.#lateRaw = raw;
      await raw.stop();
      this.#lateRaw = null;
      throw Error("supervised actor closed during restart");
    }
    if (this.#generation + 1 !== candidate)
      throw Error("supervisor generation advanced during INIT");
    this.#tickets.activate(candidate);
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
    if (this.#closed ||
        !["active", "stopping", "stop-failed"].includes(this.#phase) ||
        this.#generation !== generation || !this.#raw)
      return; // duplicate/late CONTROL cannot trigger another restart
    if (control && control.schemaVersion === 1 &&
        control.kind === "ACTOR_CARRIER_TERMINAL_CONTROL") {
      if (control.reason !== "CARRIER_RETIRED" ||
          control.actorRetired !== true ||
          control.carrierRetained !== false ||
          control.physicalExitConfirmed !== true ||
          !Number.isSafeInteger(control.actorId) || control.actorId <= 0) {
        this.#phase = "invalid-control";
        this.#revokeContinuationGeneration(generation);
        // Invalid carrier CONTROL proves no physical retirement; keep the
        // backing actor reference pinned for a later explicit cleanup.
        this.#current = null;
        this.#rejectWaiters(Error("invalid carrier retirement CONTROL"));
        return;
      }
      const receipt = Object.freeze({
        schemaVersion: 1,
        kind: "SUPERVISOR_CARRIER_TERMINAL_CONTROL",
        faultCode: "CARRIER_RETIRED",
        failedGeneration: generation,
        actorId: control.actorId,
        physicalExitConfirmed: true,
        carrierRetained: false,
        restartAuthorized: false,
        nextGeneration: null
      });
      this.#lastControl = receipt;
      this.#revokeContinuationGeneration(generation);
      this.#raw = null;
      this.#current = null;
      this.#phase = "carrier-retired";
      this.#replacement = null;
      this.#rejectWaiters(Error("supervised actor carrier physically retired"));
      if (this.#onControl) {
        queueMicrotask(() => {
          try {
            const observed = this.#onControl(receipt);
            if (observed && typeof observed.then === "function")
              Promise.resolve(observed).catch(() => {});
          } catch {}
        });
      }
      return;
    }
    if (!control || control.schemaVersion !== 1 ||
        control.kind !== "ACTOR_TERMINAL_CONTROL" ||
        ![terminalCode, "WASM_UNREACHABLE_V1"].includes(control.reason) ||
        control.actorRetired !== true ||
        control.frameQuiescent !== true ||
        control.carrierRetained !== true ||
        !Number.isSafeInteger(control.actorId) || control.actorId <= 0 ||
        !Number.isSafeInteger(control.terminalTicket) || control.terminalTicket <= 0) {
      // Invalid CONTROL is not physical retirement proof. Revoke the public
      // handle while retaining the raw actor authority until close()/STOP
      // has genuinely completed (or a carrier retirement is independently
      // confirmed). Never leak an unretired actor by dropping #raw.
      this.#phase = "invalid-control";
      this.#revokeContinuationGeneration(generation);
      this.#current = null;
      this.#rejectWaiters(Error("invalid authoritative terminal CONTROL"));
      return;
    }

    const typed = control.reason === terminalCode;
    // An explicit STOP racing behind a terminal message wins over automatic
    // restart intent. The failed STOP itself still rejects as terminal.
    const manualStop = this.#phase === "stopping" ||
      this.#phase === "stop-failed";
    const mayRestart = !manualStop && typed &&
      this.#restarts < this.#maxRestarts;
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
    this.#revokeContinuationGeneration(generation);
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
      this.#phase = manualStop ? "stopped-after-terminal" :
        typed ? "restart-budget-exhausted" : "unhandled-terminal";
      this.#replacement = null;
      this.#rejectWaiters(Error(manualStop ? "supervisor stopped during terminal fault" :
        typed ? "supervisor restart budget exhausted" :
        "unhandled guest actor terminal fault: WASM_UNREACHABLE_V1"));
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

  close() {
    // Close is a single authoritative retirement barrier. Concurrent callers
    // must observe the exact same outcome, not a premature success simply
    // because another close() already set #closed=true.
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#phase = "closing";
    this.#revokeContinuationGeneration(this.#generation);
    this.#rejectWaiters(Error("supervised actor closed"));
    this.#closePromise = this.#closeOnce();
    this.#closePromise.catch(() => {}); // physical-hold errors remain awaitable
    return this.#closePromise;
  }

  async #closeOnce() {
    const inFlight = this.#replacement;
    const raw = this.#raw;
    this.#current = null;
    this.#raw = null;
    // The replacement's #spawnNext() independently checks #closed after
    // awaiting INIT and revokes any late actor. Do not close the shared pool
    // or affect unrelated actors on the same physical Worker.
    if (inFlight) {
      try {await inFlight;} catch (error) {
        if (this.#lateRaw) {
          this.#phase = "close-failed";
          throw Error("supervised actor late restart STOP unconfirmed", {cause: error});
        }
      }
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
