import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ROUTE_WIRE,I64_ROUTE_BYTES,encode_i64_route,decode_i64_route} from '../src/route-wire.mjs';
test('canonical signed little-endian i64 route transport',()=>{
  assert.equal(ROUTE_WIRE,'atto.browser.route.v1');
  assert.equal(I64_ROUTE_BYTES,8);
  for(const value of [-(1n<<63n),-1024n,-1n,0n,1n,42n,1024n,(1n<<63n)-1n])
    assert.equal(decode_i64_route(encode_i64_route(value)),value);
  assert.deepEqual([...new Uint8Array(encode_i64_route(42n))],[42,0,0,0,0,0,0,0]);
  assert.deepEqual([...new Uint8Array(encode_i64_route(-1n))],Array(8).fill(255));
});
test('fail-closed: oversized and wrong i64 buffers',()=>{
  assert.throws(()=>encode_i64_route(42),/E_ROUTE_I64_TYPE/);
  assert.throws(()=>encode_i64_route(1n<<63n),/E_ROUTE_I64_RANGE/);
  assert.throws(()=>encode_i64_route(-(1n<<63n)-1n),/E_ROUTE_I64_RANGE/);
  assert.throws(()=>decode_i64_route(new Uint8Array(8)),/E_ROUTE_BUFFER/);
  assert.throws(()=>decode_i64_route(new ArrayBuffer(7)),/E_ROUTE_WIRE/);
  assert.throws(()=>decode_i64_route(new ArrayBuffer(9)),/E_ROUTE_WIRE/);
});

test('route decoder accepts actual cross-realm ArrayBuffers but rejects forged/shared/detached data',()=>{
  const foreign=vm.runInNewContext('new ArrayBuffer(8)');
  new DataView(foreign).setBigInt64(0,-42n,true);
  assert.equal(decode_i64_route(foreign),-42n);
  assert.throws(()=>decode_i64_route(new Proxy(new ArrayBuffer(8),{})),/E_ROUTE_BUFFER/);
  if(typeof SharedArrayBuffer==='function')
    assert.throws(()=>decode_i64_route(new SharedArrayBuffer(8)),/E_ROUTE_BUFFER/);
  const detached=new ArrayBuffer(8);
  structuredClone(detached,{transfer:[detached]});
  assert.throws(()=>decode_i64_route(detached),/E_ROUTE_BUFFER/);
});
