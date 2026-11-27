import test from "node:test";
import assert from "node:assert/strict";
import {copyPrivateBytes, copyPrivateBytesInto, refreshPrivateMemoryView} from "../src/actor-frame-bytes.mjs";

test("private byte copies are independent and exact", () => {
  const source = Uint8Array.of(1, 42, 9, 3);
  const destination = new Uint8Array(2);
  copyPrivateBytesInto(source, 1, 2, destination);
  assert.deepEqual([...destination], [42, 9]);
  const copy = copyPrivateBytes(source, 1, 2);
  copy[0] = 0;
  assert.equal(source[1], 42);
  assert.throws(() => copyPrivateBytesInto(source, 1, 2, source.subarray(1, 3)), /alias/);
  assert.throws(() => copyPrivateBytesInto(source, 1, 2, new Uint8Array(1)), /exact-size/);
  assert.throws(() => copyPrivateBytesInto(source, 1, 2, new Uint8Array(new SharedArrayBuffer(2))), /shared/);
  assert.throws(() => copyPrivateBytes(source, 3, 2), /range/);
  assert.throws(() => copyPrivateBytes(source, -1, 2), /range/);
  assert.throws(() => copyPrivateBytes(source, 0, 0), /range/);
  assert.deepEqual([...source], [1, 42, 9, 3]);
});

test("copy never invokes a caller-controlled typed-array species", () => {
  const source = Uint8Array.of(42, 9);
  Object.defineProperty(source, "constructor", {get() {
    throw new Error("species must not be consulted");
  }});
  const copy = copyPrivateBytes(source, 0, 2);
  assert.deepEqual([...copy], [42, 9]);
});

test("fixed memory view is reused and refreshed after grow(0)", () => {
  const memory = new WebAssembly.Memory({initial: 1, maximum: 1});
  const first = refreshPrivateMemoryView(memory);
  first[42] = 99;
  assert.equal(refreshPrivateMemoryView(memory, first), first);
  memory.grow(0);
  assert.equal(first.byteLength, 0);
  const next = refreshPrivateMemoryView(memory, first);
  assert.notEqual(next, first);
  assert.equal(next[42], 99);
  assert.equal(refreshPrivateMemoryView(memory, next), next);
  const partial = next.subarray(0, 8);
  const full = refreshPrivateMemoryView(memory, partial);
  assert.notEqual(full, partial);
  assert.equal(full.byteLength, 65536);
  assert.equal(full[42], 99);
  const shared = new WebAssembly.Memory({initial: 1, maximum: 1, shared: true});
  assert.throws(() => refreshPrivateMemoryView(shared), /shared backing/);
});

test("refreshing one actor-private memory does not disturb a second memory", () => {
  const first = new WebAssembly.Memory({initial: 1, maximum: 1});
  const second = new WebAssembly.Memory({initial: 1, maximum: 1});
  const oldFirst = refreshPrivateMemoryView(first);
  const liveSecond = refreshPrivateMemoryView(second);
  oldFirst.set([1, 2, 3, 4], 65532);
  liveSecond.set([9, 8, 7, 6], 65532);
  const snapshot = copyPrivateBytes(oldFirst, 65532, 4);
  first.grow(0);
  assert.equal(oldFirst.byteLength, 0);
  assert.throws(() => copyPrivateBytes(oldFirst, 0, 1), /range/);
  const currentFirst = refreshPrivateMemoryView(first, oldFirst);
  assert.deepEqual([...copyPrivateBytes(currentFirst, 65532, 4)], [1, 2, 3, 4]);
  assert.equal(refreshPrivateMemoryView(second, liveSecond), liveSecond);
  currentFirst.fill(0, 65532);
  assert.deepEqual([...snapshot], [1, 2, 3, 4]);
  assert.deepEqual([...copyPrivateBytes(liveSecond, 65532, 4)], [9, 8, 7, 6]);
});
test("copy respects nonzero source and destination view offsets", () => {
  const source = Uint8Array.of(99, 1, 2, 3, 88);
  const destination = Uint8Array.of(77, 0, 0, 66);
  copyPrivateBytesInto(source.subarray(1, 4), 1, 2, destination.subarray(1, 3));
  assert.deepEqual([...destination], [77, 2, 3, 66]);
  assert.deepEqual([...source], [99, 1, 2, 3, 88]);
  const unchanged = [...destination];
  assert.throws(() => copyPrivateBytesInto(source.subarray(1, 4), 2, 2, destination.subarray(1, 3)), /range/);
  assert.deepEqual([...destination], unchanged);
});
