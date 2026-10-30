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
