import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena} from "../src/actor-arena.mjs";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {withManagedActorTurn, validManagedFrameReceipt} from "../src/pooled-actor-frame-turn.mjs";

// These tests exercise host runtime memory, not compiler-lowered .atto frames.
const make = (id, incarnation=1) => new ActorArena({actorId:id,incarnation,kind:"shared"});
const empty = arena => {
  assert.equal(arena.stackExecutionCount,0,"no live logical stack after guest ACK");
  assert.equal(arena.stackBytesInUse,0,"no live host frame bytes after guest ACK");
};

test("synchronous signed-i64 managed turns isolate and completely unwind host frames",()=>{
  const actor=make(5201);
  for(let i=1;i<=30;i++){
    const result=withManagedActorTurn(actor,()=>{
      assert.equal(actor.stackExecutionCount,1);
      assert.equal(actor.stackBytesInUse,16);
      return BigInt(i);
    },{input:BigInt(i),resultType:"i64"});
    assert.equal(result.value,BigInt(i));
    assert.deepEqual(result.frame,{
      schemaVersion:1,frameBytes:16,activeExecutions:0,frameBytesInUse:0
    });
    empty(actor);
  }
  actor.retire();assert.equal(actor.retired,true);
});

test("ABI-admitted i64 signed endpoints are recorded without truncation",()=>{
  const actor=make(5202);
  const ends=[-(1n<<63n), (1n<<63n)-1n, 0n, -7n];
  for(const input of ends){
    assert.equal(withManagedActorTurn(actor,()=>input,{input,resultType:"i64"}).value,input);
    empty(actor);
  }
  actor.retire();
});

test("trap/cancellation scrubs frame state and leaves another actor intact",()=>{
  const left=make(5203),right=make(5204);
  assert.throws(()=>withManagedActorTurn(left,()=>{throw Error("guest trap");},
    {input:3n,resultType:"i64"}),/guest trap/);
  empty(left);
  assert.equal(withManagedActorTurn(right,()=>42n,{input:2n,resultType:"i64"}).value,42n);
  empty(right);
  assert.equal(withManagedActorTurn(left,()=>7n,{input:1n,resultType:"i64"}).value,7n);
  empty(left);
  left.retire();right.retire();
});

test("invalid i64 result is terminal for that turn without persistent frame authority",()=>{
  const actor=make(5205);
  for(const value of [0, "42", null, 1n<<63n, -(1n<<63n)-1n, undefined]){
    assert.throws(()=>withManagedActorTurn(actor,()=>value,{resultType:"i64"}),
      /managed actor result must be signed i64/);
    empty(actor);
  }
  actor.retire();
});

test("async promise result cannot retain an admitted physical actor turn",()=>{
  const actor=make(5206);
  assert.throws(()=>withManagedActorTurn(actor,()=>Promise.resolve(42n),
    {resultType:"i64"}),/managed actor result must be signed i64/);
  empty(actor);
  assert.throws(()=>withManagedActorTurn(actor,()=>Promise.resolve(),
    {resultType:"void"}),/actor lifecycle entry must return void/);
  empty(actor);
  actor.retire();
});

test("same-actor reentrant invocation is denied while outer turn remains owned",()=>{
  const actor=make(5207);
  const outer=withManagedActorTurn(actor,()=>{
    assert.throws(()=>withManagedActorTurn(actor,()=>0n,{resultType:"i64"}),
      /actor already admitted/);
    assert.equal(actor.stackExecutionCount,1);
    return 11n;
  },{resultType:"i64"});
  assert.equal(outer.value,11n);
  empty(actor);
  actor.retire();
});

test("void init and STOP guest calls receive independent, fully unwound frames",()=>{
  const actor=make(5208);
  const startup=withManagedActorTurn(actor,()=>undefined);
  assert.equal(startup.value,undefined);empty(actor);
  const data=withManagedActorTurn(actor,()=>42n,{input:2n,resultType:"i64"});
  assert.equal(data.value,42n);empty(actor);
  const stop=withManagedActorTurn(actor,()=>undefined);
  assert.equal(stop.value,undefined);empty(actor);
  actor.retire();
  assert.throws(()=>withManagedActorTurn(actor,()=>undefined),/actor arena retired/);
});

test("invalid caller-supplied ABI inputs are denied before turn allocation",()=>{
  const actor=make(5209);
  assert.throws(()=>withManagedActorTurn(actor,()=>42n,{input:1n<<63n,resultType:"i64"}),
    /input must be signed i64/);
  assert.throws(()=>withManagedActorTurn(actor,()=>42n,{input:-((1n<<63n)+1n),resultType:"i64"}),
    /input must be signed i64/);
  assert.throws(()=>withManagedActorTurn(actor,()=>42n,{input:"42",resultType:"i64"}),
    /input must be signed i64/);
  assert.throws(()=>withManagedActorTurn(actor,()=>42n,{resultType:"f64"}),
    /unsupported managed actor result ABI/);
  assert.throws(()=>withManagedActorTurn(actor,()=>42n,{resultType:"void"}),
    /actor lifecycle entry must return void/);
  empty(actor);
  actor.retire();
});

test("one actor's retirement never revives stale frame leases across incarnations",()=>{
  const first=make(5210,1),next=make(5210,2);
  withManagedActorTurn(first,()=>21n,{resultType:"i64"});
  empty(first);first.retire();
  assert.throws(()=>withManagedActorTurn(first,()=>22n,{resultType:"i64"}),
    /actor arena retired/);
  assert.equal(withManagedActorTurn(next,()=>42n,{resultType:"i64"}).value,42n);
  empty(next);next.retire();
});

test("invalid actor or invocation authority is rejected",()=>{
  const actor=make(5211);
  assert.throws(()=>withManagedActorTurn({},()=>42n,{resultType:"i64"}),
    /trusted actor arena required/);
  assert.throws(()=>withManagedActorTurn(actor,null,{resultType:"i64"}),
    /synchronous Wasm invocation required/);
  empty(actor);actor.retire();
});

test("canonical .atto source is byte-identical to legacy actor and pinned at its Git blob",async()=>{
  const canonical=await readFile(new URL("./fixtures/wasm32-single-source-actor.atto",import.meta.url));
  const legacy=await readFile(new URL("./fixtures/wasm32-single-source-actor.ores",import.meta.url));
  assert.deepEqual(canonical,legacy);
  const actual=createHash("sha1")
    .update(Buffer.from("blob "+canonical.length+"\0","ascii")).update(canonical).digest("hex");
  assert.equal(actual,"adfc0b43463d7ce92d32a4b1b63602f91e527329");
});

test("closed Worker frame ACK rejects missing, dirty, extra and wrong-retirement receipts",()=>{
  const good={schemaVersion:1,frameBytes:16,activeExecutions:0,frameBytesInUse:0,retired:false};
  assert.equal(validManagedFrameReceipt(good,false),true);
  assert.equal(validManagedFrameReceipt({...good,retired:true},true),true);
  for(const bad of [undefined,null,[],{}, {...good,activeExecutions:1}, {...good,frameBytesInUse:16}, {...good,frameBytes:8}, {...good,schemaVersion:2}, {...good,retired:true}, {...good,extra:0}])
    assert.equal(validManagedFrameReceipt(bad,false),false);
  assert.equal(validManagedFrameReceipt(good,true),false);
});

test("synchronous bridge cannot consume or cancel a prior suspended execution",()=>{
  const actor=make(5212),turn=actor.beginTurn(),execution=actor.startStack(turn);
  const frame=actor.pushStackFrame(turn,execution,1);
  actor.writeStackFrame(turn,execution,frame,Uint8Array.of(42));
  const ticket=actor.suspendStack(turn,execution);actor.endTurn(turn);
  assert.throws(()=>withManagedActorTurn(actor,()=>42n,{resultType:"i64"}),/no prior live logical execution/);
  assert.equal(actor.stackExecutionCount,1);assert.equal(actor.stackBytesInUse,1);
  const next=actor.beginTurn();assert.equal(actor.resumeStack(next,ticket),execution);
  assert.equal(actor.readStackFrame(next,execution,frame)[0],42);
  actor.popStackFrame(next,execution,frame);actor.finishStack(next,execution);actor.endTurn(next);
  empty(actor);actor.retire();
});
