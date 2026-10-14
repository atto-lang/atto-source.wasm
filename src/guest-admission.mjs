import {createHash} from "node:crypto";
import {inspectWasmBytes} from "../scripts/inspect-core-memory.mjs";
import {assertCoreI64Entry} from "../scripts/core-i64-abi.mjs";

/**
 * Zero-capability core-Wasm guest admission (experimental scalar i64 profile).
 * Pure checking: no guest instantiation, no guest code execution.
 * The result never exposes validated executable bytes to avoid a validation/use race.
 */
export function admitCoreGuest(input, {
  expectedSha256,
  entry = "main",
  maxModuleBytes = 16 * 1024 * 1024,
  maxMemoryPages = 2
} = {}) {
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(entry)) throw Error("invalid guest entry");
  const inspected = inspectWasmBytes(input, {maxModuleBytes, maxMemoryPages});
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
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw Error("invalid pinned SHA-256");
    if (sha256 !== expectedSha256) throw Error("guest artifact SHA-256 mismatch");
  }
  return Object.freeze({
    schemaVersion: 1, profile: "core-wasm.i64-v1",
    sha256, bytes: bytes.byteLength, entry,
    memoryInitialPages: memoryInitial, memoryMaximumPages: memoryMaximum,
    imports: 0, hostCapabilities: 0
  });
}
