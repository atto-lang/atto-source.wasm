import test from 'node:test';
import assert from 'node:assert/strict';

// A real WebAssembly module, deliberately independent of the Atto frontend.
// type 0: (i64 environment, i64 argument) -> i64
// type 1: (i64 argument) -> i64  (intentionally incompatible)
// type 2: (i64 environment, i64 argument, i32 table_index) -> i64
function leb(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('unsigned LEB expected');
  const out = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}
const vector = (arrays) => [...leb(arrays.length), ...arrays.flat()];
const section = (id, bytes) => [id, ...leb(bytes.length), ...bytes];
const type = (params, results) => [0x60, ...leb(params.length), ...params, ...leb(results.length), ...results];
const name = (text) => { const bytes = [...new TextEncoder().encode(text)]; return [...leb(bytes.length), ...bytes]; };
const body = (ops) => [...leb(ops.length + 1), 0, ...ops];
function moduleBytes() {
  const i64 = 0x7e, i32 = 0x7f;
  return new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, vector([type([i64, i64], [i64]), type([i64], [i64]), type([i64, i64, i32], [i64])])),
    ...section(3, vector([[0], [1], [2]])),
    ...section(4, vector([[0x70, 0x00, 0x02]])),
    ...section(7, vector([[...name('dispatch'), 0x00, 0x02]])),
    ...section(9, vector([[0, 0x41, 0, 0x0b, 2, 0, 1]])),
    ...section(10, vector([
      body([0x20, 0, 0x20, 1, 0x7c, 0x0b]),
      body([0x20, 0, 0x0b]),
      body([0x20, 0, 0x20, 1, 0x20, 2, 0x11, 0, 0, 0x0b]),
    ])),
  ]);
}

test('real Wasm typed indirect dispatch succeeds for matching function', async () => {
  const {instance} = await WebAssembly.instantiate(moduleBytes());
  assert.equal(instance.exports.dispatch(1n, 41n, 0), 42n);
});

test('real Wasm call_indirect traps on signature mismatch', async () => {
  const {instance} = await WebAssembly.instantiate(moduleBytes());
  assert.throws(() => instance.exports.dispatch(1n, 41n, 1), WebAssembly.RuntimeError);
});

test('real Wasm call_indirect traps on table bounds violation', async () => {
  const {instance} = await WebAssembly.instantiate(moduleBytes());
  assert.throws(() => instance.exports.dispatch(1n, 41n, 9), WebAssembly.RuntimeError);
});
