import test from "node:test";
import assert from "node:assert/strict";
import {ActorPipelinePolicy,actorRouteHash64} from "../src/actor-pipeline-policy.mjs";

function graph(){
 return {
  stages:[{id:"source",type:"Producer",role:"readable",outbound:"Message"},
    {id:"sink",type:"Worker",role:"writable",inbound:"Message"}],
  edges:[{source:"source",target:"sink",payload:"Message"}]
 };
}
test("actor policy topology rejects all hidden format control identifiers and payloads",()=>{
 for(const hidden of ["\u200b","\u00ad","\u2060","\u061c","\ufeff","\u202e"]){
  for(const key of ["id","type","inbound"]){
   const {stages,edges}=graph();stages[1][key]="x"+hidden+"y";
   assert.throws(()=>new ActorPipelinePolicy(stages,edges),/unsafe actor pipeline identifier/);
  }
  const {stages,edges}=graph();edges[0].payload="M"+hidden+"essage";
  assert.throws(()=>new ActorPipelinePolicy(stages,edges),/unsafe actor pipeline identifier/);
 }
});
test("visible Unicode topology remains valid and opaque route hash keys retain Unicode/NUL",()=>{
 const {stages,edges}=graph();
 stages[1].id="météo_🚀";edges[0].target="météo_🚀";
 const policy=new ActorPipelinePolicy(stages,edges);
 assert.equal(policy.forward("source").target,"météo_🚀");
 const key="private\u200b\u0000🌍";
 assert.equal(actorRouteHash64(key),actorRouteHash64(key));
 assert.equal(policy.forwardByKey("source",key).target,"météo_🚀");
});
