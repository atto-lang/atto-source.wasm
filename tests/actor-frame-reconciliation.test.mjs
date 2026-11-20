import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorArena} from '../src/actor-arena.mjs';
import {withManagedActorTurn} from '../src/pooled-actor-frame-turn.mjs';
import {makeActorFrameReceipt, assertActorFrameReceipt} from '../src/actor-frame-quiescence.mjs';

test('canonical #415 receipt accepts only complete, exact operation-specific quiescence', () => {
  assert.equal(assertActorFrameReceipt(makeActorFrameReceipt(), 'init'), true);
  assert.equal(assertActorFrameReceipt(makeActorFrameReceipt(), 'send'), true);
  assert.equal(assertActorFrameReceipt(makeActorFrameReceipt(true), 'stop'), true);
  for (const operation of ['init', 'send', 'stop']) {
    const correct = makeActorFrameReceipt(operation === 'stop');
    for (const key of Object.keys(correct)) {
      const missing = {...correct};
      delete missing[key];
      assert.throws(() => assertActorFrameReceipt(missing, operation), /receipt/);
      const accessor = {...correct};
      Object.defineProperty(accessor, key, {enumerable: true,
        get() {throw Error('untrusted receipt getter');}});
      assert.throws(() => assertActorFrameReceipt(accessor, operation), /receipt/);
    }
    for (const [key, replacement] of [
      ['schemaVersion', 0], ['authority', 'actor-frame-ledger-v0'],
      ['frameBytes', 64], ['activeExecutions', 1],
      ['frameBytesInUse', 1], ['retired', operation !== 'stop']
    ]) assert.throws(() => assertActorFrameReceipt({...correct, [key]: replacement}, operation), /receipt/);
    assert.throws(() => assertActorFrameReceipt({...correct, unexpected: true}, operation), /receipt/);
    assert.throws(() => assertActorFrameReceipt(Object.assign(Object.create({inherited: 1}), correct), operation),
      /receipt/);
  }
  assert.throws(() => assertActorFrameReceipt(makeActorFrameReceipt(), 'resume'), /operation/);
  assert.throws(() => assertActorFrameReceipt(null, 'send'), /receipt/);
  assert.throws(() => makeActorFrameReceipt(1), /retirement/);
});

test('one actor-owned #415 arena fences turns and rejects #416 bare-ACK-style suspension', () => {
  const a = new ActorArena({actorId: 801, incarnation: 1});
  const b = new ActorArena({actorId: 802, incarnation: 1});
  const opened = withManagedActorTurn(a, () => undefined);
  assertActorFrameReceipt(opened.frame, 'init');
  for (let n = 0; n < 256; n++) {
    const handled = withManagedActorTurn(a, () => BigInt(n) + 2n,
      {input: BigInt(n), resultType: 'i64'});
    assert.equal(handled.value, BigInt(n) + 2n);
    assertActorFrameReceipt(handled.frame, 'send');
    assert.throws(() => assertActorFrameReceipt(handled.frame, 'stop'), /receipt/);
  }
  assert.throws(() => withManagedActorTurn(a, () => {
    withManagedActorTurn(a, () => 9n, {resultType: 'i64'});
  }), /already admitted/);
  assert.throws(() => withManagedActorTurn(a, () => {throw Error('guest trap');}), /guest trap/);
  assert.throws(() => withManagedActorTurn(a, () => Promise.resolve(1n), {resultType:'i64'}),
    /suspending guest frame is unsupported/);
  assert.throws(() => withManagedActorTurn(a, () => 4n), /void actor guest/);
  assert.throws(() => withManagedActorTurn(a, () => 4, {resultType: 'i64'}), /signed i64/);
  assert.throws(() => withManagedActorTurn(a, () => undefined, {input: 2}), /signed i64/);
  assert.throws(() => withManagedActorTurn(a, () => undefined, {resultType: 'suspend'}), /unsupported/);
  // Failed, reentrant and suspended attempts must never strand a physical turn.
  assert.equal(withManagedActorTurn(a, () => 5n,
    {input: -2n, resultType: 'i64'}).value, 5n);
  assert.equal(withManagedActorTurn(b, () => 7n, {resultType: 'i64'}).value, 7n);
  a.retire();
  b.retire();
  assert.throws(() => withManagedActorTurn(a, () => undefined), /retired/);
});
