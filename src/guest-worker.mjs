import {parentPort, workerData} from "node:worker_threads";
import {admitCoreGuest} from "./guest-admission.mjs";

// All potentially expensive Wasm validation AND compilation occur here, under
// the parent's deadline. No host imports, WASI or ambient guest capabilities.
try {
  const bytes = Uint8Array.from(workerData.bytes);
  const admission = admitCoreGuest(bytes, workerData.options);
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, {});
  const entry = instance.exports[admission.entry];
  if (typeof entry !== "function") throw Error("missing entry");
  const result = entry();
  if (typeof result !== "bigint") throw Error("guest entry did not return i64");
  parentPort.postMessage({ok: true, result, admission});
} catch (error) {
  parentPort.postMessage({ok: false, error: String(error?.message || error).slice(0, 500)});
}
