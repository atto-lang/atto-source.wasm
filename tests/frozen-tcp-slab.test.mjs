import test from 'node:test';
import assert from 'node:assert/strict';
import { FrozenTcpSlab } from '../src/frozen-tcp-slab.mjs';

test('portable PB01 bytes, clone-on-publication, invalid indices and retirement', () => {
  const source = new Uint8Array([0, 1, 127, 128, 255]);
  const slab = new FrozenTcpSlab(source);
  source.fill(0);
  const first = slab.pin(), second = slab.pin();
  assert.equal(slab.size, 5);
  assert.equal(slab.readByte(first, 3), 128);
  assert.equal(slab.readByte(first, 4), 255);
  assert.throws(() => slab.readByte(first, -1), RangeError);
  assert.throws(() => slab.readByte(first, 5), RangeError);
  assert.throws(() => slab.readByte(first, 1.5), RangeError);
  slab.retire();
  assert.throws(() => slab.pin(), /slab retired/);
  assert.equal(slab.freed, false);
  assert.equal(slab.releasePin(first), true);
  assert.equal(slab.releasePin(first), false);
  assert.throws(() => slab.readByte(first, 3), /invalid TCP slab pin/);
  assert.equal(slab.readByte(second, 3), 128);
  assert.equal(slab.releasePin(second), true);
  assert.equal(slab.freed, true);
});

test('wrong slab, forged object and missing pin deny byte access', () => {
  const a = new FrozenTcpSlab([42]), b = new FrozenTcpSlab([42]);
  const p = a.pin();
  assert.throws(() => b.readByte(p, 0), /invalid TCP slab pin/);
  assert.throws(() => a.readByte(Object.freeze({}), 0), /invalid TCP slab pin/);
  assert.throws(() => a.readByte(null, 0), /invalid TCP slab pin/);
  assert.equal(b.releasePin(p), false);
  assert.equal(a.readByte(p, 0), 42);
  assert.equal(a.releasePin(p), true);
});

test('empty, oversized, invalid byte and mutable SAB-backed view reject', () => {
  const empty = new FrozenTcpSlab([]);
  const pin = empty.pin();
  assert.throws(() => empty.readByte(pin, 0), RangeError);
  assert.equal(empty.releasePin(pin), true);
  empty.retire();
  assert.equal(empty.freed, true);
  assert.throws(() => new FrozenTcpSlab(new Uint8Array(1024*1024+1)), RangeError);
  for (const value of [-1, 256, 1.5, NaN, {}, null, '1']) {
    assert.throws(() => new FrozenTcpSlab([value]), TypeError);
  }
  if (typeof SharedArrayBuffer !== 'undefined')
    assert.throws(() => new FrozenTcpSlab(new Uint8Array(new SharedArrayBuffer(8))), TypeError);
});

test('PB02, PB03, PB04 portable peer vectors', () => {
  for (const [bytes, index, expected] of [
    [[42],0,42], [[255,0,255,0,1],4,1],
  ]) {
    const slab = new FrozenTcpSlab(bytes), pin=slab.pin();
    assert.equal(slab.readByte(pin,index), expected);
    slab.releasePin(pin); slab.retire();
    assert.equal(slab.freed, true);
  }
});

test('release of final pin after retirement clears storage while retaining size metadata', () => {
  const slab = new FrozenTcpSlab([11, 22, 33]);
  const a = slab.pin(), b = slab.pin();
  slab.retire();
  assert.equal(slab.freed, false);
  assert.equal(slab.readByte(b, 2), 33);
  assert.equal(slab.releasePin(a), true);
  assert.equal(slab.freed, false);
  assert.equal(slab.readByte(b, 0), 11);
  assert.equal(slab.releasePin(b), true);
  assert.equal(slab.freed, true);
  assert.equal(slab.size, 3);
  assert.throws(() => slab.readByte(b, 0), /invalid TCP slab pin/);
});

test('retire without a live reader releases private storage immediately and is idempotent', () => {
  const slab = new FrozenTcpSlab([1, 2]);
  slab.retire();
  assert.equal(slab.freed, true);
  slab.retire();
  assert.equal(slab.freed, true);
  assert.throws(() => slab.pin(), /slab retired/);
});

test('pin release before retire does not prematurely free backing storage', () => {
  const slab = new FrozenTcpSlab([89]);
  const receipt = slab.pin();
  assert.equal(slab.releasePin(receipt), true);
  assert.equal(slab.freed, false);
  const second = slab.pin();
  assert.equal(slab.readByte(second, 0), 89);
  slab.retire();
  assert.equal(slab.freed, false);
  slab.releasePin(second);
  assert.equal(slab.freed, true);
});

import vm from 'node:vm';
test('cross-realm SharedArrayBuffer views fail even when instanceof is false', () => {
  const valid = vm.runInNewContext('new Uint8Array([4, 42])');
  const slab = new FrozenTcpSlab(valid), pin = slab.pin();
  assert.equal(slab.readByte(pin, 1), 42);
  slab.releasePin(pin); slab.retire();
  if (typeof SharedArrayBuffer === 'function') {
    const shared = vm.runInNewContext('new Uint8Array(new SharedArrayBuffer(16), 4, 4)');
    assert.throws(() => new FrozenTcpSlab(shared), /shared backing/);
  }
  const privateBytes = new Uint8Array([42]);
  Object.defineProperty(privateBytes, 'buffer', {get() {throw Error('untrusted shadow getter');}});
  const safe = new FrozenTcpSlab(privateBytes), reader = safe.pin();
  assert.equal(safe.readByte(reader, 0), 42);
  safe.releasePin(reader); safe.retire();
});
