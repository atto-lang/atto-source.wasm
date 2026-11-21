import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCompiledActorScalarFrameV1} from '../scripts/actor-scalar-frame-ir-v1.mjs';

function fixture(cells = 2) {
  return [
    'target triple = "wasm32-unknown-unknown"',
    '@atto.wasm.actor.scalar.frame.v1 = internal global [' + cells + ' x i64] zeroinitializer, align 8',
    'define i64 @oreslang_wasm_actor_on_message(i64 %message) {',
    'entry:',
    ...Array.from({length: cells}, (_, i) =>
      '%frame_' + i + ' = getelementptr inbounds [' + cells +
      ' x i64], ptr @atto.wasm.actor.scalar.frame.v1, i32 0, i32 ' + i),
    ...Array.from({length: cells}, (_, i) =>
      '  store volatile i64 %message, ptr %frame_' + i + ', align 8'),
    ...Array.from({length: cells}, (_, i) =>
      '  store volatile i64 0, ptr %frame_' + i + ', align 8'),
    '  ret i64 0',
    '}'
  ].join('\n');
}

test('M2 verifier accepts bounded frame with per-slot terminal scrub', () => {
  assert.deepEqual(assertCompiledActorScalarFrameV1(fixture()), {
    actorFrameAbi: 'atto-wasm-actor-scalar-frame-v1',
    actorFrameCells: 2, actorFrameBytes: 16
  });
  assert.equal(assertCompiledActorScalarFrameV1(fixture(17)).actorFrameBytes, 136);
});

test('M2 verifier also accepts LLVM constant-expression inline GEP stores', () => {
  const ir = fixture().replaceAll('%frame_0', 'getelementptr inbounds ([2 x i64], ptr @atto.wasm.actor.scalar.frame.v1, i32 0, i32 0)')
    .replaceAll('%frame_1', 'getelementptr inbounds ([2 x i64], ptr @atto.wasm.actor.scalar.frame.v1, i32 0, i32 1)')
    .replace(/^.*= getelementptr inbounds .*\n/gm, '');
  assert.equal(assertCompiledActorScalarFrameV1(ir).actorFrameBytes, 16);
});

test('M2 verifier rejects unbounded, forged, missing or duplicate frame globals', () => {
  assert.throws(() => assertCompiledActorScalarFrameV1(fixture(18)), /exceeds fixed/);
  assert.throws(() => assertCompiledActorScalarFrameV1(fixture(1)), /exceeds fixed/);
  assert.throws(() => assertCompiledActorScalarFrameV1(fixture() + '\n' +
    '@atto.wasm.actor.scalar.frame.v1 = internal global [2 x i64] zeroinitializer'),
    /ambiguous/);
  assert.throws(() => assertCompiledActorScalarFrameV1(
    fixture().replace('internal global', 'external global')), /missing/);
  assert.throws(() => assertCompiledActorScalarFrameV1(
    fixture().replace('define i64 @oreslang_wasm_actor_on_message',
      'declare i64 @oreslang_wasm_actor_on_message')), /message handler missing/);
});

test('M2 verifier rejects missing guest frame slots or unbounded indices', () => {
  assert.throws(() => assertCompiledActorScalarFrameV1(
    fixture().replace(/getelementptr inbounds/g, 'inttoptr')), /lacks explicit/);
  assert.throws(() => assertCompiledActorScalarFrameV1(
    fixture().replace('i32 0, i32 1', 'i32 0, i32 2')), /out of bounds/);
});

test('M2 verifier rejects volatile stores targeting unrelated memory', () => {
  const ir = fixture().replaceAll('ptr %frame_1,', 'ptr %unrelated,');
  assert.throws(() => assertCompiledActorScalarFrameV1(ir), /stores incomplete/);
});

test('M2 verifier rejects omitted or nonterminal zero scrubs', () => {
  assert.throws(() => assertCompiledActorScalarFrameV1(
    fixture().replace(/store volatile i64 0/g, 'store i64 0')), /stores incomplete/);
  assert.throws(() => assertCompiledActorScalarFrameV1(
    fixture().replace('store volatile i64 0, ptr %frame_0',
      'store volatile i64 1, ptr %frame_0')), /stores incomplete/);
});

test('M2 verifier rejects native message alloca fallback', () => {
  assert.throws(() => assertCompiledActorScalarFrameV1(
    fixture() + '\n%message.slot = alloca i64'), /engine-stack/);
});

test('M2 verifier fails closed on invalid and unbounded IR inputs', () => {
  for (const input of [null, undefined, '', new Uint8Array(1), 'x'.repeat(2 * 1024 * 1024 + 1)])
    assert.throws(() => assertCompiledActorScalarFrameV1(input), /bounded source LLVM IR required/);
});
