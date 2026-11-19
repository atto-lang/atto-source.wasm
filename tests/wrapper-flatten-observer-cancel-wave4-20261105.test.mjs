import test from 'node:test';
import assert from 'node:assert/strict';
import {flattenFuture} from '../src/wrapper-flatten-host.mjs';

test('unaborted observer resolves to the original producer value', async () => {
  const value = Object.freeze({id:'owned'});
  assert.strictEqual(await flattenFuture(Promise.resolve(value)), value);
  assert.strictEqual(await flattenFuture(Promise.resolve(0), {signal:new AbortController().signal}), 0);
});

test('already aborted observer rejects but never cancels the shared producer', async () => {
  const controller = new AbortController();
  const reason = new Error('observer cancelled');
  controller.abort(reason);
  const producer = Promise.resolve(71);
  await assert.rejects(flattenFuture(producer, {signal:controller.signal}), error => error === reason);
  assert.equal(await producer, 71);
});

test('abort during pending producer detaches only the observer', async () => {
  let resolveProducer;
  const producer = new Promise(resolve => {resolveProducer=resolve;});
  const controller = new AbortController();
  const observer = flattenFuture(producer, {signal:controller.signal});
  const reason = new Error('cancel the observer');
  controller.abort(reason);
  await assert.rejects(observer, error => error === reason);
  resolveProducer('still available');
  assert.equal(await producer, 'still available');
});

test('non-Promise and forged AbortSignal inputs fail closed', () => {
  assert.throws(() => flattenFuture({then() {throw Error('unexpected then');}}), /Promise required/);
  assert.throws(() => flattenFuture(Promise.resolve(1), {signal:{aborted:false}}), /AbortSignal required/);
});
