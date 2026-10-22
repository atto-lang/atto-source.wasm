import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena} from "../src/actor-arena.mjs";
import {ActorMixedShard} from "../src/actor-mixed-shard.mjs";

const fields=[{name:"id",type:"u32"},{name:"x",type:"f64"},
  {name:"flag",type:"bool"},{name:"next",type:"ref32"}];
const groups=[["id","flag"],["x","next"]];
const cases=[
  ["aos",{},72,72],
  ["soa",{},51,56],
  ["aosoa",{tileWidth:4},144,144],
  ["soaos",{groups},72,72]
];
test("actor-owned wasm32 pages store mixed width values under all four layouts",()=>{
  let id=9000;
  for(const [layout,extra,payload,allocation] of cases){
    const a=new ActorArena({actorId:id++,incarnation:1,kind:"shared"});
    const turn=a.beginTurn();
    const rows=layout==="aosoa"?5:3;
    const shard=new ActorMixedShard(a,turn,{fields,rows,layout,...extra});
    assert.equal(shard.byteLength,allocation);
    assert.equal(shard.payloadBytes,payload);
    const occupied=new Set();
    for(let row=0;row<rows;row++){
      shard.write(turn,row,"id",4294967295-row);
      shard.write(turn,row,"x",row===0?-0:row===1?NaN:row+0.25);
      shard.write(turn,row,"flag",row%2===0);
      shard.write(turn,row,"next",row+1);
      for(const f of shard.fields){
        const addr=shard.address(row,f.name);
        assert.equal(addr.absoluteByteOffset%f.alignment,0);
        for(let byte=0;byte<f.bytes;byte++){
          const pos=addr.absoluteByteOffset+byte;
          assert.equal(occupied.has(pos),false);
          occupied.add(pos);
        }
      }
    }
    assert.equal(shard.read(turn,0,"id"),4294967295);
    assert.equal(Object.is(shard.read(turn,0,"x"),-0),true);
    assert.equal(Number.isNaN(shard.read(turn,1,"x")),true);
    assert.equal(shard.read(turn,2,"flag"),true);
    assert.equal(shard.read(turn,rows-1,"next"),rows);
    assert.throws(()=>shard.write(turn,0,"id",-1),/unsigned/);
    assert.throws(()=>shard.write(turn,0,"next",0x1_0000_0000),/unsigned/);
    assert.throws(()=>shard.write(turn,0,"flag",1),/bool/);
    assert.throws(()=>shard.address(rows,"id"),/bounds/);
    shard.release(turn);
    assert.throws(()=>shard.read(turn,0,"id"),/released/);
    a.endTurn(turn);a.retire();
  }
});
test("two independent actors cannot dereference each other's mixed-width backing",()=>{
  const a=new ActorArena({actorId:9200,incarnation:1,kind:"shared"});
  const b=new ActorArena({actorId:9201,incarnation:1,kind:"shared"});
  const at=a.beginTurn(),bt=b.beginTurn();
  const options={fields,rows:2,layout:"soaos",groups};
  const left=new ActorMixedShard(a,at,options),right=new ActorMixedShard(b,bt,options);
  left.write(at,0,"id",11);right.write(bt,0,"id",99);
  assert.equal(left.read(at,0,"id"),11);
  assert.equal(right.read(bt,0,"id"),99);
  assert.throws(()=>left.read(bt,0,"id"));
  assert.throws(()=>right.write(at,0,"id",12));
  left.release(at);right.release(bt);
  a.endTurn(at);b.endTurn(bt);a.retire();b.retire();
});
test("numeric mixed-width ECS kernel operates on wasm arena bytes",()=>{
  const a=new ActorArena({actorId:9300,incarnation:1,kind:"shared"});
  const t=a.beginTurn();
  const schema=[{name:"id",type:"u32"},{name:"pos",type:"f64"},
    {name:"vel",type:"f64"},{name:"flag",type:"bool"}];
  const store=new ActorMixedShard(a,t,{fields:schema,rows:7,layout:"soaos",
    groups:[["id","flag"],["pos","vel"]]});
  for(let r=0;r<7;r++){store.write(t,r,"id",r+10);store.write(t,r,"pos",r*10);store.write(t,r,"vel",r+0.5);store.write(t,r,"flag",true);}
  store.integrate(t,"pos","vel",0.25);
  for(let r=0;r<7;r++){
    assert.equal(store.read(t,r,"pos"),r*10+(r+0.5)*0.25);
    assert.equal(store.read(t,r,"id"),r+10);
  }
  assert.throws(()=>store.integrate(t,"id","vel",0.25),/distinct f64/);
  store.release(t);a.endTurn(t);a.retire();
});
test("malicious schema accessors fail closed before actor native memory allocation",()=>{
  const a=new ActorArena({actorId:9450,incarnation:1,kind:"shared"});
  const turn=a.beginTurn();
  const hostile={type:"u32"};
  Object.defineProperty(hostile,"name",{get(){
    throw new Error("untrusted field accessor must not execute");
  }});
  assert.throws(()=>new ActorMixedShard(a,turn,{
    fields:[hostile],rows:1,layout:"aos"
  }),/own data/);
  const group=[["id"]];
  Object.defineProperty(group,0,{configurable:true,get(){
    throw new Error("untrusted group accessor must not execute");
  }});
  assert.throws(()=>new ActorMixedShard(a,turn,{
    fields:[{name:"id",type:"u32"}],rows:1,layout:"soaos",groups:group
  }),/own data/);
  const sparse=[];
  sparse.length=1;
  assert.throws(()=>new ActorMixedShard(a,turn,{
    fields:sparse,rows:1,layout:"aos"
  }),/own data/);
  const good=new ActorMixedShard(a,turn,{
    fields:[{name:"id",type:"u32"}],rows:2,layout:"soa"
  });
  good.write(turn,0,"id",42);
  assert.equal(good.read(turn,0,"id"),42);
  good.release(turn);a.endTurn(turn);a.retire();
});

test("invalid and oversized layouts reject before arena allocation",()=>{
  const a=new ActorArena({actorId:9400,incarnation:1,kind:"shared"});
  const t=a.beginTurn();
  const options={fields,rows:3,layout:"soa"};
  for(const bad of [
    {rows:100000},{layout:"aosoa",tileWidth:3},
    {layout:"soaos",groups:[["id"],["x"]]},
    {layout:"soaos",groups:[["id","x"],["x","flag","next"]]},
    {fields:[{name:"x",type:"hostObject"}]},
    {fields:[{name:"id",type:"u32"},{name:"id",type:"f64"}]}
  ])assert.throws(()=>new ActorMixedShard(a,t,{...options,...bad}));
  const stillWorks=new ActorMixedShard(a,t,options);
  stillWorks.write(t,0,"id",42);
  assert.equal(stillWorks.read(t,0,"id"),42);
  stillWorks.release(t);a.endTurn(t);a.retire();
});
