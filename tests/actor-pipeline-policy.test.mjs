import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {ActorPipelinePolicy, actorRouteHash64} from "../src/actor-pipeline-policy.mjs";
const stages = [{id:"source",type:"Producer",role:"readable",outbound:"Event"},
  ...["a","b","c"].map(id=>({id:"worker-"+id,type:"Worker",role:"writable",inbound:"Event"}))];
const edges = ["a","b","c"].map(id=>({source:"source",target:"worker-"+id,payload:"Event"}));
test("five-backend fanout, round robin and fixed key vectors", () => {
  const plan = new ActorPipelinePolicy(stages, edges);
  assert.deepEqual(plan.forwardAll("source").map(x=>x.target), ["worker-a","worker-b","worker-c"]);
  assert.deepEqual(Array.from({length:6},()=>plan.forwardRoundRobin("source").target),
    ["worker-a","worker-b","worker-c","worker-a","worker-b","worker-c"]);
  assert.throws(()=>plan.forward("source"),/ambiguous/);
  assert.equal(plan.forwardTo("source","worker-b").target,"worker-b");
  assert.throws(()=>plan.forwardTo("source","worker-z"),/not connected/);
  for (const [key,destination,hash] of [
    ["customer-7","worker-a","660308ab83c6fdf1"],["alpha","worker-a","8ac625bb85ed202b"],
    ["beta","worker-c","7627619b954620a7"],["🌍","worker-a","ff430438753bca3b"],
    ["","worker-c","cbf29ce484222325"]]) {
    assert.equal(actorRouteHash64(key).toString(16),hash);
    assert.equal(plan.forwardByKey("source",key).target,destination);
  }
  plan.close(); assert.throws(()=>plan.forwardAll("source"),/retired/);
  assert.equal(new ActorPipelinePolicy(stages,edges).forwardRoundRobin("source").target,"worker-a");
});
test("reject duplicate, invalid UTF-8, wrong type, unknown target, cycles", () => {
  const denied=(s,e)=>assert.throws(()=>new ActorPipelinePolicy(s,e));
  denied(stages,[edges[0],edges[0]]);
  denied(stages,[{...edges[0],payload:"Wrong"}]);
  denied(stages,[{...edges[0],target:"unknown"}]);
  denied([{...stages[0],id:"\0"},...stages.slice(1)],edges);
  denied([{...stages[0],type:"\ud800"},...stages.slice(1)],edges);
  denied([{...stages[0],id:"é".repeat(129)},...stages.slice(1)],edges);
  denied([{...stages[0]}, {...stages[0]}],edges);
  denied([{id:"a",type:"T",role:"transform",inbound:"Event",outbound:"Event"},
          {id:"b",type:"T",role:"transform",inbound:"Event",outbound:"Event"}],
          [{source:"a",target:"b",payload:"Event"},{source:"b",target:"a",payload:"Event"}]);
  assert.throws(()=>actorRouteHash64("\ud800"),/Unicode/);
  assert.throws(()=>actorRouteHash64("🌍".repeat(1025)),/byte budget/);
});

test("load canonical routing vectors checked byte-identically across five repos", () => {
  const fixture = JSON.parse(readFileSync(
    new URL("../contracts/v1/actor-pipeline-routing-v1.json", import.meta.url), "utf8"));
  assert.equal(fixture.schema, "oreslang.actor-pipeline-routing.v1");
  const plan = new ActorPipelinePolicy(
    fixture.graph.stages.map(s=>({
      id:s.id,type:s.actor_type,role:s.role,inbound:s.inbound,outbound:s.outbound})),
    fixture.graph.connections);
  assert.deepEqual(plan.forwardAll("producer-1").map(e=>e.target),
    fixture.operations.forward_all);
  assert.deepEqual(fixture.operations.forward_round_robin.map(() =>
    plan.forwardRoundRobin("producer-1").target), fixture.operations.forward_round_robin);
  for (const v of fixture.operations.by_key) {
    assert.equal(actorRouteHash64(v.key).toString(16).padStart(16,"0"),v.fnv1a64_hex);
    assert.equal(plan.forwardByKey("producer-1",v.key).target,v.target);
  }
});

test("bounded UTF-8 and NUL semantics are byte-exact, not UTF-16-length based", () => {
  assert.equal(actorRouteHash64(""), 0xcbf29ce484222325n);
  assert.equal(actorRouteHash64("\0"), 0xaf63bd4c8601b7dfn);
  assert.doesNotThrow(() => actorRouteHash64("🌍".repeat(1024)));
  assert.throws(() => actorRouteHash64("🌍".repeat(1025)), /byte budget/);
  assert.throws(() => actorRouteHash64("\ud800"), /Unicode/);
  assert.throws(() => actorRouteHash64("\udc00"), /Unicode/);
  const unicodeStages = stages.map((s, i) =>
    i === 0 ? {...s, id: "é".repeat(128)} : s);
  const unicodeEdges = edges.map(e=>({...e, source:"é".repeat(128)}));
  assert.doesNotThrow(() => new ActorPipelinePolicy(unicodeStages, unicodeEdges));
  assert.throws(() => new ActorPipelinePolicy(
    [{...stages[0], id:"é".repeat(129)}, ...stages.slice(1)],edges), /byte budget/);
  assert.throws(() => new ActorPipelinePolicy(
    [{...stages[0], id:"source\0spoof"}, ...stages.slice(1)],edges), /identifier/);
});
test("routing identity is immutable after graph publication and round-robin remains fair", () => {
  const mutable = edges.map(e=>({...e}));
  const plan = new ActorPipelinePolicy(stages, mutable);
  mutable[0].target="attacker";
  mutable.push({...edges[0], target:"other"});
  assert.deepEqual(plan.forwardAll("source").map(e=>e.target),
    ["worker-a","worker-b","worker-c"]);
  assert.throws(() => { plan.forwardAll("source")[0].target = "attacker"; },
    TypeError);
  const counts = new Map();
  for (let i = 0; i < 12000; i++) {
    const name=plan.forwardRoundRobin("source").target;
    counts.set(name,(counts.get(name)||0)+1);
  }
  assert.deepEqual([...counts.entries()].sort(),
    [["worker-a",4000],["worker-b",4000],["worker-c",4000]]);
  plan.close();
  assert.throws(() => plan.forwardTo("source","worker-a"), /retired/);
  assert.throws(() => plan.forwardRoundRobin("source"), /retired/);
});
test("reject unknown or retired keyed routes before parsing invalid key bytes", () => {
  const plan = new ActorPipelinePolicy(stages, edges);
  assert.throws(() => plan.forwardByKey("unknown-source", "\ud800"),
    /no downstream/);
  plan.close();
  assert.throws(() => plan.forwardByKey("source", "\ud800"),
    /retired/);
});
test("diamond fan-in is valid while cycles, dangling ports and self-edges are rejected", () => {
  const v=[
    {id:"src",type:"Producer",role:"readable",outbound:"P"},
    {id:"a",type:"Worker",role:"transform",inbound:"P",outbound:"P"},
    {id:"b",type:"Worker",role:"transform",inbound:"P",outbound:"P"},
    {id:"sink",type:"Sink",role:"writable",inbound:"P"}
  ];
  const e=[{source:"src",target:"a",payload:"P"},{source:"src",target:"b",payload:"P"},
    {source:"a",target:"sink",payload:"P"},{source:"b",target:"sink",payload:"P"}];
  assert.equal(new ActorPipelinePolicy(v,e).forwardAll("src").length,2);
  assert.throws(()=>new ActorPipelinePolicy(v,[...e,{source:"a",target:"b",payload:"P"},
    {source:"b",target:"a",payload:"P"}]),/cyclic/);
  assert.throws(()=>new ActorPipelinePolicy(v,[...e,{source:"a",target:"a",payload:"P"}]),
    /unknown or mistyped/);
  assert.throws(()=>new ActorPipelinePolicy([...v,{id:"orphan",type:"Orphan",
    role:"readable",outbound:"P"}],e),/missing port/);
});

test("endpoint tuples cannot collide through delimiters or Unicode normalization", () => {
  const s = [
    {id:"a:b",type:"Source",role:"readable",outbound:"E"},
    {id:"a",type:"Source",role:"readable",outbound:"E"},
    {id:"c",type:"Sink",role:"writable",inbound:"E"},
    {id:"b:c",type:"Sink",role:"writable",inbound:"E"}
  ];
  const e = [
    {source:"a:b",target:"c",payload:"E"},
    {source:"a",target:"b:c",payload:"E"}
  ];
  const plan = new ActorPipelinePolicy(s,e);
  assert.equal(plan.forward("a:b").target,"c");
  assert.equal(plan.forward("a").target,"b:c");
  assert.throws(()=>new ActorPipelinePolicy(s,[...e,e[0]]),/duplicate/);
  // Canonically equivalent user strings are still distinct instance IDs.
  const visuallySimilar=[
    {id:"é",type:"Source",role:"readable",outbound:"E"},
    {id:"e\u0301",type:"Source",role:"readable",outbound:"E"},
    {id:"c",type:"Sink",role:"writable",inbound:"E"},
    {id:"d",type:"Sink",role:"writable",inbound:"E"}
  ];
  const unicode=new ActorPipelinePolicy(visuallySimilar,[
    {source:"é",target:"c",payload:"E"},
    {source:"e\u0301",target:"d",payload:"E"}]);
  assert.equal(unicode.forward("é").target,"c");
  assert.equal(unicode.forward("e\u0301").target,"d");
});
test("bound graph size before topology allocation and reject unknown role", () => {
  assert.throws(()=>new ActorPipelinePolicy(
    Array.from({length:1025},(_,i)=>({id:"s"+i,type:"S",role:"readable",outbound:"E"})),
    edges),/budget/);
  assert.throws(()=>new ActorPipelinePolicy(stages,
    Array.from({length:4097},()=>edges[0])),/budget/);
  assert.throws(()=>new ActorPipelinePolicy(
    [{...stages[0],role:"controller"},...stages.slice(1)],edges),/role/);
  assert.throws(()=>new ActorPipelinePolicy(
    [{...stages[0],id:"🌍".repeat(65)},...stages.slice(1)],edges),/byte budget/);
  const exactly256="🌍".repeat(64);
  assert.doesNotThrow(()=>new ActorPipelinePolicy(
    [{...stages[0],id:exactly256},...stages.slice(1)],
    edges.map(e=>({...e,source:exactly256}))));
});
