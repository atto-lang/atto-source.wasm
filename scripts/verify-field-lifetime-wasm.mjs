#!/usr/bin/env node
// Exact scalar field-lifetime guest integration, not a second compiler.
// Trusted, reviewed compiler only. No automatic network or publication.
import assert from 'node:assert/strict';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {requireNativeDiagnostic,readBrowserDiagnostic,requireBrowserCompileStatus,requireBrowserDiagnostic} from './field-lifetime-diagnostics.mjs';
const [compilerPath, compilerSha, profilePath, fixtureRoot] = process.argv.slice(2);
assert.equal(process.argv.length, 6, 'usage: verify-field-lifetime-wasm.mjs compiler.wasm sha256 profile.json source-root');
assert.match(compilerSha, /^[a-f0-9]{64}$/);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
const readBounded = (path, max) => {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= max, 'unbounded or nonregular input');
  const bytes = readFileSync(path);
  assert.equal(bytes.length,stat.size,'input drift');
  return bytes;
};
// Optional native compiler differential. Require an explicit exact digest
// when enabled; never infer a trusted executable from PATH.
const nativePath = process.env.ATTOC;
const nativeDigest = process.env.ATTOC_SHA256;
assert.equal(Boolean(nativePath), Boolean(nativeDigest), 'native path and digest must be supplied together');
if (nativePath) {
  assert.match(nativeDigest, /^[a-f0-9]{64}$/);
  assert.equal(realpathSync(nativePath), nativePath, 'native compiler must be a canonical absolute path');
  assert.equal(sha256(readBounded(nativePath, 128*1024*1024)), nativeDigest, 'unreviewed native compiler digest');
}
let nativeCompared = 0;
function nativeCompare(path, expected, browser) {
  if (!nativePath) return;
  const r = spawnSync(nativePath, [path], {timeout: 30000, maxBuffer: 4*1024*1024, shell: false});
  assert.ifError(r.error);
  assert.equal(r.signal, null, 'native compiler terminated by signal');
  if (expected.decision === 'REJECT') {
    assert.equal(r.status, 1, 'native compiler did not return normal source rejection');
    assert.equal(r.stdout.length, 0, 'native rejection leaked artifact');
    requireNativeDiagnostic(r.stderr, path, expected.reference_diagnostic);
  } else {
    assert.equal(r.status, 0, 'native compiler failed: '+decoder.decode(r.stderr));
    assert.deepEqual(new Uint8Array(r.stdout), browser.wasm, 'native/browser guest byte mismatch');
  }
  nativeCompared++;
}
const profileBytes = readBounded(profilePath, 65536);
assert.equal(gitBlob(profileBytes), '700b115960724cf09e598569d24ea5bfe217e96e', 'unreviewed profile bytes');
const profile = JSON.parse(profileBytes);
assert.equal(profile.cases.length,19);
const compilerBytes = readBounded(compilerPath, 32*1024*1024);
assert.equal(sha256(compilerBytes), compilerSha, 'unreviewed compiler digest');
assert.ok(WebAssembly.validate(compilerBytes));
const compilerModule = new WebAssembly.Module(compilerBytes);
assert.deepEqual(WebAssembly.Module.imports(compilerModule), [], 'compiler must have zero host imports');
const api = new WebAssembly.Instance(compilerModule, {}).exports;
assert.equal(api.abi_version(), 2);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});

function compile(source) {
  const data = encoder.encode(source);
  assert.ok(data.length <= api.input_capacity(), 'source limit');
  const mem = new Uint8Array(api.memory.buffer);
  const ptr = api.input_ptr();
  assert.ok(ptr >= 0 && ptr + data.length <= mem.length, 'invalid input bounds');
  mem.set(data, ptr);
  if (requireBrowserCompileStatus(api.compile(data.length)) === 1) {
    assert.equal(api.result_length(), 0, 'compiler emitted output after failure');
    const errorMemory = new Uint8Array(api.memory.buffer);
    const offset = api.error_ptr();
    return {ok: false, diagnostic: readBrowserDiagnostic(errorMemory, offset)};
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
  const append = value => { assert.ok(stdout.length + value.length <= 65536, 'guest output budget'); stdout += value; };
  let instance;
  const atto = {
    print_i64: v => { append(String(v)); },
    print_bool: v => { append(v ? 'true' : 'false'); },
    print_f64: v => { append(String(v)); },
    print_str: (ptr, len) => {
      const memory = instance.exports.memory?.buffer;
      assert.ok(memory && ptr >= 0 && len >= 0 && ptr + len <= memory.byteLength, 'invalid guest string');
      assert.ok(len <= 65536, 'guest string budget'); append(decoder.decode(new Uint8Array(memory, ptr, len)));
    },
    print_newline: () => { append('\n'); }
  };
  instance = new WebAssembly.Instance(module, {atto});
  try { return {ok: true, value: instance.exports.main(), stdout}; }
  catch (error) { return {ok: false, error: String(error), panic: instance.exports.panic_code.value, stdout}; }
}


const root=realpathSync(fixtureRoot);
let accepted=0,rejected=0;
for(const c of profile.cases){
  const path=resolve(root,c.source_path);
  assert.ok(path.startsWith(root+sep)&&realpathSync(path)===path,'fixture escaped source root');
  const bytes=readBounded(path,65536);
  assert.equal(gitBlob(bytes),c.blob_sha,'fixture bytes changed');
  const result=compile(decoder.decode(bytes));
  nativeCompare(path,c.expected,result);
  if(c.expected.decision==='REJECT'){
    assert.equal(result.ok,false,c.source_path+' unexpectedly compiled');
    requireBrowserDiagnostic(result.diagnostic,c.expected.reference_diagnostic);
    assert.equal(api.result_length(),0,'rejection leaked artifact');
    rejected++;
  }else{
    assert.equal(result.ok,true,result.diagnostic);
    assert.deepEqual(compile(decoder.decode(bytes)).wasm,result.wasm,'nondeterministic guest');
    const execution=run(result.wasm);
    assert.equal(execution.ok,true,execution.error);
    assert.equal(execution.value,BigInt(c.expected.exit),c.source_path+' return');
    assert.equal(execution.stdout,c.expected.stdout.length?c.expected.stdout.join('\n')+'\n':'',c.source_path+' stdout');
    console.log('FIELD_GUEST '+JSON.stringify({fixture:c.source_path,blob:c.blob_sha,guest_sha256:sha256(result.wasm)}));
    accepted++;
  }
}
assert.equal(accepted,8);assert.equal(rejected,11);
assert.equal(nativeCompared,nativePath?19:0);
console.log('FIELD_WASM_INTEGRATION '+JSON.stringify({accepted,rejected,compiler_sha256:compilerSha,profile_blob:gitBlob(profileBytes),native_compared:nativeCompared,native_compiler_sha256:nativeDigest??null,independent_compiler:false,actor_runtime_certified:false}));
