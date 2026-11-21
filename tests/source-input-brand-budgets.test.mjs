import test from 'node:test';
import assert from 'node:assert/strict';
import {types} from 'node:util';
import {assertScalarSourceHasNoImports, rejectUnsupportedActorPipeSource} from '../scripts/compile-ores.mjs';

const checks=[assertScalarSourceHasNoImports,rejectUnsupportedActorPipeSource];

test('all exported source preflights reject shared-backed bytes by intrinsic brand', () => {
  const source=new TextEncoder().encode('val n = 42;');
  const backing=new SharedArrayBuffer(1024);
  const view=new Uint8Array(backing,0,source.length);
  view.set(source);
  for(const check of checks) {
    assert.throws(()=>check(view), /shared backing/);
    assert.throws(()=>check(new DataView(backing,0,source.length)),/shared backing/);
  }
});

test('post-import util.types monkeypatch cannot permit shared-backed source', () => {
  const source=new TextEncoder().encode('val n = 42;');
  const backing=new SharedArrayBuffer(1024);
  const view=new Uint8Array(backing,0,source.length);
  view.set(source);
  const previous=types.isSharedArrayBuffer;
  types.isSharedArrayBuffer=()=>false;
  try {
    for(const check of checks) {
      assert.throws(()=>check(view),/shared backing/);
      assert.throws(()=>check(new DataView(backing,0,source.length)),/shared backing/);
    }
  } finally { types.isSharedArrayBuffer=previous; }
});

test('all exported source preflights enforce physical byte budget despite spoofed getter', () => {
  const oversized=new Uint8Array(1_048_577);
  Object.defineProperty(oversized,'byteLength',{value:1});
  for(const check of checks) assert.throws(()=>check(oversized),/byte budget exceeded/);
});

test('all exported source preflights refuse Proxy and revoked Proxy without traps', () => {
  const source=new TextEncoder().encode('val n = 42;');
  let traps=0;
  const proxy=new Proxy(source,{get(){traps++;throw Error('proxy trap executed')}});
  const {proxy:revoked,revoke}=Proxy.revocable(source,{});revoke();
  for(const check of checks){
    assert.throws(()=>check(proxy),/nonshared byte input/);
    assert.throws(()=>check(revoked),/nonshared byte input/);
  }
  assert.equal(traps,0);
});

test('ordinary owned scalar byte inputs remain admitted, source imports rejected', () => {
  const bytes=new TextEncoder().encode('val n = 42;');
  for(const check of checks) assert.doesNotThrow(()=>check(bytes));
  assert.throws(()=>assertScalarSourceHasNoImports(new TextEncoder().encode('import +secret;')),/imports require/);
  assert.throws(()=>rejectUnsupportedActorPipeSource(new TextEncoder().encode('val x = producer pipe! consumer;')),/source lowering unsupported/);
});
