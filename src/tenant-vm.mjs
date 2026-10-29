import {runIsolatedCoreGuest} from "./isolated-runner.mjs";

// Host-only tenant admission around the existing disposable-worker runner.
// Node/V8 Worker threads are not OS process security boundaries.
export class OresVM {
  #tenants = new Map();
  #nextGeneration = 1;
  #maxTenants;
  #maxWorkers;
  #activeWorkers = 0;

  constructor({maxTenants = 32, maxWorkers = 4} = {}) {
    if (!Number.isSafeInteger(maxTenants) || maxTenants < 1 || maxTenants > 1024 ||
        !Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 4) {
      throw new RangeError("invalid OresVM host limits");
    }
    this.#maxTenants = maxTenants;
    this.#maxWorkers = maxWorkers;
  }

  #check(handle) {
    if (!handle || typeof handle !== "object") throw new Error("invalid isolate handle");
    const state = this.#tenants.get(handle.tenantId);
    if (!state || state.handle !== handle || state.generation !== handle.generation)
      throw new Error("stale or foreign isolate handle");
    return state;
  }

  createIsolate({tenantId, maxWorkers = 1} = {}) {
    if (typeof tenantId !== "string" || tenantId.length === 0 || tenantId.length > 128 ||
        !/^[A-Za-z0-9_.-]+$/.test(tenantId)) throw new TypeError("invalid tenant id");
    if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > this.#maxWorkers)
      throw new RangeError("invalid tenant worker quota");
    if (this.#tenants.has(tenantId)) throw new Error("duplicate tenant");
    if (this.#tenants.size >= this.#maxTenants) throw new Error("host tenant quota exceeded");
    if (!Number.isSafeInteger(this.#nextGeneration)) throw new Error("generation exhausted");
    const generation = this.#nextGeneration++;
    const handle = Object.freeze({tenantId, generation});
    this.#tenants.set(tenantId, {generation, handle, phase: "created", maxWorkers, active: 0});
    return handle;
  }

  start(handle) {
    const s = this.#check(handle);
    if (s.phase !== "created") throw new Error("invalid start phase");
    s.phase = "running";
  }

  async runGuest(handle, wasmBytes, options = {}) {
    const s = this.#check(handle);
    if (s.phase !== "running") throw new Error("tenant admission closed");
    if (s.active >= s.maxWorkers || this.#activeWorkers >= this.#maxWorkers)
      throw new Error("isolate worker quota exceeded");
    s.active++;
    this.#activeWorkers++;
    try {
      return await runIsolatedCoreGuest(wasmBytes, options);
    } finally {
      // The underlying worker runner resolves/rejects only after termination.
      s.active--;
      this.#activeWorkers--;
    }
  }

  beginShutdown(handle) {
    const s = this.#check(handle);
    if (s.phase !== "running" && s.phase !== "created")
      throw new Error("shutdown already started");
    s.phase = "quiescing";
  }

  completeShutdown(handle) {
    const s = this.#check(handle);
    if (s.phase !== "quiescing" || s.active !== 0)
      throw new Error("isolate worker executions still active");
    s.phase = "stopped";
  }

  destroy(handle) {
    const s = this.#check(handle);
    if (s.phase !== "stopped") throw new Error("isolate must stop before destruction");
    this.#tenants.delete(handle.tenantId);
  }

  snapshot(handle) {
    const s = this.#check(handle);
    return Object.freeze({tenantId: handle.tenantId, generation: s.generation,
      phase: s.phase, activeWorkers: s.active, maxWorkers: s.maxWorkers});
  }
}
