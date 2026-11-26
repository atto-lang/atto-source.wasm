#!/usr/bin/env node
// Artifact-driven proof for the exact /play/ trap sample. This is not a compiler
// and never downloads, publishes, or substitutes compiler Wasm bytes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const [compilerPath, samplePath, compilerSha, sampleBlob] = process.argv.slice(2);
if (process.argv.length !== 6 || !/^[a-f0-9]{64}$/.test(compilerSha ?? '') ||
    !/^[a-f0-9]{40}$/.test(sampleBlob ?? '')) {
  throw new Error('Usage: node scripts/verify-trap-wasm.mjs <compiler.wasm> <trap.atto> <compiler_sha256> <sample_git_blob_sha1>');
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
const compilerBytes = readFileSync(compilerPath);
const sampleBytes = readFileSync(samplePath);
assert.equal(sha256(compilerBytes), compilerSha, 'unreviewed compiler digest');
assert.equal(gitBlob(sampleBytes), sampleBlob, 'sample does not match reviewed playground blob');
assert.ok(WebAssembly.validate(compilerBytes), 'invalid compiler wasm');
const compilerModule = new WebAssembly.Module(compilerBytes);
assert.deepEqual(WebAssembly.Module.imports(compilerModule), [], 'compiler must have zero host imports');
const api = new WebAssembly.Instance(compilerModule, {}).exports;
assert.equal(api.abi_version(), 2, 'unknown compiler ABI');
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});

function compile(source) {
  const data = encoder.encode(source);
  assert.ok(data.length <= api.input_capacity(), 'source limit');
  const mem = new Uint8Array(api.memory.buffer);
  const ptr = api.input_ptr();
  assert.ok(ptr >= 0 && ptr + data.length <= mem.length, 'invalid input bounds');
  mem.set(data, ptr);
  if (api.compile(data.length) !== 0) {
    assert.equal(api.result_length(), 0, 'compiler emitted output after failure');
    const errorMemory = new Uint8Array(api.memory.buffer);
    const offset = api.error_ptr();
    assert.ok(offset >= 0 && offset < errorMemory.length, 'invalid diagnostic offset');
    let end = offset;
    while (end < errorMemory.length && errorMemory[end]) end++;
    assert.ok(end < errorMemory.length, 'unterminated diagnostic');
    return {ok: false, diagnostic: decoder.decode(errorMemory.subarray(offset, end))};
  }
  const outputMemory = new Uint8Array(api.memory.buffer);
  const offset = api.result_ptr(), length = api.result_length();
  assert.ok(length > 0 && length <= 1 << 20 && offset >= 0 && offset + length <= outputMemory.length,
    'invalid compiled guest bounds');
  const guest = outputMemory.slice(offset, offset + length);
  assert.ok(WebAssembly.validate(guest), 'invalid emitted guest wasm');
  return {ok: true, wasm: guest};
}

function run(guest) {
  const module = new WebAssembly.Module(guest);
  const allowedImports = new Set(['print_i64', 'print_bool', 'print_str', 'print_newline', 'print_f64']);
  for (const item of WebAssembly.Module.imports(module)) {
    assert.equal(item.module, 'atto', 'guest requests foreign module');
    assert.ok(item.kind === 'function' && allowedImports.has(item.name), 'guest requests unknown import');
  }
  const exports = WebAssembly.Module.exports(module);
  assert.ok(exports.some(x => x.name === 'main' && x.kind === 'function'));
  assert.ok(exports.some(x => x.name === 'panic_code' && x.kind === 'global'));
  assert.ok(exports.every(x => ['main', 'panic_code', 'memory'].includes(x.name)), 'unexpected guest export');
  let stdout = '';
  let instance;
  const atto = {
    print_i64: v => { stdout += String(v); },
    print_bool: v => { stdout += v ? 'true' : 'false'; },
    print_f64: v => { stdout += String(v); },
    print_str: (ptr, len) => {
      const memory = instance.exports.memory?.buffer;
      assert.ok(memory && ptr >= 0 && len >= 0 && ptr + len <= memory.byteLength, 'invalid guest string');
      stdout += decoder.decode(new Uint8Array(memory, ptr, len));
    },
    print_newline: () => { stdout += '\n'; }
  };
  instance = new WebAssembly.Instance(module, {atto});
  try { return {ok: true, value: instance.exports.main(), stdout}; }
  catch (error) { return {ok: false, error: String(error), panic: instance.exports.panic_code.value, stdout}; }
}

const compiled = compile(decoder.decode(sampleBytes));
assert.ok(compiled.ok, 'exact sample rejected: ' + compiled.diagnostic);
const execution = run(compiled.wasm);
assert.ok(execution.ok, 'exact guest failed: ' + execution.error);
assert.equal(execution.value, 7n);
assert.equal(execution.stdout, '5\nid must be nonnegative\nan ordinary throw was caught\n');

const overflow = compile('pub fnc main(): int { val n: int = 9223372036854775807; match trap (n + 1) over on Some(x) -> { return x; } on None -> { return 0; } end }');
assert.ok(overflow.ok, 'fatal-panic test cannot compile: ' + overflow.diagnostic);
const fatal = run(overflow.wasm);
assert.ok(!fatal.ok && fatal.panic === 1, 'checked arithmetic panic must bypass trap');
const rawThrow = compile('pub fnc main(): int { throw "bad"; }');
assert.ok(!rawThrow.ok && /throw requires an Error subclass/.test(rawThrow.diagnostic),
  'raw-string throw must be a compiler rejection');

console.log(JSON.stringify({status: 'PASS', backend: 'rust-compiled-browser-wasm',
  compiler_sha256: compilerSha, source_git_blob: sampleBlob,
  guest_sha256: sha256(compiled.wasm), guest_bytes: compiled.wasm.length,
  result: '7', stdout: execution.stdout, overflow_panic_bypassed_trap: true,
  raw_string_throw_rejected: true}));
