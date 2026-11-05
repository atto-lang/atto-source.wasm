import test from 'node:test';
import assert from 'node:assert/strict';
import {FrozenTcpSlab} from '../src/frozen-tcp-slab.mjs';

// Trusted-host source slab regressions only, not Wasm guest/network execution.
test('one MiB input is admitted, one additional byte is rejected',()=>{
 const exact=new FrozenTcpSlab(new Uint8Array(1048576));
 assert.equal(exact.size,1048576);
 const pin=exact.pin();
 assert.equal(exact.readByte(pin,1048575),0);
 exact.retire();
 assert.equal(exact.freed,false);
 assert.equal(exact.releasePin(pin),true);
 assert.equal(exact.freed,true);
 assert.throws(()=>new FrozenTcpSlab(new Uint8Array(1048577)),/one MiB/);
});
test('partial iterator failure does not publish an incomplete slab',()=>{
 const iterable={
  *[Symbol.iterator](){yield 7;yield 8;throw Error('source aborted');}
 };
 assert.throws(()=>new FrozenTcpSlab(iterable),/source aborted/);
 assert.throws(()=>new FrozenTcpSlab([true]),/unsigned byte values/);
});
test('retiring without pins is terminal and cannot reissue read authority',()=>{
 const slab=new FrozenTcpSlab([4,5]);
 slab.retire();
 assert.equal(slab.freed,true);
 assert.equal(slab.size,2);
 assert.throws(()=>slab.pin(),/slab retired/);
 assert.throws(()=>slab.readByte({},0),/invalid TCP slab pin/);
});