import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createTimeJspiBoundary} from '../src/stdlib-time-jspi.mjs';

class FakeSuspending {
  constructor(fn){return fn;}
}
function fakeClock({initial=0n,capacity=2,scheduleFails=false}={}){
  let time=initial,id=0;
  const events=new Map();
  const host=createTimeJspiBoundary({
    Suspending:FakeSuspending,
    now_ns:()=>time,
    max_pending:capacity,
    register:(fn,ms)=>{
      if(scheduleFails)throw Error('schedule failed');
      const key=++id;events.set(key,{fn,ms});return key;
    },
    unregister:key=>events.delete(key)
  });
  return {
    host,events,
    set(value){time=value;},
    delays(){return [...events.values()].map(e=>e.ms);},
    wake(value){
      time=value;
      const [key,event]=events.entries().next().value??[];
      assert.ok(event,'expected timer event');
      events.delete(key);event.fn();
    }
  };
}
test('requires a real JSPI constructor; no Promise fallback',()=>{
  assert.throws(()=>createTimeJspiBoundary({Suspending:null}),/InvalidTimeHost/);
  assert.throws(()=>createTimeJspiBoundary({Suspending:FakeSuspending,max_pending:0}),/InvalidTimeHost/);
});
test('zero-delay timer always schedules a host event',async()=>{
  const h=fakeClock();
  const p=h.host.sleep_ns(0n);
  assert.deepEqual(h.delays(),[0]);
  h.wake(0n);await p;
  assert.equal(h.host.pending,0);
});
test('early/spurious wakeups are rearmed to the exact monotonic deadline',async()=>{
  const h=fakeClock();
  const p=h.host.sleep_ns(200000000n);
  assert.deepEqual(h.delays(),[200]);
  h.wake(40000000n); assert.deepEqual(h.delays(),[160]);
  h.wake(199000001n); assert.deepEqual(h.delays(),[1]);
  h.wake(200000000n);await p;
  assert.equal(h.host.pending,0);assert.equal(h.events.size,0);
});
test('close cancels outstanding suspended guest waits exactly once',async()=>{
  const h=fakeClock();
  const a=h.host.sleep_ns(1n),b=h.host.sleep_ns(2n);
  assert.equal(h.host.pending,2);
  assert.equal(h.host.close(),true);
  await assert.rejects(a,/TimeHostClosed/);
  await assert.rejects(b,/TimeHostClosed/);
  assert.equal(h.host.pending,0);assert.equal(h.events.size,0);
  assert.equal(h.host.close(),false);
  assert.throws(()=>h.host.sleep_ns(1n),/TimeHostClosed/);
});
test('quota rejects overload but permits registration after completion',async()=>{
  const h=fakeClock({capacity:1});
  const p=h.host.sleep_ns(1n);
  assert.throws(()=>h.host.sleep_ns(2n),/TimerCapacityExceeded/);
  h.wake(1n);await p;
  const q=h.host.sleep_ns(1n);
  h.wake(2n);await q;
  assert.equal(h.host.pending,0);
});
test('invalid i64, negative and overflowing deadlines fail before admission',()=>{
  const h=fakeClock({initial:9223372036854775807n});
  for(const bad of [1,3.2,'1',null,{}])
    assert.throws(()=>h.host.sleep_ns(bad),/DurationType/);
  assert.throws(()=>h.host.sleep_ns(-1n),/NegativeDuration/);
  assert.throws(()=>h.host.sleep_ns(9223372036854775808n),/DurationOverflow/);
  assert.throws(()=>h.host.sleep_ns(1n),/DeadlineOverflow/);
  assert.equal(h.host.pending,0);
});
test('regressed and invalid clock readings reject, never extend wait',async()=>{
  const h=fakeClock();
  const first=h.host.sleep_ns(100n);
  h.wake(40n);
  h.wake(39n);
  await assert.rejects(first,/ClockWentBackwards/);
  assert.equal(h.host.pending,0);
  h.set(-1n);
  assert.throws(()=>h.host.monotonic_now(),/InvalidMonotonicClock/);
  h.set(1n);
  const second=h.host.sleep_ns(10n);
  h.wake(Number.NaN);
  await assert.rejects(second,/InvalidMonotonicClock/);
  assert.equal(h.host.pending,0); assert.equal(h.events.size,0);
});
test('scheduler exceptions and synchronous callback failures release slots',async()=>{
  const h=fakeClock({scheduleFails:true});
  await assert.rejects(h.host.sleep_ns(1n),/schedule failed/);
  assert.equal(h.host.pending,0);
  const sync=createTimeJspiBoundary({
    Suspending:FakeSuspending,now_ns:()=>0n,
    register:(fn)=>{fn();return 1;},unregister:()=>{}
  });
  await assert.rejects(sync.sleep_ns(0n),/SynchronousTimerCallback/);
  assert.equal(sync.pending,0);
});
test('existing sandbox worker still uses import-empty Wasm instantiation',async()=>{
  const worker=await readFile(new URL('../src/guest-worker.mjs',import.meta.url),'utf8');
  const library=await readFile(new URL('../stdlib/std/time.atto',import.meta.url),'utf8');
  assert.match(worker,/new WebAssembly\.Instance\(module, \{\}\)/);
  assert.doesNotMatch(worker,/stdlib-time-jspi/);
  assert.match(library,/define module time as/);
  assert.match(library,/define pub class Duration as/);
  assert.match(library,/pub fnc manual_clock\(/);
  // Host JSPI is not yet compiler-emitted Atto; do not claim guest parity.
});
