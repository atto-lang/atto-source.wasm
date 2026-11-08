/** 
 * Explicit adapter for Rust atto-lang/atto-source.rs integrated actor guest.
 * This is NOT the older, import-free oreslang scalar actor ABI.
 * Source: Rust wasm.rs exports main, panic_code, optional memory and
 * atto_actor_receive_<id>(i64)->i64; optional 'atto' imports.
 *
 * Only pinned, trusted compiler-produced guest bytes are eligible. This
 * parser verifies exact Wasm signatures, memory and import capabilities.
 * A digest checks identity only; it does not authenticate a compiler.
 */
import {assertNoManagedWasm} from '../scripts/no-managed-wasm.mjs';

const EXPECTED_IMPORTS = Object.freeze({
  print_i64: [[0x7e],[]],
  print_bool: [[0x7f],[]],
  print_str: [[0x7f,0x7f],[]],
  print_newline: [[],[]],
  actor_spawn: [[0x7f],[0x7f]],
  actor_send: [[0x7f,0x7e],[0x7f]],
  actor_join: [[0x7f],[]],
});
export const ATTO_ACTOR_ABI = 'atto.browser.actor.integrated.v1';
export const ATTO_MAX_WASM_BYTES = 1_048_576;
export const ATTO_MAX_MEMORY_PAGES = 16;
const HEADER = [0,97,115,109,1,0,0,0];
const decoder = new TextDecoder('utf-8',{fatal:true});
const reject = reason => {throw Error('ATTO_ACTOR_ADMISSION: ' + reason);};

function signature(actual, expected) {
  return !!actual && actual[0].length===expected[0].length &&
    actual[1].length===expected[1].length &&
    actual[0].every((v,i)=>v===expected[0][i]) &&
    actual[1].every((v,i)=>v===expected[1][i]);
}

/** Check the scalar types, exact export signatures and imported capabilities. */
export function inspectAttoActorAbi(bytes, actorId) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength<8 ||
      bytes.byteLength>ATTO_MAX_WASM_BYTES ||
      !HEADER.every((x,i)=>bytes[i]===x)) reject('invalid or oversized WebAssembly input');
  if (!Number.isInteger(actorId) || actorId<0 || actorId>1024)
    reject('actor handler ID out of range');
  let at=8, lastSection=0;
  const types=[],importTypes=[],functions=[],exports=new Map();
  let memoryCount=0, globalCount=0;
  const u32=end=>{
    let n=0;
    for(let i=0;i<5;i++){
      if(at>=end)reject('truncated integer');
      const b=bytes[at++];
      if(i===4&&(b&0xf0))reject('integer overflow');
      n+=(b&127)*2**(7*i);
      if(!(b&128))return n;
    }
    reject('overlong integer');
  };
  const name=end=>{
    const count=u32(end);
    if(count>end-at)reject('invalid name length');
    let out;
    try{out=decoder.decode(bytes.subarray(at,at+count));}
    catch{reject('invalid UTF-8 export/import name');}
    at+=count;
    return out;
  };
  const val=end=>{
    if(at>=end)reject('truncated type');
    const t=bytes[at++];
    if(t!==0x7f&&t!==0x7e)reject('only numeric i32/i64 types admitted');
    return t;
  };
  while(at<bytes.length) {
    const section=bytes[at++], length=u32(bytes.length), end=at+length;
    if(!Number.isSafeInteger(end)||end>bytes.length)reject('truncated section');
    if(section>12||[4,8,9].includes(section))reject('table, start, element and extension sections forbidden');
    if(section && section<=lastSection)reject('duplicate or out-of-order section');
    if(section)lastSection=section;
    if(section===1){
      const n=u32(end);
      if(n>1024)reject('type budget exceeded');
      for(let i=0;i<n;i++){
        if(bytes[at++]!==0x60)reject('GC/struct/subtype functions not admitted');
        const np=u32(end);if(np>32||np>end-at)reject('invalid parameter count');
        const params=Array.from({length:np},()=>val(end));
        const nr=u32(end);if(nr>1||nr>end-at)reject('invalid result count');
        const results=Array.from({length:nr},()=>val(end));
        types.push([params,results]);
      }
      if(at!==end)reject('malformed type section');
    } else if(section===2){
      const n=u32(end);
      if(n>7)reject('import budget exceeded');
      const names=new Set();
      for(let i=0;i<n;i++){
        const mod=name(end),field=name(end);
        if(at>=end||bytes[at++]!==0x00||mod!=='atto'||
            !Object.hasOwn(EXPECTED_IMPORTS,field)||names.has(field))
          reject('unapproved, duplicate or non-function import');
        names.add(field);
        const type=types[u32(end)];
        if(!signature(type,EXPECTED_IMPORTS[field]))
          reject('import signature mismatch: '+field);
        importTypes.push(type);
      }
      if(at!==end)reject('malformed import section');
    } else if(section===3){
      const n=u32(end);
      if(n>1024)reject('function count exceeded');
      for(let i=0;i<n;i++){
        const index=u32(end);
        if(!types[index])reject('unknown function signature');
        functions.push(types[index]);
      }
      if(at!==end)reject('malformed function section');
    } else if(section===5){
      const n=u32(end);
      if(n!==1)reject('unexpected memory count');
      const flags=u32(end),min=u32(end),max=u32(end);
      if(flags!==1||min>max||max>ATTO_MAX_MEMORY_PAGES||at!==end)
        reject('memory must be private fixed-bounded wasm32');
      memoryCount=n;
    } else if(section===6){
      const n=u32(end);
      if(n>64)reject('global budget exceeded');
      globalCount=n;
      // Numeric scalar global declarations and init expressions are
      // independently audited by assertNoManagedWasm below.
    } else if(section===7){
      const n=u32(end);
      if(n>1030)reject('export count exceeded');
      for(let i=0;i<n;i++){
        const field=name(end);
        if(at>=end)reject('truncated export kind');
        const kind=bytes[at++],index=u32(end);
        if(exports.has(field))reject('duplicate export');
        if(!['main','panic_code','memory'].includes(field) &&
           !/^atto_actor_receive_(0|[1-9][0-9]{0,3})$/.test(field))
          reject('unrecognized guest export: '+field);
        exports.set(field,{kind,index});
      }
      if(at!==end)reject('malformed export section');
    }
    at=end;
  }
  const main=exports.get('main'),panic=exports.get('panic_code');
  const receiver=exports.get('atto_actor_receive_'+actorId);
  const allFuncs=importTypes.concat(functions);
  if(!main||main.kind!==0||!signature(allFuncs[main.index],[[],[0x7e]]))
    reject('main() -> i64 required');
  if(!receiver||receiver.kind!==0||
      !signature(allFuncs[receiver.index],[[0x7e],[0x7e]]))
    reject('required actor receiver must be (i64)->i64');
  if(!panic||panic.kind!==3||panic.index!==0||globalCount<1)
    reject('panic_code global index zero required');
  const memory=exports.get('memory');
  if((memoryCount===0&&memory!==undefined) ||
     (memoryCount===1&&(!memory||memory.kind!==2||memory.index!==0)))
    reject('private memory export must match bounded local memory');
  if(!WebAssembly.validate(bytes))reject('engine rejects guest Wasm');
  return Object.freeze({actorId,hasMemory:memoryCount===1,
    actorHandlers:Array.from(exports.keys()).filter(x=>x.startsWith('atto_actor_receive_')),
    importedFunctions:importTypes.length});
}

export async function admitAttoBrowserActor(input, approvedSha256, actorId) {
  if(!(input instanceof Uint8Array) ||
     !(input.buffer instanceof ArrayBuffer) ||
     (typeof SharedArrayBuffer!=='undefined' && input.buffer instanceof SharedArrayBuffer) ||
     input.byteLength>ATTO_MAX_WASM_BYTES)
    reject('requires private bounded Uint8Array');
  if(typeof approvedSha256!=='string'||!/^[a-f0-9]{64}$/.test(approvedSha256))
    reject('requires reviewed lowercase SHA-256');
  const bytes=Uint8Array.from(input); // Own immutable digest/compile snapshot.
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),
    x=>x.toString(16).padStart(2,'0')).join('');
  if(digest!==approvedSha256)reject('artifact SHA-256 mismatch');
  const abi=inspectAttoActorAbi(bytes,actorId);
  // The existing instruction scanner excludes GC/reference types, SIMD,
  // threads and indirect/tail calls. Imports were signature-checked above.
  assertNoManagedWasm(bytes,{allowFunctionImports:true});
  const module=await WebAssembly.compile(bytes);
  const imports=WebAssembly.Module.imports(module);
  if(imports.length!==abi.importedFunctions ||
     imports.some(x=>x.module!=='atto'||x.kind!=='function'||
       !Object.hasOwn(EXPECTED_IMPORTS,x.name)))reject('compiled import mismatch');
  const output=WebAssembly.Module.exports(module);
  if(!output.some(x=>x.name==='atto_actor_receive_'+actorId&&x.kind==='function') ||
     !output.some(x=>x.name==='main'&&x.kind==='function') ||
     !output.some(x=>x.name==='panic_code'&&x.kind==='global'))
    reject('compiled export mismatch');
  return {module,abi};
}
