import test from 'node:test';
import assert from 'node:assert/strict';
import {FrozenTcpSlab} from '../src/frozen-tcp-slab.mjs';

test('owned TCP slab snapshots caller bytes and retains storage through outstanding pins',()=>{
 const input=Uint8Array.from([7,8,9]);
 const slab=new FrozenTcpSlab(input),p=slab.pin(),q=slab.pin();
 input[0]=255;
 assert.equal(slab.readByte(p,0),7);
 assert.equal(slab.pinCount,2);
 slab.retire();
 assert.equal(slab.freed,false);
 assert.equal(slab.readByte(q,2),9);
 assert.equal(slab.releasePin(p),true);
 assert.equal(slab.freed,false);
 assert.equal(slab.releasePin(q),true);
 assert.equal(slab.freed,true);
 assert.equal(slab.pinCount,0);
 assert.equal(slab.releasePin(q),false);
 assert.throws(()=>slab.readByte(p,0),/invalid TCP slab pin/);
 assert.throws(()=>slab.pin(),/slab retired/);
});

test('byte address and foreign pin must never be accepted as read authority',()=>{
 const a=new FrozenTcpSlab([2,4,6]),b=new FrozenTcpSlab([9]);
 const p=a.pin(),q=b.pin();
 assert.throws(()=>a.readByte(q,0),/invalid TCP slab pin/);
 for(const index of [-1,3,0.5,Number.MAX_SAFE_INTEGER+1])
  assert.throws(()=>a.readByte(p,index),/TCP slab byte index/);
 assert.equal(a.readByte(p,1),4);
 a.releasePin(p);b.releasePin(q);
 a.retire();b.retire();
 assert.equal(a.freed,true);
});

test('host slab rejects non-byte values rather than coercing them',()=>{
 for(const bad of [[256],[-1],[1.5],['7'],[null]])
  assert.throws(()=>new FrozenTcpSlab(bad),/unsigned byte values/);
 assert.equal(new FrozenTcpSlab([]).size,0);
});
