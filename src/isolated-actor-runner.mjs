import {Worker} from "node:worker_threads";
import {createHash} from "node:crypto";
import {snapshotGuestBytes} from "./snapshot-guest-bytes.mjs";

// Each invocation has a disposable worker, its own fixed 2-page Wasm heap,
// and no imported host callbacks. A worker's "exit" event is the physical
// quiescence receipt: neither this Promise nor its quota may settle first.
// No parent ActorArena memory or WebAssembly.Instance crosses this boundary.
const MAX_ACTIVE = 4;
let active = 0;
const validEntry = /^[A-Za-z_][A-Za-z_0-9]*$/;
const maxModuleBytes = 1024 * 1024;

export function isolatedActorWorkerStats() {
  return Object.freeze({active, maximum: MAX_ACTIVE});
}

export async function runIsolatedActorGuest(input, {
  expectedSha256, actorId, incarnation, exportName = "read",
  args = [0], initialData = new Uint8Array(0),
  timeoutMs = 2000, signal
} = {}) {
  if (typeof expectedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(expectedSha256))
    throw new TypeError("pinned actor guest SHA-256 required");
  if (!Number.isSafeInteger(actorId) || actorId <= 0 ||
      !Number.isSafeInteger(incarnation) || incarnation <= 0)
    throw new TypeError("invalid isolated actor incarnation");
  if (typeof exportName !== "string" || !validEntry.test(exportName))
    throw new TypeError("invalid isolated actor export");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new RangeError("invalid isolated actor timeout");
  if (!Array.isArray(args) || args.length > 16)
    throw new TypeError("invalid isolated actor scalar arguments");
  const scalarArgs = [];
  for (let i = 0; i < args.length; ++i) {
    const x = args[i];
    if (typeof x !== "bigint" &&
        (typeof x !== "number" || !Number.isFinite(x)))
      throw new TypeError("invalid isolated actor scalar argument");
    scalarArgs[i] = x;
  }
  if (signal !== undefined && (!signal ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function" ||
      typeof signal.aborted !== "boolean"))
    throw new TypeError("invalid cancellation signal");
  if (signal?.aborted) throw new Error("isolated actor cancelled before admission");
  if (active >= MAX_ACTIVE) throw new RangeError("isolated actor worker quota exceeded");

  const bytes = snapshotGuestBytes(input, maxModuleBytes);
  const data = snapshotGuestBytes(initialData, 65536);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedSha256) throw new Error("isolated actor artifact hash mismatch");
  active++;
  try {
    return await new Promise((resolve, reject) => {
      let worker, timer, decided = false;
      let decisionError = null, decisionValue;
      let exited = false;
      const onAbort = () => decide(new Error("isolated actor cancelled"));
      const decide = (error, value) => {
        if (decided || exited) return;
        decided = true;
        decisionError = error;
        decisionValue = value;
        // Terminate first, but never treat requesting termination as proof
        // that native Wasm has stopped. An actual Worker exit is required.
        try {
          Promise.resolve(worker.terminate()).catch(() => {
            // A failed termination request cannot release the actor's pin:
            // leave this operation pending until an actual "exit" receipt.
          });
        } catch {
          // Same fail-closed rule: wait for worker exit.
        }
      };
      try {
        worker = new Worker(new URL("./isolated-actor-worker.mjs", import.meta.url), {
          type: "module", execArgv: [], env: {},
          workerData: {
            bytes, initialData: data, expectedSha256: digest,
            actorId, incarnation, exportName, args: scalarArgs
          },
          resourceLimits: {maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8}
        });
        worker.once("exit", code => {
          exited = true;
          clearTimeout(timer);
          if (signal) {
            try { signal.removeEventListener("abort", onAbort); } catch {}
          }
          // On unexpected natural exit, or on failed termination with no
          // authenticated message, fail closed. No guest memory survives exit.
          if (!decided)
            reject(new Error("isolated actor exited without result: " + code));
          else if (decisionError)
            reject(decisionError);
          else
            resolve(decisionValue);
        });
        worker.once("message", message => {
          if (!message || message.ok !== true) {
            decide(new Error("isolated actor rejected: " +
              String(message?.error || "invalid worker reply")));
          } else if (message.digest !== digest ||
                     message.actorId !== actorId ||
                     message.incarnation !== incarnation ||
                     (message.value !== undefined &&
                      typeof message.value !== "bigint" &&
                      (typeof message.value !== "number" ||
                       !Number.isFinite(message.value)))) {
            decide(new Error("invalid isolated actor completion receipt"));
          } else {
            decide(null, {value: message.value, actorId, incarnation, terminated: true});
          }
        });
        worker.once("error", error => {
          const failure = new Error("isolated actor worker error: " + error.message);
          // An engine/worker failure after its reply but before physical exit
          // invalidates that reply; do not accidentally report success.
          if (decided && !exited) decisionError = failure;
          else decide(failure);
        });
        timer = setTimeout(() => {
          if (exited) return;
          const deadlineError = new Error("isolated actor execution deadline exceeded");
          // Worker reply is not completion. If shutdown remains pending past
          // the deadline, invalidate even a previously accepted scalar result.
          if (decided) decisionError = deadlineError;
          else decide(deadlineError);
        }, timeoutMs);
        if (signal) {
          signal.addEventListener("abort", onAbort, {once: true});
          if (signal.aborted) onAbort();
        }
      } catch (error) {
        clearTimeout(timer);
        if (signal) {
          try { signal.removeEventListener("abort", onAbort); } catch {}
        }
        if (!worker) reject(error);
        else decide(error);
      }
    });
  } finally {
    // The worker must have exited before the normal execution path settles.
    // A termination failure with no exit intentionally leaves the Promise
    // unresolved, keeping both its quota and any ActorArena pin outstanding.
    active--;
  }
}
