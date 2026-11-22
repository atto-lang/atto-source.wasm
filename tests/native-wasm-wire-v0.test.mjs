import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  REQUEST_SCHEMA,RESPONSE_SCHEMA,ACK_SCHEMA,MAX_FRAME_BYTES,
  encodeNativeWasmPair,decodeNativeWasmPair,frameNativeWasm,
  NativeWasmFrameReader
} from '../src/native-wasm-wire-v0.mjs';

const VALUES=[-9223372036854775808n,-2147483649n,-2147483648n,-32769n,
  -32768n,-129n,-128n,-33n,-32n,-1n,0n,1n,127n,128n,255n,256n,
  65535n,65536n,4294967295n,4294967296n,9223372036854775807n];

test('canonical native C++ MsgPack v2 shape digest and all i64 boundaries',()=>{
  const digest=createHash('sha256').update('oreslang.actor.shape.v2/T[I,I]').digest();
  for(const schema of [REQUEST_SCHEMA,RESPONSE_SCHEMA,ACK_SCHEMA]) {
    for(const value of VALUES) {
      const bytes=encodeNativeWasmPair(schema,1n,value);
      assert.equal(bytes[0],0x94);
      assert.ok(bytes.includes(digest));
      assert.deepEqual(decodeNativeWasmPair(schema,bytes),{ticket:1n,value});
      assert.deepEqual(decodeNativeWasmPair(schema,Buffer.from(bytes)),{ticket:1n,value});
    }
  }
});
test('strict native/WASM envelope fails closed on wrong schema, shape, canonicality and trailing bytes',()=>{
  const bytes=encodeNativeWasmPair(REQUEST_SCHEMA,1n,1n);
  assert.throws(()=>decodeNativeWasmPair(ACK_SCHEMA,bytes),/wrong.*schema/);
  const badShape=Buffer.from(bytes);
  const digest=createHash('sha256').update('oreslang.actor.shape.v2/T[I,I]').digest();
  const at=badShape.indexOf(digest);
  assert.ok(at>=0);
  badShape[at]^=0x01;
  assert.throws(()=>decodeNativeWasmPair(REQUEST_SCHEMA,badShape),/digest/);
  assert.throws(()=>decodeNativeWasmPair(REQUEST_SCHEMA,Buffer.concat([bytes,Buffer.from([0])])),/trailing/);
  assert.throws(()=>decodeNativeWasmPair(REQUEST_SCHEMA,bytes.subarray(0,bytes.length-1)),/truncated/);
  assert.throws(()=>encodeNativeWasmPair(REQUEST_SCHEMA,0n,1n),/ticket/);
  assert.throws(()=>encodeNativeWasmPair(REQUEST_SCHEMA,1n,9223372036854775808n),/signed i64/);
  assert.throws(()=>encodeNativeWasmPair('CONTROL',1n,1n),/unregistered/);
  // Replace canonical fixint(1) VALUE with noncanonical uint8(1).
  const noncanonical=Buffer.concat([bytes.subarray(0,bytes.length-1),Buffer.from([0xcc,1])]);
  assert.throws(()=>decodeNativeWasmPair(REQUEST_SCHEMA,noncanonical),/noncanonical/);
});
test('length-framed native pipes handle split/coalesced data and never accept huge/partial frames',()=>{
  const a=encodeNativeWasmPair(REQUEST_SCHEMA,1n,1n);
  const b=encodeNativeWasmPair(ACK_SCHEMA,1n,101n);
  const packet=Buffer.concat([frameNativeWasm(a),frameNativeWasm(b)]);
  const r=new NativeWasmFrameReader();
  assert.deepEqual(r.push(packet.subarray(0,2)),[]);
  assert.deepEqual(r.push(packet.subarray(2,9)),[]);
  assert.deepEqual(r.push(packet.subarray(9)),[a,b]);
  r.end();
  const bad=new NativeWasmFrameReader();
  const oversized=Buffer.alloc(4); oversized.writeUInt32BE(MAX_FRAME_BYTES+1);
  assert.throws(()=>bad.push(oversized),/size rejected/);
  const short=new NativeWasmFrameReader();
  short.push(packet.subarray(0,7));
  assert.throws(()=>short.end(),/truncated/);
});
