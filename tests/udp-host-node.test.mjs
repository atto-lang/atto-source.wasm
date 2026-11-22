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
  // Wait on an observable delivery/drop condition rather than a fixed sleep
  // that can race with slow or shared CI runners.
  for(let i=0;i<100 && b.stats().dropped_packets===0;i++)
    await new Promise(r=>setTimeout(r,2));
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

test('UDP Node host stream yields whole packets and rejects unsafe buffers',async()=>{
 const a=await openNodeUdpLoopback({authorize}),b=await openNodeUdpLoopback({authorize,maxPackets:2,maxBytes:8});
 try{
  const iterator=b.recv_stream(8)[Symbol.asyncIterator]();
  const first=iterator.next();
  await a.send_to(Uint8Array.from([8,7]),b.local_port());
  assert.deepEqual(Array.from((await first).value.bytes),[8,7]);
  const second=iterator.next();
  await a.send_to(Uint8Array.from([6]),b.local_port());
  assert.deepEqual(Array.from((await second).value.bytes),[6]);
  await assert.rejects(a.send_to(new Uint8Array(new SharedArrayBuffer(1)),b.local_port()));
  await assert.rejects(a.send_to(new Proxy(new Uint8Array(1),{}),b.local_port()));
  const ctr=new AbortController();
  ctr.abort(new Error('pre-cancelled'));
  await assert.rejects(b.recv_from(8,{signal:ctr.signal}),/pre-cancelled/);
 }finally{await a.close();await b.close();}
});

test("UDP close rejects a pending receive, retires its queue, and is idempotent", async () => {
 const sender=await openNodeUdpLoopback({authorize});
 const receiver=await openNodeUdpLoopback({authorize,maxPackets:1,maxBytes:8});
 try {
  const pending=receiver.recv_from(8);
  const closing=receiver.close();
  await assert.rejects(pending,/closed/);
  await closing;
  await receiver.close();
  assert.equal(receiver.stats().queued_packets,0);
  await assert.rejects(receiver.recv_from(8),/closed/);
 } finally { await sender.close(); await receiver.close(); }
});

test("UDP input revocation denies receive and does not publish unauthorized bytes", async () => {
 let allowed=true;
 const receiver=await openNodeUdpLoopback({authorize:(target,op)=>{
  if(!allowed && op==="udp.recv_from")throw new Error("revoked");
  authorize(target,op);
 }});
 const sender=await openNodeUdpLoopback({authorize});
 try {
  allowed=false;
  await sender.send_to(Uint8Array.from([5,4]),receiver.local_port());
  for(let i=0;i<100&&receiver.stats().dropped_packets===0;i++)
   await new Promise(r=>setTimeout(r,2));
  assert.equal(receiver.stats().dropped_packets,1);
  assert.equal(receiver.stats().queued_packets,0);
  allowed=true;
  const recv=receiver.recv_from(8);
  await sender.send_to(Uint8Array.from([3]),receiver.local_port());
  assert.deepEqual(Array.from((await recv).bytes),[3]);
 }finally{await sender.close();await receiver.close()}
});
