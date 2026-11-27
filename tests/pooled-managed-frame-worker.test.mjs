import test from "node:test";
import assert from "node:assert/strict";
import {Worker} from "node:worker_threads";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PooledWasmActors} from "../src/pooled-actor-host.mjs";

// Actual Wasm execution compiled from independently authored LLVM IR.
// Do not count this as a compiled .atto source actor/managed guest frame.
function syntheticWasmActor(){
  const dir=mkdtempSync(join(tmpdir(),"atto-host-frame-actor-"));
  try{
    const output=join(dir,"fixture.wasm");
    const ir=[
      'target triple = "wasm32-unknown-unknown"',
      '%ActorState = type { i64 }',
      '@value = internal global i64 0',
      'define void @oreslang_wasm_actor_init() { ret void }',
      'define i64 @oreslang_wasm_actor_on_message(i64 %n) {',
      'entry:',
      '%old = load i64, ptr @value',
      '%sum = add i64 %old, %n',
      'store i64 %sum, ptr @value',
      'ret i64 %sum',
      '}',
      'define void @oreslang_wasm_actor_teardown() { ret void }',
      ''
    ].join("\n");
    const flags=["--target=wasm32","-x","ir","-O0","-nostdlib",
      "-Wl,--no-entry","-Wl,--export-memory",
      "-Wl,--export=oreslang_wasm_actor_init",
      "-Wl,--export=oreslang_wasm_actor_on_message",
      "-Wl,--export=oreslang_wasm_actor_teardown",
      "-Wl,--initial-memory=131072","-Wl,--max-memory=131072",
      "-o",output,"-"];
    const r=spawnSync(process.env.CLANG||"clang",flags,{
      input:ir,encoding:"utf8",timeout:30000,maxBuffer:2*1024*1024});
    if(r.error||r.status!==0||r.signal)
      throw Error("native clang wasm32 synthetic fixture unavailable: "+String(r.stderr||r.error));
    return readFileSync(output);
  }finally{rmSync(dir,{recursive:true,force:true})}
}
const sha=b=>createHash("sha256").update(b).digest("hex");

test("real Wasm turns on one pooled Worker acknowledge only after managed frames unwind",{
  timeout:90000
},async()=>{
  const bytes=syntheticWasmActor();
  const pool=new PooledWasmActors({workers:1,maxActors:3});
  try{
    const a=await pool.spawn(bytes,{trusted:true,expectedSha256:sha(bytes)});
    const b=await pool.spawn(bytes,{trusted:true,expectedSha256:sha(bytes)});
    assert.equal(pool.actorCount,2);
    for(let i=1;i<=12;i++){
      const [av,bv]=await Promise.all([a.send(1n),b.send(2n)]);
      assert.equal(av,BigInt(i));
      assert.equal(bv,BigInt(2*i));
    }
    await a.stop();
    assert.equal(pool.actorCount,1);
    assert.equal(pool.activeWorkerCount,1,"STOP must preserve colocated sibling");
    assert.equal(await b.send(7n),31n);
    const fresh=await pool.spawn(bytes,{trusted:true,expectedSha256:sha(bytes)});
    assert.equal(await fresh.send(42n),42n,"restart has no old heap or frame data");
    assert.equal(await b.send(1n),32n);
    await fresh.stop();
    await b.stop();
    assert.equal(pool.actorCount,0);
  }finally{await pool.close()}
});

test("fabricated Worker ACK with live managed frames quarantines carrier before settling turn",{
  timeout:90000
},async()=>{
  const bytes=syntheticWasmActor();
  const pool=new PooledWasmActors({workers:1,maxActors:1,timeoutMs:5000});
  const original=Worker.prototype.postMessage;
  try{
    const actor=await pool.spawn(bytes,{trusted:true,expectedSha256:sha(bytes)});
    let injected=false;
    Worker.prototype.postMessage=function(message,...rest){
      if(!injected&&message?.kind==="send"){
        injected=true;
        // No physical Wasm turn is dispatched. A forged host-side ACK
        // cannot claim an executor whose managed frame remains live.
        queueMicrotask(()=>this.emit("message",{
          kind:"ack",id:message.id,incarnation:message.incarnation,
          ticket:message.ticket,result:123n,
          frame:{schemaVersion:1,frameBytes:16,activeExecutions:1,
            frameBytesInUse:16,retired:false}
        }));
        return;
      }
      return original.call(this,message,...rest);
    };
    await assert.rejects(actor.send(1n),/invalid managed actor frame quiescence receipt/);
    assert.equal(injected,true);
    assert.equal(pool.actorCount,0,"actor identity released only after real Worker exit");
  }finally{
    Worker.prototype.postMessage=original;
    await pool.close();
  }
});

test("fabricated Worker ACK without any managed-frame witness is rejected",{
  timeout:90000
},async()=>{
  const bytes=syntheticWasmActor();
  const pool=new PooledWasmActors({workers:1,maxActors:1,timeoutMs:5000});
  const original=Worker.prototype.postMessage;
  try{
    const actor=await pool.spawn(bytes,{trusted:true,expectedSha256:sha(bytes)});
    Worker.prototype.postMessage=function(message,...rest){
      if(message?.kind==="send"){
        queueMicrotask(()=>this.emit("message",{
          kind:"ack",id:message.id,incarnation:message.incarnation,
          ticket:message.ticket,result:1n
        }));
        return;
      }
      return original.call(this,message,...rest);
    };
    await assert.rejects(actor.send(1n),/invalid managed actor frame quiescence receipt/);
    assert.equal(pool.actorCount,0);
  }finally{
    Worker.prototype.postMessage=original;
    await pool.close();
  }
});
