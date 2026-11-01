import {Worker} from "node:worker_threads";
import {admitSharedReactorOptions, rejectUnknownCoreGuestOptions} from "./shared-reactor-policy.mjs";
import {createHash} from "node:crypto";
import {snapshotGuestBytes} from "./snapshot-guest-bytes.mjs";

// Module-local admission quota. A service with multiple Node processes must
// also enforce an aggregate per-tenant/process-level limit at its broker.
const MAX_ACTIVE_GUEST_WORKERS = 4;
let activeGuestWorkers = 0;

/**
 * Run a zero-import ()->i64 guest in a disposable worker.
 * Full Wasm parsing, validation and compilation occur INSIDE the worker, so
 * malicious compilation cannot block the calling thread before the deadline.
 * Resolves only after the guest worker has terminated.
 * Node workers are not an OS security boundary and not a strict AOT runtime.
 */
const ACCEPTED_ISOLATED_OPTIONS = new Set([
  "expectedSha256", "entry", "maxMemoryPages", "maxModuleBytes",
  "timeoutMs", "schedulerMode", "schedulerWorkers", "schedulerWorkersMax"
]);

export async function runIsolatedCoreGuest(input, options = {}) {
  rejectUnknownCoreGuestOptions(options, ACCEPTED_ISOLATED_OPTIONS);
  const {
  expectedSha256, entry = "main", maxMemoryPages = 2,
  maxModuleBytes = 16 * 1024 * 1024, timeoutMs = 2000,
  schedulerMode = "host", schedulerWorkers = 0, schedulerWorkersMax = 0
} = options;
  admitSharedReactorOptions({schedulerMode, schedulerWorkers, schedulerWorkersMax});
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new TypeError("timeoutMs must be between 1 and 30000");
  }
  if (!Number.isSafeInteger(maxModuleBytes) || maxModuleBytes < 8 || maxModuleBytes > 16 * 1024 * 1024) {
    throw new TypeError("invalid maximum module size");
  }
  if (!Number.isSafeInteger(maxMemoryPages) || maxMemoryPages < 1 || maxMemoryPages > 256) {
    throw new TypeError("invalid maximum memory pages");
  }
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(entry)) {
    throw new TypeError("invalid guest entry");
  }
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new TypeError("invalid pinned SHA-256");
  }
  // Reject shared backing stores and oversize before any worker allocation.
  // The helper makes a private immutable-by-convention input snapshot.
  if (activeGuestWorkers >= MAX_ACTIVE_GUEST_WORKERS) {
    throw new Error("guest worker concurrency quota exceeded");
  }
  const bytes = snapshotGuestBytes(input, maxModuleBytes);
  // Bind worker-reported provenance to the exact bytes the parent submitted,
  // even when this API is invoked without an external expectedSha256 pin.
  const submittedSha256 = createHash("sha256").update(bytes).digest("hex");
  activeGuestWorkers++;
  try {
    return await new Promise((resolve, reject) => {
      let worker;
      let timer;
      let decided = false;
      const finish = (error, payload) => {
        if (decided) return;
        decided = true;
        clearTimeout(timer);
        // Do not release the concurrency quota or report success while guest
        // code could still be executing. Termination must finish first.
        if (!worker) {
          reject(error || Error("guest worker was not created"));
          return;
        }
        Promise.resolve().then(() => worker.terminate()).then(
          () => error ? reject(error) : resolve(payload),
          e => reject(new Error("guest worker termination failed: " + String(e?.message || e)))
        );
      };
      try {
        worker = new Worker(new URL("./guest-worker.mjs", import.meta.url), {
          type: "module",
          // Never inherit NODE_OPTIONS/--require/--import or ambient host
          // environment from the trusted parent into the Wasm worker.
          execArgv: [],
          env: {},
          workerData: {bytes, options: {expectedSha256, entry, maxMemoryPages, maxModuleBytes}},
          resourceLimits: {maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8}
        });
        timer = setTimeout(() => finish(new Error("guest execution deadline exceeded")), timeoutMs);
        worker.once("message", message => {
          if (!message || message.ok !== true) {
            finish(new Error("guest rejected or failed: " + String(message?.error || "invalid worker result")));
          } else if (typeof message.result !== "bigint" || !message.admission ||
                     message.admission.schemaVersion !== 1 ||
                     message.admission.profile !== "core-wasm.i64-v1" ||
                     message.admission.entry !== entry ||
                     message.admission.bytes !== bytes.length ||
                     message.admission.imports !== 0 ||
                     message.admission.hostCapabilities !== 0 ||
                     !/^[a-f0-9]{64}$/.test(message.admission.sha256) ||
                     message.admission.sha256 !== submittedSha256 ||
                     (expectedSha256 !== undefined &&
                       message.admission.sha256 !== expectedSha256) ||
                     !Number.isSafeInteger(message.admission.memoryInitialPages) ||
                     !Number.isSafeInteger(message.admission.memoryMaximumPages) ||
                     message.admission.memoryInitialPages < 0 ||
                     message.admission.memoryMaximumPages < message.admission.memoryInitialPages ||
                     message.admission.memoryMaximumPages > maxMemoryPages) {
            finish(new Error("invalid guest worker response"));
          } else {
            finish(null, {value: message.result, admission: message.admission});
          }
        });
        worker.once("error", error => finish(new Error("guest worker failure: " + error.message)));
        worker.once("exit", code => finish(new Error("guest worker exited before result: " + code)));
      } catch (error) {
        finish(error);
      }
    });
  } finally {
    activeGuestWorkers--;
  }
}
