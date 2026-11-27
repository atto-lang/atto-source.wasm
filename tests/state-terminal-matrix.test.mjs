import test from 'node:test';
import assert from 'node:assert/strict';
import {createStateRuntime,runScalarStateTurn} from '../src/browser-scalar-state-runtime.mjs';

test('terminal matrix: close while shared readers or exclusive writer are live', () => {
  for (const mode of [0, 1]) for (const terminal of ['complete', 'abort']) {
    const events = [];
    const rt = createStateRuntime({onEvent: e => events.push(e.kind)});
    const {state_register: reg, state_enter: enter, state_leave: leave} = rt.imports;
    reg(0); reg(8);
    const tickets = [enter(0, mode), enter(8, 1)];
    if (mode === 0) tickets.push(enter(0, 0));
    rt.beginRetire(0); rt.beginRetire(0);
    assert.equal(rt.quiescent(0), false);
    assert.throws(() => enter(0, 0), /retired/);
    assert.throws(() => rt.complete(), /unreleased/);
    assert.equal(rt.snapshot().active, tickets.length);
    if (terminal === 'complete') for (const ticket of tickets) leave(ticket);
    rt[terminal](); rt[terminal]();
    if (terminal === 'abort') assert.throws(() => rt.complete(), /aborted/);
    else rt.abort();
    for (const ticket of tickets) assert.throws(() => leave(ticket), /replayed/);
    for (const ptr of [0, 8]) {
      assert.equal(rt.quiescent(ptr), true);
      assert.throws(() => enter(ptr, 0), /retired/);
      rt.beginRetire(ptr);
    }
    assert.throws(() => reg(16), /retirement/);
    assert.equal(rt.snapshot().active, 0);
    assert.equal(events.filter(e => e === 'retire').length, 1);
    assert.equal(events.filter(e => e === terminal).length, 1);
    assert.equal(events.filter(e => e === (terminal === 'complete' ? 'abort' : 'complete')).length, 0);
    assert.equal(events.filter(e => e === 'leave').length, terminal === 'complete' ? tickets.length : 0);
  }
});

test('throwing terminal observer cannot change final outcome or notify twice', () => {
  for (const terminal of ['complete', 'abort']) {
    const events = [];
    const rt = createStateRuntime({onEvent: e => {
      events.push(e.kind);
      if (e.kind === terminal) throw new Error('observer failed');
    }});
    rt.imports.state_register(0);
    rt[terminal](); rt[terminal]();
    if (terminal === 'abort') assert.throws(() => rt.complete(), /aborted/);
    else rt.abort();
    assert.equal(rt.observerFailureCount(), 1);
    assert.deepEqual(events, ['register', terminal]);
    assert.equal(rt.quiescent(0), true);
  }
});

test('physical turn boundary aborts every failed return and preserves original error', () => {
  for (const failure of ['start', 'main', 'unreleased', 'non-i64']) {
    const events = [];
    const rt = createStateRuntime({onEvent:e=>events.push(e.kind)});
    let ticket, unwound = false;
    const original = new Error('guest ' + failure);
    let caught;
    try {
      runScalarStateTurn(rt, () => {
        try {
          rt.imports.state_register(0);
          ticket = rt.imports.state_enter(0,1);
          if (failure === 'start' || failure === 'main') throw original;
          if (failure === 'non-i64') return 42;
          return 42n; // missing leave must fail terminal validation
        } finally {
          assert.equal(rt.snapshot().active,1);
          assert.equal(rt.snapshot().retired,false);
          unwound = true;
        }
      });
    } catch(e) { caught = e; }
    assert.equal(unwound,true);
    assert.equal(rt.snapshot().quiescent,true);
    assert.equal(rt.snapshot().active,0);
    assert.deepEqual(events,['register','enter','abort']);
    if (failure === 'start' || failure === 'main') assert.equal(caught,original);
    else assert.equal(String(caught).includes(failure === 'unreleased' ? 'unreleased' : 'i64'),true);
    assert.throws(()=>rt.imports.state_leave(ticket),/replayed/);
    assert.throws(()=>rt.complete(),/aborted/);
  }
});

test('physical turn boundary completes balanced execution once', () => {
  const events=[];
  const rt=createStateRuntime({onEvent:e=>events.push(e.kind)});
  const value=runScalarStateTurn(rt,()=>{
    rt.imports.state_register(0);
    const ticket=rt.imports.state_enter(0,0);
    rt.imports.state_leave(ticket);
    return 42n;
  });
  assert.equal(value,42n);
  assert.deepEqual(events,['register','enter','leave','complete']);
  assert.equal(rt.snapshot().quiescent,true);
  rt.abort();
  assert.deepEqual(events,['register','enter','leave','complete']);
});
