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
  assert.notEqual(refreshPrivateMemoryView(memory, next.subarray(0, 8)), next);
  const shared = new WebAssembly.Memory({initial: 1, maximum: 1, shared: true});
  assert.throws(() => refreshPrivateMemoryView(shared), /shared backing/);
});
