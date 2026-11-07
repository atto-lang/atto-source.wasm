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
  if (admission.profile==="core-wasm.i64-v1" ? typeof result!=="bigint" :
      admission.profile==="core-wasm.f64-v1" ? typeof result!=="number" : true)
    throw Error("guest entry returned an unexpected scalar type");
  parentPort.postMessage({ok: true, result, admission});
} catch (error) {
  parentPort.postMessage({ok: false, error: String(error?.message || error).slice(0, 500)});
}
