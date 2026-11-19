import test from 'node:test';
import assert from 'node:assert/strict';
import {Some, None, flattenOption, flattenFuture} from '../src/wrapper-flatten-host.mjs';

test('branded Option flatten preserves the terminal wrapper identity', () => {
  const leaf = Some({id:7});
  assert.strictEqual(flattenOption(Some(Some(leaf))), leaf);
  assert.strictEqual(flattenOption(Some(None)), None);
});

test('an embedded structural lookalike cannot impersonate the Option brand', () => {
  const forged = Object.freeze({tag:'some', value:None});
  const wrapped = Some(forged);
  assert.strictEqual(flattenOption(wrapped), wrapped);
});

test('a fake getter cannot run while membership is rejected', () => {
  let calls=0;
  const forged={};
  Object.defineProperty(forged,'tag',{get(){calls++;throw Error('getter executed');}});
  assert.throws(() => flattenOption(forged), /Option required/);
  assert.equal(calls,0);
});

test('pending observer cancellation does not cancel its shared producer', async () => {
  let resolveProducer;
  const producer = new Promise(resolve => {resolveProducer=resolve;});
  const controller = new AbortController();
  const reason = new Error('only observer cancelled');
  const observed = flattenFuture(producer,{signal:controller.signal});
  controller.abort(reason);
  await assert.rejects(observed, error => error === reason);
  resolveProducer(42);
  assert.equal(await producer,42);
});

test('pre-aborted observer rejects with its original reason', async () => {
  const controller=new AbortController();
  const reason=new Error('pre-aborted');
  controller.abort(reason);
  await assert.rejects(flattenFuture(Promise.resolve(3),{signal:controller.signal}),
                       error => error === reason);
});

test('late abort after producer settlement cannot change the settled value', async () => {
  const controller=new AbortController();
  const observed=flattenFuture(Promise.resolve('value'),{signal:controller.signal});
  assert.equal(await observed,'value');
  controller.abort(new Error('too late'));
  assert.equal(await observed,'value');
});
