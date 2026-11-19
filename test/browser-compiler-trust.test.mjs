import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyCompilerArtifact,smokeCompilerAndGuest } from '../src/browser-compiler-trust.mjs';

const head='a'.repeat(40),tree='b'.repeat(40);
function leb(n) {const o=[];do{let b=n&127;n>>>=7;if(n)b|=128;o.push(b)}while(n);return o}
function sleb(n) {const o=[];for(;;){let b=n&127;n>>=7;const done=(n===0&&!(b&64))||(n===-1&&!!(b&64));if(!done)b|=128;o.push(b);if(done)return o}}
const sec=(id,bytes)=>[id,...leb(bytes.length),...bytes];
const name=s=>[...leb(s.length),...Buffer.from(s,'ascii')];
function fixture({maxPages=1024,start=false}={}) {
  const types=[2,0x60,0,1,0x7f,0x60,1,0x7f,1,0x7f];
  const funcs=[8,0,0,1,0,0,0,0,0];
  const mem=[1,1,1,...leb(maxPages)];
  const names=['input_ptr','input_capacity','compile','result_ptr','result_length','error_ptr','error_line_number','error_column_number'];
  const exports=[9,...name('memory'),2,0];
  names.forEach((n,i)=>exports.push(...name(n),0,...leb(i)));
  const bodies=[];
  for(let i=0;i<8;i++) {
    const body=[0,0x41,...sleb(i===1?4096:0),0x0b];
    bodies.push(...leb(body.length),...body);
  }
  const bytes=Uint8Array.of(0,97,115,109,1,0,0,0,
    ...sec(1,types),...sec(3,funcs),...sec(5,mem),
    ...sec(7,exports),...(start?sec(8,[0]):[]),...sec(10,[8,...bodies]));
  return bytes;
}
function attested(bytes){
  const hash=createHash('sha256').update(bytes).digest('hex');
  const exports=WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map(x=>x.name);
  const receipt={
    schema:'atto.browser.compiler.artifact.v1',source_head:head,source_tree:tree,
    target:'wasm32-unknown-unknown',abi:'atto-playground-m0',
    compiler_sha256:hash,compiler_bytes:bytes.length,import_count:0,exports
  };
  const trust={source_head:head,source_tree:tree,compiler_sha256:hash};
  return {wasm:bytes,receipt,trust};
}
test('synthetic policy fixture has valid WebAssembly ABI (not real compiler proof)',()=>{
  const bytes=fixture();
  assert.ok(WebAssembly.validate(bytes));
  const admitted=verifyCompilerArtifact(attested(bytes));
  assert.equal(admitted.memory.maximum,1024);
  assert.equal(admitted.source_head,head);
});
test('source tree cannot be rewritten in a self-asserted receipt',()=>{
  const opts=attested(fixture());opts.receipt.source_tree='c'.repeat(40);
  assert.throws(()=>verifyCompilerArtifact(opts),/source identity mismatch/);
});
test('sha256 must be pinned outside the attacker-controlled receipt',()=>{
  const opts=attested(fixture());opts.receipt.compiler_sha256='0'.repeat(64);
  assert.throws(()=>verifyCompilerArtifact(opts),/compiler digest not pinned/);
});
test('byte tampering rejected even if a receipt is self-consistent',()=>{
  const opts=attested(fixture());
  const malicious=fixture();malicious[malicious.length-2]^=1;
  opts.wasm=malicious;
  assert.throws(()=>verifyCompilerArtifact(opts),/artifact digest mismatch/);
});
test('trusted pins cannot be omitted or partially provided',()=>{
  const opts=attested(fixture());delete opts.trust.source_head;
  assert.throws(()=>verifyCompilerArtifact(opts),/three independent trust pins/);
});
test('unknown receipt fields and schemas reject',()=>{
  const opts=attested(fixture());opts.receipt.operator_authorized=true;
  assert.throws(()=>verifyCompilerArtifact(opts),/receipt fields/);
  delete opts.receipt.operator_authorized;opts.receipt.schema='attacker.v2';
  assert.throws(()=>verifyCompilerArtifact(opts),/unsupported compiler contract/);
});
test('start sections prohibited before attempting execution',()=>{
  const bytes=fixture({start:true});
  // Invalid as a wasm program (start function returns i32), but policy must
  // reject the start section independently and before WebAssembly validation.
  const opts=attested(fixture());opts.wasm=bytes;
  const hash=createHash('sha256').update(bytes).digest('hex');
  opts.receipt.compiler_sha256=hash;opts.receipt.compiler_bytes=bytes.length;opts.trust.compiler_sha256=hash;
  assert.throws(()=>verifyCompilerArtifact(opts),/start sections forbidden/);
});
test('unbounded and >64MiB compiler memories prohibited',()=>{
  const bytes=fixture({maxPages:2048});
  const opts=attested(bytes);
  assert.throws(()=>verifyCompilerArtifact(opts),/memory limit exceeds 64 MiB/);
});
test('ordinary guest wasm cannot masquerade as a compiler',()=>{
  const bytes=Uint8Array.of(0,97,115,109,1,0,0,0,
    1,5,1,96,0,1,127,3,2,1,0,7,8,1,4,109,97,105,110,0,0,
    10,6,1,4,0,65,42,11);
  assert.ok(WebAssembly.validate(bytes));
  const opts=attested(fixture());opts.wasm=bytes;
  const hash=createHash('sha256').update(bytes).digest('hex');
  opts.receipt.compiler_sha256=hash;opts.receipt.compiler_bytes=bytes.length;
  opts.trust.compiler_sha256=hash;
  assert.throws(()=>verifyCompilerArtifact(opts),/bounded linear memory/);
});
test('synthetic ABI fixture does not pass real guest-execution smoke',async()=>{
  const opts=attested(fixture());
  const admitted=verifyCompilerArtifact(opts);
  await assert.rejects(()=>smokeCompilerAndGuest(admitted),/invalid guest bytes/);
});
