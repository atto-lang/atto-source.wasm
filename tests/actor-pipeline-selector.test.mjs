import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {ActorPipelineSelector, routeKeySlot} from "../src/actor-pipeline-selector.mjs";

const stages = () => [
  {id:"source", actorType:"Producer", role:"readable", inbound:"", outbound:"Event"},
  ...["worker-a","worker-b","worker-c"].map(id => (
    {id, actorType:"Worker", role:"writable", inbound:"Event", outbound:""}))
];
const edges = () => ["worker-a","worker-b","worker-c"].map(target => (
  {source:"source", target, payload:"Event"}));
test("v1 exact unsigned FNV-1a 64-bit slot vectors", () => {
  const contract = JSON.parse(readFileSync(new URL(
    "../contracts/v1/actor-pipeline-routing-v1.json", import.meta.url), "utf8"));
  assert.equal(contract.schema, "oreslang.actor-pipeline-routing.v1");
  for (const vector of contract.operations.by_key)
    assert.equal(["worker-a","worker-b","worker-c"][routeKeySlot(vector.key,3)],
      vector.target, vector.key);
  for (const [key, slot] of [["customer-7",0],["alpha",0],["beta",2],["🌍",0],["",2]])
    assert.equal(routeKeySlot(key, 3), slot, key);
  assert.throws(() => routeKeySlot("\ud800",3));
  assert.throws(() => routeKeySlot("e".repeat(4097),3));
  assert.equal(routeKeySlot("e".repeat(4096),3)>=0, true);
});
test("v1 deterministic DAG fanout, named, strict RR and generation reset", () => {
  const p = new ActorPipelineSelector(stages(),edges(),7);
  assert.deepEqual(p.forwardAll("source").map(e=>e.target),
    ["worker-a","worker-b","worker-c"]);
  assert.throws(()=>p.forward("source"));
  assert.equal(p.forwardTo("source","worker-b").target,"worker-b");
  assert.throws(()=>p.forwardTo("source","worker-z"));
  assert.throws(()=>p.forwardTo("worker-b","source"));
  p.requireIngressRoot("source");
  assert.throws(()=>p.requireIngressRoot("worker-a"));
  assert.deepEqual(Array.from({length:6},()=>p.forwardRoundRobin("source").target),
    ["worker-a","worker-b","worker-c","worker-a","worker-b","worker-c"]);
  assert.equal(p.forwardByKey("source","beta").target,"worker-c");
  assert.throws(()=>p.advanceGeneration(8));
  assert.equal(p.generation,7);
  p.advanceGeneration(8,{quiescent:true});
  assert.equal(p.forwardRoundRobin("source").target,"worker-a");
  assert.throws(()=>p.advanceGeneration(8,{aborted:true}));
  assert.throws(()=>p.forwardAll("worker-a"));
});
test("v1 rejects malformed nominal graph components and cycles", () => {
  const invalid = (fn) => assert.throws(fn);
  invalid(()=>new ActorPipelineSelector([...stages(),stages()[1]],edges()));
  invalid(()=>new ActorPipelineSelector(
    stages().map((s,i)=>i===1?{...s,id:"\0evil"}:s),edges()));
  invalid(()=>new ActorPipelineSelector(
    stages().map((s,i)=>i===1?{...s,id:"\ud800"}:s),edges()));
  invalid(()=>new ActorPipelineSelector(
    stages().map((s,i)=>i===1?{...s,id:"é".repeat(129)}:s),edges()));
  invalid(()=>new ActorPipelineSelector(stages(),[...edges(),edges()[0]]));
  invalid(()=>new ActorPipelineSelector(stages(),[
    {...edges()[0],target:"source"},...edges().slice(1)]));
  invalid(()=>new ActorPipelineSelector(stages(),[
    {...edges()[0],payload:"Other"},...edges().slice(1)]));
  const cyclic = [
    {id:"a",actorType:"Node",role:"duplex",inbound:"X",outbound:"X"},
    {id:"b",actorType:"Node",role:"duplex",inbound:"X",outbound:"X"},
    {id:"root",actorType:"Root",role:"readable",inbound:"",outbound:"X"}
  ];
  invalid(()=>new ActorPipelineSelector(cyclic,[
    {source:"root",target:"a",payload:"X"},
    {source:"a",target:"b",payload:"X"},
    {source:"b",target:"a",payload:"X"}]));
  const p = new ActorPipelineSelector(stages(),edges());
  assert.ok(Object.isFrozen(p.forwardAll("source")));
  assert.ok(Object.isFrozen(p.forwardAll("source")[0]));
});
