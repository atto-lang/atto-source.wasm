import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotGuestBytes as snapshot} from '../src/snapshot-guest-bytes.mjs';

test('offset DataView snapshot takes only visible bytes and detaches from caller',()=>{
 const source=Uint8Array.of(99,1,2,3,77);
 const view=new DataView(source.buffer,1,3);
 const copied=snapshot(view,3);
 assert.deepEqual([...copied],[1,2,3]);
 source[2]=200;
 assert.deepEqual([...copied],[1,2,3]);
});

test('subarray snapshot ignores inherited Symbol.iterator impersonation',()=>{
 const source=Uint8Array.of(8,9,10,11);
 const view=source.subarray(1,3);
 let called=0;
 Object.defineProperty(view,Symbol.iterator,{value(){called++;throw Error('iterator trap');}});
 assert.deepEqual([...snapshot(view,2)],[9,10]);
 assert.equal(called,0);
});

test('spoofed buffer and size getters cannot evade the physical allocation budget',()=>{
 const bytes=Uint8Array.of(1,2,3,4);
 let read=0;
 Object.defineProperty(bytes,'byteLength',{get(){read++;throw Error('spoof');}});
 Object.defineProperty(bytes,'buffer',{get(){read++;throw Error('spoof');}});
 assert.throws(()=>snapshot(bytes,3),/exceeds maximum byte size/);
 assert.deepEqual([...snapshot(bytes,4)],[1,2,3,4]);
 assert.equal(read,0);
});

test('invalid limits and SharedArrayBuffer-backed guests fail closed',()=>{
 for(const max of [-1,1.25,Number.MAX_SAFE_INTEGER,NaN])
  assert.throws(()=>snapshot(Uint8Array.of(1),max),/invalid maximum module size/);
 assert.throws(()=>snapshot([1,2,3],16),/expected core WebAssembly bytes/);
 if(typeof SharedArrayBuffer==='function'){
  const shared=new Uint8Array(new SharedArrayBuffer(4));
  assert.throws(()=>snapshot(shared,4),/SharedArrayBuffer-backed Wasm input is forbidden/);
 }
});
