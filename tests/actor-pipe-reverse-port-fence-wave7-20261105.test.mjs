import test from 'node:test';
import assert from 'node:assert/strict';
import {planActorBidirectionalMetadata} from '../src/actor-pipe-bidirectional-metadata.mjs';

const stage = (id, role, forwardIn, forwardOut, backwardIn='', backwardOut='') => ({
  id, actorType:'DemoActor', role, forwardIn, forwardOut, backwardIn, backwardOut
});
const bidirectional = () => [
  stage('source','readable','','data','reply',''),
  stage('middle','transform','data','out','ack','reply'),
  stage('sink','writable','out','','','ack')
];

test('reverse DATA routing is immutable metadata, never minted runtime authority', () => {
  const input = bidirectional();
  const result = planActorBidirectionalMetadata(input);
  assert.equal(result.backwardEnabled, true);
  assert.equal(result.reversePolicy, 'REQUIRES_RUNTIME_CORRELATION_AND_GENERATION_FENCING');
  assert.deepEqual(result.reverseEdges, [
    {source:'middle', target:'source', payload:'reply'},
    {source:'sink', target:'middle', payload:'ack'}
  ]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.forwardStages));
  assert.ok(Object.isFrozen(result.reverseEdges));
  assert.ok(Object.isFrozen(result.reverseEdges[0]));
  input[1].backwardOut = 'forged';
  assert.equal(result.reverseEdges[0].payload, 'reply');
});

test('reverse reply mismatch and half-configured ports are denied', () => {
  const mismatch = bidirectional();
  mismatch[1].backwardOut = 'wrong';
  assert.throws(() => planActorBidirectionalMetadata(mismatch), /incompatible reverse/);
  const partial = bidirectional();
  partial[0].backwardIn = '';
  assert.throws(() => planActorBidirectionalMetadata(partial), /incomplete actor pipeline reverse/);
});

test('no-reverse pipeline remains data-only and reverse edges absent', () => {
  const result = planActorBidirectionalMetadata([
    stage('source','readable','','data'),
    stage('sink','writable','data','')
  ]);
  assert.equal(result.backwardEnabled, false);
  assert.equal(result.reversePolicy, 'NO_REVERSE_DATA');
  assert.deepEqual(result.reverseEdges, []);
});

test('getter stage properties and sparse stage arrays are rejected without invocation', () => {
  const input = bidirectional();
  let invoked = 0;
  Object.defineProperty(input[1], 'actorType', {
    enumerable:true, get() {invoked++; return 'Forged';}
  });
  assert.throws(() => planActorBidirectionalMetadata(input), /own data/);
  assert.equal(invoked, 0);
  const sparse = new Array(2);
  sparse[0] = stage('source','readable','','data');
  assert.throws(() => planActorBidirectionalMetadata(sparse), /own data/);
});