/**
 * Small, bounded reader for the pieces of core Wasm required to enforce
 * loader policy. This is *not* a general Wasm parser or execution sandbox.
 */
import {snapshotGuestBytes} from "../src/snapshot-guest-bytes.mjs";

export function inspectWasmBytes(input,{maxModuleBytes=1048576,maxMemoryPages=32}={}){
 if(!Number.isSafeInteger(maxModuleBytes)||maxModuleBytes<8||maxModuleBytes>16*1024*1024)throw new TypeError("invalid maximum module size");
 if(!Number.isSafeInteger(maxMemoryPages)||maxMemoryPages<1||maxMemoryPages>256)throw new TypeError("invalid maximum memory pages");
 if(input instanceof WebAssembly.Module)throw new TypeError("precompiled WebAssembly.Module cannot be inspected: provide original bytes");
 // This validator can also be called directly, outside the worker, so it
 // must uphold the same no-shared-backing admission invariant.
 let bytes=snapshotGuestBytes(input,maxModuleBytes);
 const fail=message=>{throw new Error("Wasm admission denied: "+message)};
 if(bytes.length<8||bytes[0]!==0||bytes[1]!==97||bytes[2]!==115||bytes[3]!==109||
    bytes[4]!==1||bytes[5]!==0||bytes[6]!==0||bytes[7]!==0)fail("invalid core module header");
 let at=8;
 const u32=end=>{
  let value=0;
  for(let i=0;i<5;i++){
   if(at>=end)fail("truncated unsigned integer");
   const b=bytes[at++];
   if(i===4&&(b&0xf0)!==0)fail("invalid u32 encoding");
   value+=(b&0x7f)*2**(7*i);
   if((b&0x80)===0)return value;
  }
  fail("overlong unsigned integer");
 };
 let memoryCount=0,hasMemoryMaximum=false,memoryInitial=0,memoryMaximum=0;
 while(at<bytes.length){
  const id=bytes[at++];
  const length=u32(bytes.length);
  const end=at+length;
  if(end>bytes.length)fail("section extends beyond module");
  // Reject host import sections before validation or Wasm code compilation.
  // Empty import sections are denied too: the scalar profile has no imports.
  if(id===2)fail("host imports denied before Wasm compilation");
  if(id===8)fail("start section is forbidden (runs before host admission completes)");
  if(id===4)fail("table section is not yet admitted");
  if(id===9)fail("element sections are forbidden in the scalar profile");
  if(id===13)fail("exception tag sections are forbidden in the scalar profile");
  // Reject GC struct/array, recursive type groups, subtyping and managed
  // reference types *before* compiling the module. This is a deliberately
  // narrow numeric function type reader, not a full Wasm opcode validator.
  if(id===1){
   const count=u32(end);
   if(count>1024)fail("type declaration budget exceeded");
   for(let i=0;i<count;i++){
    if(at>=end||bytes[at++]!==0x60)
     fail("GC/subtype or non-function type forbidden in scalar profile");
    for(let group=0;group<2;group++){
     const n=u32(end);
     if(n>1024)fail("function signature exceeds type budget");
     for(let j=0;j<n;j++){
      if(at>=end)fail("truncated function signature");
      const type=bytes[at++];
      if(type!==0x7f&&type!==0x7e&&type!==0x7d&&type!==0x7c)
       fail("GC/reference/vector value type forbidden in scalar profile");
     }
    }
   }
   if(at!==end)fail("malformed type section");
  }
  if(id===5){
   const count=u32(end);
   memoryCount+=count;
   if(count>1)fail("more than one memory");
   if(count===1){
    const flags=u32(end);
    if(flags!==1)fail("memory requires fixed initial and maximum limits; shared/memory64 forbidden");
    memoryInitial=u32(end);memoryMaximum=u32(end);
    hasMemoryMaximum=true;
    if(memoryInitial>memoryMaximum||memoryMaximum>maxMemoryPages)fail("linear memory exceeds host budget");
   }
   if(at!==end)fail("malformed memory section");
  }
  at=end;
 }
 if(!WebAssembly.validate(bytes))fail("invalid WebAssembly module");
 return {bytes,memoryCount,hasMemoryMaximum,memoryInitial,memoryMaximum};
}
