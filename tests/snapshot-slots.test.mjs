import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {snapshotGuestBytes} from '../src/snapshot-guest-bytes.mjs';

test('byte budget and snapshot ignore shadowed view and buffer properties', () => {
  for (const input of [new ArrayBuffer(32), new Uint8Array(32), new DataView(new ArrayBuffer(32))]) {
    for (const name of ['byteLength', 'byteOffset', 'buffer']) {
      Object.defineProperty(input, name, {get() { throw Error('shadow getter invoked'); }});
    }
    assert.throws(() => snapshotGuestBytes(input, 16), /maximum byte size/);
    assert.equal(snapshotGuestBytes(input, 32).length, 32);
  }
});

test('snapshot uses the real view extent and supports cross-realm ArrayBuffers', () => {
  const bytes = new Uint8Array([9, 1, 2, 9]);
  const view = new DataView(bytes.buffer, 1, 2);
  Object.defineProperty(view, 'byteOffset', {value: 0});
  Object.defineProperty(view, 'buffer', {value: new ArrayBuffer(0)});
  assert.deepEqual([...snapshotGuestBytes(view, 2)], [1, 2]);
  const foreign = vm.runInNewContext('new Uint8Array([1, 2, 3]).buffer');
  assert.deepEqual([...snapshotGuestBytes(foreign, 3)], [1, 2, 3]);
});

test('exported byte-snapshot helper rejects missing and invalid size budgets before reading input',()=>{
  let touched=0;
  const hostile=new Proxy({}, {
    get(){touched++;throw Error('caller trap should not run');},
    getPrototypeOf(){touched++;throw Error('caller prototype trap should not run');}
  });
  for(const maximum of [undefined,NaN,Infinity,-1,1.5,16*1024*1024+1]){
    assert.throws(()=>snapshotGuestBytes(hostile,maximum),/invalid maximum module size/);
    assert.throws(()=>snapshotGuestBytes(new Uint8Array([1]),maximum),/invalid maximum module size/);
  }
  assert.equal(touched,0);
  assert.deepEqual([...snapshotGuestBytes(new Uint8Array([42]),1)],[42]);
});
