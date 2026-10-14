import {Worker} from "node:worker_threads";
import {admitCoreGuest} from "./guest-admission.mjs";

/**
 * Disposable worker-per-invocation runner for the pure ()->i64 profile.
 * Not an Oreslang actor scheduler, not a native AOT host and not a security
 * boundary against vulnerabilities in Node/V8 or other same-process attacks.
 * Synchronous admission precedes any WebAssembly execution.
 */
export async function runIsolatedCoreGuest(input, {
  expectedSha256, entry = "main", maxMemoryPages = 2,
  maxModuleBytes = 16 * 1024 * 1024, timeoutMs = 2000
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new TypeError("timeoutMs must be between 1 and 30000");
  }
  // Copy *before* checking and transfer another copy into Worker data.
  // Guest input is never read again after the snapshot is made.
  if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) {
    throw new TypeError("expected core WebAssembly bytes");
  }
  // Reject oversized buffers *before* cloning attacker-controlled bytes.
  // The admission helper performs an independent bound check on the snapshot.
  const length = input.byteLength;
  if (!Number.isSafeInteger(length) || length > maxModuleBytes) {
    throw new Error("Wasm module exceeds maximum byte size");
  }
  const bytes = input instanceof ArrayBuffer ? Uint8Array.from(new Uint8Array(input)) :
    Uint8Array.from(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  const admission = admitCoreGuest(bytes, {expectedSha256, entry, maxMemoryPages, maxModuleBytes});
  const workerData = {bytes, entry: admission.entry};
  return await new Promise((resolve, reject) => {
    let settled = false;
    let worker;
    let timer;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Force execution lifetime to end even after success/error.
      if (worker) void worker.terminate().catch(() => {});
      if (err) reject(err); else resolve({value, admission});
    };
    try {
      worker = new Worker(new URL("./guest-worker.mjs", import.meta.url), {
        type: "module", workerData,
        resourceLimits: {maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8}
      });
      timer = setTimeout(() => finish(Error("guest execution deadline exceeded")), timeoutMs);
      worker.once("message", message => {
        if (!message || message.ok !== true) {
          finish(Error("guest failed: " + String(message?.error || "invalid worker result")));
        } else if (typeof message.result !== "bigint") {
          finish(Error("invalid guest result"));
        } else {
          finish(null, message.result);
        }
      });
      worker.once("error", error => finish(Error("guest worker failure: " + error.message)));
      worker.once("exit", code => finish(Error("guest worker exited before result: " + code)));
    } catch (error) {
      finish(error);
    }
  });
}
