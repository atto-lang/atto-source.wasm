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
