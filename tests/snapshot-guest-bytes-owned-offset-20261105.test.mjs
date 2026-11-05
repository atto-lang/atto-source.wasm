import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotGuestBytes} from '../src/snapshot-guest-bytes.mjs';

test('subarray snapshots are byte-offset exact, immutable and bypass hostile iterators and own buffer getters',()=>{
 const bytes=Uint8Array.from([91,1,2,3,92]);
 const view=bytes.subarray(1,4);
 let calls=0;
 Object.defineProperty(view,Symbol.iterator,{get(){calls++;throw Error('iterator executed')}});
 Object.defineProperty(view,'buffer',{get(){calls++;throw Error('buffer getter executed')}});
 const owned=snapshotGuestBytes(view,3);
 assert.deepEqual([...owned],[1,2,3]);
 bytes[1]=255;
 assert.deepEqual([...owned],[1,2,3]);
 assert.equal(calls,0);
 assert.notEqual(owned.buffer,bytes.buffer);
});

test('native DataView slots preserve correct offset even when shadowed by caller properties',()=>{
 const bytes=Uint8Array.from([8,7,6,5,4]);
 const view=new DataView(bytes.buffer,2,2);
 let calls=0;
 Object.defineProperty(view,'byteLength',{get(){calls++;throw Error('getter executed')}});
 Object.defineProperty(view,'byteOffset',{get(){calls++;throw Error('getter executed')}});
 const owned=snapshotGuestBytes(view,2);
 assert.deepEqual([...owned],[6,5]);
 assert.equal(calls,0);
 assert.throws(()=>snapshotGuestBytes(view,1),/maximum byte size/);
});

test('raw-byte admission rejects invalid budgets, nonbuffers and shared backing',()=>{
 assert.throws(()=>snapshotGuestBytes({},10),/expected core WebAssembly bytes/);
 for(const budget of [-1,1.5,16*1024*1024+1])
  assert.throws(()=>snapshotGuestBytes(new Uint8Array(0),budget),/invalid maximum module size/);
 if(typeof SharedArrayBuffer==='function'){
  const shared=new Uint8Array(new SharedArrayBuffer(8));
  assert.throws(()=>snapshotGuestBytes(shared,8),/SharedArrayBuffer-backed/);
 }
 assert.equal(snapshotGuestBytes(new ArrayBuffer(0),0).byteLength,0);
});
