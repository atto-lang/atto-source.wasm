import test from 'node:test';
import assert from 'node:assert/strict';
import {flattenFuture} from '../src/wrapper-flatten-host.mjs';

test('already-aborted observer rejects with exact reason without cancelling producer',async()=>{
  const cancel=new Error('observer stopped');
  const controller=new AbortController();controller.abort(cancel);
  let release;const producer=new Promise(resolve=>{release=resolve;});
  await assert.rejects(flattenFuture(producer,{signal:controller.signal}),e=>e===cancel);
  release('producer live');
  assert.equal(await producer,'producer live');
});
test('aborting a live observer does not change shared producer resolution',async()=>{
  const controller=new AbortController();let resolve;
  const producer=new Promise(r=>{resolve=r;});
  const view=flattenFuture(producer,{signal:controller.signal});
  const reason=new Error('cancelled');
  controller.abort(reason);
  await assert.rejects(view,e=>e===reason);
  resolve(41);
  assert.equal(await producer,41);
});
test('successful observer remains settled after late abort',async()=>{
  const controller=new AbortController();
  const view=flattenFuture(Promise.resolve(42),{signal:controller.signal});
  assert.equal(await view,42);
  controller.abort(new Error('too late'));
  assert.equal(await view,42);
});
test('invalid cancellation authority cannot be passed as a plain object',()=>{
  assert.throws(()=>flattenFuture(Promise.resolve(1),{signal:{aborted:false}}),/AbortSignal required/);
});