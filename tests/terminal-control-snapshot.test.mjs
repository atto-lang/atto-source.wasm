import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TERMINAL_EFFECT_TYPE, makeTerminalEffectNotice, terminalEffectReceiver,
  EffectNoticeProtocolError
} from '../runtime/terminal-effect-notice.mjs';

const worker = Object.freeze({physical_worker: true});
const base = Object.freeze({
  actor_id: 'actor:7', parent_id: 'supervisor:2',
  generation: 4, sequence: 0, effect: 'raise',
  error_type: 'DatabaseError', message: 'lost quorum'
});
const receiver = () => terminalEffectReceiver({...base, worker});
const payload = () => ({
  type: TERMINAL_EFFECT_TYPE, ...base
});

test('descriptor snapshot defeats get-trap TOCTOU on trusted Worker receive', () => {
  let propertyReads = 0;
  const hostile = new Proxy(payload(), {
    get(_target, key) {
      propertyReads++;
      // Old code read value.effect AFTER checking descriptors and accepted panic.
      if (key === 'effect') return 'panic';
      throw Error('get trap invoked: ' + String(key));
    }
  });
  const control = receiver().accept(hostile, worker);
  assert.equal(control.lane, 'CONTROL');
  assert.equal(control.effect, 'raise', 'only the validated data snapshot can be used');
  assert.equal(control.recoverable, false);
  assert.equal(propertyReads, 0, 'no Proxy get calls on the validated original');
});

test('descriptor snapshot defeats get-trap TOCTOU on trusted host maker', () => {
  let reads = 0;
  const hostile = new Proxy({...base}, {
    get(_target, key) {reads++; throw Error('unexpected input read: '+String(key));}
  });
  const result = makeTerminalEffectNotice(hostile);
  assert.equal(result.effect, 'raise');
  assert.equal(result.type, TERMINAL_EFFECT_TYPE);
  assert.equal(reads, 0);
});

test('hidden or symbol authority cannot be laundered in either direction', () => {
  const inputs = [
    Object.defineProperty({...base}, 'cleanup_done', {value:true, enumerable:false}),
    Object.assign({...base}, {[Symbol('CONTROL')]:true}),
  ];
  for (const input of inputs) assert.throws(
    () => makeTerminalEffectNotice(input), EffectNoticeProtocolError);
  const hidden = Object.defineProperty(payload(),'cleanup_done',{value:true,enumerable:false});
  assert.throws(() => receiver().accept(hidden,worker),/unexpected or missing fields/);
  const symbol = payload();
  symbol[Symbol('authorized')] = true;
  assert.throws(() => receiver().accept(symbol,worker),/unexpected or missing fields/);
});

test('accessors are rejected without invocation and cannot close valid CONTROL receiver', () => {
  let called=0;
  const hostile=payload();
  Object.defineProperty(hostile, 'effect', {
    enumerable:true, get(){called++;return 'panic';}
  });
  const acceptor=receiver();
  assert.throws(() => acceptor.accept(hostile,worker), /notice field/);
  assert.equal(called,0);
  assert.equal(acceptor.closed,false);
  const approved=acceptor.accept(payload(),worker);
  assert.equal(approved.effect,'raise');
  assert.equal(acceptor.closed,true);
});

test('typed DATA and forged supervisor notices never become CONTROL', () => {
  const acceptor=receiver();
  for(const type of ['atto.actor.data.v1','atto.actor.terminal-effect.v2']){
    assert.throws(()=>acceptor.accept({...payload(),type},worker),
      /unsupported notice version/);
  }
  assert.throws(()=>acceptor.accept({...payload(),effect:'ack'},worker),
    /invalid terminal effect/);
  assert.throws(()=>acceptor.accept(payload(),Object.freeze({physical_worker:true})),
    /untrusted Worker/);
  assert.equal(acceptor.closed,false);
  const result=acceptor.accept(payload(),worker);
  assert.equal(result.lane,'CONTROL');
  assert.throws(()=>acceptor.accept(payload(),worker),/terminal/);
});
