import {snapshotGuestBytes} from "./snapshot-guest-bytes.mjs";

// The current bridge admits ONLY synchronous Wasm modules whose sole import
// is the current actor's private, fixed-size linear memory. It neither grants
// host callbacks nor supports Oreslang await/continuations.
const NativeModule = WebAssembly.Module;
const moduleImports = NativeModule.imports;
const moduleExports = NativeModule.exports;
const MAX_MODULE_BYTES = 1024 * 1024;

function verifyStructure(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 97 ||
      bytes[2] !== 115 || bytes[3] !== 109 || bytes[4] !== 1 ||
      bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) {
    throw new Error("invalid Wasm actor module header");
  }
  let cursor = 8;
  const length = bytes.length;
  function u32(limit) {
    let number = 0;
    for (let i = 0; i < 5; ++i) {
      if (cursor >= limit) throw new Error("truncated Wasm section length");
      const b = bytes[cursor++];
      if (i === 4 && (b & 0xf0)) throw new Error("invalid Wasm section length");
      number += (b & 0x7f) * (2 ** (7 * i));
      if (!(b & 0x80)) return number;
    }
    throw new Error("overlong Wasm section length");
  }
  while (cursor < length) {
    const section = bytes[cursor++];
    const size = u32(length);
    if (size > length - cursor) throw new Error("truncated Wasm section");
    // Keep host actor-memory authority unambiguous: exactly one imported
    // linear memory, no module-defined secondary memories, no start callback.
    if (section === 5 || section === 8) {
      throw new Error("actor guest denies defined memory and start sections");
    }
    // No tables/indirect calls or element/tag sections in this narrow profile.
    if (section === 4 || section === 9 || section === 13) {
      throw new Error("actor guest denies tables, elements and exception tags");
    }
    cursor += size;
  }
}

export function compileActorMemoryGuest(input) {
  // Snapshot once before parsing and compiling. Shared, aliased mutable bytes
  // must never be trusted to remain stable across validation and execution.
  const bytes = snapshotGuestBytes(input, MAX_MODULE_BYTES);
  verifyStructure(bytes);
  const module = new NativeModule(bytes);
  const imports = moduleImports.call(NativeModule, module);
  if (imports.length !== 1 ||
      imports[0].module !== "env" ||
      imports[0].name !== "memory" ||
      imports[0].kind !== "memory") {
    throw new Error("actor guest requires exactly one env.memory import");
  }
  const exports = moduleExports.call(NativeModule, module);
  if (!exports.length)
    throw new Error("actor guest requires a function export");
  for (let i = 0; i < exports.length; ++i) {
    if (exports[i].kind !== "function")
      throw new Error("actor guest may export only functions, never memory");
  }
  // Native Wasm instantiation additionally rejects incompatible memory types
  // (shared, memory64, too many required pages, etc.).
  return module;
}
