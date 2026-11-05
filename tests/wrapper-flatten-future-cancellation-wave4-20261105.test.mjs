import test from 'node:test';
import assert from 'node:assert/strict';
import {Some,None,flattenOption,flattenFuture} from '../src/wrapper-flatten-host.mjs';

test('cancelling a future observer does not cancel its shared producer',async()=>{
  let resolveProducer;
  const producer=new Promise(resolve=>{resolveProducer=resolve;});
  const controller=new AbortController();
  const cancelled=new Error('observer cancelled');
  const observer=flattenFuture(producer,{signal:controller.signal});
  controller.abort(cancelled);
  await assert.rejects(observer,error=>error===cancelled);
  resolveProducer(42);
  assert.equal(await producer,42);
});

test('already-aborted observer denies without awaiting producer',async()=>{
  const controller=new AbortController();
  controller.abort(new Error('already cancelled'));
  await assert.rejects(flattenFuture(Promise.resolve(7),{signal:controller.signal}),
    /already cancelled/);
});

test('settled observer retains producer identity and settles exactly once',async()=>{
  const leaf=Object.freeze({answer:42});
  const controller=new AbortController();
  const observed=flattenFuture(Promise.resolve(leaf),{signal:controller.signal});
  assert.strictEqual(await observed,leaf);
  controller.abort(new Error('late abort'));
  assert.strictEqual(await observed,leaf);
});

test('forged Option wrappers and malformed future controls fail closed',()=>{
  assert.throws(()=>flattenOption({tag:'some',value:None}),/Option required/);
  const inner=Some({value:1});
  assert.strictEqual(flattenOption(Some(Some(inner))),inner);
  assert.throws(()=>flattenFuture({then() {}}),/Promise required/);
  assert.throws(()=>flattenFuture(Promise.resolve(1),{signal:{}}),/AbortSignal required/);
});
