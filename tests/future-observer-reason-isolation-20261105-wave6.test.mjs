import test from 'node:test';
import assert from 'node:assert/strict';
import {flattenFuture} from '../src/wrapper-flatten-host.mjs';

test('non-Error cancellation reasons retain their identity', async () => {
  const reason = Object.freeze({code:'observer-exit'});
  const controller = new AbortController();
  let producerResolve;
  const producer = new Promise(resolve => { producerResolve = resolve; });
  const observer = flattenFuture(producer, {signal:controller.signal});
  controller.abort(reason);
  await assert.rejects(observer, error => error === reason);
  producerResolve('producer-still-running');
  assert.equal(await producer, 'producer-still-running');
});

test('a rejecting producer forwards the exact rejection subject without reshaping it', async () => {
  const rejected = Object.freeze({tag:'producer-failure'});
  const producer = Promise.reject(rejected);
  await assert.rejects(flattenFuture(producer), error => error === rejected);
});

test('a settled observer is not rewritten by a late abort', async () => {
  const controller = new AbortController();
  const observed = flattenFuture(Promise.resolve(41), {signal:controller.signal});
  assert.equal(await observed, 41);
  controller.abort(Error('too late'));
  assert.equal(await observed, 41);
});
