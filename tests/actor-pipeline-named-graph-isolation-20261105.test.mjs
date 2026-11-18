import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorPipelinePolicy} from '../src/actor-pipeline-policy.mjs';

function graph(){
 const stages=[
  {id:'src',type:'Source',role:'readable',outbound:'Event'},
  {id:'sink_a',type:'Sink',role:'writable',inbound:'Event'},
  {id:'sink_b',type:'Sink',role:'writable',inbound:'Event'}
 ];
 const edges=[
  {source:'src',target:'sink_a',payload:'Event'},
  {source:'src',target:'sink_b',payload:'Event'}
 ];
 return {stages,edges};
}
test('independent pipeline instances never share round-robin state',()=>{
 const a=new ActorPipelinePolicy(...Object.values(graph()));
 const b=new ActorPipelinePolicy(...Object.values(graph()));
 assert.equal(a.forwardRoundRobin('src').target,'sink_a');
 assert.equal(a.forwardRoundRobin('src').target,'sink_b');
 assert.equal(b.forwardRoundRobin('src').target,'sink_a');
 assert.equal(a.forwardRoundRobin('src').target,'sink_a');
 assert.equal(b.forwardRoundRobin('src').target,'sink_b');
});
test('caller mutations after admission cannot rewrite routes',()=>{
 const {stages,edges}=graph();
 const p=new ActorPipelinePolicy(stages,edges);
 stages[1].id='evil';edges[0].target='evil';edges.push({source:'src',target:'evil',payload:'Event'});
 assert.deepEqual(p.forwardAll('src').map(x=>x.target),['sink_a','sink_b']);
 assert.throws(()=>p.forwardTo('src','evil'),/target is not connected/);
 assert.equal(Object.isFrozen(p.forwardAll('src')),true);
 assert.equal(Object.isFrozen(p.forwardAll('src')[0]),true);
});
test('retiring one graph cannot retire another',()=>{
 const a=new ActorPipelinePolicy(...Object.values(graph()));
 const b=new ActorPipelinePolicy(...Object.values(graph()));
 a.close();
 for(const read of [()=>a.forwardAll('src'),()=>a.forwardRoundRobin('src'),()=>a.forwardByKey('src','k')])
  assert.throws(read,/retired pipeline generation/);
 assert.equal(b.forwardRoundRobin('src').target,'sink_a');
});
