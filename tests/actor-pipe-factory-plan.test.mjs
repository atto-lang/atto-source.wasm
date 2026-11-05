import test from "node:test";
import assert from "node:assert/strict";
import { planActorPipeFactory, planActorConnectEdge } from "../src/actor-pipe-factory-plan.mjs";

const stages = () => [
  {id:"reader-1", actorType:"Reader", role:"readable", inbound:"", outbound:"Bytes"},
  {id:"transformer-1", actorType:"Transformer", role:"transform", inbound:"Bytes", outbound:"Rows"},
  {id:"writer-1", actorType:"Writer", role:"writable", inbound:"Rows", outbound:""}
];

test("Actor.pipe constructor and zero-arg type forms lower to one ordered static chain", () => {
  // Both forms must lower to the SAME compiler-generated descriptor sequence;
  // a host-only planner cannot itself parse either AttoLang source form.
  const constructorForm = planActorPipeFactory(stages(), 7);
  const typeForm = planActorPipeFactory(stages(), 7);
  assert.deepEqual(constructorForm.edges, [
    {source:"reader-1", target:"transformer-1", payload:"Bytes"},
    {source:"transformer-1", target:"writer-1", payload:"Rows"}
  ]);
  assert.deepEqual(constructorForm.edges, typeForm.edges);
  assert.equal(constructorForm.generation, 7);
  assert.equal(constructorForm.selector.forward("reader-1").target, "transformer-1");
  assert.equal(constructorForm.selector.forward("transformer-1").target, "writer-1");
  assert.ok(Object.isFrozen(constructorForm.stages));
  assert.ok(Object.isFrozen(constructorForm.edges));
  assert.ok(Object.isFrozen(constructorForm.edges[0]));
});

test("Actor.connect shapes existing typed actor references but cannot authorize or spawn them", () => {
  const s = stages();
  const edge = planActorConnectEdge(s[1], s[2]);
  assert.deepEqual(edge, {source:"transformer-1", target:"writer-1", payload:"Rows"});
  assert.ok(Object.isFrozen(edge));
  assert.throws(() => planActorConnectEdge(s[2], s[0]), /incompatible/);
  assert.throws(() => planActorConnectEdge(s[0], s[2]), /incompatible/);
  assert.throws(() => planActorConnectEdge(s[1], {...s[1]}), /incompatible/);
});

test("reject stage and port mismatch before publication", () => {
  const s = stages();
  s[1].inbound = "Packet";
  assert.throws(() => planActorPipeFactory(s), /incompatible/);
  const dup = stages();
  dup[1].id = dup[0].id;
  assert.throws(() => planActorPipeFactory(dup), /duplicate actor instance/);
  const unsupported = stages();
  unsupported[1].role = "supervisor";
  assert.throws(() => planActorPipeFactory(unsupported), /stage role/);
  const invalidRead = stages();
  invalidRead[0].inbound = "Bytes";
  assert.throws(() => planActorPipeFactory(invalidRead), /stage role/);
});

test("never evaluate stage getters, constructors or caller-provided array iterators", () => {
  let invoked = 0;
  const s = stages();
  Object.defineProperty(s[1], "id", {get() { invoked++; return "stolen"; }});
  assert.throws(() => planActorPipeFactory(s), /own data properties/);
  assert.equal(invoked, 0);

  const a = stages();
  Object.defineProperty(a, "1", {get() { invoked++; return stages()[1]; }});
  assert.throws(() => planActorPipeFactory(a), /own data properties/);
  assert.equal(invoked, 0);

  const b = stages();
  Object.defineProperty(b, Symbol.iterator, {value() {
    invoked++; throw new Error("must not iterate caller stages");
  }});
  assert.equal(planActorPipeFactory(b).edges.length, 2);
  assert.equal(invoked, 0);
  assert.throws(() => planActorPipeFactory([stages()[0], () => { invoked++; }, stages()[2]]),
    /compiler-owned data/);
  assert.equal(invoked, 0);
});

test("snapshot input metadata and generated edges are immutable", () => {
  const input = stages();
  const p = planActorPipeFactory(input);
  input[0].id = "forged";
  input[1].inbound = "Other";
  input[2].id = "redirected";
  input.push({...input[2]});
  assert.equal(p.selector.forward("reader-1").target, "transformer-1");
  assert.equal(p.selector.forward("transformer-1").target, "writer-1");
  assert.equal(p.stages[0].id, "reader-1");
  assert.throws(() => {p.edges[0].target = "redirected";}, TypeError);
  assert.throws(() => {p.stages.push(stages()[0]);}, TypeError);
});

test("bounded metadata, unicode, generations and stage counts", () => {
  assert.throws(() => planActorPipeFactory([]), /stage budget/);
  assert.throws(() => planActorPipeFactory([stages()[0]]), /stage budget/);
  assert.throws(() => planActorPipeFactory(Array(3)), /own data properties/);
  assert.throws(() => planActorPipeFactory(stages(), 0), /generation/);
  assert.throws(() => planActorPipeFactory(stages(), 1.2), /generation/);
  for (const bad of ["bad\0id", "\ud800", "🌍".repeat(65)]) {
    const s = stages(); s[0].id = bad;
    assert.throws(() => planActorPipeFactory(s));
  }
  const s = stages();
  s[1].actorType = "";
  assert.throws(() => planActorPipeFactory(s), /identifier/);

  const count = 1024;
  const chain = Array.from({length:count}, (_, i) => ({
    id:"node-" + i, actorType:"Stage", role:i===0?"readable":i===count-1?"writable":"transform",
    inbound:i===0?"":"Item", outbound:i===count-1?"":"Item"
  }));
  const p = planActorPipeFactory(chain, 99);
  assert.equal(p.edges.length, count-1);
  assert.equal(p.selector.forward("node-0").target, "node-1");
  assert.throws(() => planActorPipeFactory([...chain, {...chain[0], id:"extra"}]),
    /stage budget/);
});

test("synthetic metadata is not a guest actor or mailbox implementation", () => {
  const p = planActorPipeFactory(stages());
  assert.equal(typeof p.start, "undefined");
  assert.equal(typeof p.send, "undefined");
  assert.equal(typeof p.stop, "undefined");
  assert.equal(typeof p.selector.forward, "function");
});


test("actor factory rejects invisible-control and bidi identifiers before routing publication",()=>{
 for(const bad of ["worker\u202ePASS","worker\u0085PASS","worker\nPASS","worker\u2066PASS","worker\u200ePASS"]){
  const s=stages();s[1].actorType=bad;
  assert.throws(()=>planActorPipeFactory(s),/unsafe actor factory identifier or port/);
  assert.throws(()=>planActorConnectEdge(s[0],s[1]),/unsafe actor factory identifier or port/);
 }
});
