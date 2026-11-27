#!/usr/bin/env node
// Artifact-driven independent host verification. No compiler download,
// distribution, alternate compiler implementation or synthesized guest.
import assert from 'node:assert/strict';
import {readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';

const [path,digest] = process.argv.slice(2);
assert.equal(process.argv.length,4,'usage: node scripts/verify-stored-pair-wasm.mjs compiler.wasm sha256');
assert.match(digest ?? '',/^[a-f0-9]{64}$/,'explicit reviewed compiler SHA256 required');
assert.ok(statSync(path).size <= 64*1024*1024,'compiler artifact too large');
const compiler=readFileSync(path);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(compiler),digest,'compiler digest mismatch');
assert.ok(WebAssembly.validate(compiler),'invalid compiler artifact');
const mod=new WebAssembly.Module(compiler);
assert.deepEqual(WebAssembly.Module.imports(mod),[],'compiler imports must be empty');
const api=new WebAssembly.Instance(mod,{}).exports;
assert.ok(api.memory instanceof WebAssembly.Memory);
for(const k of ['abi_version','input_ptr','input_capacity','compile','result_ptr','result_length','error_ptr'])
  assert.equal(typeof api[k],'function','missing compiler export '+k);
assert.equal(api.abi_version(),2);
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
function compile(source){
  const input=enc.encode(source),ptr=api.input_ptr(),cap=api.input_capacity();
  const mem=new Uint8Array(api.memory.buffer);
  assert.ok(Number.isSafeInteger(ptr)&&Number.isSafeInteger(cap)&&ptr>=0&&cap>=input.length&&ptr+cap<=mem.length);
  mem.set(input,ptr);
  const rc=api.compile(input.length),len=api.result_length(),after=new Uint8Array(api.memory.buffer);
  if(rc!==0){
    assert.equal(len,0,'failed compile exposed stale guest bytes');
    const start=api.error_ptr();
    assert.ok(Number.isSafeInteger(start)&&start>=0&&start<after.length);
    const end=after.indexOf(0,start);
    assert.ok(end>=start&&end-start<=65536,'invalid diagnostic extent');
    return {error:dec.decode(after.subarray(start,end))};
  }
  const start=api.result_ptr();
  assert.ok(Number.isSafeInteger(start)&&Number.isSafeInteger(len)&&start>=0&&len>0&&len<=1048576&&start+len<=after.length);
  const guest=after.slice(start,start+len);
  assert.ok(WebAssembly.validate(guest),'invalid generated guest');
  return {guest};
}
function execute(bytes){
  const m=new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(m),[],'pure scalar Pair guest unexpectedly requests host authority');
  const exports=WebAssembly.Module.exports(m);
  assert.ok(exports.some(x=>x.name==='main'&&x.kind==='function'));
  assert.ok(exports.every(x=>['main','panic_code','memory'].includes(x.name)),'unexpected guest export');
  const x=new WebAssembly.Instance(m,{}).exports;
  const value=x.main();
  if(x.panic_code) assert.equal(x.panic_code.value,0);
  return value;
}
const source=body=>'pub fnc main(): int { '+body+' }';
const tail='const Pair<int> p = x; return p.key == "x" ? p.value : 99;';
const positives=[
  ['short','const x := 5; '+tail,5n],
  ['expanded','const x = x := 5; '+tail,5n],
  ['factory','const x = Pair.of("x", 5); '+tail,5n],
  ['different-key','const x = y := 5; return x.key == "y" ? x.value : 99;',5n],
  ['runtime-local','val n = 21; val x := n+n; return x.value;',42n],
  ['let-shadow','let x := 5; let x := x.value + 1; return x.value;',6n]
];
const negatives=[
  ['scalar-escape','const x := 5; return x;','E_PAIR_ESCAPE_UNSUPPORTED'],
  ['unbound-short','const x := x; return x.value;','E_UNBOUND'],
  ['unbound-expanded','const x = x := x; return x.value;','E_UNBOUND'],
  ['duplicate','const x := 5; const x := 6; return x.value;','E_DUPLICATE'],
  ['runtime-const','val n = 5; const x := n; return x.value;','E_PAIR_CONSTEXPR'],
  ['key-write','let x := 5; x.key = "other"; return x.value;','E_PAIR_STORAGE_UNSUPPORTED'],
  ['forged-slot','val __atto_pair_local_0 = 5; return 5;','E_RESERVED']
];
const receipt=[];
for(const [id,body,expected] of positives){
  const result=compile(source(body));
  assert.ok(result.guest,id+': '+result.error);
  assert.equal(execute(result.guest),expected,id);
  const again=compile(source(body));
  assert.deepEqual(again.guest,result.guest,id+' nondeterministic guest');
  receipt.push({id,result:String(expected),source_sha256:sha(enc.encode(source(body))),guest_sha256:sha(result.guest)});
}
assert.equal(receipt[0].guest_sha256,receipt[1].guest_sha256);
assert.equal(receipt[0].guest_sha256,receipt[2].guest_sha256);
for(const [id,body,code] of negatives){
  const result=compile(source(body));
  assert.ok(!result.guest&&result.error?.includes(code),id+': '+result.error);
  const recovery=compile(source(positives[0][1]));
  assert.ok(recovery.guest,'compiler did not recover from '+id);
  assert.equal(sha(recovery.guest),receipt[0].guest_sha256,'stale diagnostic/output after '+id);
}
console.log(JSON.stringify({status:'PASS',backend:'rust-compiled-browser-wasm',compiler_sha256:digest,positives:receipt,negatives:negatives.map(([id,,code])=>({id,code})),recovery_cases:negatives.length,independent_compiler:false}));
