import test from "node:test";
import assert from "node:assert/strict";
import {
 stateRegionRequirement, stateRegionRequirementAuthorizesRelease
} from "../src/state-region-requirement.mjs";

const record=()=>({
 contractVersion:"1.0",regionBinding:"region-1",
 executionBinding:"current-logical-execution",generationFence:true,
 loanId:17,place:"state-value",kind:"read",action:"borrow"
});

test("state-region data descriptor snapshot never invokes Proxy get traps",()=>{
 const input=record();let gets=0,descriptors=0;
 const proxy=new Proxy(input,{
  get(_target,key){gets++;return key==="regionBinding"?" ":undefined;},
  getOwnPropertyDescriptor(target,key){descriptors++;
   return Reflect.getOwnPropertyDescriptor(target,key);
  }
 });
 const out=stateRegionRequirement(proxy);
 assert.equal(out.regionBinding,"region-1");
 assert.equal(out.loanId,17);
 assert.equal(Object.isFrozen(out),true);
 assert.equal(gets,0);
 assert.equal(descriptors,14); // 8 required fields and 6 forbidden-authority checks.
});

test("changing get traps cannot forge matching borrow/release physical authority",()=>{
 const borrow=record(),release={...record(),action:"release",regionBinding:"other"};
 let gets=0;
 const forged=new Proxy(release,{get(target,key){
  gets++;return key==="regionBinding"?"region-1":Reflect.get(target,key);
 }});
 assert.equal(stateRegionRequirementAuthorizesRelease(borrow,forged),false);
 assert.equal(gets,0);
 const good={...record(),action:"release"};
 assert.equal(stateRegionRequirementAuthorizesRelease(borrow,good),true);
 const bad=record();Object.defineProperty(bad,"regionBinding",{
  get(){throw Error("untrusted accessor");}
 });
 assert.throws(()=>stateRegionRequirement(bad),/accessor forbidden/);
});
