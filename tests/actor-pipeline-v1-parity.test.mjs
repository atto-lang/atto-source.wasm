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


test('route hash and by-key selection ignore poisoned typed-array iterator and numeric constructors', () => {
  const route = policy();
  const expectedHash = actorRouteHash64('beta');
  const expectedTarget = route.forwardByKey('producer-1', 'beta').target;
  const iterator = Object.getOwnPropertyDescriptor(Uint8Array.prototype, Symbol.iterator);
  const bigint = Object.getOwnPropertyDescriptor(globalThis, 'BigInt');
  const number = Object.getOwnPropertyDescriptor(globalThis, 'Number');
  let hash, target;
  try {
    Object.defineProperty(Uint8Array.prototype, Symbol.iterator, {
      configurable: true, writable: true, value: function* () { yield 0; }
    });
    Object.defineProperty(globalThis, 'BigInt', {
      configurable: true, writable: true, value() { return 0n; }
    });
    Object.defineProperty(globalThis, 'Number', {
      configurable: true, writable: true, value() { return 0; }
    });
    hash = actorRouteHash64('beta');
    target = route.forwardByKey('producer-1', 'beta').target;
  } finally {
    if (iterator) Object.defineProperty(Uint8Array.prototype, Symbol.iterator, iterator);
    else delete Uint8Array.prototype[Symbol.iterator];
    if (bigint) Object.defineProperty(globalThis, 'BigInt', bigint);
    else delete globalThis.BigInt;
    if (number) Object.defineProperty(globalThis, 'Number', number);
    else delete globalThis.Number;
  }
  assert.equal(hash, expectedHash);
  assert.equal(target, expectedTarget);
});

test('duplicate edge admission ignores poisoned JSON.stringify', () => {
  const stringify = Object.getOwnPropertyDescriptor(JSON, 'stringify');
  let rejected = false, counter = 0;
  try {
    Object.defineProperty(JSON, 'stringify', {
      configurable: true, writable: true, value() { return 'forged-' + (++counter); }
    });
    try {
      new ActorPipelinePolicy(stages, [edges[0], edges[0], ...edges.slice(1)]);
    } catch (error) {
      rejected = error instanceof TypeError && /duplicate pipeline edge/.test(String(error));
    }
  } finally {
    Object.defineProperty(JSON, 'stringify', stringify);
  }
  assert.equal(rejected, true);
});
