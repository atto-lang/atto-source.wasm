import test from "node:test";
import assert from "node:assert/strict";
import {ActorSpawnQuotaGate} from "../src/actor-spawn-quota-gate.mjs";
const unit=[1n,1n,1n,1n], zero=[0n,0n,0n,0n];
test("generation, exact token identity, replay and retirement",()=>{
  const g=new ActorSpawnQuotaGate(unit,1,2), other=new ActorSpawnQuotaGate(unit,1,2);
  const p=g.reserve(unit);
  assert.equal(g.tryEnterReceive(p),null);
  assert.throws(()=>other.beginInit(p),/STALE_PERMIT/);
  const init=g.beginInit(p);
  assert.throws(()=>g.completeInit({...init},true),/INIT_AUTHORITY/);
  assert.throws(()=>g.beginInit(p),/INIT_AUTHORITY/);
  assert.equal(g.completeInit(init,true),true);
  assert.throws(()=>g.completeInit(init,true),/INIT_AUTHORITY/);
  const a=g.tryEnterReceive(p), b=g.tryEnterReceive(p);
  assert.throws(()=>g.tryEnterReceive(p),/FULL/);
  g.retire(p);
  assert.equal(g.tryEnterReceive(p),null);
  assert.throws(()=>g.releaseAfterQuiescence(p),/IN_FLIGHT/);
  assert.throws(()=>g.finishReceive({...a}),/STALE_PERMIT/);
  g.finishReceive(a);
  assert.throws(()=>g.finishReceive(a),/STALE_PERMIT/);
  assert.throws(()=>g.releaseAfterQuiescence(p),/IN_FLIGHT/);
  g.finishReceive(b);g.releaseAfterQuiescence(p);
  const q=g.reserve(unit);
  assert.ok(q.generation>p.generation);
  assert.throws(()=>g.retire(p),/STALE_PERMIT/);
  const qi=g.beginInit(q);g.retire(q);
  assert.throws(()=>g.releaseAfterQuiescence(q),/IN_FLIGHT/);
  assert.equal(g.completeInit(qi,true),false);
  g.releaseAfterQuiescence(q);assert.deepEqual(g.usage,zero);
});
test("exact uint64 arithmetic, independent limits and 100000 rollback cycles",()=>{
  const g=new ActorSpawnQuotaGate(unit,1,1);
  for(let i=0;i<4;i++){
    const c=[...unit];c[i]=2n;
    assert.throws(()=>g.reserve(c),/QUOTA/);
  }
  assert.throws(()=>g.reserve([1,1,1,1]),/QUOTA/);
  const max=Array(4).fill((1n<<64n)-1n);
  const big=new ActorSpawnQuotaGate(max,2,1);
  const p=big.reserve(max);
  assert.throws(()=>big.reserve(unit),/QUOTA/);
  big.retire(p);big.releaseAfterQuiescence(p);
  for(let i=0;i<100000;i++){
    const q=g.reserve(unit);
    assert.equal(g.completeInit(g.beginInit(q),false),false);
    g.releaseAfterQuiescence(q);
  }
  assert.deepEqual(g.usage,zero);assert.deepEqual(big.usage,zero);
});
test("single worker asynchronous contenders cannot overbook retained promise",async()=>{
  const g=new ActorSpawnQuotaGate(unit,1,1);
  const results=await Promise.all(Array.from({length:32},async()=>{
    await Promise.resolve();
    try{return g.reserve(unit);}catch(e){assert.match(e.message,/QUOTA/);return null;}
  }));
  const winners=results.filter(Boolean);
  assert.equal(winners.length,1);
  g.retire(winners[0]);g.releaseAfterQuiescence(winners[0]);
  assert.deepEqual(g.usage,zero);
});
