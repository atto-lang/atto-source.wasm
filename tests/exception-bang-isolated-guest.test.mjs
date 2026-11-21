import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const runner=fileURLToPath(new URL('../scripts/run-bounded-exception-bang-guest.mjs',import.meta.url));
function uleb(n){
  const out=[];do{let x=n&127;n>>>=7;if(n)x|=128;out.push(x);}while(n);
  return out;
}
const str=s=>[...uleb(Buffer.byteLength(s)),...Buffer.from(s,'utf8')];
const sec=(id,bytes)=>[id,...uleb(bytes.length),...bytes];

// Purpose-built *synthetic* module. This is NOT an Atto compiler output or
// a backend parity fixture. The positive ABI shape only tests child isolation.
function guest({body=[0,0x42,7,0x0b],returnsI64=true,importModule=null}={}){
  const type=returnsI64?0x7e:0x7f;
  const types=importModule?[2,0x60,0,0,0x60,0,1,type]:[1,0x60,0,1,type];
  const imports=importModule?sec(2,[1,...str(importModule),...str('print_newline'),0,0]):[];
  const funcIndex=importModule?1:0;
  return Buffer.from([0,97,115,109,1,0,0,0,
    ...sec(1,types),...imports,
    ...sec(3,[1,importModule?1:0]),
    ...sec(5,[1,0,1]),
    ...sec(7,[2,...str('main'),0,funcIndex,...str('memory'),2,0]),
    ...sec(10,[1,...uleb(body.length),...body])]);
}
function launch(bytes,timeout=3000){
  return spawnSync(process.execPath,['--max-old-space-size=128',runner],{
    input:bytes,encoding:'utf8',timeout,maxBuffer:64*1024,
    env:{PATH:process.env.PATH??'',NODE_OPTIONS:''}});
}
test('synthetic i64 guest runs in isolated child with bounded JSON receipt',()=>{
  const module=guest();
  assert.ok(WebAssembly.validate(module));
  const r=launch(module);
  assert.equal(r.error,undefined);
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(JSON.parse(r.stdout),{
    scope:'ISOLATED_COMPILED_GUEST',value:'7',stdout:''});
});
test('child refuses an i32 return masquerading as required i64 guest result',()=>{
  const module=guest({returnsI64:false,body:[0,0x41,7,0x0b]});
  assert.ok(WebAssembly.validate(module));
  const r=launch(module);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/must return wasm i64/);
});
test('child refuses unauthorized host import namespace',()=>{
  const module=guest({importModule:'env'});
  assert.ok(WebAssembly.validate(module));
  const r=launch(module);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/unauthorized guest import namespace/);
});
test('a synchronous infinite Wasm loop cannot hang the caller',()=>{
  const module=guest({body:[0,3,0x40,0x0c,0,0x0b,0x42,7,0x0b]});
  assert.ok(WebAssembly.validate(module));
  const r=launch(module,800);
  assert.equal(r.error?.code,'ETIMEDOUT','unbounded or unexpectedly completed guest');
  assert.notEqual(r.status,0);
});
test('a malicious imported print flood is rejected before exceeding 4KiB',()=>{
  const callPrint=Array.from({length:4110},()=>[0x10,0]).flat();
  const module=guest({importModule:'atto',body:[0,...callPrint,0x42,7,0x0b]});
  assert.ok(WebAssembly.validate(module));
  const r=launch(module);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/compiled guest stdout exceeded maximum/);
  assert.ok(r.stdout.length<1000,'print flood escaped to CI stdout');
});
test('malformed and overly large Wasm guest artifacts fail closed',()=>{
  for(const module of [Buffer.from([0,97,115,109,1,0,0,0]),
    Buffer.alloc(1024*1024+1)]){
    const r=launch(module);
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/GUEST_EXECUTION_REJECTED/);
  }
});
test('child has no automatic guest parity certificate',()=>{
  const r=launch(guest());
  const x=JSON.parse(r.stdout);
  assert.equal(x.scope,'ISOLATED_COMPILED_GUEST');
  assert.equal(Object.hasOwn(x,'independent_compiler'),false);
  assert.equal(Object.hasOwn(x,'compiler_sha256'),false);
  assert.equal(Object.hasOwn(x,'guest_parity_pass'),false);
});
