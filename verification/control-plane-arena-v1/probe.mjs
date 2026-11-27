import assert from "node:assert/strict";
import {ControlPlaneArena32 as Arena} from "./control-plane-arena32.mjs";
const mode=process.argv[2];
assert.ok(["array-buffer","wasm-linear"].includes(mode));
assert.equal(Arena.ABI,"control_generation12_slot20_v1");
const a=new Arena(2,mode),b=new Arena(2,mode);
const parent=a.tryAllocate(),child=a.tryAllocate(),foreign=b.tryAllocate();
assert.notEqual(parent,0n);assert.notEqual(child,0n);
assert.equal(parent&0xffffffffn,foreign&0xffffffffn);
assert.equal(a.tryAllocate(),0n);
assert.throws(()=>b.readI64(parent,0));assert.throws(()=>a.writeRef32(parent,foreign));
a.writeI64(parent,0,9000000000n);assert.equal(a.readI64(parent,0),9000000000n);
a.writeI64(parent,8,-(1n<<63n));assert.equal(a.readI64(parent,8),-(1n<<63n));
assert.throws(()=>a.writeI64(parent,0,1n<<63n));assert.equal(a.readI64(parent,0),9000000000n);
assert.throws(()=>a.writeI64(parent,16,1n));a.writeRef32(parent,child);
assert.equal(a.readRef32(parent),child);a.drop(child);
assert.throws(()=>a.readI64(child,0));assert.throws(()=>a.readRef32(parent));
const reused=a.tryAllocate();assert.notEqual(reused,child);assert.equal(a.readI64(reused,0),0n);
a.writeRef32(parent,reused);assert.equal(a.readRef32(parent),reused);
a.drop(parent);a.drop(reused);assert.throws(()=>a.drop(reused));a.close();a.close();
assert.equal(a.tryAllocate(),0n);assert.throws(()=>a.readI64(parent,0));b.close();
const fifo=new Arena(3,mode);
for(let g=1;g<=4095;g++)for(let slot=1;slot<=3;slot++){
  const h=fifo.tryAllocate();assert.equal(Number(h&0xffffffffn)>>>20,g);assert.equal(Number(h&0xfffffn),slot);
  assert.equal(fifo.readI64(h,0),0n);assert.equal(fifo.readRef32(h),0n);
  fifo.writeI64(h,0,BigInt(slot));fifo.drop(h);
}
assert.equal(fifo.tryAllocate(),0n);fifo.close();
const reverse=new Arena(5,mode),held=Array.from({length:5},()=>reverse.tryAllocate());
assert.equal(reverse.tryAllocate(),0n);for(let i=4;i>=0;i--)reverse.drop(held[i]);
for(let i=4;i>=0;i--){const h=reverse.tryAllocate();assert.equal(Number(h&0xfffffn),i+1);assert.notEqual(h,held[i]);assert.throws(()=>reverse.readI64(held[0],0));}
reverse.close();
const long=new Arena(256,mode);
for(let i=0;i<1000000;i++){
  const h=long.tryAllocate();assert.notEqual(h,0n);assert.equal(long.readI64(h,0),0n);assert.equal(long.readRef32(h),0n);
  long.writeI64(h,0,BigInt(i));assert.equal(long.readI64(h,0),BigInt(i));long.drop(h);
}
long.close();
console.log("CONTROL_LINEAR_HOST_PASS mode="+mode+" cycles=1000000 retirement=12285 physical_release=NOT_PROVEN host_gc=NOT_MEASURED");
