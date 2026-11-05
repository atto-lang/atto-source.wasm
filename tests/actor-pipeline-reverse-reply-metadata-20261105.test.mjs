import test from 'node:test';
import assert from 'node:assert/strict';
import {planActorBidirectionalMetadata} from '../src/actor-pipe-bidirectional-metadata.mjs';

const stage=(id,role,fi,fo,bi='',bo='')=>({
 id,actorType:id+'Type',role,forwardIn:fi,forwardOut:fo,backwardIn:bi,backwardOut:bo
});
const forward=()=>[
 stage('source','readable','','Event'),
 stage('transform','transform','Event','Summary'),
 stage('sink','writable','Summary','')
];
const duplex=()=>[
 stage('source','readable','','Event','Ack',''),
 stage('transform','duplex','Event','Summary','Ack','Ack'),
 stage('sink','writable','Summary','','','Ack')
];
test('forward-only pipeline never claims reverse reply authority',()=>{
 const plan=planActorBidirectionalMetadata(forward());
 assert.equal(plan.backwardEnabled,false);
 assert.equal(plan.reversePolicy,'NO_REVERSE_DATA');
 assert.equal(plan.reverseEdges.length,0);
 assert.equal(Object.isFrozen(plan.forwardStages),true);
});
test('duplex pipeline reverse edges require runtime correlation and generation fencing',()=>{
 const plan=planActorBidirectionalMetadata(duplex());
 assert.equal(plan.backwardEnabled,true);
 assert.equal(plan.reversePolicy,'REQUIRES_RUNTIME_CORRELATION_AND_GENERATION_FENCING');
 assert.deepEqual(plan.reverseEdges,[
  {source:'transform',target:'source',payload:'Ack'},
  {source:'sink',target:'transform',payload:'Ack'}
 ]);
 assert.equal(Object.isFrozen(plan.reverseEdges[0]),true);
});
test('incomplete and mismatched reply ports reject metadata',()=>{
 const missing=duplex();missing[1].backwardOut='';
 assert.throws(()=>planActorBidirectionalMetadata(missing),/incomplete actor pipeline reverse reply ports/);
 const mismatch=duplex();mismatch[1].backwardOut='Wrong';
 assert.throws(()=>planActorBidirectionalMetadata(mismatch),/incompatible reverse reply DATA ports/);
 const invalid=forward();invalid[1].forwardIn='Wrong';
 assert.throws(()=>planActorBidirectionalMetadata(invalid),/incompatible forward DATA ports/);
});
test('own-data stage and array checks never execute hostile getters',()=>{
 let reads=0;const a=duplex();
 Object.defineProperty(a[1],'id',{get(){reads++;throw Error('getter');}});
 assert.throws(()=>planActorBidirectionalMetadata(a),/requires own data/);
 const b=duplex();
 Object.defineProperty(b,'1',{get(){reads++;throw Error('getter');}});
 assert.throws(()=>planActorBidirectionalMetadata(b),/requires own data/);
 assert.equal(reads,0);
});
