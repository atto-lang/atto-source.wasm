import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena} from "../src/actor-arena.mjs";

// Host-runtime lifecycle regressions. These cannot establish compiled .atto
// actor semantics or WebAssembly engine call-stack isolation.
const arena=(actorId,incarnation=1)=>
  new ActorArena({actorId,incarnation,kind:"shared"});
const live=(a,t,value=42)=>{
  const e=a.startStack(t),f=a.pushStackFrame(t,e,4);
  a.writeStackFrame(t,e,f,Uint8Array.of(value,2,3,4));
  return {e,f};
};
const done=(a,t,{e,f})=>{
  a.popStackFrame(t,e,f);
  a.finishStack(t,e);
};

test("a suspended execution cannot resume in its issuing physical actor turn",()=>{
  const a=arena(2101),t1=a.beginTurn(),task=live(a,t1);
  const ticket=a.suspendStack(t1,task.e);
  for(let attempt=0;attempt<3;attempt++){
    assert.throws(()=>a.resumeStack(t1,ticket),/requires a new physical actor turn/);
    assert.throws(()=>a.readStackFrame(t1,task.e,task.f),/active actor stack execution authority/);
    assert.equal(a.stackExecutionCount,1);
    assert.equal(a.stackBytesInUse,4);
  }
  a.endTurn(t1);
  const t2=a.beginTurn();
  assert.equal(a.resumeStack(t2,ticket),task.e);
  assert.deepEqual([...a.readStackFrame(t2,task.e,task.f)],[42,2,3,4]);
  done(a,t2,task);
  a.endTurn(t2);a.retire();
});

test("independent suspended executions cannot leapfrog a physical turn",()=>{
  const a=arena(2102),t1=a.beginTurn();
  const first=live(a,t1,17),receipt1=a.suspendStack(t1,first.e);
  const second=live(a,t1,23),receipt2=a.suspendStack(t1,second.e);
  assert.equal(a.stackExecutionCount,2);
  for(const receipt of [receipt1,receipt2]){
    assert.throws(()=>a.resumeStack(t1,receipt),/new physical actor turn/);
  }
  a.endTurn(t1);
  const t2=a.beginTurn();
  assert.equal(a.resumeStack(t2,receipt2),second.e);
  assert.equal(a.readStackFrame(t2,second.e,second.f)[0],23);
  assert.throws(()=>a.resumeStack(t2,receipt1),/already active/);
  done(a,t2,second);
  assert.equal(a.resumeStack(t2,receipt1),first.e);
  assert.equal(a.readStackFrame(t2,first.e,first.f)[0],17);
  done(a,t2,first);
  assert.equal(a.stackExecutionCount,0);
  a.endTurn(t2);a.retire();
});

test("same-turn denial does not invalidate a ticket required by later scheduler resume",()=>{
  const a=arena(2103),t1=a.beginTurn(),task=live(a,t1,39);
  const ticket=a.suspendStack(t1,task.e);
  assert.throws(()=>a.resumeStack(t1,ticket),/new physical actor turn/);
  assert.throws(()=>a.endTurn(Object.freeze({})),/turn authority required/);
  a.endTurn(t1);
  const t2=a.beginTurn();
  a.resumeStack(t2,ticket);
  assert.equal(a.readStackFrame(t2,task.e,task.f)[0],39);
  assert.throws(()=>a.endTurn(t2),/must suspend or finish/);
  done(a,t2,task);
  assert.throws(()=>a.resumeStack(t2,ticket),/stale or consumed/);
  a.endTurn(t2);a.retire();
});

test("cancellation after denied early resume revokes ticket and stack bytes",()=>{
  const a=arena(2104),t=a.beginTurn(),task=live(a,t,88);
  const ticket=a.suspendStack(t,task.e);
  assert.throws(()=>a.resumeStack(t,ticket),/new physical actor turn/);
  a.cancelStack(t,task.e);
  assert.equal(a.stackBytesInUse,0);
  assert.equal(a.stackExecutionCount,0);
  assert.throws(()=>a.resumeStack(t,ticket),/stale or consumed/);
  const replacement=live(a,t,7);
  assert.deepEqual([...a.readStackFrame(t,replacement.e,replacement.f)],[7,2,3,4]);
  assert.throws(()=>a.readStackFrame(t,replacement.e,task.f),/foreign, stale or non-top/);
  done(a,t,replacement);
  a.endTurn(t);a.retire();
});

test("foreign actor, same actor ID new incarnation, and forged tokens are denied",()=>{
  const a=arena(2105),b=arena(2105),at=a.beginTurn(),bt=b.beginTurn();
  const task=live(a,at,51),ticket=a.suspendStack(at,task.e);
  assert.throws(()=>b.resumeStack(bt,ticket),/foreign, stale or consumed/);
  assert.throws(()=>a.resumeStack(at,structuredClone(ticket)),/foreign, stale or consumed/);
  assert.throws(()=>a.resumeStack(at,ticket),/new physical actor turn/);
  b.endTurn(bt);b.retire();
  a.endTurn(at);
  const t2=a.beginTurn();a.resumeStack(t2,ticket);done(a,t2,task);
  a.endTurn(t2);a.retire();
  const next=arena(2105,2),nt=next.beginTurn();
  assert.throws(()=>next.resumeStack(nt,ticket),/foreign, stale or consumed/);
  next.endTurn(nt);next.retire();
});

test("STOP with a lifetime pin fences all resume attempts and drains on final release",()=>{
  const a=arena(2106),t1=a.beginTurn(),task=live(a,t1,62);
  const pin=a.pinLifetime(t1),ticket=a.suspendStack(t1,task.e);
  assert.throws(()=>a.resumeStack(t1,ticket),/new physical actor turn/);
  a.endTurn(t1);a.retire();
  assert.equal(a.retired,true);
  assert.equal(a.stackExecutionCount,1,"external quiescence still pins memory");
  assert.throws(()=>a.beginTurn(),/retired/);
  a.releaseLifetimePin(pin);
  assert.equal(a.stackExecutionCount,0);
  assert.equal(a.stackBytesInUse,0);
  a.releaseLifetimePin(pin);
  const next=arena(2106,2),nt=next.beginTurn();
  assert.throws(()=>next.resumeStack(nt,ticket),/foreign, stale or consumed/);
  next.endTurn(nt);next.retire();
});

test("same-turn violation by actor A does not damage actor B",()=>{
  const a=arena(2107),b=arena(2108),at=a.beginTurn(),bt=b.beginTurn();
  const ta=live(a,at,1),tb=live(b,bt,42);
  const ticket=a.suspendStack(at,ta.e);
  assert.throws(()=>a.resumeStack(at,ticket),/new physical actor turn/);
  assert.equal(b.readStackFrame(bt,tb.e,tb.f)[0],42);
  done(b,bt,tb);
  a.endTurn(at);b.endTurn(bt);
  const t2=a.beginTurn();a.resumeStack(t2,ticket);
  assert.equal(a.readStackFrame(t2,ta.e,ta.f)[0],1);
  done(a,t2,ta);a.endTurn(t2);
  a.retire();b.retire();
});

test("resume tickets are exact opaque identities, not data-bearing capabilities",()=>{
  const a=arena(2109),t1=a.beginTurn(),task=live(a,t1,31);
  const ticket=a.suspendStack(t1,task.e);
  for(const forged of [null,undefined,0,1234,"resume",false,Object.freeze({})]){
    assert.throws(()=>a.resumeStack(t1,forged),/foreign, stale or consumed/);
  }
  assert.throws(()=>a.resumeStack(t1,ticket),/new physical actor turn/);
  a.endTurn(t1);
  const t2=a.beginTurn();a.resumeStack(t2,ticket);
  done(a,t2,task);a.endTurn(t2);a.retire();
});
