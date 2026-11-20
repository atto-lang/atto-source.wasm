import test from 'node:test';
import assert from 'node:assert/strict';
import {ACTOR_FRAME_PROFILES, assertActorFrameProfile} from '../scripts/actor-frame-profile.mjs';
import {compileSourceActorToWasm} from '../scripts/compile-source-actor.mjs';

const {SCALAR, STACK64} = ACTOR_FRAME_PROFILES;
const scalarIR = n => [
  'target triple = "wasm32-unknown-unknown"',
  '@atto.wasm.actor.scalar.frame.v1 = internal global [' + n + ' x i64] zeroinitializer',
  'define i64 @oreslang_wasm_actor_on_message(i64 %input) {',
  'entry:',
  ...Array.from({length:n}, (_, i) => '  %slot' + i +
    ' = getelementptr inbounds [' + n +
    ' x i64], ptr @atto.wasm.actor.scalar.frame.v1, i32 0, i32 ' + i),
  ...Array.from({length:n}, (_, i) => '  store volatile i64 9, ptr %slot' + i),
  ...Array.from({length:n}, (_, i) => '  store volatile i64 0, ptr %slot' + i),
  '  ret i64 0',
  '}',
  ''
].join('\n');
const stackIR = [
  'target triple = "wasm32-unknown-unknown"',
  '@oreslang.wasm.actor.frame.slots = internal global [64 x i64] zeroinitializer',
  '@oreslang.wasm.actor.frame.depth = internal global i64 0',
  'define void @atto.actor.guest.frame.denied() { ret void }',
  'define void @atto.actor.guest.frames.clean() { ret void }',
  'define i64 @oreslang_wasm_actor_on_message(i64 %n) {',
  '  %slot = getelementptr inbounds [64 x i64], ptr @oreslang.wasm.actor.frame.slots, i32 0, i32 0',
  '  store volatile i64 0, ptr %slot',
  '  ret i64 %n',
  '}'
].join('\n');

test('two explicit, noninterchangeable compiler frame profiles are admitted', () => {
  for (const n of [2, 5, 17]) {
    const got = assertActorFrameProfile(scalarIR(n), SCALAR);
    assert.deepEqual(got, {actorFrameProfile: SCALAR, actorFrameCells: n});
    assert.equal(Object.isFrozen(got), true);
  }
  assert.deepEqual(assertActorFrameProfile(stackIR, STACK64),
    {actorFrameProfile: STACK64, actorFrameCells: 64});
  assert.throws(() => assertActorFrameProfile(stackIR, SCALAR), /scalar frame/);
  assert.throws(() => assertActorFrameProfile(scalarIR(5), STACK64), /stack64/);
});

test('mis-sized, competing, comment-only and unclean frames fail closed', () => {
  for (const n of [1, 18, 64])
    assert.throws(() => assertActorFrameProfile(scalarIR(n), SCALAR), /cell budget/);
  assert.throws(() => assertActorFrameProfile(scalarIR(4) + '\n' + stackIR, SCALAR),
    /competing/);
  assert.throws(() => assertActorFrameProfile(';' + scalarIR(4).replaceAll('\n','\n;'), SCALAR),
    /missing/);
  assert.throws(() => assertActorFrameProfile(scalarIR(4).replaceAll('store volatile i64 0,', 'store volatile i64 1,'), SCALAR),
    /zeroization/);
  assert.throws(() => assertActorFrameProfile(
    scalarIR(3).replace('ptr %slot1', 'ptr %unrelated'), SCALAR), /zeroization/);
  assert.throws(() => assertActorFrameProfile(
    scalarIR(3).replace('i32 0, i32 2', 'i32 0, i32 3'), SCALAR), /out of bounds/);
  assert.throws(() => assertActorFrameProfile(scalarIR(4) + '\n%message.slot = alloca i64', SCALAR),
    /alloca/);
  assert.throws(() => assertActorFrameProfile(stackIR.replace('frame.depth', 'frame.depth.deleted'), STACK64),
    /depth/);
  assert.throws(() => assertActorFrameProfile(stackIR.replace('[64 x i64]', '[63 x i64]'), STACK64),
    /stack64/);
  // Regression: LLVM ignores everything after ';' on a code line.
  // Old profile parser incorrectly counted forged volatile stores in comments.
  const commentSpoof = scalarIR(2).split('\\n').map((line, i) =>
    line.includes('store volatile i64')
      ? '  %comment_spoof_' + i + ' = add i64 0, 0 ; ' + line.trim()
      : line).join('\\n');
  assert.throws(() => assertActorFrameProfile(commentSpoof, SCALAR),
    /zeroization|stores incomplete/);
  const stackCommentSpoof = stackIR.replace('store volatile i64 0, ptr %slot',
    '%noop = add i64 0, 0 ; store volatile i64 0, ptr %slot');
  assert.throws(() => assertActorFrameProfile(stackCommentSpoof, STACK64),
    /cleanup evidence missing/);
  assert.throws(() => assertActorFrameProfile(stackIR, 'auto'), /unknown or implicit/);
  assert.throws(() => assertActorFrameProfile('', SCALAR), /bounded/);
  assert.throws(() => assertActorFrameProfile('x'.repeat(2 * 1024 * 1024 + 1), SCALAR), /bounded/);
});

test('profiled source bridge rejects implicit, non-Atto and unpinned compiler inputs before spawn', async () => {
  const common = {compiler: '/invalid/compiler', source: '/invalid/main.atto'};
  await assert.rejects(compileSourceActorToWasm({...common, actorFrameProfile: 'auto'}),
    /unsupported actor frame compiler profile/);
  await assert.rejects(compileSourceActorToWasm({...common, actorFrameProfile: SCALAR}),
    /requires \.atto and pinned native compiler/);
  await assert.rejects(compileSourceActorToWasm({...common, source: '/invalid/main.ores',
    expectedCompilerSha256:'a'.repeat(64), actorFrameProfile: STACK64}),
    /requires \.atto and pinned native compiler/);
});
