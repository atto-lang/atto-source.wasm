import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_REF32_STORAGE_ABI_V1, CONTROL_REF32_SLOT_BITS,
  CONTROL_REF32_GENERATION_BITS, CONTROL_REF32_SLOT_LIMIT,
  CONTROL_REF32_GENERATION_LIMIT, require_control_ref32_abi_v1,
  encode_control_ref32_v1, decode_control_ref32_v1
} from '../src/control-ref32-v1.mjs';

test('bit widths and ABI cannot be mistaken for actor offset or .NET actor token', () => {
  assert.equal(CONTROL_REF32_SLOT_BITS, 20);
  assert.equal(CONTROL_REF32_GENERATION_BITS, 12);
  assert.equal(CONTROL_REF32_SLOT_LIMIT, 1_048_575);
  assert.equal(CONTROL_REF32_GENERATION_LIMIT, 4095);
  assert.equal(CONTROL_REF32_STORAGE_ABI_V1, 'control_generation12_slot20_v1');
  require_control_ref32_abi_v1('control_generation12_slot20_v1');
  for (const invalid of ['control_generation20_slot12_v1', 'generation16_slot16',
    'generation20_slot12', 'offset8_plus_one', '', null, undefined, 0]) {
    assert.throws(() => require_control_ref32_abi_v1(invalid), /E_CONTROL_REF32_ABI/);
  }
});

test('unsigned high-bit and maximum word round trip without signed coercion', () => {
  assert.equal(decode_control_ref32_v1(0), null);
  for (const [index, generation, expected] of [
    [0, 1, 0x0010_0001], [0, 2048, 0x8000_0001],
    [CONTROL_REF32_SLOT_LIMIT - 1, 4095, 0xffff_ffff],
    [0, 4095, 0xfff0_0001], [CONTROL_REF32_SLOT_LIMIT - 1, 1, 0x001f_ffff]
  ]) {
    const value = encode_control_ref32_v1(index, generation);
    assert.equal(value, expected);
    assert.deepEqual(decode_control_ref32_v1(value), {slot_index:index, generation});
  }
});

test('reject zero fields, out-of-range slots, nonintegers and invalid words', () => {
  for (const [index, generation] of [[-1,1], [CONTROL_REF32_SLOT_LIMIT,1],
    [0,0], [0,4096], [0,-1], [0,1.5], [0,Infinity], [1n,1], ['1',1],
    [NaN,1], [undefined,1], [null,1]]) {
    assert.throws(() => encode_control_ref32_v1(index,generation), /E_CONTROL_REF32_BITS/);
  }
  for (const invalid of [-1, 1, 0x0010_0000, 0x8000_0000, 0x1_0000_0000,
    1.5, '1048577', 1n, null, undefined, NaN, Infinity]) {
    assert.throws(() => decode_control_ref32_v1(invalid), /E_CONTROL_REF32_BITS/);
  }
});

test('distinct domains can issue the same bits: codec never grants authority', () => {
  const actorLikeBits = encode_control_ref32_v1(0,1);
  const controlLikeBits = encode_control_ref32_v1(0,1);
  assert.equal(actorLikeBits, controlLikeBits);
  assert.deepEqual(Object.keys(decode_control_ref32_v1(controlLikeBits)).sort(), ['generation','slot_index']);
  // Only trusted runtime issuer/incarnation/type sidecars can authorize access.
});
