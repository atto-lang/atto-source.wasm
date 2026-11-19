import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNoManagedWasm} from '../scripts/no-managed-wasm.mjs';

const header = [0, 97, 115, 109, 1, 0, 0, 0];
function section(id, content) {
  assert.ok(content.length < 128, 'canonical one-byte length test fixture');
  return [id, content.length, ...content];
}
function moduleWithBody(bodyInstructions) {
  const body = [0, ...bodyInstructions, 0x0b];
  return Uint8Array.from([
    ...header, ...section(1, [1, 0x60, 0, 1, 0x7e]),
    ...section(3, [1, 0]),
    ...section(7, [1, 4, 0x6d, 0x61, 0x69, 0x6e, 0, 0]),
    ...section(10, [1, body.length, ...body]),
  ]);
}

for (const [label, instructions] of [
  ['nested block return_call', [0x02, 0x40, 0x12, 0, 0x0b]],
  ['nested if return_call_indirect', [0x41, 1, 0x04, 0x40, 0x13, 0, 0, 0x0b]],
  ['unreachable return_call_ref', [0x00, 0x15, 0]],
  ['direct return_call_ref', [0x15, 0]],
]) {
  test('reject tail-transfer extension inside ' + label, () => {
    assert.throws(() => assertNoManagedWasm(moduleWithBody(instructions)),
      /WASM_TAIL_CALL_FEATURE_UNSUPPORTED/);
  });
}

test('signed integer immediates of all three tail opcodes are not instructions', () => {
  for (const immediate of [0x12, 0x13, 0x15]) {
    assert.doesNotThrow(() => assertNoManagedWasm(
      moduleWithBody([0x42, immediate])));
  }
});

test('floating point bit payloads and custom section bytes cannot be opcode matches', () => {
  // The admission scanner is an opcode parser, not a valid module typechecker.
  assert.doesNotThrow(() => assertNoManagedWasm(
    moduleWithBody([0x43, 0x12, 0x13, 0x15, 0])));
  const base = moduleWithBody([0x42, 0]);
  const custom = Uint8Array.from([...base, ...section(0,
    [1, 0x78, 0x12, 0x13, 0x15])]);
  assert.doesNotThrow(() => assertNoManagedWasm(custom));
});

test('truncated tail immediates do not accidentally fall through as numeric constants', () => {
  for (const opcode of [0x12, 0x13, 0x15]) {
    assert.throws(() => assertNoManagedWasm(moduleWithBody([opcode])),
      /WASM_TAIL_CALL_FEATURE_UNSUPPORTED/);
  }
});
