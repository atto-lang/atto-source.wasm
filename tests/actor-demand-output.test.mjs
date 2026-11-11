import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorIoEnvelope} from '../src/runtime/actor-io.mjs';
import {ActorDemandOutputPort} from '../src/runtime/actor-demand-output.mjs';

const make=(maxRecords=2,maxBytes=64)=> {
  const io=new ActorIoEnvelope({actorId:57,maxRecords,maxBytes});
  const port=new ActorDemandOutputPort({
    io,authority:io.authority(),capacity:2,maxInFlight:1,
    maxBytes:16,maxDemand:4
  });
  return {io,port};
};

test('demand-gated output is backed by real copied actor I/O, bounded FIFO and loan ACK',()=>{
  const {port}=make();
  assert.equal(port.tryOffer(Uint8Array.of(1)), 'no-subscriber');
  const lease=port.subscribe();
  assert.throws(()=>port.subscribe(),/exclusive/);
  assert.equal(port.tryOffer(Uint8Array.of(1)), 'no-demand');
  port.request(lease,4);
  const first=Uint8Array.of(1,2);
  assert.equal(port.tryOffer(first),'accepted');
  first[0]=255; // actor envelope must own an independent snapshot
  assert.equal(port.tryOffer(Uint8Array.of(3,4)),'accepted');
  assert.equal(port.tryOffer(Uint8Array.of(5)),'full');
  const one=port.tryNext(lease);
  assert.deepEqual([...one.value],[1,2]);
  assert.equal(port.tryNext(lease).kind,'not-ready');
  assert.equal(port.tryOffer(Uint8Array.of(5)),'accepted');
  assert.equal(port.retainedBytes,5);
  assert.equal(port.ack(lease,one.ticket),true);
  assert.equal(port.ack(lease,one.ticket),false);
  const two=port.tryNext(lease);
  assert.deepEqual([...two.value],[3,4]);
  assert.equal(port.ack(lease,two.ticket),true);
  const three=port.tryNext(lease);
  assert.deepEqual([...three.value],[5]);
  assert.equal(port.ack(lease,three.ticket),true);
  assert.equal(port.retainedBytes,0);
});

test('completed output cannot be cancelled and preserves committed messages',()=>{
  const {port}=make();
  const lease=port.subscribe();port.request(lease,2);
  port.tryOffer(Uint8Array.of(7));port.tryOffer(Uint8Array.of(8));
  assert.equal(port.complete(),true);
  assert.equal(port.cancel(),false);
  const one=port.tryNext(lease),two=(port.ack(lease,one.ticket),port.tryNext(lease));
  assert.deepEqual([...one.value,...two.value],[7,8]);
  assert.equal(port.ack(lease,two.ticket),true);
  assert.equal(port.tryNext(lease).kind,'complete');
});

test('cancellation drops undelivered bytes, retains checked-out loan and fences new sends',()=>{
  const {port}=make();
  const lease=port.subscribe();port.request(lease,2);
  port.tryOffer(Uint8Array.of(1,2));
  port.tryOffer(Uint8Array.of(3,4));
  const item=port.tryNext(lease);
  assert.equal(port.cancel(),true);
  assert.equal(port.complete(),false);
  assert.equal(port.queued,0);
  assert.equal(port.retainedBytes,2);
  assert.equal(port.tryOffer(Uint8Array.of(9)),'closed');
  assert.equal(port.tryNext(lease).kind,'cancelled');
  assert.equal(port.ack(lease,item.ticket),true);
  assert.equal(port.retainedBytes,0);
});

test('invalid request and stale actor generation fail closed',()=>{
  const {io,port}=make();
  const lease=port.subscribe();
  assert.throws(()=>port.request(lease,0),RangeError);
  assert.throws(()=>port.request(lease,1_000_000_001),RangeError);
  assert.equal(port.outstandingDemand,0);
  io.restart(2);
  assert.throws(()=>port.tryOffer(Uint8Array.of(1)),/stale, foreign, or retired/);
  assert.throws(()=>port.request(lease,1),/stale, foreign, or retired/);
});

test('underlying actor output quota refuses without consuming credits',()=>{
  const {port}=make(1,1);
  const lease=port.subscribe();port.request(lease,2);
  assert.equal(port.tryOffer(Uint8Array.of(4)),'accepted');
  assert.equal(port.tryOffer(Uint8Array.of(5)),'host-backpressure');
  assert.equal(port.outstandingDemand,1);
  assert.equal(port.retainedBytes,1);
});
