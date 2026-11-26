import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUEST_SCHEMA, encodeNativeWasmPair, decodeNativeWasmPair,
  frameNativeWasm, NativeWasmFrameReader, MAX_FRAME_BYTES
} from '../src/native-wasm-wire-v0.mjs';

const payload = () => encodeNativeWasmPair(REQUEST_SCHEMA, 19n, -42n);

function allWirePaths(bytes) {
  return [
    () => decodeNativeWasmPair(REQUEST_SCHEMA, bytes),
    () => frameNativeWasm(bytes),
    () => new NativeWasmFrameReader().push(bytes)
  ];
}

test('native/WASM DATA input rejects forged Proxy views without invoking traps', () => {
  let traps = 0;
  const forged = new Proxy(payload(), {
    get() { traps++; throw Error('untrusted getter was invoked'); },
    getPrototypeOf() { traps++; throw Error('untrusted prototype trap'); }
  });
  for (const operation of allWirePaths(forged))
    assert.throws(operation, /genuine Uint8Array/);
  assert.equal(traps, 0, 'the rejection path must not inspect Proxy properties');
});

test('native/WASM DATA input refuses SharedArrayBuffer-backed views', () => {
  const original = payload();
  const shared = new Uint8Array(new SharedArrayBuffer(original.length));
  shared.set(original);
  for (const operation of allWirePaths(shared))
    assert.throws(operation, /SharedArrayBuffer/);
});

test('native/WASM DATA uses intrinsic slots, never overridden getters or iterators', () => {
  class HostileBytes extends Uint8Array {
    get length() { throw Error('attacker length getter'); }
    subarray() { throw Error('attacker subarray override'); }
    [Symbol.iterator]() { throw Error('attacker iterator override'); }
  }
  const original = payload();
  const hostile = new HostileBytes(original);
  assert.deepEqual(decodeNativeWasmPair(REQUEST_SCHEMA, hostile),
                   {ticket: 19n, value: -42n});
  const framed = frameNativeWasm(hostile);
  const reader = new NativeWasmFrameReader();
  assert.deepEqual(reader.push(framed), [original]);
  reader.end();
});

test('framing uses an owned snapshot and a malformed oversize view is refused', () => {
  const original = payload();
  const framed = frameNativeWasm(original);
  original.fill(0);
  const reader = new NativeWasmFrameReader();
  assert.deepEqual(reader.push(framed), [payload()]);
  reader.end();
  const oversized = new Uint8Array(MAX_FRAME_BYTES + 1);
  assert.throws(() => decodeNativeWasmPair(REQUEST_SCHEMA, oversized), /maximum byte size/);
  assert.throws(() => frameNativeWasm(oversized), /maximum byte size/);
});

test('split pipe chunks remain owned even after the producer mutates input', () => {
  const packet = frameNativeWasm(payload());
  const header = packet.subarray(0, 2);
  const reader = new NativeWasmFrameReader();
  assert.deepEqual(reader.push(header), []);
  header.fill(0xff);
  assert.deepEqual(reader.push(packet.subarray(2)), [payload()]);
  reader.end();
});
