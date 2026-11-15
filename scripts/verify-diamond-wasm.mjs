#!/usr/bin/env node
// Source-to-Wasm proof for the exact /play/ diamond inheritance preview.
// This repository does not implement another Atto compiler. The caller supplies
// a separately built, reviewed compiler binary; this script never downloads,
// embeds, republishes, or substitutes a compiler artifact.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const EXPECTED_SAMPLE_BLOB = '05814acb37c0335c03294875b870560a2839031d';
const [compilerPath, samplePath, compilerDigest, sampleBlob] = process.argv.slice(2);
if (process.argv.length !== 6 ||
    !/^[a-f0-9]{64}$/.test(compilerDigest ?? '') ||
    !/^[a-f0-9]{40}$/.test(sampleBlob ?? '')) {
  throw new Error('Usage: node scripts/verify-diamond-wasm.mjs <atto_compiler.wasm> <diamond-inheritance.atto> <approved-compiler-sha256> <sample-git-blob-sha1>');
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
const compilerBytes = readFileSync(compilerPath);
const sampleBytes = readFileSync(samplePath);
assert.equal(sampleBlob, EXPECTED_SAMPLE_BLOB, 'sample blob is not the reviewed /play/ example');
assert.equal(gitBlob(sampleBytes), sampleBlob, 'sample bytes differ from the reviewed Git blob');
assert.equal(sha256(compilerBytes), compilerDigest, 'compiler bytes differ from approved digest');
assert.ok(WebAssembly.validate(compilerBytes), 'invalid compiler WebAssembly');
const compilerModule = new WebAssembly.Module(compilerBytes);
assert.deepEqual(WebAssembly.Module.imports(compilerModule), [], 'compiler has unexpected host imports');
const api = new WebAssembly.Instance(compilerModule, {}).exports;
assert.equal(api.abi_version(), 2, 'unsupported compiler ABI');
assert.ok(api.memory instanceof WebAssembly.Memory, 'compiler has no declared memory');
for (const name of ['input_ptr', 'input_capacity', 'compile', 'result_ptr', 'result_length', 'error_ptr']) {
  assert.equal(typeof api[name], 'function', 'missing compiler export ' + name);
}

const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {fatal: true});
function compile(source) {
  const data = encoder.encode(source), capacity = api.input_capacity(), inputPtr = api.input_ptr();
  const memory = new Uint8Array(api.memory.buffer);
  assert.ok(capacity > 0 && data.length <= capacity && inputPtr >= 0 &&
    inputPtr + capacity <= memory.byteLength, 'compiler input outside Wasm bounds');
  memory.set(data, inputPtr);
  const rc = api.compile(data.length);
  if (rc !== 0) {
    assert.equal(api.result_length(), 0, 'failed compile must not issue a guest module');
    const bytes = new Uint8Array(api.memory.buffer);
    const at = api.error_ptr();
    assert.ok(at >= 0 && at < bytes.length, 'invalid diagnostic pointer');
    let end = at;
    while (end < bytes.length && bytes[end] !== 0) end++;
    assert.ok(end < bytes.length, 'unterminated compiler diagnostic');
    return {ok: false, diagnostic: decoder.decode(bytes.subarray(at, end))};
  }
  const bytes = new Uint8Array(api.memory.buffer);
  const at = api.result_ptr(), n = api.result_length();
  assert.ok(at >= 0 && n > 0 && n <= 1024 * 1024 && at + n <= bytes.length, 'guest output exceeds bounds');
  const wasm = bytes.slice(at, at + n);
  assert.ok(WebAssembly.validate(wasm), 'compiler emitted invalid guest Wasm');
  return {ok: true, wasm};
}
function run(wasm) {
  const module = new WebAssembly.Module(wasm);
  const allowed = new Set(['print_i64','print_bool','print_str','print_newline','print_f64']);
  for (const imp of WebAssembly.Module.imports(module)) {
    assert.equal(imp.module, 'atto', 'guest import from unexpected module');
    assert.ok(imp.kind === 'function' && allowed.has(imp.name), 'guest has unexpected import');
  }
  const exports = WebAssembly.Module.exports(module);
  assert.ok(exports.some(x => x.name === 'main' && x.kind === 'function'), 'guest has no main');
  assert.ok(exports.some(x => x.name === 'panic_code' && x.kind === 'global'), 'guest has no panic code');
  assert.ok(exports.every(x => ['main','panic_code','memory'].includes(x.name)), 'unexpected guest export');
  let stdout = '', instance;
  const atto = {
    print_i64: n => { stdout += String(n); },
    print_bool: n => { stdout += n ? 'true' : 'false'; },
    print_f64: n => { stdout += String(n); },
    print_newline: () => { stdout += '\n'; },
    print_str: (ptr, len) => {
      const memory = instance.exports.memory?.buffer;
      assert.ok(memory && ptr >= 0 && len >= 0 && ptr + len <= memory.byteLength, 'guest string is out of bounds');
      stdout += decoder.decode(new Uint8Array(memory, ptr, len));
    },
  };
  instance = new WebAssembly.Instance(module, {atto});
  return {value: instance.exports.main(), stdout};
}
function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length - 1, 1, 'expected one exact declaration to mutate');
  return source.replace(from, to);
}

const source = decoder.decode(sampleBytes);
const success = compile(source);
assert.ok(success.ok, 'reviewed inheritance source rejected: ' + success.diagnostic);
const result = run(success.wasm);
assert.equal(result.value, 0n);
assert.equal(result.stdout, 'Ada\nhello\nroot\ndiamond resolved\n');

const override = '  pub override describe(): string {\n    return "diamond resolved";\n  }\n';
for (const [label, changed, expected] of [
  ['missing diamond override', replaceOnce(source, override, ''), 'E_AMBIGUOUS_MEMBER'],
  ['implicit override', replaceOnce(source, override, override.replace('pub override', 'pub')), 'E_OVERRIDE_REQUIRED'],
  ['mismatched signature', replaceOnce(source, 'pub override describe(): string {', 'pub override describe(): bool {'), 'E_OVERRIDE_SIGNATURE'],
]) {
  const rejected = compile(changed);
  assert.equal(rejected.ok, false, label + ' incorrectly issued guest Wasm');
  assert.equal(rejected.diagnostic?.split(':')[0], expected, label + ': ' + rejected.diagnostic);
}

console.log(JSON.stringify({
  status: 'PASS', backend: 'Rust compiler built for wasm32; genuine generated guest Wasm',
  compiler_sha256: compilerDigest, sample_git_blob: sampleBlob,
  guest_sha256: sha256(success.wasm), guest_bytes: success.wasm.byteLength,
  return_value: '0', stdout: result.stdout,
  rejected: ['E_AMBIGUOUS_MEMBER', 'E_OVERRIDE_REQUIRED', 'E_OVERRIDE_SIGNATURE'],
}));
