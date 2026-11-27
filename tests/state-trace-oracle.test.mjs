import test from 'node:test';
import assert from 'node:assert/strict';
import {createStateRuntime} from '../src/browser-scalar-state-runtime.mjs';
import {assertStateTrace} from './state-trace-oracle.mjs';

function actual(abort = false) {
  const events = [];
  const rt = createStateRuntime({onEvent: e => events.push(e)});
  const {state_register: reg, state_enter: enter, state_leave: leave} = rt.imports;
  reg(0); reg(8);
  const w = enter(0, 1); leave(w);
  const r = enter(8, 0);
  if (abort) rt.abort(); else { leave(r); rt.complete(); }
  return {ok: !abort, state: rt.snapshot(), events};
}
const positive = {claims: [[1, 1], [2, 0]], containers: 2, terminal: 'complete'};

test('accept exact complete and abort traces emitted by host runtime', () => {
  assertStateTrace(actual(), positive);
  assertStateTrace(actual(true), {...positive, terminal: 'abort', outstanding: 1});
});

test('reject wrong identity, mode and sequence even when enter/leave counts match', () => {
  for (const claims of [[[2, 1], [1, 0]], [[1, 0], [2, 1]], [[2, 0], [1, 1]]]) {
    assert.throws(() => assertStateTrace(actual(), {...positive, claims}), /claim order/);
  }
  const r = actual();
  r.events = r.events.map(e => e.kind === 'leave' && e.mode === 1 ? {...e, containerId: 2} : e);
  assert.throws(() => assertStateTrace(r, positive), /unmatched writer/);
});

test('reject missing or duplicate terminal, live completion, truncated trace', () => {
  const r = actual();
  assert.throws(() => assertStateTrace({...r, events: r.events.slice(0, -1)}, positive), /missing terminal/);
  assert.throws(() => assertStateTrace({...r, events: [...r.events, {kind: 'complete'}]}, positive), /after terminal/);
  assert.throws(() => assertStateTrace({...r, events: r.events.filter(e => e.kind !== 'leave')}, positive), /outstanding claims/);
  assert.throws(() => assertStateTrace({...r, events: Array(4096).fill({kind: 'complete'})}, positive), /truncated/);
});

test('reject conflicting grants and admission after retirement', () => {
  const r = actual();
  const index = r.events.findIndex(e => e.kind === 'enter');
  for (const extra of [{kind: 'enter', containerId: 1, mode: 0}, {kind: 'enter', containerId: 1, mode: 1}]) {
    const events = [...r.events]; events.splice(index + 1, 0, extra);
    assert.throws(() => assertStateTrace({...r, events}, positive), /incompatible/);
  }
  const events = [...r.events]; events.splice(index, 0, {kind: 'retire', containerId: 1});
  assert.throws(() => assertStateTrace({...r, events}, positive), /retired claim/);
});
