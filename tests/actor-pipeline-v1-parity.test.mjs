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

test('host prototype poisoning cannot redirect frozen actor routes', () => {
  const original = Object.getOwnPropertyDescriptor(Object, 'freeze');
  try {
    Object.defineProperty(Object, 'freeze', {
      configurable: true, writable: true, value(value) { return value; }
    });
    const p = policy();
    const published = p.forwardAll('producer-1');
    assert.equal(Object.isFrozen(published), true);
    assert.equal(Object.isFrozen(published[0]), true);
    assert.throws(() => { published[0].target = 'unconnected-forged-worker'; }, TypeError);
    assert.throws(() => { published.push({target:'forged'}); }, TypeError);
    assert.deepEqual(p.forwardAll('producer-1').map(x => x.target),
      fixture.operations.forward_all);
    assert.equal(p.forwardRoundRobin('producer-1').target, 'worker-a');
    assert.equal(p.forwardTo('producer-1', 'worker-b').target, 'worker-b');
  } finally {
    Object.defineProperty(Object, 'freeze', original);
  }
});

test('Map prototype poisoning cannot spoof route membership or RR advancement', () => {
  const p = policy();
  const get = Object.getOwnPropertyDescriptor(Map.prototype, 'get');
  const set = Object.getOwnPropertyDescriptor(Map.prototype, 'set');
  try {
    Object.defineProperty(Map.prototype, 'get', {
      configurable: true, writable: true,
      value(key) {
        if (key === 'producer-1') return [{source:key,target:'forged',payload:'Event'}];
        return get.value.call(this,key);
      }
    });
    Object.defineProperty(Map.prototype, 'set', {
      configurable: true, writable: true,
      value(key, val) {
        if (key === 'producer-1') return this; // forged refusal to advance RR
        return set.value.call(this,key,val);
      }
    });
    const targets = Array.from({length:6}, () =>
      p.forwardRoundRobin('producer-1').target);
    assert.deepEqual(targets, fixture.operations.forward_round_robin);
    assert.equal(p.forwardTo('producer-1', 'worker-b').target, 'worker-b');
    assert.throws(() => p.forwardTo('producer-1', 'forged'), /not connected/);
  } finally {
    Object.defineProperty(Map.prototype, 'get', get);
    Object.defineProperty(Map.prototype, 'set', set);
  }
});

test('TextEncoder and String prototype poisoning cannot alter route hash or admit NUL IDs', () => {
  const value = actorRouteHash64('alpha');
  const encode = Object.getOwnPropertyDescriptor(TextEncoder.prototype, 'encode');
  const includes = Object.getOwnPropertyDescriptor(String.prototype, 'includes');
  const charCodeAt = Object.getOwnPropertyDescriptor(String.prototype, 'charCodeAt');
  try {
    Object.defineProperty(TextEncoder.prototype, 'encode', {
      configurable: true, writable: true, value() { return new Uint8Array([0]); }
    });
    Object.defineProperty(String.prototype, 'includes', {
      configurable: true, writable: true, value() { return false; }
    });
    Object.defineProperty(String.prototype, 'charCodeAt', {
      configurable: true, writable: true, value() { return 65; }
    });
    assert.equal(actorRouteHash64('alpha'), value);
    assert.throws(() => actorRouteHash64('\ud800'), /Unicode/);
    assert.throws(() => new ActorPipelinePolicy(
      [{...stages[0], id:'producer\0forged'}, ...stages.slice(1)], edges),
      /pipeline identifier/);
  } finally {
    Object.defineProperty(TextEncoder.prototype, 'encode', encode);
    Object.defineProperty(String.prototype, 'includes', includes);
    Object.defineProperty(String.prototype, 'charCodeAt', charCodeAt);
  }
});

test('route hashing ignores poisoned typed-array iterator and numeric constructors', () => {
  const p = policy();
  const referenceHash = actorRouteHash64('beta');
  const referenceTarget = p.forwardByKey('producer-1', 'beta').target;
  assert.equal(referenceTarget, 'worker-c');
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
    target = p.forwardByKey('producer-1', 'beta').target;
  } finally {
    if (iterator) Object.defineProperty(Uint8Array.prototype, Symbol.iterator, iterator);
    else delete Uint8Array.prototype[Symbol.iterator];
    if (bigint) Object.defineProperty(globalThis, 'BigInt', bigint);
    else delete globalThis.BigInt;
    if (number) Object.defineProperty(globalThis, 'Number', number);
    else delete globalThis.Number;
  }
  assert.equal(hash, referenceHash);
  assert.equal(target, referenceTarget);
});

test('duplicate edges cannot evade admission through poisoned JSON.stringify', () => {
  const stringify = Object.getOwnPropertyDescriptor(JSON, 'stringify');
  let admitted = false, rejected = false, counter = 0;
  try {
    Object.defineProperty(JSON, 'stringify', {
      configurable: true, writable: true,
      value() { return 'fresh-edge-' + (++counter); }
    });
    try {
      new ActorPipelinePolicy(stages, [edges[0], edges[0], ...edges.slice(1)]);
      admitted = true;
    } catch (error) {
      rejected = error instanceof TypeError &&
        /duplicate pipeline edge/.test(String(error));
    }
  } finally {
    Object.defineProperty(JSON, 'stringify', stringify);
  }
  assert.equal(admitted, false, 'duplicate edge must never reach the route table');
  assert.equal(rejected, true, 'reject duplicate edge with explicit diagnostic');
});

test('mutable Array and Map iterators cannot remove graph stages or edges', () => {
  const arrayIterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  const mapIterator = Object.getOwnPropertyDescriptor(Map.prototype, Symbol.iterator);
  let target, count, cyclicDenied = false;
  try {
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true, writable: true, value: function* () {}
    });
    Object.defineProperty(Map.prototype, Symbol.iterator, {
      configurable: true, writable: true, value: function* () {}
    });
    const p = policy();
    target = p.forwardTo('producer-1', 'worker-b').target;
    count = p.forwardAll('producer-1').length;
    try {
      new ActorPipelinePolicy(stages, [edges[0], edges[0], ...edges.slice(1)]);
    } catch (error) {
      cyclicDenied = error instanceof TypeError;
    }
  } finally {
    Object.defineProperty(Array.prototype, Symbol.iterator, arrayIterator);
    Object.defineProperty(Map.prototype, Symbol.iterator, mapIterator);
  }
  assert.equal(target, 'worker-b');
  assert.equal(count, 3);
  assert.equal(cyclicDenied, true);
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

test('edge pair identity is collision-free for literal backslash-zero stage names', () => {
  // Both IDs contain printable backslash and zero, never an actual NUL.
  // Using a printable '\0' delimiter would collapse these two distinct pairs.
  const a0b = String.raw`a\0b`, b0c = String.raw`b\0c`;
  const localStages = [
    {id:'a', type:'Reader', role:'readable', inbound:'', outbound:'E'},
    {id:a0b, type:'Reader', role:'readable', inbound:'', outbound:'E'},
    {id:b0c, type:'Writer', role:'writable', inbound:'E', outbound:''},
    {id:'c', type:'Writer', role:'writable', inbound:'E', outbound:''}
  ];
  const p = new ActorPipelinePolicy(localStages, [
    {source:'a', target:b0c, payload:'E'},
    {source:a0b, target:'c', payload:'E'}
  ]);
  assert.equal(p.forward('a').target, b0c);
  assert.equal(p.forward(a0b).target, 'c');
});

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
