import {createHash} from "node:crypto";
import {inspectWasmBytes} from "../scripts/inspect-core-memory.mjs";
import {assertCoreI64Entry} from "../scripts/core-i64-abi.mjs";
import {snapshotGuestBytes} from "./snapshot-guest-bytes.mjs";
import {validateCoreOptions} from "./validate-core-options.mjs";
import {assertVisibilityProfileEntry} from "./visibility-profile.mjs";
const ownKeys = Reflect.ownKeys;
const objectKeys = Object.keys;
const arraySome = Function.prototype.call.bind(Array.prototype.some);
const regexTest = Function.prototype.call.bind(RegExp.prototype.test);

/**
 * Zero-capability core-Wasm guest admission (experimental scalar i64 profile).
 * Pure checking: no guest instantiation, no guest code execution.
 * The result never exposes validated executable bytes to avoid a validation/use race.
 */
export function compileAdmittedCoreGuest(input, options = {}) {
  const {
  expectedSha256,
  entry = "main",
  maxModuleBytes = 16 * 1024 * 1024,
  maxMemoryPages = 2,
  ioMode = "nio-only",
  guestNetworkIo = false,
  nioReactors = 0,
  actorPhysicalTurns = 0,
  hardRealtime = false,
  namespaceBindings = null,
  threadPolicy = null,
  // Stage-0 WASM does not implement VM-owned physical TCP pooling.
  sharedTcpPool = false,
  tcpPoolLeaseCount = 0,
  tcpPoolPointerSharing = false,
  ...additionalOptions
  } = validateCoreOptions(options, null);
  // This core-wasm.i64-v1 implementation has no guest network host imports,
  // actor scheduler, or safe native reactor bridge. Fail explicitly before
  // compiling any guest bytes. A max=1 actor lease is NOT a supported actor.
  // Keeping unsupported features at zero is semantic parity, not a fallback
  // to blocking host I/O or a pretend concurrent actor.
  // A scalar guest is instantiated on exactly one Node Worker with an
  // import-free, private, non-shared bounded linear memory. This is a real
  // per-memory-space enforcement path, not an Atto actor scheduler.
  if (threadPolicy !== null && threadPolicy !== "single-threaded")
    throw new TypeError("unsupported guest threading policy");
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
  // silently ignored. No guest sockets, pinned readonly slabs, or immutable shared-slab imports, or
  // transport lease ABI exist in this scalar-only profile.
  if (sharedTcpPool !== false || tcpPoolLeaseCount !== 0 ||
      tcpPoolPointerSharing !== false ||
      arraySome(objectKeys(additionalOptions), key =>
        regexTest(/(?:tcp|socket|connection|shared).*(?:pool|lease|pointer)|(?:pool|lease).*(?:tcp|socket|connection)|(?:shared|frozen|readonly|immutable|borrowed|pinned|zero.?copy).*(?:slab|buffer|memory|pointer|pin)|(?:slab|buffer|memory|pin).*(?:share|pinned|readonly|immutable|lease|pointer|zero.?copy)|zero.?copy|(?:pinned|pin|slab|buffer)bytes/i, key)))
    throw new TypeError("WASM shared TCP pool/lease/pointer capability is unsupported");
  // This profile has no extensible host-capability namespace. Reject ANY
  // unrecognized option, including false-valued typos and Symbol keys, rather
  // than silently implying that a requested capability was provided.
  if (ownKeys(additionalOptions).length !== 0)
    throw new TypeError("WASM rejects unknown core-guest admission options: unsupported zero-capability guest option");
  // The scalar Wasm profile has no manifest-owned multi-file namespace
  // graph, startup barrier or exact-symbol provider routing.
  if (namespaceBindings !== null)
    throw new TypeError("WASM namespace linking requires verified package index and reachable initialization");
  if (entry === "init")
    throw new TypeError("WASM init lifecycle cannot be invoked as a guest entry");
  // Bound requested export names before scanning source/decoding Wasm bytes.
  // This keeps the scalar guest API aligned with the browser host limit.
  if (typeof entry!=="string" || entry.length>128 ||
      !/^[A-Za-z_][A-Za-z_0-9]*$/.test(entry)) throw Error("invalid guest entry");
  if (expectedSha256 !== undefined &&
      (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)))
    throw Error("invalid pinned SHA-256");
  // Verify the pinned immutable byte snapshot BEFORE validating or JIT-compiling
  // untrusted Wasm. Never hash one buffer and execute another.
  if (!Number.isSafeInteger(maxModuleBytes) || maxModuleBytes < 8 ||
      maxModuleBytes > 16 * 1024 * 1024) throw new TypeError("invalid maximum module size");
  const snapshot = snapshotGuestBytes(input, maxModuleBytes);
  const sha256 = createHash("sha256").update(snapshot).digest("hex");
  if (expectedSha256 !== undefined) {
    if (sha256 !== expectedSha256) throw Error("guest artifact SHA-256 mismatch");
  }
  const inspected = inspectWasmBytes(snapshot, {maxModuleBytes, maxMemoryPages});
  const {bytes, memoryCount, memoryInitial, memoryMaximum, hasMemoryMaximum} = inspected;
  if (memoryCount !== 1 || !hasMemoryMaximum) {
    throw Error("guest requires exactly one privately defined, bounded linear memory");
  }
  const module = new WebAssembly.Module(bytes);
  assertVisibilityProfileEntry(module, entry);
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
    imports: 0, hostCapabilities: 0,
    ...(threadPolicy === "single-threaded" ? {threadPolicy} : {})
  });
  return {module, admission};
}
// Preserve the existing metadata-only API: callers do not receive executable code.
export function admitCoreGuest(input, options = {}) {
  return compileAdmittedCoreGuest(input, options).admission;
}
