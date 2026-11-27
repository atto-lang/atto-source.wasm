import test from 'node:test';
import assert from 'node:assert/strict';
import {createStateRuntime} from '../src/browser-scalar-state-runtime.mjs';

test('retire and successful completion are one-shot notifications',()=>{
  const events=[];const rt=createStateRuntime({onEvent:e=>events.push(e.kind)});
  rt.imports.state_register(0); const t=rt.imports.state_enter(0,0);
  rt.beginRetire(0);rt.beginRetire(0);
  assert.equal(rt.quiescent(0),false);
  rt.imports.state_leave(t);rt.complete();rt.complete();rt.abort();
  assert.deepEqual(events,['register','enter','retire','leave','complete']);
  assert.equal(rt.snapshot().quiescent,true);
});
test('aborted runtime never reports successful completion',()=>{
  const events=[];const rt=createStateRuntime({onEvent:e=>events.push(e.kind)});
  rt.imports.state_register(0);const t=rt.imports.state_enter(0,1);
  rt.abort();rt.abort();assert.throws(()=>rt.complete(),/aborted/);
  assert.throws(()=>rt.imports.state_leave(t),/replayed/);
  assert.deepEqual(events,['register','enter','abort']);
  assert.equal(rt.quiescent(0),true);
});
test('failed complete does not terminalize live runtime',()=>{
  const events=[];const rt=createStateRuntime({onEvent:e=>events.push(e.kind)});
  rt.imports.state_register(0);const t=rt.imports.state_enter(0,1);
  assert.throws(()=>rt.complete(),/unreleased/);assert.equal(rt.snapshot().retired,false);
  rt.imports.state_leave(t);rt.complete();assert.equal(rt.snapshot().quiescent,true);
  assert.deepEqual(events,['register','enter','leave','complete']);
});
test('signed i32 state pointer bounds preserve ledger',()=>{
  const rt=createStateRuntime({maxContainers:2,maxTickets:1});
  const {state_register:reg,state_enter:enter,state_leave:leave}=rt.imports;
  const before=rt.snapshot();
  for(const ptr of [0x80000000,0xfffffff8,0x100000000,2**53,Infinity,NaN,-8,1.5,'8',8n]){
    assert.throws(()=>reg(ptr),/invalid state pointer/);
    assert.throws(()=>enter(ptr,0),/unknown state container/);
    assert.throws(()=>rt.beginRetire(ptr),/unknown state container/);
    assert.throws(()=>rt.quiescent(ptr),/unknown state container/);
    assert.deepEqual(rt.snapshot(),before);
  }
  reg(0);reg(0x7ffffff8);
  const t=enter(0x7ffffff8,1);leave(t);rt.complete();
  assert.equal(rt.snapshot().quiescent,true);
});
