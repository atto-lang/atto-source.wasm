// Exact-source browser compiler integration; never publishes compiler/guest artifacts.
// This is delegated source compilation using the Rust-authored compiler, not
// an independent Wasm source compiler. Nested mutable graph parity is separate.
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';

const [compilerPath,compilerSha,attoc,compilerTree]=process.argv.slice(2);
assert.equal(process.argv.length,6,'usage: verify-copy-modes-wasm.mjs <compiler wasm> <sha256> <native attoc> <compiler source root>');
assert.match(compilerSha,/^[0-9a-f]{64}$/);
const bytes=readFileSync(compilerPath);
assert.ok(bytes.length>8 && bytes.length<=32*1024*1024,'compiler size bound');
await verifyCompilerBytes(bytes,compilerSha,bytes.length);
assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)),[],'compiler must be import-free');
const compiler=await createCompiler(bytes);
const digest=b=>createHash('sha256').update(b).digest('hex');
const gitBlob=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const positives=[
 '991-copy-doublebang-scalar.atto','992-copy-doublebang-grouped.atto',
 '993-copy-doublebang-flat-class.atto','994-copy-doublebang-two-independent-class-copies.atto',
 '995-copy-doublebang-flat-class-mixed-fields.atto','996-copy-doublebang-constructor-state.atto',
 '997-copy-doublebang-private-state.atto','998-copy-shallow-flat-class.atto'
];
const negatives=[
 '991-copy-doublebang-class-unproved.atto','992-copy-doublebang-mut-invalid.atto',
 '996-copy-doublebang-exclusive-loan.atto','997-copy-doublebang-nested-array-no-runtime.atto',
 '153-copy-noncopy-class.atto'
];
const allowed=new Set(['print_i64','print_bool','print_f64','print_str','print_newline','actor_spawn','actor_send']);
const dir=mkdtempSync(join(tmpdir(),'atto-copy-browser-'));
function load(group,name){
  const path=resolve(compilerTree,'tests/fixtures',group,name), raw=readFileSync(path);
  assert.ok(raw.length<=65536);
  return {path,raw,text:new TextDecoder('utf-8',{fatal:true}).decode(raw)};
}
function native(source,out){
  const r=spawnSync(resolve(attoc),[source,'-o',out],{encoding:'utf8',timeout:30000,maxBuffer:1<<20});
  assert.ifError(r.error);assert.equal(r.signal,null);assert.notEqual(r.status,null);
  return r;
}
function guest(bytes,expected){
  const mod=new WebAssembly.Module(bytes);
  const imports={atto:Object.create(null)};
  for(const item of WebAssembly.Module.imports(mod)){
    assert.equal(item.module,'atto');assert.equal(item.kind,'function');assert.ok(allowed.has(item.name));
    imports.atto[item.name]=()=>{throw Error('unexpected guest host call '+item.name);};
  }
  const inst=new WebAssembly.Instance(mod,imports);
  assert.equal(inst.exports.main(),BigInt(expected));
  assert.equal(inst.exports.panic_code.value,0);
}
try {
  for(const name of positives){
    const f=load('pass',name);
    const expected=f.text.match(/^\/\/ expect-exit: (\d+)$/m)?.[1];
    assert.ok(expected);
    const output=join(dir,name+'.wasm');
    const n=native(f.path,output);assert.equal(n.status,0,n.stderr);
    const w=compiler.compile(f.text);assert.equal(w.ok,true,JSON.stringify(w.diagnostics));
    const nativeBytes=readFileSync(output);
    assert.deepEqual(Buffer.from(w.wasm),nativeBytes,'native and browser compiler byte mismatch');
    guest(w.wasm,expected);
    console.log(JSON.stringify({scope:'BROWSER_WASM_COPY_GUEST',name,blob:gitBlob(f.raw),guest_sha256:digest(w.wasm),expected,status:'PASS'}));
  }
  for(const name of negatives){
    const f=load('fail',name);
    const expected=f.text.match(/^\/\/ expect-error: (E_[A-Z_]+)$/m)?.[1];
    assert.ok(expected);
    const output=join(dir,name+'.wasm');
    const n=native(f.path,output);assert.notEqual(n.status,0);assert.ok(n.stderr.includes(expected),n.stderr);
    assert.equal(existsSync(output),false);
    const w=compiler.compile(f.text);assert.equal(w.ok,false);assert.equal(Object.hasOwn(w,'wasm'),false);
    assert.ok(w.diagnostics.some(d=>d.message.includes(expected)),JSON.stringify(w.diagnostics));
    console.log(JSON.stringify({scope:'BROWSER_WASM_COPY_REJECTION',name,blob:gitBlob(f.raw),diagnostic:expected,status:'PASS'}));
  }
  // Reuse the same compiler after all negative requests. A failed invocation
  // must not poison subsequent compilation or publish an earlier guest.
  const recovery=compiler.compile('pub fnc main(): int { return 42; }');
  assert.equal(recovery.ok,true);guest(recovery.wasm,42);
  console.log('BROWSER_WASM_COPY_RESULT pass=8 reject=5 recovery=1 byte_parity=8');
} finally {rmSync(dir,{recursive:true,force:true});}
