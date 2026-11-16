import test from 'node:test';
import assert from 'node:assert/strict';
import {DurableLockQueues} from '../src/durable-lock-queues.mjs';
const enq = (q, lockId, operationId, actorId = 3, bytes = 4, actorGeneration = 1) =>
  q.enqueue({actorId, actorGeneration, lockId, operationId, bytes});

test('tenant-scoped FIFO, actor non-reentrancy, finish and cancellation', () => {
  const a = new DurableLockQueues(1, {maxLocks: 2, maxEntries: 5, maxPerLock: 3, maxBytes: 20});
  const b = new DurableLockQueues(2);
  const one = enq(a, 7, 1); const two = enq(a, 7, 2);
  const other = enq(a, 9, 3); const differentTenant = enq(b, 7, 1);
  assert.equal(one.head, true); assert.equal(two.head, false); assert.equal(other.head, true);
  assert.throws(() => a.claim(differentTenant.ticket), /foreign/);
  assert.throws(() => a.claim(two.ticket), /FIFO/);
  assert.throws(() => a.finish(one.ticket), /unclaimed/);
  assert.equal(a.claim(one.ticket), true); assert.equal(a.claim(other.ticket), false);
  assert.throws(() => a.cancelHead(one.ticket), /claimed/);
  assert.equal(a.finish(one.ticket), two.ticket);
  assert.equal(a.claim(other.ticket), true); assert.equal(a.claim(two.ticket), false);
  assert.equal(a.finish(other.ticket), null);
  assert.equal(a.claim(two.ticket), true);
  assert.equal(a.finish(two.ticket), null);
  assert.throws(() => a.claim(one.ticket), /stale/);
  assert.equal(a.snapshot().entries, 0);
  const again = enq(a, 7, 1); const waiting = enq(a, 7, 2);
  a.cancelWaiter(waiting.ticket);
  assert.equal(a.cancelHead(again.ticket), null);
  assert.equal(a.snapshot().entries, 0);
  assert.equal(b.claim(differentTenant.ticket), true);
  assert.equal(b.finish(differentTenant.ticket), null);
});

test('atomic quota rejection, generation/identity and shutdown gates', () => {
  const q = new DurableLockQueues(6, {maxLocks: 1, maxEntries: 2, maxPerLock: 2, maxBytes: 6});
  const first = enq(q, 4, 1, 1, 4);
  assert.throws(() => enq(q, 5, 2, 2, 1), /capacity/);
  assert.throws(() => enq(q, 4, 2, 2, 4), /capacity/);
  assert.throws(() => enq(q, 4, 1, 1, 1), /duplicate/);
  assert.deepEqual(q.snapshot().entries, 1);
  assert.throws(() => q.claim({...first.ticket}), /foreign/);
  assert.equal(q.hasActor(1,1), true);
  const next = enq(q,4,2,2,1);
  assert.equal(q.cancelHead(first.ticket), next.ticket);
  assert.equal(q.hasActor(1,1), false);
  q.quiesce();
  assert.equal(q.drained, false);
  assert.throws(() => q.claim(next.ticket), /quiescing/);
  assert.throws(() => enq(q, 4, 3), /quiescing/);
  assert.equal(q.cancelHead(next.ticket), null);
  assert.equal(q.drained, true);
});

test('independent actors may claim separate lock heads', () => {
  const q = new DurableLockQueues(8);
  const a = enq(q, 1, 1, 4);
  const b = enq(q, 2, 2, 5);
  assert.equal(q.claim(a.ticket), true);
  assert.equal(q.claim(b.ticket), true);
  assert.equal(q.snapshot().runningActors, 2);
  q.finish(a.ticket); q.finish(b.ticket);
});
