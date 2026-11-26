import test from 'node:test';
import assert from 'node:assert/strict';
import {MonotonicIdentityV1} from '../src/monotonic-identity-v1.mjs';

test('100000 fresh identities and independent counters', () => {
  const actor = new MonotonicIdentityV1(), ticket = new MonotonicIdentityV1();
  for (let i = 1; i <= 100000; i++) {
    assert.equal(actor.issue(), i);
    assert.equal(ticket.issue(), 2*i-1);
    assert.equal(ticket.issue(), 2*i);
  }
});

test('last safe identity is issued once and exhaustion never wraps', () => {
  const counter = new MonotonicIdentityV1(Number.MAX_SAFE_INTEGER-2);
  assert.equal(counter.issue(), Number.MAX_SAFE_INTEGER-1);
  assert.equal(counter.issue(), Number.MAX_SAFE_INTEGER);
  for (let i = 0; i < 1000; i++) assert.equal(counter.issue(), null);
  for (const n of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER+1, '1'])
    assert.throws(() => new MonotonicIdentityV1(n), RangeError);
});
