import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {FrozenTcpSlab} from '../src/frozen-tcp-slab.mjs';

test('native typed view iterator bypasses hostile own Symbol.iterator',()=>{
  let touched=0;
  const a=new Uint8Array([2,42]);
  Object.defineProperty(a,Symbol.iterator,{get(){touched++;throw Error('attacker getter')}});
  const slab=new FrozenTcpSlab(a),pin=slab.pin();
  assert.equal(slab.readByte(pin,1),42);
  assert.equal(touched,0);
  slab.releasePin(pin);slab.retire();assert.equal(slab.freed,true);
});
test('typed Uint16Array still validates logical elements, not byte storage',()=>{
  assert.throws(()=>new FrozenTcpSlab(new Uint16Array([256])),/unsigned byte/);
  const s=new FrozenTcpSlab(new Uint16Array([42]));const p=s.pin();
  assert.equal(s.readByte(p,0),42);s.releasePin(p);
});
test('foreign private view accepted and shared backing rejected',()=>{
  const foreign=vm.runInNewContext('new Uint8Array([42])');
  const s=new FrozenTcpSlab(foreign);const p=s.pin();assert.equal(s.readByte(p,0),42);s.releasePin(p);
  const shared=vm.runInNewContext('new Uint8Array(new SharedArrayBuffer(3))');
  assert.throws(()=>new FrozenTcpSlab(shared),/shared backing/);
});
test('generic iterable and retirement remain available',()=>{
  const slab=new FrozenTcpSlab([1,42]);const p=slab.pin();slab.retire();
  assert.equal(slab.readByte(p,1),42);slab.releasePin(p);assert.equal(slab.freed,true);
});
