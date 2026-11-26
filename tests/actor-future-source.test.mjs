// Source-contract only. The real compiler must admit/reject the .atto fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const future = readFileSync(new URL('../stdlib/actor/future.atto', import.meta.url), 'utf8');
const positive = readFileSync(new URL('../contracts/std-actor-v1/future-owned.accept.atto', import.meta.url), 'utf8');
const negative = readFileSync(new URL('../contracts/std-actor-v1/future-borrowed.reject.atto', import.meta.url), 'utf8');
const doubleAwait = readFileSync(new URL('../contracts/std-actor-v1/future-double-await.reject.atto', import.meta.url), 'utf8');
test('ActorFuture is sealed, affine and namespace-owned, never user-constructed', () => {
  assert.match(future, /use namespace std\.actor;/);
  assert.match(future, /pub susp fnc await_reply<T>\(take! ActorFuture<T> receipt\) -> T/);
  assert.match(future, /take! ActorFuture<Result<T,E>> receipt\) -> Result<T,E>/);
  assert.equal((future.match(/return await receipt;/g) || []).length, 2);
  assert.doesNotMatch(future, /\bdefine\s+(?:pub\s+)?(?:module|class)\s+(?:ActorFuture|actor)\b|\bnew ActorFuture\b/);
  assert.match(positive, /take! ActorFuture<int>/);
  assert.match(negative, /reject_borrowed_reply\(ActorFuture<int> receipt\)/);
  assert.equal((doubleAwait.match(/await receipt/g) || []).length, 2);
});
