import test from 'node:test';
import assert from 'node:assert/strict';
import {BufferedStdioHost,GenerationStdioHost} from '../runtime/buffered-stdio-host.mjs';
function gate(){let open;const promise=new Promise(r=>{open=r;});return {promise,open};}
test('bounded bytes include in-flight; waiters FIFO; cancellation is precommit only',async()=>{
 const entered=gate(), release=gate(), out=[];
 const q=new BufferedStdioHost(async s=>{entered.open();await release.promise;out.push(s);},4,4,4,8);
 const a=q.admit('éé');assert.equal((await a.admitted).ok,true);await entered.promise;
 const b=q.admit('B'),drop=q.admit('X'),c=q.admit('C');
 assert.deepEqual(q.accounting,{acceptedRecords:1,acceptedBytes:4,pendingRecords:3,pendingBytes:3});
 assert.equal(drop.cancel(),true);assert.equal((await drop.admitted).code,'CANCELLED');
 assert.equal(a.cancel(),false);
 let progressed=false;await new Promise(r=>setTimeout(()=>{progressed=true;r();},0));assert.equal(progressed,true);
 release.open();await b.admitted;await c.admitted;assert.equal(c.cancel(),false);
 assert.equal((await q.seal()).ok,true);assert.deepEqual(out,['éé','B','C']);
 assert.deepEqual(q.accounting,{acceptedRecords:0,acceptedBytes:0,pendingRecords:0,pendingBytes:0});
});
test('cancel large head admits smaller waiter without waiting for another sink completion',async()=>{
 const release=gate(),entered=gate();const q=new BufferedStdioHost(async()=>{entered.open();await release.promise;},4,4,4,8);
 await q.admit('123').admitted;await entered.promise;
 const a=q.admit('XX'),b=q.admit('Y');assert.equal(q.accounting.pendingRecords,2);
 assert.equal(a.cancel(),true);assert.equal((await b.admitted).ok,true);
 release.open();assert.equal((await q.seal()).ok,true);
});
test('abort settles accepted, pending and close receipts; ignores late physical completion',async()=>{
 const entered=gate(),release=gate();const q=new BufferedStdioHost(async()=>{entered.open();await release.promise;},1,8,2,8);
 const a=q.admit('A');await a.admitted;await entered.promise;
 const b=q.admit('B');assert.equal(q.abort(),true);
 assert.equal((await a.delivered).code,'ABORTED');assert.equal((await b.admitted).code,'ABORTED');
 assert.equal((await q.seal()).code,'ABORTED');
 assert.equal(q.accounting.acceptedBytes,1);assert.equal(q.accounting.acceptedRecords,1);
 release.open();await q.physicallyDrained;
 assert.equal((await a.delivered).code,'ABORTED');assert.equal(q.accounting.acceptedBytes,0);
});
test('quota, malformed unicode, sink rejection and seal are explicit',async()=>{
 const entered=gate(),release=gate();const q=new BufferedStdioHost(async()=>{entered.open();await release.promise;throw Error('sink');},1,8,1,1);
 const a=q.admit('A');await a.admitted;await entered.promise;
 const b=q.admit('B');assert.equal((await q.admit('C').admitted).code,'WAITER_QUOTA');
 assert.equal((await q.admit('😀😀😀').admitted).code,'OVERSIZE');
 assert.equal((await q.admit(String.fromCharCode(0xd800)).admitted).code,'INVALID_RECORD');
 release.open();assert.equal((await a.delivered).code,'SINK_FAILURE');
 assert.equal((await b.admitted).code,'SINK_FAILURE');assert.equal((await q.seal()).code,'SINK_FAILURE');
});
test('seal rejects pending but drains previously accepted',async()=>{
 const release=gate();const q=new BufferedStdioHost(()=>release.promise,1,8,2,8);
 const a=q.admit('a'),b=q.admit('b');await a.admitted;const closed=q.seal();
 assert.equal((await b.admitted).code,'CLOSED');release.open();
 assert.equal((await a.delivered).ok,true);assert.equal((await closed).ok,true);
 assert.equal((await q.admit('c').admitted).code,'CLOSED');
});

test('retirement revokes pending producer and does not authorize new generation',async()=>{
 const entered=gate(),release=gate(),out=[];
 const q=new BufferedStdioHost(async s=>{entered.open();await release.promise;out.push(s);},1,8,2,8);
 const owners=new GenerationStdioHost(q,2);
 const a=owners.openOwner(),b=owners.openOwner();
 assert.throws(()=>owners.openOwner(),RangeError);
 await owners.admit(a,'A').admitted;await entered.promise;
 const drop=owners.admit(a,'DROP');
 assert.equal((await owners.admit(a,'busy').admitted).code,'OWNER_BUSY');
 assert.equal(owners.retire(a),true);assert.equal((await drop.admitted).code,'STALE_OWNER');
 assert.equal((await owners.admit(a,'bad').admitted).code,'STALE_OWNER');
 const c=owners.openOwner();assert.notEqual(a,c);
 const keep=owners.admit(c,'C');assert.equal(owners.retire(b),true);
 release.open();assert.equal((await keep.admitted).ok,true);await q.seal();
 assert.deepEqual(out,['A','C']);
});
test('retirement between commitment and readiness cannot publish a fresh success',async()=>{
 const q=new BufferedStdioHost(async()=>{},1,8,2,8),owners=new GenerationStdioHost(q);
 const a=owners.openOwner(),h=owners.admit(a,'A');
 owners.retire(a);assert.equal((await h.admitted).code,'STALE_OWNER');assert.equal(h.cancel(),false);
 await q.seal();
});
