import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorPipelinePolicy,actorRouteHash64} from '../src/actor-pipeline-policy.mjs';

const fixture=()=>{
 const targets=['one','two','three'];
 const stages=[{id:'src',type:'Source',role:'readable',outbound:'Event'},
  ...targets.map(id=>({id,type:'Sink',role:'writable',inbound:'Event'}))];
 const edges=targets.map(target=>({source:'src',target,payload:'Event'}));
 return new ActorPipelinePolicy(stages,edges);
};

test('keyed admission follows canonical 64-bit UTF-8 hash and never advances RR',()=>{
 const p=fixture();
 const routes=p.forwardAll('src');
 for(const key of ['key-1','key-2','same-key','\u03b1']){
  const expected=routes[Number(actorRouteHash64(key)%BigInt(routes.length))];
  assert.strictEqual(p.forwardByKey('src',key),expected);
  assert.strictEqual(p.forwardByKey('src',key),expected);
 }
 assert.equal(p.forwardRoundRobin('src').target,'one');
 p.forwardByKey('src','key-2');
 assert.equal(p.forwardRoundRobin('src').target,'two');
});

test('independent generations do not share round-robin or keyed route cursors',()=>{
 const a=fixture(),b=fixture();
 a.forwardRoundRobin('src');
 a.forwardRoundRobin('src');
 assert.equal(b.forwardRoundRobin('src').target,'one');
 const key='independent';
 assert.equal(a.forwardByKey('src',key).target,b.forwardByKey('src',key).target);
 assert.equal(a.forwardRoundRobin('src').target,'three');
 assert.equal(b.forwardRoundRobin('src').target,'two');
});

test('retirement fences keyed routes regardless of earlier cursor activity',()=>{
 const p=fixture();
 p.forwardByKey('src','stable');
 p.forwardRoundRobin('src');
 p.close();
 assert.throws(()=>p.forwardByKey('src','stable'),/retired pipeline generation/);
});
