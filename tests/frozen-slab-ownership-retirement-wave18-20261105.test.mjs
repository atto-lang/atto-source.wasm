import test from 'node:test';
import assert from 'node:assert/strict';
import {FrozenTcpSlab} from '../src/frozen-tcp-slab.mjs';

test('slab owns a detached copy even if caller mutates the source after construction',()=>{
 const source=Uint8Array.of(4,5,6);
 const slab=new FrozenTcpSlab(source);
 const pin=slab.pin();
 source[1]=199;
 assert.equal(slab.readByte(pin,1),5);
 assert.equal(slab.size,3);
 assert.equal(slab.releasePin(pin),true);
});

test('retirement waits for every outstanding pin and refuses new admission',()=>{
 const slab=new FrozenTcpSlab([1,2,3]),first=slab.pin(),second=slab.pin();
 slab.retire();
 assert.equal(slab.freed,false);
 assert.equal(slab.pinCount,2);
 assert.throws(()=>slab.pin(),/slab retired/);
 assert.equal(slab.releasePin(first),true);
 assert.equal(slab.freed,false);
 assert.equal(slab.readByte(second,2),3);
 assert.equal(slab.releasePin(second),true);
 assert.equal(slab.freed,true);
 assert.equal(slab.pinCount,0);
 assert.equal(slab.releasePin(second),false);
});

test('forged pins, cross-instance pins and invalid offsets cannot read physical bytes',()=>{
 const left=new FrozenTcpSlab([8]),right=new FrozenTcpSlab([7]);
 const pin=left.pin();
 assert.throws(()=>left.readByte(Object.freeze({}),0),/invalid TCP slab pin/);
 assert.throws(()=>right.readByte(pin,0),/invalid TCP slab pin/);
 assert.throws(()=>left.readByte(pin,-0.5),/TCP slab byte index/);
 assert.throws(()=>left.readByte(pin,1),/TCP slab byte index/);
 left.releasePin(pin);
 assert.throws(()=>left.readByte(pin,0),/invalid TCP slab pin/);
});

test('invalid source byte elements and shared writable backing are rejected',()=>{
 for(const bad of [[-1],[256],[1.25],[NaN]])
  assert.throws(()=>new FrozenTcpSlab(bad),/unsigned byte values/);
 if(typeof SharedArrayBuffer==='function'){
  const shared=new Uint8Array(new SharedArrayBuffer(4));
  assert.throws(()=>new FrozenTcpSlab(shared),/mutable shared backing memory/);
 }
});
