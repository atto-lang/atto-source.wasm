import test from 'node:test';
import assert from 'node:assert/strict';
import {openNodeUdpLoopback} from '../src/host-udp-node.mjs';
const authorize=(target,op)=>{if(!target.startsWith('127.0.0.1:')||!op.startsWith('udp.'))throw Error('denied')};
test('UDP Node host binds, sends ordered packets and empty datagrams',async()=>{
 const a=await openNodeUdpLoopback({authorize}),b=await openNodeUdpLoopback({authorize});
 try{
  const first=b.recv_from(100);
  assert.equal(await a.send_to(Uint8Array.from([1,0,255]),b.local_port()),3);
  const p=await first;assert.deepEqual(Array.from(p.bytes),[1,0,255]);assert.equal(p.source.port,a.local_port());
  const empty=b.recv_from(100);
  assert.equal(await a.send_to(new Uint8Array(0),b.local_port()),0);
  assert.equal((await empty).bytes.length,0);
  assert.equal(b.stats().dropped_packets,0);
 }finally{await a.close();await b.close();}
});
test('UDP Node host truncates explicitly, bounds queue, cancels pending recv',async()=>{
 const a=await openNodeUdpLoopback({authorize}),b=await openNodeUdpLoopback({authorize,maxPackets:1,maxBytes:8});
 try{
  const tooSmall=b.recv_from(2);await a.send_to(Uint8Array.from([4,5,6]),b.local_port());
  await assert.rejects(tooSmall,/truncated/);
  await a.send_to(Uint8Array.from([5]),b.local_port());
  await a.send_to(Uint8Array.from([6]),b.local_port());
  await new Promise(r=>setTimeout(r,15));
  assert.equal(b.stats().queued_packets,1);assert.equal(b.stats().dropped_packets,1);
  assert.deepEqual(Array.from((await b.recv_from(2)).bytes),[5]);
  const abort=new AbortController();const pending=b.recv_from(2,{signal:abort.signal});
  abort.abort();await assert.rejects(pending);
  assert.equal(b.stats().queued_packets,0);
 }finally{await a.close();await b.close()}
});
test('UDP Node host checks permissions and close',async()=>{
 let allowed=true;const gate=(target,op)=>{if(!allowed)throw Error('denied');authorize(target,op)};
 const a=await openNodeUdpLoopback({authorize:gate});
 try{allowed=false;await assert.rejects(a.send_to(Uint8Array.from([9]),45678),/denied/);assert.throws(()=>a.recv_from(1),/denied/);}
 finally{allowed=true;await a.close()}
 await assert.rejects(a.send_to(new Uint8Array(0),12345),/closed/);
});
