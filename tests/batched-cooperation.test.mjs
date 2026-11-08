import test from 'node:test';
import assert from 'node:assert/strict';
import {BatchedCooperationMeter} from '../src/batched-cooperation.mjs';

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
