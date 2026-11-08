import test from 'node:test';
import assert from 'node:assert/strict';
import {BatchedCooperationMeter} from '../src/batched-cooperation.mjs';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';

test('slow checkpoint is never executed on nonboundary iterations', () => {
  for (const interval of [128, 512]) {
    const meter = new BatchedCooperationMeter(interval);
    const polls = [];
    for (let i = 1; i <= 4096; ++i) {
      const due = meter.commit_batch(1, notice => polls.push(notice));
      assert.equal(due, i % interval === 0);
    }
    assert.equal(polls.length, 4096 / interval);
    assert.equal(polls[0].completed, interval);
    assert.equal(polls.at(-1).completed, 4096);
    assert.equal(polls.at(-1).overdue, true);
    assert.equal(meter.completed, 4096);
  }
});

test('overdue work does not switch to checking every iteration', () => {
  const meter = new BatchedCooperationMeter();
  let polls = 0;
  for (let i = 0; i < 640; ++i) {
    const due = meter.commit_batch(1, ({overdue}) => {
      ++polls;
      assert.equal(overdue, i + 1 >= 512);
    });
    if (i >= 512 && i < 639) assert.equal(due, false);
  }
  assert.equal(polls, 5);
});

test('bounded batch crossing one phase boundary polls exactly once', () => {
  const meter = new BatchedCooperationMeter(128);
  let polls = 0;
  const poll = () => {polls++;};
  meter.commit_batch(127, poll);
  assert.equal(polls, 0);
  meter.commit_batch(128, poll);
  assert.equal(polls, 1);
  assert.equal(meter.phase, 127);
  meter.commit_batch(1, poll);
  assert.equal(polls, 2);
  assert.equal(meter.phase, 0);
});

test('invalid work and callbacks fail before altering counters', () => {
  assert.throws(() => new BatchedCooperationMeter(1), RangeError);
  const meter = new BatchedCooperationMeter();
  for (const n of [0, -1, 129, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER])
    assert.throws(() => meter.commit_batch(n, () => {}), RangeError);
  assert.throws(() => meter.commit_batch(1), TypeError);
  assert.equal(meter.completed, 0);
});

test('dispatch reset and actor state are independent', () => {
  const a = new BatchedCooperationMeter();
  const b = new BatchedCooperationMeter();
  let calls = 0;
  a.commit_batch(128, () => calls++);
  b.commit_batch(127, () => calls++);
  assert.equal(calls, 1);
  a.begin_dispatch();
  assert.equal(a.completed, 0);
  assert.equal(a.phase, 0);
  assert.equal(b.phase, 127);
  b.commit_batch(1, () => calls++);
  assert.equal(calls, 2);
});


test('checkpoint callbacks cannot recursively charge or reset their own dispatch', () => {
  const meter = new BatchedCooperationMeter();
  let seen = 0;
  meter.commit_batch(128, receipt => {
    seen++;
    assert.ok(Object.isFrozen(receipt), 'receipt is an immutable snapshot');
    assert.throws(() => meter.commit_batch(1, () => {}), /reentrant cooperation charge/);
    assert.throws(() => meter.begin_dispatch(), /reentrant cooperation dispatch reset/);
    assert.equal(meter.completed, 128);
    assert.equal(meter.phase, 0);
  });
  assert.equal(seen, 1);
  meter.commit_batch(127, () => {throw new Error('premature poll');});
  assert.equal(seen, 1);
  meter.commit_batch(1, () => {seen++;});
  assert.equal(seen, 2);
});

test('a throwing slow-path callback cannot replay the same checkpoint', () => {
  const meter = new BatchedCooperationMeter();
  assert.throws(() => meter.commit_batch(128, () => { throw Error('scheduler exception'); }),
    /scheduler exception/);
  assert.equal(meter.completed, 128);
  assert.equal(meter.phase, 0);
  let polls = 0;
  meter.commit_batch(127, () => {polls++;});
  assert.equal(polls, 0);
  meter.commit_batch(1, () => {polls++;});
  assert.equal(polls, 1);
});

test('seeded differential batch sizes preserve exact work/phase boundaries', () => {
  for (const interval of [128, 512]) {
    const meter = new BatchedCooperationMeter(interval);
    let seed = 0x12345678;
    let total = 0, count = 0;
    for (let i = 0; i < 10000; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const work = (seed >>> 0) % interval + 1;
      const before = total;
      const due = meter.commit_batch(work, ({completed, overdue}) => {
        count++;
        assert.equal(completed, before + work);
        assert.equal(overdue, completed >= 512);
      });
      total += work;
      assert.equal(due, Math.floor(total / interval) !== Math.floor(before / interval));
      assert.equal(meter.completed, total);
      assert.equal(meter.phase, total % interval);
    }
    assert.equal(count, Math.floor(total / interval));
  }
});

test('unimplemented Wasm guest checkpoint options fail closed before worker creation', async () => {
  // A host-side batching meter must not be accepted as proof that a raw
  // wasm32 guest was instrumented. No input is compiled by these negatives.
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  await assert.rejects(
    runIsolatedCoreGuest(bytes, {checkpointInterval: 128}),
    /unknown guest runner option/
  );
  await assert.rejects(
    runIsolatedCoreGuest(bytes, {actorPhysicalTurns: 1}),
    /unknown guest runner option/
  );
});


test('asynchronous checkpoint callback cannot silently pretend to yield', () => {
  const meter = new BatchedCooperationMeter();
  assert.throws(
    () => meter.commit_batch(128, () => Promise.resolve('not a synchronous handoff')),
    /asynchronous checkpoint callback unsupported/
  );
  assert.equal(meter.completed, 128); // account remains committed on rejection
  assert.equal(meter.phase, 0);
  let later = 0;
  meter.commit_batch(127, () => {later++;});
  assert.equal(later, 0);
  meter.commit_batch(1, () => {later++;});
  assert.equal(later, 1);
});


test('external callers cannot raise or suppress the fixed 512-work threshold', () => {
  assert.ok(Object.isFrozen(BatchedCooperationMeter));
  assert.equal(BatchedCooperationMeter.DISPATCH_BUDGET, 512);
  assert.throws(() => {BatchedCooperationMeter.DISPATCH_BUDGET = 1_000_000;}, TypeError);
  assert.throws(() => Object.defineProperty(BatchedCooperationMeter, 'DISPATCH_BUDGET', {value: -1}),
    TypeError);
  const meter = new BatchedCooperationMeter();
  let count = 0;
  for (let i = 0; i < 512; ++i)
    meter.commit_batch(1, ({overdue}) => {
      count++;
      assert.equal(overdue, i >= 511);
    });
  assert.equal(count, 4);
});
