import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorPipelinePolicy} from '../src/actor-pipeline-policy.mjs';

const names=Array.from({length:1024},(_,i)=>'stage-'+i);
const stages=names.map((id,i)=>({
 id,type:'Stage',role:i===0?'readable':i===1023?'writable':'transform',
 ...(i?{inbound:'Event'}:{}),...(i!==1023?{outbound:'Event'}:{})
}));
const baseEdges=Array.from({length:1023},(_,i)=>({source:names[i],target:names[i+1],payload:'Event'}));
const allEdges=()=>{
 const edges=[...baseEdges];
 for(let src=0;src<1024&&edges.length<4096;src++)
  for(let dst=src+2;dst<1024&&edges.length<4096;dst++)
   edges.push({source:names[src],target:names[dst],payload:'Event'});
 return edges;
};

test('1024 stages and a contiguous 1023-edge source-to-sink pipeline are admitted',()=>{
 const plan=new ActorPipelinePolicy(stages,baseEdges);
 assert.equal(plan.forward('stage-0').target,'stage-1');
 assert.equal(plan.forward('stage-1022').target,'stage-1023');
});

test('4096 unique acyclic typed edges are admitted at the exact graph quota',()=>{
 const edges=allEdges();
 assert.equal(edges.length,4096);
 const plan=new ActorPipelinePolicy(stages,edges);
 assert.equal(plan.forwardAll('stage-0').length>1,true);
 assert.equal(plan.forward('stage-1022').target,'stage-1023');
});

test('one stage or edge beyond the quota is rejected before topology construction',()=>{
 assert.throws(()=>new ActorPipelinePolicy([...stages,stages[0]],baseEdges),/pipeline graph budget/);
 const edges=allEdges();
 assert.throws(()=>new ActorPipelinePolicy(stages,[...edges,edges[0]]),/pipeline graph budget/);
});
