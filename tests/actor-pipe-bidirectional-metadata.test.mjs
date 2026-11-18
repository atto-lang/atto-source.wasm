import test from 'node:test';
import assert from 'node:assert/strict';
import {planActorBidirectionalMetadata as plan} from '../src/actor-pipe-bidirectional-metadata.mjs';
import {planActorBidirectionalPipeFactory} from '../src/actor-pipe-factory-plan.mjs';
const stages=()=>[
 {id:'reader',actorType:'Reader',role:'readable',forwardIn:'',forwardOut:'Work',backwardIn:'Receipt',backwardOut:''},
 {id:'transform',actorType:'Transform',role:'transform',forwardIn:'Work',forwardOut:'Job',backwardIn:'Receipt',backwardOut:'Receipt'},
 {id:'writer',actorType:'Writer',role:'writable',forwardIn:'Job',forwardOut:'',backwardIn:'',backwardOut:'Receipt'}
];
test('typed forward and reverse adjacency',()=>{
 const p=plan(stages());
 assert.equal(p.backwardEnabled,true);
 assert.deepEqual(p.reverseEdges,[
  {source:'transform',target:'reader',payload:'Receipt'},
  {source:'writer',target:'transform',payload:'Receipt'}]);
 assert.deepEqual(p.forwardStages.map(s=>s.id),['reader','transform','writer']);
 assert.ok(Object.isFrozen(p.reverseEdges[0]));
});
test('typed reverse metadata composes with audited forward-only selector',()=>{
 const p=planActorBidirectionalPipeFactory(stages(),11);
 assert.equal(p.forward.selector.forward('reader').target,'transform');
 assert.equal(p.forward.selector.forward('transform').target,'writer');
 assert.equal(p.forward.generation,11);
 assert.equal(p.reverseEdges[0].target,'reader');
 assert.match(p.reversePolicy,/REQUIRES_RUNTIME/);
 assert.equal(typeof p.send,'undefined');
 assert.equal(typeof p.backward,'undefined');
});
test('one-way DATA pipeline is allowed, with no implicit response channel',()=>{
 const s=stages().map(s=>({...s,backwardIn:'',backwardOut:''}));
 const p=plan(s); assert.equal(p.backwardEnabled,false);assert.deepEqual(p.reverseEdges,[]);
 assert.equal(planActorBidirectionalPipeFactory(s).reverseEdges.length,0);
});
test('reverse payload mismatch is denied',()=>{
 const s=stages();s[1].backwardOut='Other'; assert.throws(()=>plan(s),/incompatible reverse/);
 assert.throws(()=>planActorBidirectionalPipeFactory(s),/incompatible reverse/);
});
test('missing or partial reverse port sets denied',()=>{
 for(const i of [0,1,2]) for(const k of ['backwardIn','backwardOut']) {
  const s=stages();if(!s[i][k])continue;
  s[i][k]='';assert.throws(()=>plan(s));
 }
});
test('wrong forward type and malformed roles denied',()=>{
 const s=stages();s[1].forwardOut='Other';assert.throws(()=>plan(s),/incompatible forward/);
 for(const bad of ['supervisor','readable','other']) {
  const b=stages();b[1].role=bad;assert.throws(()=>plan(b),/role/);
 }
});
test('owned metadata snapshot never executes getters or iterators',()=>{
 let invoked=0;
 const a=stages();Object.defineProperty(a[1],'backwardIn',{get(){invoked++;return 'Receipt';}});
 assert.throws(()=>plan(a),/own data/);assert.equal(invoked,0);
 const b=stages();Object.defineProperty(b,'1',{get(){invoked++;return stages()[1];}});
 assert.throws(()=>plan(b),/own data/);assert.equal(invoked,0);
 const c=stages();Object.defineProperty(c,Symbol.iterator,{value(){invoked++;throw Error('iterator');}});
 assert.equal(plan(c).reverseEdges.length,2);assert.equal(invoked,0);
});
test('immutable snapshots ignore input mutation',()=>{
 const s=stages(),p=plan(s);s[0].id='forged';s[1].backwardIn='fake';
 assert.equal(p.forwardStages[0].id,'reader');assert.equal(p.reverseEdges[1].target,'transform');
 assert.throws(()=>{p.reverseEdges[0].payload='forged';},TypeError);
});
test('bounded metadata, malformed Unicode, duplicate and sparse arrays fail closed',()=>{
 const s=stages();s[1].id=s[0].id;assert.throws(()=>plan(s),/duplicate/);
 assert.throws(()=>plan([]),/stage budget/);
 assert.throws(()=>plan(Array(3)),/own data/);
 for(const bad of ['\ud800','bad\0name','🌍'.repeat(65),'x'.repeat(50000)]){
  const p=stages();p[1].id=bad;assert.throws(()=>plan(p));
 }
 const chain=Array.from({length:1024},(_,i)=>({id:'n'+i,actorType:'T',
  role:i===0?'readable':i===1023?'writable':'transform',
  forwardIn:i===0?'':'X',forwardOut:i===1023?'':'X',
  backwardIn:'',backwardOut:''}));
 assert.equal(plan(chain).forwardStages.length,1024);
 assert.throws(()=>plan([...chain,{...chain[0],id:'extra'}]),/stage budget/);
});

test('duplex intermediate stage accepts a typed bidirectional shape',()=>{const s=stages();s[1].role='duplex';assert.equal(plan(s).reverseEdges.length,2);});


test('bidirectional actor metadata rejects hidden control and bidi actor identities',()=>{
 for(const bad of ['actor\u202ePASS','actor\u0085PASS','actor\nPASS','actor\u2066PASS','actor\u200ePASS']){
  const v=stages();v[1].id=bad;
  assert.throws(()=>plan(v),/unsafe actor pipeline identifier or payload/);
  assert.throws(()=>planActorBidirectionalPipeFactory(v),/unsafe actor pipeline identifier or payload/);
 }
});
