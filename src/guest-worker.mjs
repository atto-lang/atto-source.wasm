import {parentPort, workerData} from "node:worker_threads";

// Trusted worker wrapper. The guest has no JS host imports, no WASI,
// no clock/files/network and no cross-worker shared memory.
// Workers are V8 isolates in ONE PROCESS; this is not an OS sandbox.
try {
  const bytes = Uint8Array.from(workerData.bytes);
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length !== 0) throw Error("host imports denied");
  const instance = new WebAssembly.Instance(module, {});
  const entry = instance.exports[workerData.entry];
  if (typeof entry !== "function") throw Error("missing entry");
  const result = entry();
  if (typeof result !== "bigint") throw Error("guest entry did not return i64");
  parentPort.postMessage({ok: true, result});
} catch (e) {
  parentPort.postMessage({ok: false, error: String(e?.message || e).slice(0, 500)});
}
