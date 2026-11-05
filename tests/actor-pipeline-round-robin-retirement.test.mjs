import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorPipelinePolicy} from '../src/actor-pipeline-policy.mjs';

const fixture=()=>{
 const stages=[
  {id:'src',type:'Source',role:'readable',outbound:'Event'},
  ...['one','two','three'].map(id=>({id,type:'Sink',role:'writable',inbound:'Event'}))
 ];
 const edges=['one','two','three'].map(target=>({source:'src',target,payload:'Event'}));
 return {stages,edges};
};

test('three-target round robin preserves admission order through two full rotations',()=>{
 const {stages,edges}=fixture();
 const p=new ActorPipelinePolicy(stages,edges);
 const observed=Array.from({length:6},()=>p.forwardRoundRobin('src').target);
 assert.deepEqual(observed,['one','two','three','one','two','three']);
 assert.ok(Object.isFrozen(p.forwardAll('src')));
});

test('caller mutation cannot repoint an admitted route or its immutable snapshot',()=>{
 const {stages,edges}=fixture();
 const p=new ActorPipelinePolicy(stages,edges);
 const route=p.forwardTo('src','two');
 edges[1].target='spoof'; stages[2].id='spoof';
 assert.strictEqual(p.forwardTo('src','two'),route);
 assert.ok(Object.isFrozen(route));
 assert.throws(()=>{route.target='spoof';},TypeError);
});

test('retirement fences all route readers, including keyed and round-robin routing',()=>{
 const {stages,edges}=fixture();
 const p=new ActorPipelinePolicy(stages,edges);
 p.close();
 for(const action of [
  ()=>p.forwardAll('src'),
  ()=>p.forwardTo('src','two'),
  ()=>p.forwardRoundRobin('src'),
  ()=>p.forwardByKey('src','stable-key')
 ]) assert.throws(action,/retired pipeline generation/);
});
