import test from 'node:test';
import assert from 'node:assert/strict';
import {createStateRuntime} from '../src/browser-scalar-state-runtime.mjs';
test('independent reader counts, exclusivity and retired generation checks',()=>{
  const rt=createStateRuntime({maxContainers:64,maxTickets:64});
  const {state_register:reg,state_enter:enter,state_leave:leave}=rt.imports;
  for(let i=1;i<=32;i++)reg(i*8);
  const reads=Array.from({length:32},(_,i)=>enter((i+1)*8,0));
  const second=enter(8,0);
  assert.throws(()=>enter(8,1),/contention/);
  leave(reads[0]);
  assert.throws(()=>enter(8,1),/contention/);
  leave(second);
  const w=enter(8,1);
  assert.throws(()=>enter(8,0),/contention/);
  assert.throws(()=>enter(8,1),/contention/);
  rt.beginRetire(8);
  assert.equal(rt.quiescent(8),false);
  leave(w);
  assert.equal(rt.quiescent(8),true);
  assert.throws(()=>leave(w),/replayed/);
  assert.throws(()=>enter(8,0),/retired/);
  for(const ticket of reads.slice(1))leave(ticket);
  rt.complete();
  assert.equal(rt.snapshot().active,0);
  assert.equal(rt.snapshot().quiescent,true);
});
test('abort clears per-container counters, stale tickets and foreign authority',()=>{
  const a=createStateRuntime(),b=createStateRuntime();
  a.imports.state_register(8);a.imports.state_register(16);b.imports.state_register(8);
  const r=a.imports.state_enter(8,0),w=a.imports.state_enter(16,1);
  const foreign=b.imports.state_enter(8,1);
  assert.throws(()=>a.imports.state_leave(foreign),/missing or replayed/);
  assert.throws(()=>a.complete(),/unreleased/);
  a.abort();
  for(const ptr of [8,16])assert.equal(a.quiescent(ptr),true);
  for(const ticket of [r,w])assert.throws(()=>a.imports.state_leave(ticket),/replayed/);
  assert.equal(a.snapshot().active,0);
  assert.equal(b.snapshot().active,1);
  b.imports.state_leave(foreign);b.complete();
});
test('bounded deterministic differential ledger under mixed admission and release',()=>{
  const rt=createStateRuntime({maxContainers:16,maxTickets:64});
  const model=Array.from({length:16},()=>({r:0,w:false}));
  const tickets=[];
  for(let i=0;i<16;i++)rt.imports.state_register(i*8);
  let rng=123456789;
  const rand=()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng;};
  for(let step=0;step<10000;step++){
    if(tickets.length&&(rand()>>>16)%3===0){
      const index=(rand()>>>8)%tickets.length;
      const [{ticket,i,mode}]=tickets.splice(index,1);
      rt.imports.state_leave(ticket);
      if(mode)model[i].w=false;else model[i].r--;
    }else{
      const i=(rand()>>>8)%16,mode=(rand()>>>16)%2,m=model[i];
      if(tickets.length===64||m.w||(mode&&m.r)){
        assert.throws(()=>rt.imports.state_enter(i*8,mode),/capacity|contention/);
      }else{
        tickets.push({ticket:rt.imports.state_enter(i*8,mode),i,mode});
        if(mode)m.w=true;else m.r++;
      }
    }
    assert.equal(rt.snapshot().active,tickets.length);
  }
  for(const {ticket} of tickets)rt.imports.state_leave(ticket);
  rt.complete();assert.equal(rt.snapshot().quiescent,true);
});
