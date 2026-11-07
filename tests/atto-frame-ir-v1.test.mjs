import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCompiledActorScalarFrameV1} from '../scripts/actor-scalar-frame-ir-v1.mjs';

function fixture(cells = 2) {
  return [
    'target triple = "wasm32-unknown-unknown"',
    '@atto.wasm.actor.scalar.frame.v1 = internal global [' + cells + ' x i64] zeroinitializer, align 8',
    '%f = getelementptr inbounds [' + cells + ' x i64], ptr @atto.wasm.actor.scalar.frame.v1, i32 0, i32 0',
    ...Array.from({length: 2 * cells}, () => 'store volatile i64 0, ptr %f, align 8')
  ].join('\n');
}

test('M2 contract admits exactly one bounded frame with init/scrub stores', () => {
  assert.deepEqual(assertCompiledActorScalarFrameV1(fixture()), {
    actorFrameAbi: 'atto-wasm-actor-scalar-frame-v1',
    actorFrameCells: 2, actorFrameBytes: 16
  });
  assert.deepEqual(assertCompiledActorScalarFrameV1(fixture(17)).actorFrameBytes, 136);
});

test('M2 contract rejects unbounded, forged or duplicated actor frame globals', () => {
  assert.throws(() => assertCompiledActorScalarFrameV1(fixture(18)), /exceeds fixed/);
  assert.throws(() => assertCompiledActorScalarFrameV1(fixture(1)), /exceeds fixed/);
  assert.throws(() => assertCompiledActorScalarFrameV1(fixture() + '\n' +
    '@atto.wasm.actor.scalar.frame.v1 = internal global [2 x i64] zeroinitializer'),
    /ambiguous/);
  assert.throws(() => assertCompiledActorScalarFrameV1(
    fixture().replace('internal global', 'external global')), /missing/);
});

test('M2 contract rejects missing explicit slot and scrub stores', () => {
  assert.throws(() => assertCompiledActorScalarFrameV1(
    fixture().replace(/getelementptr inbounds/g, 'inttoptr')), /lacks explicit/);
  assert.throws(() => assertCompiledActorScalarFrameV1(
    fixture().replace(/store volatile i64/g, 'store i64')), /incomplete/);
});

test('M2 contract rejects native message alloca fallback', () => {
  assert.throws(() => assertCompiledActorScalarFrameV1(
    fixture() + '\n%message.slot = alloca i64'), /engine-stack/);
});

test('M2 contract fails closed on invalid and unbounded IR inputs', () => {
  for (const input of [null, undefined, '', new Uint8Array(1), 'x'.repeat(2 * 1024 * 1024 + 1)])
    assert.throws(() => assertCompiledActorScalarFrameV1(input), /bounded source LLVM IR required/);
});
