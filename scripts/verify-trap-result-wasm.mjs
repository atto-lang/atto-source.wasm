#!/usr/bin/env node
// Artifact-driven canonical trap->Result guest gate (v1). This is not a compiler
// and never downloads, publishes, or substitutes compiler Wasm bytes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const [compilerPath, samplePath, compilerSha, sampleBlob] = process.argv.slice(2);
if (process.argv.length !== 6 || !/^[a-f0-9]{64}$/.test(compilerSha ?? '') ||
    !/^[a-f0-9]{40}$/.test(sampleBlob ?? '')) {
  throw new Error('Usage: node scripts/verify-trap-result-wasm.mjs <compiler.wasm> <result.atto> <compiler_sha256> <sample_git_blob_sha1>');
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
const compilerBytes = readFileSync(compilerPath);
const sampleBytes = readFileSync(samplePath);
assert.equal(sha256(compilerBytes), compilerSha, 'unreviewed compiler digest');
assert.equal(gitBlob(sampleBytes), sampleBlob, 'sample does not match reviewed Result fixture blob');
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

// This gate is intentionally separate from the historical Option-era /play/
// verifier. Compilation is performed by a caller-supplied, SHA-pinned real
// Rust/Wasm compiler. Host-only unit tests MUST NOT be described as guest proof.
const actualSource = decoder.decode(sampleBytes);
const positive = [
  {id: 'canonical-existing-result', source: actualSource, expected: 42n},
  {id: 'caught-ordinary-throw', source: [
    'fnc fail(): int throws Error { throw Error("bad id"); }',
    'pub fnc main(): int {',
    '  val result: Result<int, Error> = trap fail();',
    '  return match result over',
    '    on Ok(_) -> 0,',
    '    on Err() -> 9',
    '  end;',
    '}'
  ].join('\n'), expected: 9n},
  {id: 'returned-err-is-data', source: [
    'fnc checked(): Result<int, Error> { return Err(Error("invalid")); }',
    'pub fnc main(): int {',
    '  val result: Result<int, Error> = trap checked();',
    '  return match result over',
    '    on Ok(_) -> 0,',
    '    on Err() -> 17',
    '  end;',
    '}'
  ].join('\n'), expected: 17n}
];
const compiledCases = [];
for (const testCase of positive) {
  const output = compile(testCase.source);
  assert.ok(output.ok, testCase.id + ' rejected by real compiler: ' + output.diagnostic);
  const execution = run(output.wasm);
  assert.ok(execution.ok, testCase.id + ' trapped: ' + execution.error);
  assert.equal(execution.value, testCase.expected, testCase.id + ' result mismatch');
  assert.equal(execution.stdout, '', testCase.id + ' unexpected guest output');
  compiledCases.push({id: testCase.id, guest_sha256: sha256(output.wasm)});
}
// This must not accept the retired Option-era trap result. A toolchain that
// still accepts Option<int> as the type of a trapped int must fail this gate.
const rejected = [
  {id: 'old-option-trap-binding', source:
    'pub fnc main(): int { val value: Option<int> = trap (40 + 2); return 0; }'},
  {id: 'non-error-throw', source:
    'pub fnc main(): int { throw "bad"; }'}
];
for (const testCase of rejected) {
  const output = compile(testCase.source);
  assert.equal(output.ok, false, testCase.id + ' incorrectly compiled');
  assert.ok(output.diagnostic && output.diagnostic.trim().length > 0,
    testCase.id + ' must have a compiler-owned diagnostic');
}
// Checked integer overflow is an ordinary Wasm panic, not a caught throw.
// Its fatal outcome must not be turned into Err(Error) or a normal return.
const overflow = compile([
  'pub fnc main(): int {',
  '  val n: int = 9223372036854775807;',
  '  val result: Result<int, Error> = trap (n + 1);',
  '  return match result over',
  '    on Ok(value) -> value,',
  '    on Err() -> 0',
  '  end;',
  '}'
].join('\n'));
assert.ok(overflow.ok, 'overflow test cannot compile: ' + overflow.diagnostic);
const fatal = run(overflow.wasm);
assert.ok(!fatal.ok && fatal.panic === 1,
  'checked overflow panic must bypass Result trap');

console.log(JSON.stringify({
  status: 'PASS',
  profile: 'atto-trap-result-v1',
  evidence_kind: 'real-compiler-wasm-guest-executed',
  compiler_sha256: compilerSha,
  source_git_blob: sampleBlob,
  guest_cases: compiledCases,
  guest_executions: compiledCases.length + 1,
  rejected_without_wasm: rejected.map(testCase => testCase.id),
  overflow_panic_bypassed_trap: true
}));
