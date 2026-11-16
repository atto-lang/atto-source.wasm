import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {snapshotGuestBytes} from '../src/snapshot-guest-bytes.mjs';

const header=[0,97,115,109,1,0,0,0];

test('nonzero-offset Node Buffer slices never include adjacent bytes',()=>{
  const padded=Buffer.from([255,...header,254]);
  const view=padded.subarray(1,9);
  const copy=snapshotGuestBytes(view,8);
  assert.deepEqual([...copy],header);
  padded[2]=0;
  assert.equal(copy[1],97,'guest snapshot must not alias caller memory');
});

test('DataView own accessors cannot spoof the intrinsic byte extent',()=>{
  const padded=Uint8Array.from([255,...header,254]);
  const view=new DataView(padded.buffer,1,8);
  let getterCalls=0;
  for(const name of ['buffer','byteOffset','byteLength'])
    Object.defineProperty(view,name,{get(){getterCalls++;throw Error('hostile '+name);}});
  const copy=snapshotGuestBytes(view,8);
  assert.deepEqual([...copy],header);
  assert.equal(getterCalls,0);
  assert.throws(()=>snapshotGuestBytes(view,7),/maximum byte size/);
  assert.equal(getterCalls,0);
});

test('cross-realm subviews preserve native offsets without running the caller iterator',()=>{
  const foreign=vm.runInNewContext(
    'new Uint8Array(new Uint8Array([255,0,97,115,109,1,0,0,0,254]).buffer,1,8)');
  Object.defineProperty(foreign,Symbol.iterator,{value:function*(){
    throw Error('untrusted iterator was executed');
  }});
  assert.deepEqual([...snapshotGuestBytes(foreign,8)],header);
});

test('the exported snapshot helper admits an empty bounded input but denies over-budget bytes',()=>{
  assert.equal(snapshotGuestBytes(new Uint8Array(0),0).length,0);
  assert.throws(()=>snapshotGuestBytes(new Uint8Array(9),8),/maximum byte size/);
});
