import test from 'node:test';
import assert from 'node:assert/strict';
import {Some,None,flattenOption,flattenFuture} from '../src/wrapper-flatten-host.mjs';

test('cancelling one observer leaves second observer and producer live',async()=>{
  let release;const producer=new Promise(resolve=>{release=resolve;});
  const abort=new AbortController();
  const first=flattenFuture(producer,{signal:abort.signal});
  const second=flattenFuture(producer);
  const reason=new Error('only first observer');
  abort.abort(reason);
  await assert.rejects(first,error=>error===reason);
  release(42);
  assert.equal(await second,42);
  assert.equal(await producer,42);
});
test('two observers preserve one producer rejection identity',async()=>{
  const error=new Error('shared producer');
  const producer=Promise.reject(error);
  await Promise.all([assert.rejects(flattenFuture(producer),e=>e===error),
    assert.rejects(flattenFuture(producer),e=>e===error)]);
});
test('late cancellation never changes already-resolved observer value',async()=>{
  const controller=new AbortController();
  const done=flattenFuture(Promise.resolve('ready'),{signal:controller.signal});
  assert.equal(await done,'ready');
  controller.abort(new Error('late'));
  assert.equal(await done,'ready');
});
test('nominal Option flattening stops at an unbranded lookalike',()=>{
  let reads=0;
  const fake={tag:'some'};
  Object.defineProperty(fake,'value',{get(){reads++;throw Error('untrusted');}});
  const wrapped=Some(Some(fake));
  assert.strictEqual(flattenOption(wrapped).value,fake);
  assert.equal(reads,0);
  assert.strictEqual(flattenOption(Some(Some(None))),None);
});