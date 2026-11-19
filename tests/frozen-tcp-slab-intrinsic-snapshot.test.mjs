import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {FrozenTcpSlab} from '../src/frozen-tcp-slab.mjs';

test('genuine Uint8Array slots take precedence over poisoned subclass getters and iterators', () => {
  class Poisoned extends Uint8Array {
    get byteLength() { throw new Error('poisoned byteLength'); }
    get buffer() { throw new Error('poisoned buffer'); }
    *[Symbol.iterator]() { throw new Error('poisoned iterator'); }
  }
  const source = new Poisoned([12, 34, 56]);
  const slab = new FrozenTcpSlab(source);
  source[1] = 99;
  const p = slab.pin();
  assert.equal(slab.size, 3);
  assert.deepEqual([0, 1, 2].map(i => slab.readByte(p, i)), [12, 34, 56]);
  slab.retire();
  assert.equal(slab.freed, false);
  assert.equal(slab.releasePin(p), true);
  assert.equal(slab.freed, true);
});

test('foreign-realm shared backing and resizable backing are denied', () => {
  const shared = runInNewContext('new Uint8Array(new SharedArrayBuffer(2))');
  assert.throws(() => new FrozenTcpSlab(shared), /shared backing memory/);
  const ordinaryShared = new Uint16Array(new SharedArrayBuffer(8));
  assert.throws(() => new FrozenTcpSlab(ordinaryShared), /shared backing memory/);
  const growable = new ArrayBuffer(4, {maxByteLength: 8});
  if (growable.resizable) assert.throws(() => new FrozenTcpSlab(new Uint8Array(growable)), /resizable/);
});

test('source proxy is rejected without invoking malicious hooks', () => {
  let calls = 0;
  const proxy = new Proxy(new Uint8Array([7]), {get() {calls++; throw Error('trap called');}});
  assert.throws(() => new FrozenTcpSlab(proxy), /invalid TCP byte source/);
  assert.equal(calls, 0);
});

test('original iterable behavior, byte cap, partial iterator failure, and retirement remain supported', () => {
  const slab = new FrozenTcpSlab([4, 5]);
  assert.equal(slab.readByte(slab.pin(), 1), 5);
  slab.retire();
  assert.throws(() => slab.pin(), /slab retired/);
  assert.throws(() => new FrozenTcpSlab([true]), /unsigned byte values/);
  assert.throws(() => new FrozenTcpSlab({ *[Symbol.iterator]() {yield 7;throw Error('source aborted');} }), /source aborted/);
  assert.equal(new FrozenTcpSlab(new Uint8Array(1048576)).size, 1048576);
  assert.throws(() => new FrozenTcpSlab(new Uint8Array(1048577)), /one MiB/);
});


test('poisoned Array.prototype.push cannot suppress typed bytes or iterable bytes', () => {
  const original = Array.prototype.push;
  let typed, iterable;
  try {
    Array.prototype.push = function () { return this.length; };
    typed = new FrozenTcpSlab(new Uint8Array([17, 29]));
    iterable = new FrozenTcpSlab([31, 47]);
  } finally {
    Array.prototype.push = original;
  }
  const first = typed.pin(), second = iterable.pin();
  assert.equal(typed.size, 2);
  assert.deepEqual([typed.readByte(first, 0), typed.readByte(first, 1)], [17, 29]);
  assert.equal(iterable.size, 2);
  assert.deepEqual([iterable.readByte(second, 0), iterable.readByte(second, 1)], [31, 47]);
});
