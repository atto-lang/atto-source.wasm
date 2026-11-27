import test from 'node:test';
import assert from 'node:assert/strict';
import {TenantStdioAdmission} from '../src/runtime/tenant-stdio-admission.mjs';
function gate(){let open;const promise=new Promise(r=>{open=r;});return {promise,open};}
const tick=()=>Promise.resolve();
test('generation and descriptor identity; cancelled head advances while sink gated',async()=>{
 const entered=gate(),release=gate(),out=[];
 const q=new TenantStdioAdmission(async s=>{entered.open();await release.promise;out.push(s);},4,4,4,8);
 const other=new TenantStdioAdmission(async()=>{},4,4,4,8);
 const a=q.admit(1,1,'123').ticket;await tick();
 assert.equal(q.takeReady(1,1,a).ok,true);await entered.promise;
 const head=q.admit(1,1,'XX').ticket,tail=q.admit(1,2,'Y').ticket;
 assert.equal(q.takeReady(1,2,tail).pending,true);
 assert.equal(q.cancel(1,2,head),false);assert.equal(other.cancel(1,1,head),false);
 assert.equal(other.takeReady(1,2,tail).code,'STALE');assert.equal(q.cancel(1,1,head),true);
 await tick();assert.equal(q.takeReady(1,1,tail).code,'STALE');assert.equal(q.takeReady(1,2,tail).ok,true);
 assert.equal(q.takeReady(1,2,tail).code,'STALE');release.open();assert.equal((await q.seal()).ok,true);
 assert.deepEqual(out,['123','Y']);await other.seal();
});
test('bounded ready receipts and exact retirement ignore late readiness',async()=>{
 const entered=gate(),release=gate();
 const q=new TenantStdioAdmission(async()=>{entered.open();await release.promise;},1,4,2,4);
 const a=q.admit(1,1,'a').ticket;await tick();await entered.promise;
 const b=q.admit(1,1,'b').ticket;assert.equal(q.admit(1,2,'c').code,'WAITER_QUOTA');
 q.retire(1,1);await tick();assert.equal(q.retainedReceipts,0);
 assert.equal(q.takeReady(1,1,a).code,'STALE');assert.equal(q.takeReady(1,1,b).code,'STALE');
 const c=q.admit(1,2,'c').ticket;q.retire(1,1);
 assert.equal(q.takeReady(1,2,c).pending,true);release.open();
 await new Promise(r=>setTimeout(r,10));assert.equal(q.takeReady(1,2,c).ok,true);
 assert.equal((await q.seal()).ok,true);
});
test('abort terminal admission and prevent new writes',async()=>{
 const entered=gate(),release=gate();const q=new TenantStdioAdmission(async()=>{entered.open();await release.promise;},1,4,2,4);
 const a=q.admit(1,1,'a').ticket;await tick();await entered.promise;
 assert.equal(q.takeReady(1,1,a).ok,true);
 const b=q.admit(1,1,'b').ticket;assert.equal(q.abort(),true);await tick();
 assert.equal(q.takeReady(1,1,b).code,'ABORTED');assert.equal(q.admit(1,2,'c').code,'CLOSED');
 release.open();assert.equal((await q.seal()).code,'ABORTED');
});
