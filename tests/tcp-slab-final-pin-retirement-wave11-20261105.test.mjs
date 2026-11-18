import test from 'node:test';
import assert from 'node:assert/strict';
import {FrozenTcpSlab} from '../src/frozen-tcp-slab.mjs';
test('mutable input bytes are snapshotted and original input mutations do not affect slab',()=>{
  const source=Uint8Array.from([1,2,3]);
  const slab=new FrozenTcpSlab(source);const pin=slab.pin();
  source[1]=200;
  assert.equal(slab.size,3);
  assert.equal(slab.readByte(pin,1),2);
  assert.equal(slab.releasePin(pin),true);
});
test('retirement waits for last distinct pin and no later pin can be admitted',()=>{
  const slab=new FrozenTcpSlab([7,8]);
  const a=slab.pin(),b=slab.pin();
  slab.retire();
  assert.equal(slab.freed,false);
  assert.equal(slab.readByte(b,1),8);
  assert.throws(()=>slab.pin(),/slab retired/);
  assert.equal(slab.releasePin(a),true);
  assert.equal(slab.freed,false);
  assert.equal(slab.releasePin(b),true);
  assert.equal(slab.freed,true);
  assert.equal(slab.pinCount,0);
  assert.equal(slab.releasePin(b),false);
  assert.throws(()=>slab.readByte(b,0),/invalid TCP slab pin/);
});
test('foreign pins, non-byte sources and indexes fail closed',()=>{
  const slab=new FrozenTcpSlab([1]);
  const pin=slab.pin(),other=new FrozenTcpSlab([2]).pin();
  assert.throws(()=>slab.readByte(other,0),/invalid TCP slab pin/);
  for(const index of [-1,1,0.5,NaN])assert.throws(()=>slab.readByte(pin,index),/TCP slab byte index/);
  for(const source of [[-1],[256],[1.5],['1']])
    assert.throws(()=>new FrozenTcpSlab(source),/unsigned byte values/);
  assert.equal(slab.releasePin(pin),true);
});
