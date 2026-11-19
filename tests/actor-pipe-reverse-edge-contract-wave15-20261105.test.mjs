import test from 'node:test';
import assert from 'node:assert/strict';
import {planActorBidirectionalMetadata as plan} from '../src/actor-pipe-bidirectional-metadata.mjs';

const stage=(id,role,forwardIn,forwardOut,backwardIn='',backwardOut='')=>({
  id,actorType:'Worker',role,forwardIn,forwardOut,backwardIn,backwardOut
});

test('two-stage reverse DATA path is an obligation, not a minted reply capability',()=>{
  const result=plan([
    stage('source','readable','','frame','answer',''),
    stage('sink','writable','frame','','','answer')
  ]);
  assert.equal(result.backwardEnabled,true);
  assert.equal(result.reverseEdges.length,1);
  assert.deepEqual(result.reverseEdges[0],{source:'sink',target:'source',payload:'answer'});
  assert.equal(result.reversePolicy,'REQUIRES_RUNTIME_CORRELATION_AND_GENERATION_FENCING');
  assert.ok(Object.isFrozen(result.reverseEdges[0]));
  assert.ok(Object.isFrozen(result.forwardStages));
});

test('forward-only plan emits no reverse edges, and mismatched ports fail',()=>{
  const forward=plan([stage('a','readable','','frame'),stage('b','writable','frame','')]);
  assert.equal(forward.backwardEnabled,false);
  assert.deepEqual(forward.reverseEdges,[]);
  assert.equal(forward.reversePolicy,'NO_REVERSE_DATA');
  assert.throws(()=>plan([stage('a','readable','','x'),stage('b','writable','y','')]),/incompatible forward DATA ports/);
  assert.throws(()=>plan([stage('a','readable','','frame','reply',''),stage('b','writable','frame','','','different')]),/incompatible reverse reply DATA ports/);
});

test('descriptor accessors, repeated stage IDs and invalid Unicode never grant ports',()=>{
  const first=stage('first','readable','','frame');
  let calls=0;
  Object.defineProperty(first,'id',{enumerable:true,get(){calls++;throw Error('getter');}});
  assert.throws(()=>plan([first,stage('sink','writable','frame','')]),/requires own data: id/);
  assert.equal(calls,0);
  assert.throws(()=>plan([stage('x','readable','','frame'),stage('x','writable','frame','')]),/duplicate actor pipeline stage/);
  assert.throws(()=>plan([stage('a'+String.fromCharCode(0x202e),'readable','','frame'),stage('b','writable','frame','')]),/unsafe actor pipeline identifier/);
});
