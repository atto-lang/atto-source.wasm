#!/usr/bin/env node
// Candidate-only real Rust-compiled browser Wasm execution gate for canonical
// exceptional bangs. DOES NOT fetch, publish or independently certify an
// atto-source.rs compiler. The reviewed compiler bytes must be provided by
// the caller and bound to an independently approved SHA-256.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

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
  const guestModule=new WebAssembly.Module(bytes);
  const allowed=new Set(['print_i64','print_bool','print_str','print_newline','print_f64']);
  for(const imp of WebAssembly.Module.imports(guestModule)){
    assert.equal(imp.module,'atto','unexpected guest import module');
    assert.ok(imp.kind==='function'&&allowed.has(imp.name),
      'unexpected guest host function');
  }
  const exports=WebAssembly.Module.exports(guestModule);
  assert.ok(exports.some(x=>x.name==='main'&&x.kind==='function'),
    'missing guest entrypoint');
  assert.ok(exports.every(x=>['main','memory','panic_code'].includes(x.name)),
    'unexpected guest export');
  let stdout='',instance;
  const host={
    print_i64:v=>{stdout+=String(v);},
    print_bool:v=>{stdout+=v?'true':'false';},
    print_f64:v=>{stdout+=String(v);},
    print_newline:()=>{stdout+='\n';},
    print_str:(ptr,len)=>{
      const buffer=instance?.exports.memory?.buffer;
      assert.ok(buffer&&Number.isSafeInteger(ptr)&&Number.isSafeInteger(len)&&
        ptr>=0&&len>=0&&ptr+len<=buffer.byteLength,'invalid guest string pointer');
      stdout+=decoder.decode(new Uint8Array(buffer,ptr,len));
    }
  };
  instance=new WebAssembly.Instance(guestModule,{atto:host});
  const value=instance.exports.main();
  return {value,stdout};
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
  ['trap! 7','E_TRAP_BANG_RESULT_UNVERIFIED'],
  ['throw! 7','E_TYPE'],
  ['raise! "untyped"','E_TYPE']
];
for(const [expr,code] of negative){
  const sample='pub fnc main(): int { return '+expr+'; }';
  const rejected=compile(sample);
  assert.equal(rejected.ok,false,'unverified guest effect compiled: '+expr);
  assert.ok(rejected.diagnostic.includes(code),
    'wrong compiler diagnostic for '+expr+': '+rejected.diagnostic);
}
console.log(JSON.stringify({
  status:'PASS',scope:'approved-rust-compiled-browser-wasm-artifact',
  independent_compiler:false,
  compiler_sha256:expectedSha,
  positive_guest_cases:observations,
  no_artifact_reject_cases:negative.length
}));
