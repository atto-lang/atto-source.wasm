/**
 * Strict, import-free, core-Wasm actor ABI verifier. Use only AFTER
 * inspectWasmBytes and WebAssembly.Module.imports(module).length === 0.
 * JS WebAssembly function .length cannot detect an incorrect result type.
 */
const EXPECTED = Object.freeze({
  oreslang_wasm_actor_init: {params: [], results: []},
  oreslang_wasm_actor_on_message: {params: [0x7e], results: [0x7e]},
  oreslang_wasm_actor_teardown: {params: [], results: []}
});
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const fail = msg => {throw Error('WASM actor ABI: ' + msg);};

export function assertScalarActorAbi(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 ||
      ![0,97,115,109,1,0,0,0].every((n,i) => bytes[i] === n))
    fail('invalid core module');
  let at = 8;
  const readU32 = end => {
    let n = 0;
    for (let i = 0; i < 5; i++) {
      if (at >= end) fail('truncated integer');
      const b = bytes[at++];
      if (i === 4 && (b & 0xf0)) fail('u32 overflow');
      n += (b & 127) * 2 ** (7 * i);
      if (!(b & 128)) return n;
    }
    fail('overlong integer');
  };
  const types = [], functions = [], exports = new Map();
  let seenTypes = false, seenFunctions = false, seenExports = false;
  while (at < bytes.length) {
    const id = bytes[at++], length = readU32(bytes.length), end = at + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) fail('section exceeds binary');
    if (id === 1) {
      if (seenTypes) fail('duplicate type section');
      seenTypes = true;
      const count = readU32(end);
      if (count > 1024) fail('type budget exceeded');
      for (let i = 0; i < count; i++) {
        if (at >= end || bytes[at++] !== 0x60) fail('non-function type');
        const np = readU32(end);
        if (np > end - at) fail('parameter count exceeds section');
        const params = Array.from(bytes.subarray(at, at + np)); at += np;
        const nr = readU32(end);
        if (nr > end - at) fail('result count exceeds section');
        const results = Array.from(bytes.subarray(at, at + nr)); at += nr;
        types.push({params, results});
      }
      if (at !== end) fail('malformed type section');
    } else if (id === 3) {
      if (seenFunctions) fail('duplicate function section');
      seenFunctions = true;
      const count = readU32(end);
      if (count > 1024) fail('function budget exceeded');
      for (let i = 0; i < count; i++) functions.push(readU32(end));
      if (at !== end) fail('malformed function section');
    } else if (id === 7) {
      if (seenExports) fail('duplicate export section');
      seenExports = true;
      const count = readU32(end);
      if (count !== 4) fail('expected three lifecycle functions and memory');
      for (let i = 0; i < count; i++) {
        const size = readU32(end);
        if (size > end - at) fail('truncated export name');
        const name = decoder.decode(bytes.subarray(at, at + size)); at += size;
        if (at >= end) fail('truncated export kind');
        const kind = bytes[at++], index = readU32(end);
        if (exports.has(name)) fail('duplicate export identity');
        exports.set(name, {kind, index});
      }
      if (at !== end) fail('malformed export section');
    }
    at = end;
  }
  if (!seenTypes || !seenFunctions || !seenExports) fail('missing function type/export section');
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const entry = exports.get(name);
    if (!entry || entry.kind !== 0) fail('missing function export: ' + name);
    const typeIndex = functions[entry.index], signature = types[typeIndex];
    if (!signature ||
        signature.params.length !== expected.params.length ||
        signature.results.length !== expected.results.length ||
        !signature.params.every((x,i) => x === expected.params[i]) ||
        !signature.results.every((x,i) => x === expected.results[i]))
      fail('incorrect function signature: ' + name);
  }
  const memory = exports.get('memory');
  if (!memory || memory.kind !== 2 || memory.index !== 0)
    fail('expected private memory export index zero');
  if (exports.size !== 4) fail('unexpected export');
  return true;
}
