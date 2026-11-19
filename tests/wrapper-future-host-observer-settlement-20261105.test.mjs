import test from 'node:test';
import assert from 'node:assert/strict';
import {Some,None,flattenOption,flattenFuture} from '../src/wrapper-flatten-host.mjs';

test('a host future observer resolves without changing the shared producer',async()=>{
  let release;
  const source=new Promise(resolve=>{release=resolve;});
  const observer=flattenFuture(source);
  release('ready');
  assert.equal(await observer,'ready');
  assert.equal(await source,'ready');
});
test('host future observer preserves rejection object identity',async()=>{
  const reason=new Error('producer failure');
  await assert.rejects(flattenFuture(Promise.reject(reason)),error=>error===reason);
});
test('thenable lookalikes cannot run callbacks during nominal Promise admission',()=>{
  let calls=0;
  const fake={then(){calls++;}};
  assert.throws(()=>flattenFuture(fake),/Promise required/);
  assert.equal(calls,0);
});
test('nested branded Options stop at the original unbranded payload',()=>{
  const leaf={tag:'none'};
  const terminal=Some(leaf);
  assert.strictEqual(flattenOption(Some(Some(terminal))),terminal);
  assert.strictEqual(flattenOption(Some(Some(None))),None);
  assert.strictEqual(flattenOption(terminal),terminal);
});