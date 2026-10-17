import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ActorPipelinePolicy, actorRouteHash64} from '../src/actor-pipeline-policy.mjs';

const fixture = JSON.parse(readFileSync(new URL('../contracts/v1/actor-pipeline-routing-v1.json', import.meta.url), 'utf8'));
const stages = fixture.graph.stages.map(({id, actor_type, role, inbound, outbound}) => ({id, type: actor_type, role, inbound, outbound}));
const edges = fixture.graph.connections;
const policy = () => new ActorPipelinePolicy(stages, edges);

for (const {key, fnv1a64_hex, target} of fixture.operations.by_key) {
  test('FNV-1a route key ' + JSON.stringify(key), () => {
    assert.equal(actorRouteHash64(key).toString(16).padStart(16,'0'), fnv1a64_hex);
    assert.equal(policy().forwardByKey('producer-1', key).target, target);
  });
}

test('full immutable fan-out and explicit destination', () => {
  const p = policy();
  assert.deepEqual(p.forwardAll('producer-1').map(x => x.target), fixture.operations.forward_all);
  assert.throws(() => {p.forwardAll('producer-1')[0].target='forged';}, TypeError);
  assert.equal(p.forwardTo('producer-1', 'worker-b').target, 'worker-b');
  assert.throws(() => p.forwardTo('producer-1','worker-z'), /not connected/);
  assert.throws(() => p.forward('producer-1'), /ambiguous/);
});

test('constructor-seeded RR cycles, independent sessions, fresh generation', () => {
  for (let round = 0; round < 256; ++round) {
    const p = policy();
    assert.deepEqual(Array.from({length:6}, () => p.forwardRoundRobin('producer-1').target), fixture.operations.forward_round_robin);
    p.close();
    assert.throws(() => p.forwardRoundRobin('producer-1'), /retired/);
  }
});

test('unknown source/retired generation checked before parsing hostile key', () => {
  const p = policy();
  assert.throws(() => p.forwardByKey('forged-source', '\ud800'), /no downstream/);
  p.close();
  assert.throws(() => p.forwardByKey('producer-1', '\ud800'), /retired/);
});

test('reject malformed Unicode and keys exceeding 4096 UTF-8 bytes', () => {
  for (const bad of ['\ud800', '\udc00', '🌍'.repeat(1025)]) {
    assert.throws(() => actorRouteHash64(bad));
  }
  assert.doesNotThrow(() => actorRouteHash64('🌍'.repeat(1024)));
});

test('reject unknown target, duplicate pair, self edge and malformed identity', () => {
  const edits = [
    [stages, [...edges, {...edges[0]}]],
    [stages, [{...edges[0], target:'no-such-actor'}, ...edges.slice(1)]],
    [stages, [{...edges[0], target:'producer-1'}, ...edges.slice(1)]],
    [[...stages, {...stages[1]}], edges],
    [[{...stages[0], id:'producer\0bad'}, ...stages.slice(1)], edges],
    [[{...stages[0], id:'🌍'.repeat(65)}, ...stages.slice(1)], edges],
  ];
  for (const [s,e] of edits) assert.throws(() => new ActorPipelinePolicy(s,e));
});

test('parallel pipelines maintain independent selectors', () => {
  const p1=policy(),p2=policy();
  for(let i=0;i<1000;i++) {
    const target=fixture.operations.forward_all[i%3];
    assert.equal(p1.forwardRoundRobin('producer-1').target,target);
    if(i%2===0) assert.equal(p2.forwardRoundRobin('producer-1').target,fixture.operations.forward_all[(i/2)%3]);
  }
});


test('bounded graph snapshot ignores hostile iterators and changing lengths', () => {
  function adversarial(items) {
    const input = items.map(item => ({...item}));
    let reads = 0;
    const proxy = new Proxy(input, {
      get(target, key, receiver) {
        if (key === 'length') return ++reads === 1 ? target.length : 999999;
        if (key === Symbol.iterator)
          throw new Error('caller iterator must never run');
        return Reflect.get(target, key, receiver);
      }
    });
    return {proxy, reads: () => reads, input};
  }
  const s = adversarial(stages), e = adversarial(edges);
  const plan = new ActorPipelinePolicy(s.proxy, e.proxy);
  assert.deepEqual(plan.forwardAll('producer-1').map(x => x.target), fixture.operations.forward_all);
  assert.equal(s.reads(), 1);
  assert.equal(e.reads(), 1);
  s.input[0].id = 'forged';
  e.input[0].target = 'forged';
  assert.equal(plan.forwardRoundRobin('producer-1').target, 'worker-a');

  const sparseStages = stages.slice();
  delete sparseStages[1];
  assert.throws(() => new ActorPipelinePolicy(sparseStages, edges), /invalid pipeline stage/);
  const sparseEdges = edges.slice();
  delete sparseEdges[0];
  assert.throws(() => new ActorPipelinePolicy(stages, sparseEdges), /invalid pipeline edge/);
});


test('changing caller length cannot conceal an unreachable directed cycle', () => {
  const cyclicStages = [
    {id:'root', type:'Producer', role:'readable', inbound:'', outbound:'Event'},
    {id:'loop-a', type:'Worker', role:'transform', inbound:'Event', outbound:'Event'},
    {id:'loop-b', type:'Worker', role:'transform', inbound:'Event', outbound:'Event'},
    {id:'sink', type:'Sink', role:'writable', inbound:'Event', outbound:''},
  ];
  const cyclicEdges = [
    {source:'root', target:'sink', payload:'Event'},
    {source:'loop-a', target:'loop-b', payload:'Event'},
    {source:'loop-b', target:'loop-a', payload:'Event'},
  ];
  let reads = 0;
  const tampered = new Proxy(cyclicStages, {
    get(target, key, receiver) {
      // Old code admitted four stages, then checked a forged count of two
      // against the two acyclic vertices reached by topological sorting.
      if (key === 'length') return ++reads === 1 ? 4 : 2;
      return Reflect.get(target, key, receiver);
    }
  });
  assert.throws(() => new ActorPipelinePolicy(tampered, cyclicEdges), /cyclic/);
  assert.equal(reads, 1, 'only the admitted source count may be consulted');
});
