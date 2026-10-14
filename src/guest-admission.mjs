import {createHash} from "node:crypto";
import {inspectWasmBytes} from "../scripts/inspect-core-memory.mjs";
import {assertCoreI64Entry} from "../scripts/core-i64-abi.mjs";

/**
 * Zero-capability core-Wasm guest admission (experimental scalar i64 profile).
 * Pure checking: no guest instantiation, no guest code execution.
 * The result never exposes validated executable bytes to avoid a validation/use race.
 */
export function compileAdmittedCoreGuest(input, {
  expectedSha256,
  entry = "main",
  maxModuleBytes = 16 * 1024 * 1024,
  maxMemoryPages = 2
} = {}) {
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(entry)) throw Error("invalid guest entry");
  // Verify the pinned immutable byte snapshot BEFORE validating or JIT-compiling
  // untrusted Wasm. Never hash one buffer and execute another.
  if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) {
    throw new TypeError("expected core WebAssembly bytes");
  }
  if (!Number.isSafeInteger(maxModuleBytes) || maxModuleBytes < 8 ||
      maxModuleBytes > 16 * 1024 * 1024) throw new TypeError("invalid maximum module size");
  if (input.byteLength > maxModuleBytes) throw Error("Wasm module exceeds maximum byte size");
  const snapshot = input instanceof ArrayBuffer ? Uint8Array.from(new Uint8Array(input)) :
    Uint8Array.from(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
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
