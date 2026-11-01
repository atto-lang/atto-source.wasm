import {createHash} from "node:crypto";
import {inspectWasmBytes} from "../scripts/inspect-core-memory.mjs";
import {assertCoreI64Entry} from "../scripts/core-i64-abi.mjs";
import {snapshotGuestBytes} from "./snapshot-guest-bytes.mjs";

/**
 * Zero-capability core-Wasm guest admission (experimental scalar i64 profile).
 * Pure checking: no guest instantiation, no guest code execution.
 * The result never exposes validated executable bytes to avoid a validation/use race.
 */
export function compileAdmittedCoreGuest(input, {
  expectedSha256,
  entry = "main",
  maxModuleBytes = 16 * 1024 * 1024,
  maxMemoryPages = 2,
  ioMode = "nio-only",
  guestNetworkIo = false,
  nioReactors = 0,
  actorPhysicalTurns = 0,
  hardRealtime = false,
  // Stage-0 WASM does not implement VM-owned physical TCP pooling.
  sharedTcpPool = false,
  tcpPoolLeaseCount = 0,
  tcpPoolPointerSharing = false,
  ...additionalOptions
} = {}) {
  // This core-wasm.i64-v1 implementation has no guest network host imports,
  // actor scheduler, or safe native reactor bridge. Fail explicitly before
  // compiling any guest bytes. A max=1 actor lease is NOT a supported actor.
  // Keeping unsupported features at zero is semantic parity, not a fallback
  // to blocking host I/O or a pretend concurrent actor.
  if (ioMode !== "nio-only")
    throw new TypeError("WASM runtime refuses legacy/blocking host I/O");
  if (guestNetworkIo !== false)
    throw new TypeError("WASM guest NIO is not implemented; host network I/O denied");
  if (nioReactors !== 0)
    throw new TypeError("WASM reactor threads are unsupported in core-wasm.i64-v1");
  if (actorPhysicalTurns !== 0)
    throw new TypeError("WASM physical source actor execution is unsupported");
  if (hardRealtime !== false)
    throw new TypeError("WASM hard-real-time scheduling is unsupported");
  // Do not allow a misspelled/forward-compat TCP capability switch to be
  // silently ignored. No guest sockets, immutable shared-slab imports, or
  // transport lease ABI exist in this scalar-only profile.
  if (sharedTcpPool !== false || tcpPoolLeaseCount !== 0 ||
      tcpPoolPointerSharing !== false ||
      Object.keys(additionalOptions).some(key =>
        /(?:tcp|socket|connection|shared).*(?:pool|lease|pointer)|(?:pool|lease).*(?:tcp|socket|connection)/i.test(key)))
    throw new TypeError("WASM shared TCP pool/lease/pointer capability is unsupported");
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(entry)) throw Error("invalid guest entry");
  // Verify the pinned immutable byte snapshot BEFORE validating or JIT-compiling
  // untrusted Wasm. Never hash one buffer and execute another.
  if (!Number.isSafeInteger(maxModuleBytes) || maxModuleBytes < 8 ||
      maxModuleBytes > 16 * 1024 * 1024) throw new TypeError("invalid maximum module size");
  const snapshot = snapshotGuestBytes(input, maxModuleBytes);
  const sha256 = createHash("sha256").update(snapshot).digest("hex");
  if (expectedSha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw Error("invalid pinned SHA-256");
    if (sha256 !== expectedSha256) throw Error("guest artifact SHA-256 mismatch");
  }
  const inspected = inspectWasmBytes(snapshot, {maxModuleBytes, maxMemoryPages});
  const {bytes, memoryCount, memoryInitial, memoryMaximum, hasMemoryMaximum} = inspected;
  if (memoryCount !== 1 || !hasMemoryMaximum) {
    throw Error("guest requires exactly one privately defined, bounded linear memory");
  }
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) {
    throw Error("host imports denied: " + imports.map(x => x.module + "." + x.name).join(", "));
  }
  // Check function signature; JavaScript can silently coerce omitted params.
  assertCoreI64Entry(bytes, entry);
  const exports = WebAssembly.Module.exports(module);
  if (!exports.some(x => x.name === entry && x.kind === "function")) {
    throw Error("missing guest entry function");
  }
  // Match the native Wasmtime scalar ABI: memory is a required explicit export.
  if (!exports.some(x => x.name === "memory" && x.kind === "memory")) {
    throw Error("guest must export exactly one bounded memory");
  }
  const otherExports = exports.filter(x => x.name !== entry && !(x.name === "memory" && x.kind === "memory"));
  if (otherExports.length) throw Error("unexpected guest exports: " + otherExports.map(x => x.name).join(", "));
  const admission = Object.freeze({
    schemaVersion: 1, profile: "core-wasm.i64-v1",
    sha256, bytes: bytes.byteLength, entry,
    memoryInitialPages: memoryInitial, memoryMaximumPages: memoryMaximum,
    imports: 0, hostCapabilities: 0
  });
  return {module, admission};
}
// Preserve the existing metadata-only API: callers do not receive executable code.
export function admitCoreGuest(input, options = {}) {
  return compileAdmittedCoreGuest(input, options).admission;
}
