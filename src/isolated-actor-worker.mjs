import {parentPort, workerData} from "node:worker_threads";
import {createHash} from "node:crypto";
import {compileActorMemoryGuest} from "./actor-guest-policy.mjs";

// Disposable worker: never imports a parent's ActorArena or WebAssembly.Memory.
// No callback/WASI imports; the only env.memory import is created locally.
// The only outgoing guest data is a numeric scalar, never a raw heap view.
try {
  if (Object.keys(process.env).length !== 0 ||
      process.execArgv.length !== 0) {
    throw new Error("isolated actor inherited forbidden host environment");
  }
  const bytes = workerData.bytes;
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== workerData.expectedSha256)
    throw new Error("isolated actor source identity mismatch");
  const module = compileActorMemoryGuest(bytes);
  const memory = new WebAssembly.Memory({initial: 2, maximum: 2});
  const data = workerData.initialData;
  if (!(data instanceof Uint8Array) || data.byteLength > 65536)
    throw new Error("invalid actor initial heap snapshot");
  new Uint8Array(memory.buffer).set(data, 0);
  const instance = new WebAssembly.Instance(module, {env: {memory}});
  const entry = instance.exports[workerData.exportName];
  if (typeof entry !== "function")
    throw new Error("missing actor guest export");
  const value = entry(...workerData.args);
  if (value !== undefined && typeof value !== "bigint" &&
      (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error("actor guest returned non-scalar value");
  }
  parentPort.postMessage({
    ok: true, value, digest,
    actorId: workerData.actorId, incarnation: workerData.incarnation
  });
} catch (error) {
  parentPort.postMessage({ok: false, error: String(error?.message || error).slice(0, 300)});
}
