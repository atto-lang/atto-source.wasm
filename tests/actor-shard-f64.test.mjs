import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena} from "../src/actor-arena.mjs";
import {ActorShardF64, MAX_ACTOR_SHARD_BYTES} from "../src/actor-shard-f64.mjs";

function arena(id) {
  return new ActorArena({actorId:id,incarnation:1,kind:"shared"});
}

test("actor-owned f64 shards preserve values across all four layouts", () => {
  const layouts = [
    ["aos", {}],
    ["soa", {}],
    ["aosoa", {lanes:4}],
    ["soaos", {groupWidths:[2,2]}]
  ];
  let actorId = 7000;
  for (const [layout, options] of layouts) {
    const a = arena(actorId++);
    const turn = a.beginTurn();
    const shard = new ActorShardF64(a, turn, {
      rows:7,fields:4,layout,...options
    });
    assert.ok(shard.byteLength <= MAX_ACTOR_SHARD_BYTES);
    if (layout === "aosoa") assert.equal(shard.physicalRows,8);
    if (layout === "soaos") assert.equal(shard.groupCount,2);

    for (let row=0;row<shard.rows;++row) {
      shard.write(turn,row,0,row*10);
      shard.write(turn,row,1,row+0.25);
      shard.write(turn,row,2,row+0.5);
      shard.write(turn,row,3,row===0?-0:(row===1?NaN:100+row));
    }
    assert.equal(Object.is(shard.read(turn,0,3),-0),true);
    assert.equal(Number.isNaN(shard.read(turn,1,3)),true);

    shard.integrate(turn,0,2,0.25);
    for (let row=0;row<shard.rows;++row) {
      assert.equal(shard.read(turn,row,0),row*10+(row+0.5)*0.25);
      assert.equal(shard.read(turn,row,1),row+0.25);
    }
    assert.throws(()=>shard.read(turn,7,0),/bounds/);
    shard.release(turn);
    assert.throws(()=>shard.read(turn,0,0),/released/);
    a.endTurn(turn);
    a.retire();
  }
});

test("SoAoS is physically distinct from SoA and uses grouped row subrecords", () => {
  const a = arena(7100);
  const turn = a.beginTurn();
  const soa = new ActorShardF64(a,turn,{rows:4,fields:4,layout:"soa"});
  const soaos = new ActorShardF64(a,turn,{
    rows:4,fields:4,layout:"soaos",groupWidths:[2,2]
  });
  assert.equal(soa.getPhysicalByteOffset(1,1),40);
  assert.equal(soaos.getPhysicalByteOffset(1,1),24);
  assert.equal(soa.getPhysicalByteOffset(1,2),72);
  assert.equal(soaos.getPhysicalByteOffset(1,2),80);
  soa.release(turn);
  soaos.release(turn);
  a.endTurn(turn);
  a.retire();
});

test("layout admission is bounded and fails closed before arena publication", () => {
  const a = arena(7200);
  const turn = a.beginTurn();
  assert.throws(()=>new ActorShardF64(a,turn,{rows:1,fields:1,layout:"invented"}),/unknown/);
  assert.throws(()=>new ActorShardF64(a,turn,{rows:8192,fields:2,layout:"soa"}),/64 KiB/);
  assert.throws(()=>new ActorShardF64(a,turn,{
    rows:2730,fields:3,layout:"aosoa",lanes:1024
  }),/padding/);
  assert.throws(()=>new ActorShardF64(a,turn,{
    rows:4,fields:4,layout:"aosoa",lanes:3
  }),/power of two/);
  assert.throws(()=>new ActorShardF64(a,turn,{
    rows:4,fields:4,layout:"soaos"
  }),/field groups/);
  assert.throws(()=>new ActorShardF64(a,turn,{
    rows:4,fields:4,layout:"soaos",groupWidths:[2,0,2]
  }),/positive/);
  assert.throws(()=>new ActorShardF64(a,turn,{
    rows:4,fields:4,layout:"soaos",groupWidths:[2,1]
  }),/partition/);
  assert.throws(()=>new ActorShardF64(a,turn,{
    rows:4,fields:4,layout:"soa",groupWidths:[2,2]
  }),/invalid for this layout/);
  a.endTurn(turn);
  a.retire();
});

test("arena subrange operations are bounds checked and never expose shared backing", () => {
  const a = arena(7300);
  const turn = a.beginTurn();
  const h = a.allocPersistent(turn,16);
  a.writeRange(turn,h,4,Uint8Array.from([1,2,3,4]));
  const out = new Uint8Array(4);
  a.readRangeInto(turn,h,4,out);
  assert.deepEqual([...out],[1,2,3,4]);
  assert.throws(()=>a.writeRange(turn,h,13,Uint8Array.from([1,2,3,4])),/outside allocation/);
  assert.throws(()=>a.readRangeInto(turn,h,16,new Uint8Array(1)),/outside allocation/);
  if (typeof SharedArrayBuffer === "function") {
    assert.throws(()=>a.writeRange(turn,h,0,new Uint8Array(new SharedArrayBuffer(4))),/shared backing/);
    assert.throws(()=>a.readRangeInto(turn,h,0,new Uint8Array(new SharedArrayBuffer(4))),/shared backing/);
  }
  a.endTurn(turn);
  a.retire();
});

test("shard captures native arena/DataView methods before prototype tampering", () => {
  const a = arena(7400);
  const turn = a.beginTurn();
  const shard = new ActorShardF64(a,turn,{
    rows:2,fields:2,layout:"soaos",groupWidths:[1,1]
  });
  const readDescriptor = Object.getOwnPropertyDescriptor(ActorArena.prototype,"readRangeInto");
  const writeDescriptor = Object.getOwnPropertyDescriptor(ActorArena.prototype,"writeRange");
  const getDescriptor = Object.getOwnPropertyDescriptor(DataView.prototype,"getFloat64");
  const setDescriptor = Object.getOwnPropertyDescriptor(DataView.prototype,"setFloat64");
  try {
    Object.defineProperty(ActorArena.prototype,"readRangeInto",{
      configurable:true,writable:true,value(){throw new Error("hijacked arena read");}
    });
    Object.defineProperty(ActorArena.prototype,"writeRange",{
      configurable:true,writable:true,value(){throw new Error("hijacked arena write");}
    });
    Object.defineProperty(DataView.prototype,"getFloat64",{
      configurable:true,writable:true,value(){throw new Error("hijacked DataView get");}
    });
    Object.defineProperty(DataView.prototype,"setFloat64",{
      configurable:true,writable:true,value(){throw new Error("hijacked DataView set");}
    });
    shard.write(turn,0,0,42.5);
    assert.equal(shard.read(turn,0,0),42.5);
  } finally {
    Object.defineProperty(ActorArena.prototype,"readRangeInto",readDescriptor);
    Object.defineProperty(ActorArena.prototype,"writeRange",writeDescriptor);
    Object.defineProperty(DataView.prototype,"getFloat64",getDescriptor);
    Object.defineProperty(DataView.prototype,"setFloat64",setDescriptor);
    shard.release(turn);
    a.endTurn(turn);
    a.retire();
  }
});
