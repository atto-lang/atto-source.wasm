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
  assert.throws(()=>receiver.recv_from(8),/closed/);
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

test("UDP denied destination precedes access to hostile guest packet data", async () => {
 const socket=await openNodeUdpLoopback({authorize:(target,op)=>{
  if(op==="udp.send_to")throw new Error("destination denied");
  authorize(target,op);
 }});
 try {
  const hostile=new Proxy(new Uint8Array([1]),{
   get(){throw new Error("guest packet was inspected before permission")}
  });
  await assert.rejects(socket.send_to(hostile,12345),/destination denied/);
 }finally{await socket.close();}
});

test('UDP buffered packet source is reauthorized at dequeue after revocation',async()=>{
 let denied=false;
 let sender;
 const receiver=await openNodeUdpLoopback({authorize:(endpoint,op)=>{
  if(denied && op==='udp.recv_from' && endpoint.endsWith(':' + sender.local_port()))
    throw new Error('source grant revoked');
  authorize(endpoint,op);
 }});
 sender=await openNodeUdpLoopback({authorize});
 try{
  await sender.send_to(Uint8Array.from([9,8,7]),receiver.local_port());
  for(let n=0;n<100 && receiver.stats().queued_packets===0;n++)
    await new Promise(r=>setTimeout(r,2));
  assert.equal(receiver.stats().queued_packets,1);
  denied=true;
  await assert.rejects(receiver.recv_from(8),/source grant revoked/);
  assert.equal(receiver.stats().queued_bytes,0);
  assert.equal(receiver.stats().queued_packets,0);
  assert.equal(receiver.stats().dropped_packets,1);
  denied=false;
  const pending=receiver.recv_from(8);
  await sender.send_to(Uint8Array.from([5]),receiver.local_port());
  assert.deepEqual(Array.from((await pending).bytes),[5]);
 }finally{await sender.close();await receiver.close()}
});

test('UDP stream return cancels a pending receive and releases its socket watch',async()=>{
  const receiver=await openNodeUdpLoopback({authorize});
  const sender=await openNodeUdpLoopback({authorize});
  try{
    const stream=receiver.recv_stream(8);
    const pending=stream.next();
    const stopped=await stream.return();
    assert.equal(stopped.done,true);
    let watchdog;
    const retired=await Promise.race([pending,new Promise((_,reject)=>
      {watchdog=setTimeout(()=>reject(new Error('UDP stream return did not cancel pending read')),1000);})])
      .finally(()=>clearTimeout(watchdog));
    assert.equal(retired.done,true);
    assert.equal((await stream.next()).done,true);
    const fresh=receiver.recv_from(8);
    await sender.send_to(new Uint8Array([99]),receiver.local_port());
    assert.deepEqual(Array.from((await fresh).bytes),[99]);
  }finally{await sender.close();await receiver.close();}
});

test('UDP stream rejects concurrent next and external cancellation retires read',async()=>{
  const receiver=await openNodeUdpLoopback({authorize});
  try{
    const cancelled=new AbortController();
    const stream=receiver.recv_stream(8,{signal:cancelled.signal});
    const pending=stream.next();
    await assert.rejects(stream.next(),/concurrent UDP stream.next/);
    cancelled.abort(new Error('stream external cancellation'));
    await assert.rejects(pending,/stream external cancellation/);
    await stream.return();
    assert.equal((await stream.next()).done,true);
    const retry=new AbortController();
    const pending2=receiver.recv_from(8,{signal:retry.signal});
    retry.abort();
    await assert.rejects(pending2);
  }finally{await receiver.close();}
});

test('UDP outbound send capacity is bounded and released on completion and close',async()=>{
 const sender=await openNodeUdpLoopback({authorize,maxPendingSends:1,maxPendingBytes:4});
 const receiver=await openNodeUdpLoopback({authorize});
 try{
  const recv=receiver.recv_from(8);
  const first=sender.send_to(Uint8Array.from([1,2,3]),receiver.local_port());
  assert.equal(sender.stats().pending_send_packets,1);
  assert.equal(sender.stats().pending_send_bytes,3);
  await assert.rejects(sender.send_to(Uint8Array.from([4]),receiver.local_port()),/send quota/);
  assert.equal(await first,3);
  assert.equal(sender.stats().pending_send_packets,0);
  assert.equal(sender.stats().pending_send_bytes,0);
  assert.deepEqual(Array.from((await recv).bytes),[1,2,3]);
  await assert.rejects(sender.send_to(Uint8Array.from([1,2,3,4,5]),receiver.local_port()),/send quota/);
  // A new send can acquire the retired capacity.
  const second=sender.send_to(Uint8Array.from([9]),receiver.local_port());
  const close=sender.close();
  await assert.rejects(second,/closed/);
  await close;
  assert.equal(sender.stats().pending_send_packets,0);
  assert.equal(sender.stats().pending_send_bytes,0);
 }finally{await sender.close();await receiver.close();}
});
test('UDP stats require live NETWORK authority and reject input quota bypass',async()=>{
 let allowed=true;
 const guarded=await openNodeUdpLoopback({authorize:(resource,op)=>{
   if(!allowed) throw new Error('NET revoked');
   authorize(resource,op);
 }});
 try{
  allowed=false;
  assert.throws(()=>guarded.stats(),/NET revoked/);
  allowed=true;
  assert.equal(guarded.stats().pending_send_packets,0);
 }finally{await guarded.close();}
 await assert.rejects(openNodeUdpLoopback({authorize,maxPendingSends:0}),/queue quota/);
 await assert.rejects(openNodeUdpLoopback({authorize,maxPendingBytes:4194305}),/queue quota/);
});

test('UDP rejects async, false and malformed host authorization outcomes',async()=>{
 await assert.rejects(openNodeUdpLoopback({authorize:()=>Promise.resolve(true)}),/synchronous/);
 await assert.rejects(openNodeUdpLoopback({authorize:()=>false}),/authorization denied/);
 await assert.rejects(openNodeUdpLoopback({authorize:()=>null}),/synchronous/);
 let allowed=true;
 const udp=await openNodeUdpLoopback({authorize:()=>allowed});
 try{
  allowed=false;
  assert.throws(()=>udp.local_port(),/authorization denied/);
  await assert.rejects(udp.send_to(Uint8Array.of(9),12345),/authorization denied/);
  allowed=true;
  assert.ok(udp.local_port()>0);
 }finally{await udp.close();}
});
