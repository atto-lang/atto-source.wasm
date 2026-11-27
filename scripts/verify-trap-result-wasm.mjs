#!/usr/bin/env node
// Artifact-driven canonical trap->Result guest gate (v1). This is not a compiler
// and never downloads, publishes, or substitutes compiler Wasm bytes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {checkedUnwrapFixtures, verifyCheckedUnwrapFixture, verifyCheckedUnwrapExecution} from '../src/checked-unwrap-fixtures.mjs';
import {checkedUnwrapRejections, verifyCheckedUnwrapRejection} from '../src/checked-unwrap-rejections.mjs';
import {isRuntimeTrapWithPanicCode, guardHostImport} from '../src/trap-result-guest-outcome.mjs';

const [compilerPath, samplePath, compilerSha, sampleBlob, mode] = process.argv.slice(2);
const fullV6 = mode === '--checked-unwrap-v6-full';
const checkedUnwrap = mode === '--checked-unwrap-v6' || fullV6;
if ((process.argv.length !== 6 && !(process.argv.length === 7 && checkedUnwrap)) || !/^[a-f0-9]{64}$/.test(compilerSha ?? '') ||
    !/^[a-f0-9]{40}$/.test(sampleBlob ?? '')) {
  throw new Error('Usage: node scripts/verify-trap-result-wasm.mjs <compiler.wasm> <result.atto> <compiler_sha256> <sample_git_blob_sha1> [--checked-unwrap-v6|--checked-unwrap-v6-full]');
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
const compilerBytes = readFileSync(compilerPath);
const sampleBytes = readFileSync(samplePath);
assert.equal(sha256(compilerBytes), compilerSha, 'unreviewed compiler digest');
assert.equal(gitBlob(sampleBytes), sampleBlob, 'sample does not match reviewed Result fixture blob');
assert.equal(sampleBlob, '2d71c15eb4e2f9f5b9bf42b5eef8ce3271d8106e', 'sample does not match reviewed Result fixture blob');
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
  const append = text => {
    assert.ok(stdout.length + text.length <= 65536, 'guest stdout budget');
    stdout += text;
  };
  let instance;
  const trustedPrintCallbacks = {
    print_i64: v => append(String(v)),
    print_bool: v => append(v ? 'true' : 'false'),
    print_f64: v => append(String(v)),
    print_str: (ptr, len) => {
      const memory = instance.exports.memory?.buffer;
      assert.ok(memory && ptr >= 0 && len >= 0 && ptr + len <= memory.byteLength, 'invalid guest string');
      assert.ok(len <= 65536, 'guest string budget');
      append(decoder.decode(new Uint8Array(memory, ptr, len)));
    },
    print_newline: () => append('\n')
  };
  // Every host callback is guarded, including unexpected RuntimeError
  // subclasses: only an actual Wasm instruction may satisfy the fatal trap
  // witness. Untrusted guest source cannot supply or replace these imports.
  const atto = Object.fromEntries(Object.entries(trustedPrintCallbacks)
    .map(([name, callback]) => [name, guardHostImport(name, callback)]));
  instance = new WebAssembly.Instance(module, {atto});
  assert.equal(instance.exports.panic_code.value, 0, 'nonzero initial guest panic code');
  assert.equal(stdout, '', 'guest startup produced output');
  try {
    const value = instance.exports.main();
    return {ok: true, value, panic: instance.exports.panic_code.value, stdout};
  } catch (error) {
    const panic = instance.exports.panic_code.value;
    return {
      ok: false, error: String(error), panic, stdout,
      runtimeTrapWithPanicCode: isRuntimeTrapWithPanicCode(error, panic)
    };
  }
}

// Optional candidate gate runs only the pinned checked-unwrap fixtures.
// It never turns host models or rejected compilation into guest evidence.
if (checkedUnwrap) {
  const guestCases = [];
  for (const [id] of checkedUnwrapFixtures) {
    const bytes = readFileSync(fileURLToPath(new URL('../tests/fixtures/checked-unwrap-v6/' + id + '.atto', import.meta.url)));
    const [,blob] = verifyCheckedUnwrapFixture(id, bytes);
    const output = compile(decoder.decode(bytes));
    assert.ok(output.ok, id + ' rejected by compiler: ' + output.diagnostic);
    const result = run(output.wasm);
    verifyCheckedUnwrapExecution(id, result);
    guestCases.push({id, source_git_blob: blob, guest_sha256: sha256(output.wasm)});
  }
  const negative = [];
  for (const [id, source] of checkedUnwrapRejections) {
    const output = compile(source);
    verifyCheckedUnwrapRejection(id, output);
    negative.push({id, diagnostic: output.diagnostic});
  }
  if(fullV6){
    const remaining=[{"path":"checked-unwrap.atto","git_blob_sha1":"90c6166041963d1f466bc51f105c66a0a7be15ac","expected":{"result":42}},{"path":"inline-task-failure.atto","git_blob_sha1":"446624a894788834550ac7a13a7a76ea5d06444c","expected":{"result":42,"stdout":"D"}},{"path":"short-circuit.atto","git_blob_sha1":"d24442cf7daf1dd86876b418f0cb9e793cbb23c2","expected":{"result":42,"stdout":"RR"}},{"path":"terminal-expect.atto","git_blob_sha1":"864e6b34fe46de9c260a7e537f3f008caa7c8b79","expected":{"runtime_failure":"uncaught_guest_panic"}}];
    const outcomes=[];
    for(const fixture of remaining){
      const bytes=readFileSync(fileURLToPath(new URL('../tests/fixtures/checked-unwrap-v6/'+fixture.path,import.meta.url)));
      assert.equal(gitBlob(bytes),fixture.git_blob_sha1,'canonical fixture identity');
      try{
        const output=compile(decoder.decode(bytes));
        if(!output.ok){outcomes.push({id:fixture.path,status:'COMPILE_REJECTED',diagnostic:output.diagnostic});continue;}
        const result=run(output.wasm);
        if(fixture.expected.runtime_failure){
          assert.ok(!result.ok && result.runtimeTrapWithPanicCode && result.panic>0,'terminal expect must produce actual guest panic');
        }else{
          assert.equal(result.ok,true);
          assert.equal(result.panic,0);
          assert.equal(result.value,BigInt(fixture.expected.result));
          assert.equal(result.stdout,fixture.expected.stdout??'');
        }
        outcomes.push({id:fixture.path,status:'PASS',guest_sha256:sha256(output.wasm)});
      }catch(error){outcomes.push({id:fixture.path,status:'EXECUTION_FAILED',diagnostic:String(error)});}
    }
    const passed=outcomes.filter(x=>x.status==='PASS').length;
    console.log(JSON.stringify({status:passed===remaining.length?'PASS':'FAIL',profile:'checked-unwrap-v6-full',compiler_sha256:compilerSha,prior_guest_cases:guestCases,remaining:outcomes,guest_executions:guestCases.length+passed,rejected_without_wasm:negative}));
    if(passed!==remaining.length)process.exitCode=1;
    process.exit();
  }
  console.log(JSON.stringify({status:'PASS', profile:'checked-unwrap-v6-rust-candidate',
    evidence_kind:'real-compiler-wasm-guest-executed', compiler_sha256:compilerSha,
    guest_cases:guestCases, guest_executions:guestCases.length, rejected_without_wasm:negative}));
  process.exit(0);
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
  assert.equal(execution.panic, 0, testCase.id + ' returned with pending panic code');
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
assert.ok(!fatal.ok && fatal.runtimeTrapWithPanicCode && fatal.panic === 1,
  'checked overflow must produce a real Wasm trap with panic_code=1, not a host import failure');

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
