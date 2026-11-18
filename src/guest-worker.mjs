import {parentPort, workerData} from "node:worker_threads";
import {compileAdmittedCoreGuest} from "./guest-admission.mjs";

// All potentially expensive Wasm validation AND compilation occur here, under
// the parent's deadline. No host imports, WASI or ambient guest capabilities.
try {
  // Fail closed if the runtime accidentally changes Worker construction to
  // inherit host environment variables. Wasm itself has no host imports.
  if (Object.keys(process.env).length !== 0) {
    throw Error("guest worker inherited forbidden host environment");
  }
  // The parent gives this worker private structured-cloned bytes.
  // Admission snapshots once and returns the exact compiled/validated module.
  const {admission, module} = compileAdmittedCoreGuest(workerData.bytes, workerData.options);
  const instance = new WebAssembly.Instance(module, {});
  const entry = instance.exports[admission.entry];
  if (typeof entry !== "function") throw Error("missing entry");
  const result = entry();
  if (typeof result !== "bigint") throw Error("guest entry did not return i64");
  parentPort.postMessage({ok: true, result, admission});
} catch (error) {
  // Only genuine executed guest RuntimeErrors are labelled as traps.
  const trap = error instanceof WebAssembly.RuntimeError;
  const message = String(error?.message || error).slice(0, 450);
  parentPort.postMessage({ok: false, error: (trap ? "wasm runtime trap: " : "") + message});
}
