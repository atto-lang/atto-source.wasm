import test from 'node:test';
import assert from 'node:assert/strict';
import {encode_event_batch, decode_event_batch, snapshot_command_envelope, limits}
  from '../src/durable-command-wire-v1.mjs';

const b = value => new TextEncoder().encode(value);
const vector = [
  {schema_version:1,payload:b('MoneyDeposited(60)')},
  {schema_version:1,payload:b('MoneyDeposited(40)')}
];
const golden='0000000200000001000000124d6f6e65794465706f736974656428363029'
  +'00000001000000124d6f6e65794465706f736974656428343029';

test('shared Java/LLVM big-endian two-event framing',()=>{
  const encoded=encode_event_batch(vector);
  assert.equal(Buffer.from(encoded).toString('hex'),golden);
  assert.deepEqual(decode_event_batch(encoded),vector);
});
test('caller-owned and decoder-owned event payloads never alias',()=>{
  const payload=b('abc');
  const wire=encode_event_batch([{schema_version:1,payload}]);
  payload[0]=88;
  const events=decode_event_batch(wire);
  assert.equal(new TextDecoder().decode(events[0].payload),'abc');
  events[0].payload[0]=99;
  assert.equal(new TextDecoder().decode(decode_event_batch(wire)[0].payload),'abc');
});
test('truncation and trailing bytes fail closed',()=>{
  const encoded=encode_event_batch(vector);
  for (const size of [0,4,11,encoded.length-1])
    assert.throws(()=>decode_event_batch(encoded.slice(0,size)),/DURABLE_COMMAND_WIRE_V1_/);
  const extra=new Uint8Array(encoded.length+1);extra.set(encoded);
  assert.throws(()=>decode_event_batch(extra),/TRAILING_BYTES/);
});
test('count/schema/large payload/overlong batch fail closed',()=>{
  const encoded=encode_event_batch(vector);
  const corrupt=encoded.slice();new DataView(corrupt.buffer).setUint32(0,0,false);
  assert.throws(()=>decode_event_batch(corrupt),/COUNT/);
  const bad=encoded.slice();new DataView(bad.buffer).setUint32(4,0,false);
  assert.throws(()=>decode_event_batch(bad),/SCHEMA/);
  assert.throws(()=>encode_event_batch([{schema_version:1,payload:new Uint8Array(65537)}]),/PAYLOAD/);
  assert.throws(()=>encode_event_batch(Array.from({length:257},()=>vector[0])),/COUNT/);
  assert.throws(()=>encode_event_batch(Array.from({length:17},()=>({
    schema_version:1,payload:new Uint8Array(65536)
  }))),/BATCH_BUDGET/);
});
test('request and original reply must be owned and bounded',()=>{
  const req=b('Deposit(100)'),reply=b('Ok(balance=100)');
  const envelope=snapshot_command_envelope(req,reply,vector);
  req.fill(0);reply.fill(0);
  assert.equal(new TextDecoder().decode(envelope.request),'Deposit(100)');
  assert.equal(new TextDecoder().decode(envelope.reply),'Ok(balance=100)');
  assert.equal(Buffer.from(envelope.batch).toString('hex'),golden);
  assert.throws(()=>snapshot_command_envelope(new Uint8Array(65537),b('ok'),vector),/COMMAND/);
  assert.throws(()=>snapshot_command_envelope(b('cmd'),new Uint8Array(65537),vector),/REPLY/);
});
test('this is a host wire codec, not a guest or durable backend certification',()=>{
  assert.equal(limits.max_events,256);
  assert.equal(limits.max_batch_bytes,1048576);
});
