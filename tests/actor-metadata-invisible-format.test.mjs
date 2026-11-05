import test from "node:test";
import assert from "node:assert/strict";
import {planActorPipeFactory,planActorConnectEdge} from "../src/actor-pipe-factory-plan.mjs";
import {planActorBidirectionalMetadata} from "../src/actor-pipe-bidirectional-metadata.mjs";

const forward=()=>[
 {id:"reader",actorType:"Reader",role:"readable",inbound:"",outbound:"Work"},
 {id:"transform",actorType:"Transform",role:"transform",inbound:"Work",outbound:"Job"},
 {id:"writer",actorType:"Writer",role:"writable",inbound:"Job",outbound:""}
];
const duplex=()=>[
 {id:"reader",actorType:"Reader",role:"readable",
  forwardIn:"",forwardOut:"Work",backwardIn:"",backwardOut:""},
 {id:"transform",actorType:"Transform",role:"transform",
  forwardIn:"Work",forwardOut:"Job",backwardIn:"",backwardOut:""},
 {id:"writer",actorType:"Writer",role:"writable",
  forwardIn:"Job",forwardOut:"",backwardIn:"",backwardOut:""}
];

test("hidden Unicode format characters cannot enter actor IDs or payload contracts",()=>{
 for(const format of ["\u200b","\u00ad","\u2060","\u061c","\ufeff"]){
  for(const key of ["id","actorType","outbound"]){
   const a=forward();a[1][key]="before"+format+"after";
   assert.throws(()=>planActorPipeFactory(a),/unsafe actor factory identifier or port/);
   assert.throws(()=>planActorConnectEdge(a[0],a[1]),
     /unsafe actor factory identifier or port/);
  }
  for(const key of ["id","actorType","forwardOut"]){
   const a=duplex();a[1][key]="before"+format+"after";
   assert.throws(()=>planActorBidirectionalMetadata(a),
     /unsafe actor pipeline identifier or payload/);
  }
 }
});

test("visible Unicode actor identifiers and payload names are still valid",()=>{
 const a=forward();a[1].id="transform_é";a[1].actorType="Transform🌍";
 assert.equal(planActorPipeFactory(a).stages[1].id,"transform_é");
 const b=duplex();b[1].id="transform_é";b[1].actorType="Transform🌍";
 assert.equal(planActorBidirectionalMetadata(b).forwardStages[1].id,"transform_é");
});
