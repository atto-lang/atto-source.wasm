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
