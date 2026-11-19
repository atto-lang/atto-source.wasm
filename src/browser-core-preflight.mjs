import {snapshotGuestBytes} from "./snapshot-guest-bytes.mjs";
import {inspectWasmBytes} from "../scripts/inspect-core-memory.mjs";
import {assertCoreI64Entry} from "../scripts/core-i64-abi.mjs";

const MAX_BYTES = 16 * 1024 * 1024;
const toHex = bytes => [...new Uint8Array(bytes)]
  .map(value => value.toString(16).padStart(2, "0")).join("");

/**
 * Browser-compatible, zero-import core-Wasm build-time artifact preflight.
 *
 * This is an async module loader/preflight, NOT untrusted guest execution,
 * an OS sandbox, native machine-code AOT, or a strict no-JIT WebAssembly
 * runtime. Run actual guests inside separately supervised module Workers
 * with a host-controlled deadline; never run untrusted main() on the UI thread.
 *
 * An expected digest is required but is only useful when provisioned through
 * an independently trusted channel, not supplied by the same guest as bytes.
 * Neither the module nor its linear memory is shared with an actor by default.
 */
export async function preflightBrowserCoreGuest(input, expectedSha256) {
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256))
    throw new TypeError("browser Wasm requires a pinned 64-digit SHA-256");
  // Snapshot before awaiting Web Crypto: the caller may mutate its own bytes.
  const owned = snapshotGuestBytes(input, MAX_BYTES);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== "function")
    throw new Error("browser Web Crypto SHA-256 is required");
  const digest = toHex(await subtle.digest("SHA-256", owned));
  if (digest !== expectedSha256)
    throw new Error("browser Wasm SHA-256 pin mismatch");

  // These are browser-compatible pure-ES scanners: no node:* module imports.
  // Validate before asking an engine to compile attacker-supplied bytes.
  const inspected = inspectWasmBytes(owned, {
    maxModuleBytes: MAX_BYTES,
    maxMemoryPages: 2
  });
  if (inspected.memoryCount !== 1 || !inspected.hasMemoryMaximum ||
      inspected.memoryMaximum !== 2 || inspected.memoryInitial > 2)
    throw new Error("browser Wasm requires one private wasm32 memory with 2-page cap");
  assertCoreI64Entry(inspected.bytes, "main");

  // Browser and Node WebAssembly engines may perform JIT/tiered compilation.
  // No host imports are supplied. Raw guest execution is intentionally absent.
  const module = await WebAssembly.compile(inspected.bytes);
  if (WebAssembly.Module.imports(module).length !== 0)
    throw new Error("browser Wasm host imports are forbidden");
  const exports = WebAssembly.Module.exports(module);
  if (exports.length !== 2 ||
      !exports.some(item => item.kind === "function" && item.name === "main") ||
      !exports.some(item => item.kind === "memory" && item.name === "memory"))
    throw new Error("browser Wasm must export only main and memory");
  const admission = Object.freeze({
    schemaVersion: 1,
    profile: "core-wasm.i64-v1",
    sha256: digest,
    bytes: owned.byteLength,
    imports: 0,
    hostCapabilities: 0,
    entry: "main",
    memoryInitialPages: inspected.memoryInitial,
    memoryMaximumPages: 2
  });
  return Object.freeze({module, admission});
}
