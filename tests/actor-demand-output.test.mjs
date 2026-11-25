import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorIoEnvelope} from '../src/runtime/actor-io.mjs';
import {ActorDemandOutputPort} from '../src/runtime/actor-demand-output.mjs';

function make(maxRecords=2,maxBytes=64) {
  const io = new ActorIoEnvelope({actorId:57,maxRecords,maxBytes});
  const port = new ActorDemandOutputPort({io,authority:io.authority(),capacity:2,
    maxInFlight:1,maxBytes:16,maxDemand:4});
  return {io,port};
}

test('real actor queue enforces demand, FIFO and exact ACK credit refunds',()=>{
  const {port}=make();
  assert.equal(port.tryOffer(Uint8Array.of(1)),'no-subscriber');
  const reader=port.subscribe();
  assert.throws(()=>port.subscribe(),/exclusive/);
  assert.equal(port.tryOffer(Uint8Array.of(1)),'no-demand');
  port.request(reader,4);
  const source=Uint8Array.of(1,2);
  assert.equal(port.tryOffer(source),'accepted');
  source[0]=255;
  assert.equal(port.tryOffer(Uint8Array.of(3,4)),'accepted');
  assert.equal(port.tryOffer(Uint8Array.of(5)),'full');
  const one=port.tryNext(reader);
  assert.deepEqual([...one.value],[1,2]);
  assert.equal(port.tryNext(reader).kind,'not-ready'); // in-flight cap
  assert.equal(port.tryOffer(Uint8Array.of(5)),'accepted');
  assert.equal(port.retainedBytes,5);
  assert.equal(port.ack(reader,one.ticket),true);
  assert.equal(port.ack(reader,one.ticket),false);
  const two=port.tryNext(reader);
  assert.deepEqual([...two.value],[3,4]);
  assert.equal(port.ack(reader,two.ticket),true);
  const three=port.tryNext(reader);
  assert.deepEqual([...three.value],[5]);
  assert.equal(port.ack(reader,three.ticket),true);
  assert.equal(port.retainedBytes,0);
});

test('complete half-closes real output only after drained FIFO',()=>{
  const {port,io}=make();const auth=io.authority();const reader=port.subscribe();
  port.request(reader,2);
  port.tryOffer(Uint8Array.of(7));port.tryOffer(Uint8Array.of(8));
  assert.equal(port.complete(),true);
  assert.equal(port.cancel(),false);
  assert.equal(io.outputAtEof(auth),false);
  assert.throws(()=>io.readOutput(auth),/exclusively leased/);
  assert.throws(()=>io.closeOutput(auth),/exclusively leased/);
  const a=port.tryNext(reader);
  assert.deepEqual([...a.value],[7]);
  assert.equal(port.ack(reader,a.ticket),true);
  const b=port.tryNext(reader);
  assert.deepEqual([...b.value],[8]);
  assert.equal(io.outputAtEof(auth),true);
  assert.equal(port.ack(reader,b.ticket),true);
  assert.equal(port.tryNext(reader).kind,'complete');
  assert.equal(port.dispose(reader),true);
  assert.equal(io.tryWriteOutput(auth,Uint8Array.of(9)),false,'closed output never reopens');
});

test('cancel scrubs dropped bytes, leaves checked-out loans until ACK',()=>{
  const {port,io}=make();const auth=io.authority();const reader=port.subscribe();
  port.request(reader,2);
  port.tryOffer(Uint8Array.of(1,2));port.tryOffer(Uint8Array.of(3,4));
  const loan=port.tryNext(reader);
  assert.equal(port.cancel(),true);
  assert.equal(port.queued,0);
  assert.equal(port.retainedBytes,2);
  assert.equal(io.outputAtEof(auth),true);
  assert.equal(port.tryOffer(Uint8Array.of(5)),'closed');
  assert.equal(port.tryNext(reader).kind,'cancelled');
  assert.equal(port.ack(reader,loan.ticket),true);
  assert.equal(port.retainedBytes,0);
  assert.equal(port.dispose(reader),true);
});

test('forged byteLength and iteration cannot forge retained byte credits',()=>{
  const {port}=make();const reader=port.subscribe();port.request(reader,2);
  class Poisoned extends Uint8Array {
    get byteLength() {return 0;}
    *[Symbol.iterator]() {throw Error('must not consume attacker iterator');}
  }
  const forged=new Poisoned([9,8,7,6]);
  assert.equal(port.tryOffer(forged),'accepted');
  assert.equal(port.retainedBytes,4);
  const loan=port.tryNext(reader);
  assert.deepEqual([...loan.value],[9,8,7,6]);
  assert.equal(port.ack(reader,loan.ticket),true);
  assert.equal(port.retainedBytes,0);
  assert.throws(()=>port.tryOffer(new Proxy(Uint8Array.of(1),{})),/genuine Uint8Array/);
});

test('capacity denial cannot debit demand or acquire bytes',()=>{
  const {port}=make(1,2);const reader=port.subscribe();port.request(reader,3);
  assert.equal(port.tryOffer(Uint8Array.of(1,2)),'accepted');
  assert.equal(port.tryOffer(Uint8Array.of(3)),'host-backpressure');
  assert.equal(port.outstandingDemand,2);
  assert.equal(port.retainedBytes,2);
});

test('stale generation revokes lease, rejects old ACK and lets fresh output proceed',()=>{
  const {port,io}=make();const old=io.authority();const reader=port.subscribe();
  port.request(reader,1);port.tryOffer(Uint8Array.of(1));
  io.restart(2);
  assert.throws(()=>port.tryNext(reader),/stale, foreign, or retired/);
  assert.throws(()=>port.ack(reader,1),/stale, foreign, or retired/);
  assert.throws(()=>port.complete(),/stale, foreign, or retired/);
  const fresh=io.authority();
  assert.notEqual(fresh,old);
  assert.equal(io.tryWriteOutput(fresh,Uint8Array.of(9)),true);
  assert.deepEqual([...io.readOutput(fresh)],[9]);
});

test('exclusive output lease denies unauthorized reads, writes and close',()=>{
  const {port,io}=make();const auth=io.authority();
  assert.throws(()=>io.tryWriteOutput(auth,Uint8Array.of(1)),/exclusively leased/);
  assert.throws(()=>io.readOutput(auth),/exclusively leased/);
  assert.throws(()=>io.closeOutput(auth),/exclusively leased/);
  assert.throws(()=>io.releaseOutputLease(auth,{}),/missing/);
  const reader=port.subscribe();
  assert.equal(port.cancel(),true);
  assert.equal(port.dispose(reader),true);
  assert.equal(io.closeOutput(auth),false);
});

test('repeated close remains idempotent; reader lease cannot be forged',()=>{
  const {port,io}=make();const reader=port.subscribe();
  assert.throws(()=>port.request({},1),/exclusive output reader lease/);
  assert.throws(()=>port.dispose({}),/exclusive output reader lease/);
  assert.equal(port.complete(),true);
  assert.equal(port.complete(),false);
  assert.equal(port.tryNext(reader).kind,'complete');
  assert.equal(port.dispose(reader),true);
  assert.equal(io.outputAtEof(io.authority()),true);
});
