import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {flattenFuture} from '../src/wrapper-flatten-host.mjs';

test('synthetic abort event cannot revoke an observer', async () => {
  const controller = new AbortController();
  let complete;
  const producer = new Promise(resolve => { complete = resolve; });
  const observed = flattenFuture(producer, {signal: controller.signal});
  controller.signal.dispatchEvent(new Event('abort'));
  assert.equal(controller.signal.aborted, false);
  complete(42);
  assert.equal(await observed, 42);
});

test('synthetic events do not consume the real cancellation listener', async () => {
  const controller = new AbortController();
  let complete;
  const producer = new Promise(resolve => { complete = resolve; });
  const observed = flattenFuture(producer, {signal: controller.signal});
  controller.signal.dispatchEvent(new Event('abort'));
  controller.signal.dispatchEvent(new Event('abort'));
  const reason = new Error('real cancellation');
  controller.abort(reason);
  complete(42); // A lost abort listener must resolve incorrectly, never hang.
  await assert.rejects(observed, error => error === reason);
  assert.equal(await producer, 42);
});

for (const timing of ['before', 'after']) {
  for (const reason of [null, 0, false, '']) {
    test(`${timing} registration cancellation preserves ${JSON.stringify(reason)}`, async () => {
      const controller = new AbortController();
      if (timing === 'before') controller.abort(reason);
      const observed = flattenFuture(Promise.resolve(42), {signal: controller.signal});
      if (timing === 'after') controller.abort(reason);
      await assert.rejects(observed, error => Object.is(error, reason));
    });
  }
}

test('late cancellation cannot replace an observed successful result', async () => {
  const controller = new AbortController();
  const observed = flattenFuture(Promise.resolve(42), {signal: controller.signal});
  assert.equal(await observed, 42);
  controller.abort(new Error('too late'));
  assert.equal(await observed, 42);
});

for (const outcome of ['success', 'failure', 'cancel']) {
  test(`${outcome} removes the observer listener after synthetic events`, async () => {
    const controller = new AbortController();
    let complete, fail;
    const producer = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    const observed = flattenFuture(producer, {signal: controller.signal});
    controller.signal.dispatchEvent(new Event('abort'));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    if (outcome === 'success') {
      complete(42);
      assert.equal(await observed, 42);
    } else {
      const reason = new Error(outcome);
      if (outcome === 'cancel') controller.abort(reason);
      else fail(reason);
      await assert.rejects(observed, error => error === reason);
      if (outcome === 'cancel') complete(42);
    }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}
