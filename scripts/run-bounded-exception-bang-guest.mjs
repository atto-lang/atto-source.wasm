#!/usr/bin/env node
// Restricted child-process executor for a single *compiled guest* Wasm.
// Never execute an approved compiler-produced guest synchronously in the CI
// control process: looping Wasm can block JS timers and exhaust log buffers.
// This program has no filesystem/network host imports available to the guest.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const MAX_GUEST_BYTES=1024*1024;
const MAX_STDOUT_BYTES=4096;
const decoder=new TextDecoder('utf-8',{fatal:true});

export function runBoundedGuest(bytes){
  assert.ok(Buffer.isBuffer(bytes) && bytes.length>=8 &&
    bytes.length<=MAX_GUEST_BYTES,'guest Wasm size is outside approved bound');
  assert.ok(WebAssembly.validate(bytes),'invalid compiled Wasm guest');
  const module=new WebAssembly.Module(bytes);
  const allowed=new Set(['print_i64','print_bool','print_str','print_newline','print_f64']);
  for(const imp of WebAssembly.Module.imports(module)){
    assert.equal(imp.module,'atto','unauthorized guest import namespace');
    assert.ok(imp.kind==='function'&&allowed.has(imp.name),
      'unauthorized guest import '+imp.name);
  }
  const exports=WebAssembly.Module.exports(module);
  assert.ok(exports.some(x=>x.name==='main'&&x.kind==='function'),
    'missing compiled guest main');
  assert.ok(exports.some(x=>x.name==='memory'&&x.kind==='memory'),
    'missing exported guest memory');
  assert.ok(exports.some(x=>x.name==='panic_code'&&x.kind==='global'),
    'missing guest panic_code ABI global');
  assert.ok(exports.every(x=>['main','memory','panic_code'].includes(x.name)),
    'unexpected compiled guest export');
  let stdout='',instance;
  const append=value=>{
    const s=String(value);
    assert.ok(Buffer.byteLength(stdout,'utf8')+Buffer.byteLength(s,'utf8')<=
      MAX_STDOUT_BYTES,'compiled guest stdout exceeded maximum');
    stdout+=s;
  };
  const host={
    print_i64:v=>append(v),
    print_bool:v=>append(v?'true':'false'),
    print_f64:v=>append(v),
    print_newline:()=>append('\n'),
    print_str:(ptr,len)=>{
      const buffer=instance?.exports.memory?.buffer;
      assert.ok(buffer instanceof ArrayBuffer &&
        Number.isSafeInteger(ptr)&&Number.isSafeInteger(len)&&
        ptr>=0&&len>=0&&len<=MAX_STDOUT_BYTES&&
        ptr+len<=buffer.byteLength,
        'invalid bounded guest print_str pointer/length');
      append(decoder.decode(new Uint8Array(buffer,ptr,len)));
    }
  };
  instance=new WebAssembly.Instance(module,{atto:host});
  const result=instance.exports.main();
  assert.equal(typeof result,'bigint','compiled guest must return wasm i64');
  const panic=instance.exports.panic_code?.value;
  assert.ok((typeof panic==='bigint'||Number.isInteger(panic)) &&
    BigInt(panic)>=0n,'invalid guest panic_code global');
  assert.equal(BigInt(panic),0n,
    'compiled guest entered terminal panic rather than ordinary throw/raise');
  return {scope:'ISOLATED_COMPILED_GUEST',
    value:String(result),stdout,panic_code:String(panic)};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{
    const bytes=readFileSync(0);
    const result=runBoundedGuest(bytes);
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch(e){
    process.stderr.write('GUEST_EXECUTION_REJECTED: '+
      String(e?.message??e).slice(0,512)+'\n');
    process.exitCode=1;
  }
}
