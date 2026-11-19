import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNoManagedWasm} from '../scripts/no-managed-wasm.mjs';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header = [0, 97, 115, 109, 1, 0, 0, 0];
function section(id, bytes) {
  assert.ok(bytes.length < 128, 'test fixture must have a single-byte section size');
  return [id, bytes.length, ...bytes];
}
function moduleWithBody(instructions) {
  const body = [0, ...instructions, 0x0b]; // no locals; explicit end
  return Uint8Array.from([
    ...header,
    ...section(1, [1, 0x60, 0, 1, 0x7e]), // one () -> i64 type
    ...section(3, [1, 0]), // one function
    ...section(7, [1, 4, 109, 97, 105, 110, 0, 0]),
    ...section(10, [1, body.length, ...body]),
  ]);
}

for (const [opcode, name, immediates] of [
  [0x12, 'return_call', [0]],
  [0x13, 'return_call_indirect', [0, 0]],
]) {
  test('deny unsupported ' + name + ' before engine compilation', () => {
    const bytes = moduleWithBody([opcode, ...immediates]);
    assert.throws(() => assertNoManagedWasm(bytes),
      /WASM_TAIL_CALL_FEATURE_UNSUPPORTED/);
    assert.throws(() => inspectWasmBytes(bytes),
      /WASM_TAIL_CALL_FEATURE_UNSUPPORTED/);
  });
}

test('tail opcode values embedded as signed LEB operands are not opcodes', () => {
  for (const immediate of [0x12, 0x13]) {
    const bytes = moduleWithBody([0x42, immediate]); // i64.const immediate
    assert.doesNotThrow(() => assertNoManagedWasm(bytes));
    assert.doesNotThrow(() => inspectWasmBytes(bytes));
  }
});
