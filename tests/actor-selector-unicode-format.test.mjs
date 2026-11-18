import test from "node:test";
import assert from "node:assert/strict";
import {ActorPipelineSelector,routeKeySlot} from "../src/actor-pipeline-selector.mjs";

const graph=()=>({
 stages:[
  {id:"read",actorType:"Reader",role:"readable",inbound:"",outbound:"Work"},
  {id:"middle",actorType:"Middle",role:"transform",inbound:"Work",outbound:"Job"},
  {id:"write",actorType:"Writer",role:"writable",inbound:"Job",outbound:""}
 ],
 links:[
  {source:"read",target:"middle",payload:"Work"},
  {source:"middle",target:"write",payload:"Job"}
 ]
});
test("direct selector refuses hidden actor topology metadata and edge identifiers",()=>{
 for(const invisible of ["\u200b","\u00ad","\u2060","\u061c","\ufeff"]){
  for(const field of ["id","actorType","inbound","outbound"]){
   const g=graph();g.stages[1][field]="a"+invisible+"b";
   assert.throws(()=>new ActorPipelineSelector(g.stages,g.links),
    /unsafe actor routing metadata/);
  }
  const g=graph();g.links[0].payload="a"+invisible+"b";
  assert.throws(()=>new ActorPipelineSelector(g.stages,g.links),
   /unsafe actor routing metadata/);
 }
});
test("routing hash still accepts arbitrary UTF-8 keys and visible Unicode topology",()=>{
 const g=graph();
 g.stages[1].id="météo";
 g.links[0].target="météo";g.links[1].source="météo";
 const s=new ActorPipelineSelector(g.stages,g.links);
 assert.equal(s.forward("read").target,"météo");
 const opaque="key\u200b\u0000😀";
 assert.equal(routeKeySlot(opaque,13),routeKeySlot(opaque,13));
 assert.ok(routeKeySlot(opaque,13)>=0);
});
