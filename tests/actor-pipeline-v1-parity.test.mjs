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

test('route selectors ignore monkey-patched Map.get/set and Array.find', () => {
  const p = policy(); // graph was approved before hostile prototype changes
  const savedGet = Object.getOwnPropertyDescriptor(Map.prototype, 'get');
  const savedSet = Object.getOwnPropertyDescriptor(Map.prototype, 'set');
  const savedFind = Object.getOwnPropertyDescriptor(Array.prototype, 'find');
  const results = [];
  try {
    Object.defineProperty(Map.prototype, 'get', {
      ...savedGet, value() { return Object.freeze([{target: 'attacker'}]); }
    });
    Object.defineProperty(Map.prototype, 'set', {
      ...savedSet, value() { throw new Error('hijacked Map.set'); }
    });
    Object.defineProperty(Array.prototype, 'find', {
      ...savedFind, value() { return {target: 'attacker'}; }
    });
    results.push(p.forwardTo('producer-1', 'worker-b').target);
    results.push(p.forwardRoundRobin('producer-1').target);
    results.push(p.forwardRoundRobin('producer-1').target);
    results.push(p.forwardByKey('producer-1', fixture.operations.by_key[0].key).target);
    try { p.forwardTo('producer-1', 'attacker'); results.push('incorrectly admitted'); }
    catch (err) { results.push(err instanceof TypeError ? 'rejected' : 'wrong failure'); }
  } finally {
    Object.defineProperty(Map.prototype, 'get', savedGet);
    Object.defineProperty(Map.prototype, 'set', savedSet);
    Object.defineProperty(Array.prototype, 'find', savedFind);
  }
  assert.deepEqual(results, [
    'worker-b',
    fixture.operations.forward_round_robin[0],
    fixture.operations.forward_round_robin[1],
    fixture.operations.by_key[0].target,
    'rejected'
  ]);
});

test('approved routing and FNV hash survive hostile globals during graph construction', () => {
  const restore = [
    [Map.prototype, 'get', Object.getOwnPropertyDescriptor(Map.prototype, 'get')],
    [Map.prototype, 'set', Object.getOwnPropertyDescriptor(Map.prototype, 'set')],
    [Map.prototype, 'has', Object.getOwnPropertyDescriptor(Map.prototype, 'has')],
    [Set.prototype, 'has', Object.getOwnPropertyDescriptor(Set.prototype, 'has')],
    [Set.prototype, 'add', Object.getOwnPropertyDescriptor(Set.prototype, 'add')],
    [Array.prototype, 'push', Object.getOwnPropertyDescriptor(Array.prototype, 'push')],
    [String.prototype, 'includes', Object.getOwnPropertyDescriptor(String.prototype, 'includes')],
    [TextEncoder.prototype, 'encode', Object.getOwnPropertyDescriptor(TextEncoder.prototype, 'encode')]
  ];
  const oldFreeze = Object.freeze, oldIsArray = Array.isArray;
  const oldBigInt = globalThis.BigInt, oldNumber = globalThis.Number;
  let outcome;
  try {
    for (const [object, name, descriptor] of restore)
      Object.defineProperty(object, name, {
        ...descriptor, value() { throw new Error('poisoned ' + name); }
      });
    Object.freeze = value => value;
    Array.isArray = () => true;
    globalThis.BigInt = () => { throw new Error('poisoned BigInt'); };
    globalThis.Number = () => { throw new Error('poisoned Number'); };
    const route = policy();
    const chosen = route.forwardTo('producer-1', 'worker-b');
    const roundRobin = route.forwardRoundRobin('producer-1');
    const byKey = route.forwardByKey('producer-1', fixture.operations.by_key[0].key);
    let rejected;
    try { route.forwardTo('producer-1', 'attacker'); rejected = false; }
    catch (error) { rejected = error instanceof TypeError; }
    outcome = {
      explicit: chosen.target, rr: roundRobin.target,
      hash: byKey.target, rejected,
      frozen: Object.isFrozen(route.forwardAll('producer-1')[0])
    };
  } finally {
    for (const [object, name, descriptor] of restore)
      Object.defineProperty(object, name, descriptor);
    Object.freeze = oldFreeze;
    Array.isArray = oldIsArray;
    globalThis.BigInt = oldBigInt;
    globalThis.Number = oldNumber;
  }
  assert.deepEqual(outcome, {
    explicit: 'worker-b', rr: fixture.operations.forward_round_robin[0],
    hash: fixture.operations.by_key[0].target, rejected: true, frozen: true
  });
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
