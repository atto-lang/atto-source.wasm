/** ABI v2 bridge for oreslang-source.rs/browser. Wasm + typed-IR ESM targets. */
export const COMPILER_ABI = 2;
const MAX_GUEST_BYTES = 1 << 20;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function errorString(memory, address) {
  const bytes = new Uint8Array(memory.buffer);
  let end = address;
  while (end < bytes.length && end < address + 512 && bytes[end]) end++;
  return decoder.decode(bytes.subarray(address, end));
}

/** Refuse compiler bytes that differ from the vendored, receipted artifact. */
export async function verifyCompilerBytes(bytes, expectedSha256, expectedLength) {
  if (bytes.byteLength !== expectedLength) throw new Error('Compiler integrity check failed (size)');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
  if (hex !== expectedSha256) throw new Error('Compiler integrity check failed (sha256)');
}

export async function createCompiler(compilerBytes) {
  if (!WebAssembly.validate(compilerBytes)) throw new Error('Compiler is not valid WebAssembly');
  const { instance } = await WebAssembly.instantiate(compilerBytes, {});
  const api = instance.exports;
  if (!api.memory || typeof api.compile !== 'function' || typeof api.abi_version !== 'function' || api.abi_version() !== COMPILER_ABI) {
    throw new Error('Compiler ABI mismatch');
  }
  const capacity = api.input_capacity();
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 65536) throw new Error('Invalid compiler source capacity');
  // A trap inside the compiler leaves its internal state undefined, so an
  // instance that trapped once is never used again.
  let poisoned = null;
  return {
    compile(source, target = 'wasm', verification = 'ordinary') {
      if (!['ordinary','strict','counted-ready-v1','explicit-rebinding'].includes(verification)) throw new TypeError('unsupported verification profile');
      if (verification === 'explicit-rebinding' && (target !== 'wasm' || typeof api.compile_explicit_rebinding !== 'function'))
        throw new Error('E_EXPLICIT_REBIND_UNSUPPORTED: compiler lacks explicit binding Wasm ABI');
      if (verification === 'strict' && (target !== 'wasm' || typeof api.compile_strict_i64 !== 'function'))
        throw new Error('E_VERIFY_UNSUPPORTED: compiler lacks strict i64 Wasm ABI');
      if (verification === 'counted-ready-v1' && (target !== 'wasm' || typeof api.compile_counted_ready_v1 !== 'function'))
        throw new Error('E_COUNTED_READY_UNSUPPORTED: compiler lacks explicit counted-ready Wasm ABI');
      if (!['wasm', 'javascript'].includes(target)) throw new TypeError('unsupported compiler target');
      if (target === 'javascript' && typeof api.compile_js !== 'function') throw new Error('Compiler has no JavaScript emitter');
      if (poisoned) throw new Error(`Compiler instance unusable after an internal fault (${poisoned})`);
      if (typeof source !== 'string') throw new TypeError('source must be a string');
      const bytes = encoder.encode(source);
      if (bytes.length > capacity) {
        return { ok: false, diagnostics: [{ line: 1, column: 1, message: `E_SOURCE_LIMIT: source exceeds ${capacity} UTF-8 bytes` }] };
      }
      const pointer = api.input_ptr();
      if (pointer < 0 || pointer + bytes.length >= api.memory.buffer.byteLength) throw new Error('Compiler input memory bounds violated');
      new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
      let status;
      try { status = (verification === 'explicit-rebinding' ? api.compile_explicit_rebinding : verification === 'strict' ? api.compile_strict_i64 : verification === 'counted-ready-v1' ? api.compile_counted_ready_v1 : target === 'javascript' ? api.compile_js : api.compile)(bytes.length); }
      catch (error) { poisoned = error.message; throw new Error(`Compiler internal fault: ${error.message}`); }
      if (status !== 0) {
        const diagnostic = {
          line: api.error_line_number(),
          column: api.error_column_number(),
          message: errorString(api.memory, api.error_ptr()) || 'E_COMPILER: unspecified compilation error'
        };
        if (api.result_length() !== 0) throw new Error('Compiler published artifact on error');
        return { ok: false, diagnostics: [diagnostic] };
      }
      const length = api.result_length();
      const outPtr = api.result_ptr();
      if (length < 8 || length > MAX_GUEST_BYTES || outPtr < 0 || outPtr + length > api.memory.buffer.byteLength) {
        throw new Error('Compiler output memory bounds violated');
      }
      const wasm = new Uint8Array(api.memory.buffer, outPtr, length).slice();
      if (target === 'javascript') return { ok: true, esm: decoder.decode(wasm), diagnostics: [] };
      if (!WebAssembly.validate(wasm)) throw new Error('Compiler emitted invalid WebAssembly');
      return { ok: true, wasm, diagnostics: [] };
    }
  };
}