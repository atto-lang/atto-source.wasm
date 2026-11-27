#!/usr/bin/env node
// Candidate-only real Rust-compiled browser Wasm ownership execution gate.
// Caller supplies exact-source-built candidate bytes and digest. This does
// not independently approve an artifact or certify exceptional control.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const guestRunner=fileURLToPath(new URL('./run-bounded-scalar-separator-guest.mjs',import.meta.url));

const [compilerPath, expectedSha] = process.argv.slice(2);
if(process.argv.length!==4 || !/^[a-f0-9]{64}$/.test(expectedSha??'')){
  throw new Error('Usage: node scripts/verify-ownership-candidate.mjs <candidate-compiler.wasm> <expected-sha256>');
}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const compilerBytes=readFileSync(compilerPath);
assert.ok(compilerBytes.length>=8 && compilerBytes.length<=64*1024*1024,
  'compiler artifact size outside bounded candidate profile');
assert.equal(digest(compilerBytes),expectedSha,'unapproved or altered compiler binary');
assert.ok(WebAssembly.validate(compilerBytes),'compiler artifact is not valid Wasm');
const compiler=new WebAssembly.Module(compilerBytes);
assert.deepEqual(WebAssembly.Module.imports(compiler),[],
  'compiler requires unallowed host imports');
const api=new WebAssembly.Instance(compiler,{}).exports;
assert.equal(typeof api.abi_version,'function','missing compiler ABI');
assert.equal(api.abi_version(),2,'unknown compiler ABI');
for(const name of ['input_ptr','input_capacity','compile','result_ptr','result_length','error_ptr']){
  assert.equal(typeof api[name],'function','missing compiler export '+name);
}
assert.ok(api.memory instanceof WebAssembly.Memory,'compiler memory missing');
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});

function compile(source){
  const bytes=encoder.encode(source);
  const capacity=api.input_capacity();
  assert.ok(bytes.length>0 && bytes.length<=Math.min(capacity,262144),
    'compiler source exceeds bounded input capacity');
  const inputPtr=api.input_ptr();
  const mem=new Uint8Array(api.memory.buffer);
  assert.ok(Number.isSafeInteger(inputPtr) && inputPtr>=0 &&
    inputPtr+bytes.length<=mem.length,'invalid compiler input pointer');
  mem.set(bytes,inputPtr);
  const status=api.compile(bytes.length);
  const resultLength=api.result_length();
  if(status!==0){
    assert.equal(resultLength,0,'rejected source still emitted a guest artifact');
    const errMem=new Uint8Array(api.memory.buffer);
    const errPtr=api.error_ptr();
    assert.ok(Number.isSafeInteger(errPtr)&&errPtr>=0&&errPtr<errMem.length,
      'compiler error pointer out of bounds');
    let end=errPtr;
    while(end<errMem.length&&errMem[end]!==0 && end-errPtr<4096)end++;
    assert.ok(end<errMem.length&&errMem[end]===0&&end>errPtr,
      'diagnostic missing, oversized or unterminated');
    return {ok:false,diagnostic:decoder.decode(errMem.subarray(errPtr,end))};
  }
  const outMem=new Uint8Array(api.memory.buffer),ptr=api.result_ptr();
  assert.ok(Number.isSafeInteger(ptr)&&ptr>=0&&resultLength>0&&
    resultLength<=1<<20&&ptr+resultLength<=outMem.length,
    'compiler published invalid guest output');
  const guest=outMem.slice(ptr,ptr+resultLength);
  assert.ok(WebAssembly.validate(guest),'compiler published invalid guest Wasm');
  return {ok:true,bytes:guest};
}

function runGuest(bytes){
  // The compiler artifact has a SHA-bound provenance, but its generated
  // guest may still contain an infinite loop, stdout flood or huge memory
  // allocation. Run it in a bounded *child process*; JS timers cannot
  // interrupt synchronous WebAssembly execution in this main process.
  assert.ok(bytes instanceof Uint8Array && bytes.length>=8 &&
    bytes.length<=1024*1024,'compiled guest outside bounded profile');
  const child=spawnSync(process.execPath,
    ['--max-old-space-size=128',guestRunner],{
      input:Buffer.from(bytes),encoding:'utf8',
      timeout:5000,maxBuffer:64*1024,windowsHide:true,
      env:{PATH:process.env.PATH??'',NODE_OPTIONS:''}
    });
  assert.equal(child.error,undefined,
    'compiled guest child error/timeout: '+String(child.error));
  assert.equal(child.signal,null,'compiled guest was killed: '+child.stderr);
  assert.equal(child.status,0,
    'compiled guest rejected or exited abnormally: '+child.stderr);
  assert.ok(child.stdout.length>0 && child.stdout.length<=8192,
    'compiled guest receipt missing/oversized');
  const receipt=JSON.parse(child.stdout);
  assert.equal(receipt.scope,'ISOLATED_SCALAR_SEPARATOR_GUEST','forged guest scope');
  assert.match(receipt.value,/^-?[0-9]+$/,'non-integer guest result');
  assert.ok(typeof receipt.stdout==='string'&&
    Buffer.byteLength(receipt.stdout,'utf8')<=4096,
    'guest stdout exceeded bounded profile');
  return {value:BigInt(receipt.value),stdout:receipt.stdout};
}

// Exact source registry: never normalize or rewrite guest source bytes.
const contract=JSON.parse(readFileSync(new URL('../contracts/copy-ownership-parity-v1.json',import.meta.url),'utf8'));
assert.equal(contract.status,'TARGET_NOT_EXECUTED');
assert.equal(contract.cases.length,19);
assert.equal(new Set(contract.cases.map(c=>c.id)).size,19);
const control='pub fnc main(): int { return 42; }';
const baseline=compile(control);
assert.ok(baseline.ok);
assert.equal(runGuest(baseline.bytes).value,42n);
let passed=0,failed=0;
for(const c of contract.cases){
 const result=compile(c.source);
 let actual;
 try {
  if(result.ok){
   // An unexpectedly admitted negative is a failure even when it traps.
   if(c.expect.kind!=='execute')throw Error('negative produced artifact');
   const observed=runGuest(result.bytes);
   actual={kind:'execute',value:String(observed.value),guest_sha256:digest(result.bytes)};
   assert.equal(observed.value,BigInt(c.expect.value));
  }else{
   actual={kind:'reject',diagnostic:result.diagnostic};
   assert.equal(c.expect.kind,'semantic_reject');
   assert.equal(result.diagnostic.split(':')[0],c.expect.diagnostic);
  }
  passed++;
  console.log(JSON.stringify({id:c.id,status:'PASS',source_sha256:digest(encoder.encode(c.source)),actual}));
 }catch(error){
  failed++;
  console.log(JSON.stringify({id:c.id,status:'FAIL',source_sha256:digest(encoder.encode(c.source)),actual:actual??{kind:'unexpected-artifact',guest_sha256:result.ok?digest(result.bytes):null},error:String(error.message).slice(0,600)}));
 }
 const recovered=compile(control);
 assert.ok(recovered.ok);
 assert.equal(digest(recovered.bytes),digest(baseline.bytes));
}
console.log(JSON.stringify({scope:'CANDIDATE_OWNERSHIP_NOT_APPROVED_ARTIFACT',compiler_sha256:expectedSha,passed,failed,skipped:0}));
assert.equal(failed,0,'ownership parity requires every exact guest outcome and diagnostic');
