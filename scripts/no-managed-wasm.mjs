/**
 * Fail-closed managed-reference/GC admission for the narrow core-wasm.i64-v1
 * profile. Parses actual function types, global declarations, function locals
 * and instruction immediates (not opaque substring scans). Rejects Wasm GC,
 * reference types, SIMD, threads, indirect calls, and unsupported opcodes.
 *
 * This scanner is a language-subset restriction, not a whole-process proof:
 * JavaScript/V8/Node can still GC; guest compiler/linker/import audit and
 * ownership/drop proofs remain separate requirements.
 */
export function assertNoManagedWasm(bytes) {
  // This scanner is a security boundary: never use mutable Array prototype
  // predicates for magic bytes or type/section allowlists.
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 ||
      bytes[0] !== 0 || bytes[1] !== 97 || bytes[2] !== 115 ||
      bytes[3] !== 109 || bytes[4] !== 1 || bytes[5] !== 0 ||
      bytes[6] !== 0 || bytes[7] !== 0) {
    throw Error("no-managed-Wasm: invalid core module header");
  }
  let at = 8;
  const deny = message => { throw Error("no-managed-Wasm: " + message); };
  const u32 = end => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      if (at >= end) deny("truncated unsigned integer");
      const byte = bytes[at++];
      if (i === 4 && (byte & 0xf0)) deny("u32 overflow");
      value += (byte & 127) * 2 ** (i * 7);
      if (!(byte & 128)) return value;
    }
    deny("overlong unsigned integer");
  };
  const skipSigned = (end, limit = 10) => {
    for (let i = 0; i < limit; i++) {
      if (at >= end) deny("truncated signed integer");
      if (!(bytes[at++] & 128)) return;
    }
    deny("overlong signed integer");
  };
  const numericType = end => {
    if (at >= end) deny("truncated value type");
    const type = bytes[at++];
    if (type !== 0x7f && type !== 0x7e && type !== 0x7d && type !== 0x7c)
      deny("managed reference, vector or GC value type forbidden");
  };
  const skipBytes = (end, count) => {
    if (!Number.isSafeInteger(count) || count < 0 || count > end - at) {
      deny("truncated instruction immediate");
    }
    at += count;
  };
  const scanInstruction = end => {
    if (at >= end) deny("truncated instruction");
    const op = bytes[at++];
    // Tail-call instructions require an independently authorized runtime
    // feature profile and a portable fallback for engines lacking the
    // extension. This scalar host currently provides neither. Reject at the
    // actual instruction boundary (never by matching raw immediate bytes).
    if (op === 0x12 || op === 0x13 || op === 0x15)
      deny("WASM_TAIL_CALL_FEATURE_UNSUPPORTED: return_call/return_call_indirect/return_call_ref not admitted");
    if (op === 0xfb) deny("Wasm-GC opcode forbidden");
    if (op >= 0xd0 && op <= 0xd6) deny("reference instruction forbidden");
    if (op === 0xfd || op === 0xfe) deny("SIMD/atomic extension not admitted");
    if (op === 0x02 || op === 0x03 || op === 0x04) {
      if (at >= end) deny("truncated block type");
      const b = bytes[at];
      if (b === 0x40) { at++; return op; }
      if (b === 0x7f || b === 0x7e || b === 0x7d || b === 0x7c) {
        at++; return op;
      }
      if (b === 0x6f || b === 0x70 || b === 0x63 || b === 0x64) {
        deny("reference block type forbidden");
      }
      skipSigned(end, 5);
      return op;
    }
    if (op === 0x0c || op === 0x0d || op === 0x10 ||
        (op >= 0x20 && op <= 0x24)) {
      u32(end);
      return op;
    }
    if (op === 0x0e) {
      const count = u32(end);
      if (count > end - at) deny("invalid branch table size");
      for (let i = 0; i <= count; i++) u32(end);
      return op;
    }
    if (op === 0x1c) {
      const count = u32(end);
      if (count > end - at) deny("invalid typed select count");
      for (let i = 0; i < count; i++) numericType(end);
      return op;
    }
    if (op >= 0x28 && op <= 0x3e) {
      u32(end); // alignment
      u32(end); // offset
      return op;
    }
    if (op === 0x3f || op === 0x40) {
      if (u32(end) !== 0) deny("unexpected memory index");
      return op;
    }
    if (op === 0x41 || op === 0x42) {
      skipSigned(end, op === 0x41 ? 5 : 10);
      return op;
    }
    if (op === 0x43 || op === 0x44) {
      skipBytes(end, op === 0x43 ? 4 : 8);
      return op;
    }
    if (op === 0xfc) {
      if (u32(end) > 7) deny("non-scalar extended instruction forbidden");
      return op;
    }
    if ((op <= 0x0b) || op === 0x0f ||
        op === 0x1a || op === 0x1b ||
        (op >= 0x45 && op <= 0xc4)) return op;
    deny("unsupported instruction opcode 0x" + op.toString(16));
  };
  let sawType = false, sawCode = false;
  while (at < bytes.length) {
    const id = bytes[at++];
    const size = u32(bytes.length);
    const end = at + size;
    if (!Number.isSafeInteger(end) || end > bytes.length) deny("section exceeds module");
    // A bare call to this exported scanner must be safe even without the
    // separate host import/table/start guard. Never let an unsupported
    // managed-ref-bearing section bypass standalone preflight.
    if (id > 13) deny("unknown extension section not admitted");
    if (id === 2 || id === 4 || id === 8 || id === 9 || id === 13)
      deny("host import, table, start, element or tag section forbidden");
    if (id === 1) {
      if (sawType) deny("duplicate type section");
      sawType = true;
      const count = u32(end);
      if (count > end - at) deny("type count exceeds section");
      for (let i = 0; i < count; i++) {
        if (at >= end || bytes[at++] !== 0x60) {
          deny("GC/subtype/array/struct type forbidden: only scalar functions");
        }
        const params = u32(end);
        if (params > end - at) deny("invalid function parameter count");
        for (let j = 0; j < params; j++) numericType(end);
        const results = u32(end);
        if (results > end - at) deny("invalid function result count");
        for (let j = 0; j < results; j++) numericType(end);
      }
      if (at !== end) deny("malformed scalar type section");
    } else if (id === 6) {
      const count = u32(end);
      if (count > end - at) deny("global count exceeds section");
      for (let i = 0; i < count; i++) {
        numericType(end);
        if (at >= end || bytes[at++] > 1) deny("invalid global mutability");
        // This strict bootstrap supports only scalar const/global.get init.
        if (at >= end) deny("truncated global initializer");
        const op = bytes[at];
        if (op !== 0x41 && op !== 0x42 && op !== 0x43 &&
            op !== 0x44 && op !== 0x23) {
          deny("managed or non-scalar global initializer forbidden");
        }
        scanInstruction(end);
        if (at >= end || bytes[at++] !== 0x0b) {
          deny("global initializer must end immediately");
        }
      }
      if (at !== end) deny("malformed scalar global section");
    } else if (id === 10) {
      if (sawCode) deny("duplicate code section");
      sawCode = true;
      const count = u32(end);
      if (count > end - at) deny("function count exceeds code section");
      for (let i = 0; i < count; i++) {
        const bodySize = u32(end), bodyEnd = at + bodySize;
        if (bodyEnd > end) deny("function body exceeds section");
        const groups = u32(bodyEnd);
        if (groups > bodyEnd - at) deny("invalid local declaration count");
        for (let j = 0; j < groups; j++) {
          u32(bodyEnd);
          numericType(bodyEnd);
        }
        while (at < bodyEnd) scanInstruction(bodyEnd);
        if (!bodySize || bytes[bodyEnd - 1] !== 0x0b) {
          deny("function body missing final end");
        }
      }
      if (at !== end) deny("malformed scalar code section");
    }
    at = end;
  }
}
