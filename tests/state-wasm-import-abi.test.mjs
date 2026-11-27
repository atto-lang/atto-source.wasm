import test from 'node:test';
import assert from 'node:assert/strict';
import {createStateRuntime} from '../src/browser-scalar-state-runtime.mjs';

// Synthetic Wasm ABI witness, not compiler output. Only these fixed local
// modules run; this does not relax trusted-compiler admission of guest bytes.
const uleb = n => {
  const bytes = [];
  do { const b = n & 127; n >>>= 7; bytes.push(b | (n ? 128 : 0)); } while (n);
  return bytes;
};
const name = s => { const b = [...new TextEncoder().encode(s)]; return [...uleb(b.length), ...b]; };
const section = (id, b) => [id, ...uleb(b.length), ...b];
const imported = (s, type) => [...name('atto'), ...name(s), 0, type];
const reg = [0x41, 0, 0x10, 0];
const enter = (mode, local) => [0x41, 0, 0x41, mode, 0x10, 1, 0x21, local];
const leave = local => [0x20, local, 0x10, 2];
const result = [0x42, 42];
function guest(runtime, instructions) {
  const body = [1, 2, 0x7e, ...instructions, 0x0b]; // two i64 locals
  const bytes = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [4, 0x60, 1, 0x7f, 0, 0x60, 2, 0x7f, 0x7f, 1, 0x7e,
      0x60, 1, 0x7e, 0, 0x60, 0, 1, 0x7e]),
    ...section(2, [3, ...imported('state_register', 0), ...imported('state_enter', 1), ...imported('state_leave', 2)]),
    ...section(3, [1, 3]),
    ...section(7, [1, ...name('main'), 0, 3]),
    ...section(10, [1, ...uleb(body.length), ...body]),
  ]);
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), {atto: runtime.imports}).exports.main;
}
function fixture() {
  const events = [];
  const runtime = createStateRuntime({onEvent: e => events.push(e)});
  return {runtime, events};
}

test('real Wasm i64 tickets survive two read scopes and a subsequent writer', () => {
  const {runtime, events} = fixture();
  const main = guest(runtime, [...reg, ...enter(0, 0), ...enter(0, 1), ...leave(1), ...leave(0),
    ...enter(1, 0), ...leave(0), ...result]);
  assert.equal(main(), 42n);
  assert.equal(runtime.snapshot().active, 0);
  runtime.complete();
  assert.deepEqual(events.map(e => e.kind), ['register', 'enter', 'enter', 'leave', 'leave', 'enter', 'leave', 'complete']);
  assert.deepEqual(events.filter(e => e.kind === 'enter').map(e => e.mode), [0, 0, 1]);
  assert.equal(runtime.snapshot().quiescent, true);
});

test('real Wasm trap unwinds before terminal abort of live read or write ticket', () => {
  for (const mode of [0, 1]) {
    const {runtime, events} = fixture();
    const main = guest(runtime, [...reg, ...enter(mode, 0), 0x00]); // unreachable
    assert.throws(main, WebAssembly.RuntimeError);
    assert.equal(runtime.snapshot().active, 1);
    assert.throws(() => runtime.complete(), /unreleased/);
    runtime.abort(); runtime.abort();
    assert.throws(() => runtime.complete(), /aborted/);
    assert.equal(runtime.quiescent(0), true);
    assert.deepEqual(events.map(e => e.kind), ['register', 'enter', 'abort']);
  }
});

test('normal Wasm return with an outstanding ticket cannot complete successfully', () => {
  const {runtime, events} = fixture();
  const main = guest(runtime, [...reg, ...enter(1, 0), ...result]);
  assert.equal(main(), 42n);
  assert.throws(() => runtime.complete(), /unreleased/);
  assert.equal(runtime.snapshot().active, 1);
  runtime.abort();
  assert.equal(runtime.snapshot().quiescent, true);
  assert.deepEqual(events.map(e => e.kind), ['register', 'enter', 'abort']);
});

test('Wasm import contention unwinds without admitting an incompatible second loan', () => {
  for (const [first, second] of [[0, 1], [1, 0], [1, 1]]) {
    const {runtime, events} = fixture();
    const main = guest(runtime, [...reg, ...enter(first, 0), ...enter(second, 1), ...result]);
    assert.throws(main, /contention/);
    assert.equal(runtime.snapshot().active, 1);
    runtime.abort();
    assert.equal(runtime.quiescent(0), true);
    assert.deepEqual(events.map(e => e.kind), ['register', 'enter', 'abort']);
  }
});
