#!/usr/bin/env node
// Candidate-only real Rust-compiled browser Wasm execution gate for canonical
// exceptional bangs. DOES NOT fetch, publish or independently certify an
// atto-source.rs compiler. The reviewed compiler bytes must be provided by
// the caller and bound to an independently approved SHA-256.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const guestRunner=fileURLToPath(new URL('./run-bounded-exception-bang-guest.mjs',import.meta.url));

const [compilerPath, expectedSha] = process.argv.slice(2);
if(process.argv.length!==4 || !/^[a-f0-9]{64}$/.test(expectedSha??'')){
  throw new Error('Usage: node scripts/verify-exception-bang-wasm.mjs <approved-compiler.wasm> <approved-sha256>');
}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const compilerBytes=readFileSync(compilerPath);
assert.ok(compilerBytes.length>=8 && compilerBytes.length<=64*1024*1024,
  'compiler artifact size outside approved bounded profile');
assert.equal(digest(compilerBytes),expectedSha,'unapproved or altered compiler binary');
assert.ok(WebAssembly.validate(compilerBytes),'compiler artifact is not valid Wasm');
const compiler=new WebAssembly.Module(compilerBytes);
assert.deepEqual(WebAssembly.Module.imports(compiler),[],
  'compiler requires unapproved host imports');
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
  assert.equal(receipt.scope,'ISOLATED_COMPILED_GUEST','forged guest scope');
  assert.match(receipt.value,/^-?[0-9]+$/,'non-integer guest result');
  assert.ok(typeof receipt.stdout==='string'&&
    Buffer.byteLength(receipt.stdout,'utf8')<=4096,
    'guest stdout exceeded bounded profile');
  return {value:BigInt(receipt.value),stdout:receipt.stdout};
}

const positive=[
  {
    name:'throw-bang-catch-and-finally',
    source:`fnc fail(): int throws(Error) { throw! Error("bang throw"); }
      pub fnc main(): int {
        try { return fail(); }
        catch (Error e) { stdio.println("caught bang"); return 7; }
        finally { stdio.println("finally"); }
      }`,
    value:7n,stdout:'caught bang\nfinally\n'
  },
  {
    name:'raise-bang-bypasses-catch-and-reaches-recover',
    source:`fnc fail(): int raises(Error) { raise! Error("bang raise"); }
      fnc f(): int {
        recover |err, cursor| -> { stdio.println(err.message); return 9; };
        try { return fail(); }
        catch (Error e) { stdio.println("UNEXPECTED catch"); return -1; }
      }
      pub fnc main(): int { return f(); }`,
    value:9n,stdout:'bang raise\n'
  }
];
const observations=[];
for(const item of positive){
  const compiled=compile(item.source);
  assert.ok(compiled.ok,item.name+' compilation rejected: '+compiled.diagnostic);
  const result=runGuest(compiled.bytes);
  assert.equal(result.value,item.value,item.name+' guest return mismatch');
  assert.equal(result.stdout,item.stdout,item.name+' guest stdout mismatch');
  observations.push({name:item.name,guest_sha256:digest(compiled.bytes),
    value:String(result.value),stdout:result.stdout});
}
const negative=[
  ['pub fnc main(): int { return trap! 7; }','E_TRAP_BANG_RESULT_UNVERIFIED'],
  ['pub fnc main(): int { throw! 7; }','E_TYPE'],
  ['pub fnc main(): int { raise! "untyped"; }','E_TYPE']
];
// Exercise the approved compiler artifact itself, not a host regex that
// could conceal a compiler accepting invalid guest syntax.
for(const keyword of ['trap!','throw!','raise!','panic!','copy!','copy!!',
  'take!','move!','borrow!','share!','pin!','drop!','pipe!','rpipe!','stop!','expand!']){
  for(const tail of ['value','(42)','/*comment*/ value','','\u00a0value']){
    negative.push(['pub fnc main(): int { return '+keyword+tail+'; }',
      'E_BANG_KEYWORD_WHITESPACE']);
  }
}
for(const [sample,code] of negative){
  const rejected=compile(sample);
  assert.equal(rejected.ok,false,'unverified guest effect compiled: '+sample);
  assert.ok(rejected.diagnostic.includes(code),
    'wrong compiler diagnostic for '+sample+': '+rejected.diagnostic);
}
console.log(JSON.stringify({
  status:'PASS',scope:'approved-rust-compiled-browser-wasm-artifact',
  independent_compiler:false,
  compiler_sha256:expectedSha,
  positive_guest_cases:observations,
  no_artifact_reject_cases:negative.length
}));
