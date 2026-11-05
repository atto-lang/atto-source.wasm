import test from 'node:test';
import assert from 'node:assert/strict';
import {flattenFuture} from '../src/wrapper-flatten-host.mjs';

test('aborting an observer does not cancel a shared pending producer', async () => {
  let finish;
  const source = new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  const cancelled = new Error('observer revoked');
  const observation = flattenFuture(source, {signal: controller.signal});
  controller.abort(cancelled);
  await assert.rejects(observation, error => error === cancelled);
  finish('producer-completed');
  assert.equal(await source, 'producer-completed');
  assert.equal(await flattenFuture(source), 'producer-completed');
});

test('aborting after a fulfilled observation cannot replace its value', async () => {
  const controller = new AbortController();
  const token = Object.freeze({id: 7});
  const observation = flattenFuture(Promise.resolve(token), {signal: controller.signal});
  assert.strictEqual(await observation, token);
  controller.abort(new Error('too late'));
  assert.strictEqual(await observation, token);
});

test('pre-aborted observers reject with an AbortError when no reason is supplied', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(flattenFuture(Promise.resolve(5), {signal: controller.signal}),
    error => error?.name === 'AbortError');
  assert.throws(() => flattenFuture(Promise.resolve(1), {signal: {aborted: true}}),
    /AbortSignal required/);
});
