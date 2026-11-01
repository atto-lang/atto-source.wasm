// Core-Wasm has no source actor scheduler or guest I/O capability. The host
// event loop is not an Oreslang worker pool and cannot satisfy a two-thread
// startup promise. Admit only the explicit zero-worker profile before decoding.
export function admitSharedReactorOptions({
  schedulerMode = "host", schedulerWorkers = 0, schedulerWorkersMax = 0
} = {}) {
  if (schedulerMode !== "host" || schedulerWorkers !== 0 || schedulerWorkersMax !== 0) {
    throw new TypeError("shared reactor workers are unsupported in core-wasm.i64-v1");
  }
}

/**
 * Strict, side-effect-free option admission. Unsupported placement, hard
 * affinity, actor or I/O requests must not silently degrade to scalar execution.
 * Validate before decoding untrusted guest bytes or constructing a Worker.
 */
export function rejectUnknownCoreGuestOptions(options, accepted) {
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
      (Object.getPrototypeOf(options) !== Object.prototype &&
       Object.getPrototypeOf(options) !== null)) {
    throw new TypeError("core-wasm options must be a plain object");
  }
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !accepted.has(key)) {
      throw new TypeError("unsupported core-wasm guest option: " + String(key));
    }
    const desc = Object.getOwnPropertyDescriptor(options, key);
    if (!desc || !Object.hasOwn(desc, "value")) {
      throw new TypeError("core-wasm option accessors are unsupported: " + key);
    }
  }
}
