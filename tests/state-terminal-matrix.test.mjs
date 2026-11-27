import test from 'node:test';
import assert from 'node:assert/strict';
import {createStateRuntime} from '../src/browser-scalar-state-runtime.mjs';

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

test('capacity exhaustion and retirement preserve ticket authority across incarnations', () => {
  for (const terminal of ['complete', 'abort']) {
    const events = [];
    const rt = createStateRuntime({maxContainers:2,maxTickets:2,onEvent:e=>events.push(e.kind)});
    const other = createStateRuntime({maxContainers:1,maxTickets:1});
    const {state_register:reg,state_enter:enter,state_leave:leave}=rt.imports;
    reg(0); reg(8); other.imports.state_register(0);
    const a=enter(0,0), b=enter(8,1), foreign=other.imports.state_enter(0,1);
    const before=rt.snapshot(), eventCount=events.length;
    assert.throws(()=>reg(16),/container admission capacity/);
    assert.throws(()=>enter(0,0),/admission capacity/);
    assert.throws(()=>leave(foreign),/replayed/);
    assert.throws(()=>other.imports.state_leave(a),/replayed/);
    assert.throws(()=>rt.complete(),/unreleased/);
    assert.deepEqual(rt.snapshot(),before);
    assert.equal(events.length,eventCount);
    leave(a);
    rt.beginRetire(8);
    assert.throws(()=>enter(8,0),/retired/);
    const next=enter(0,1);
    assert.equal(next,b+1n); // rejected admissions do not mint tickets
    assert.throws(()=>leave(a),/replayed/);
    assert.equal(rt.quiescent(8),false);
    if(terminal==='complete'){leave(b);leave(next);}
    rt[terminal]();
    assert.equal(rt.snapshot().active,0);
    assert.equal(rt.quiescent(0),true);
    assert.equal(rt.quiescent(8),true);
    assert.equal(other.snapshot().active,1);
    other.imports.state_leave(foreign);
    other.complete();
    assert.equal(other.snapshot().quiescent,true);
  }
});
