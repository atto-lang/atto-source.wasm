import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeWasmActorRegistry} from '../src/actorref-registry-v0.mjs';

function fixture({hold = false, failStop = false, failClose = false, capacity = 40} = {}) {
  const events = [], pending = [];
  const pool = {
    async spawn() {
      events.push('spawn');
      let value = 0n, retired = false;
      return Object.freeze({
        send: async delta => {
          if (retired) throw Error('actor retired');
          value += delta;
          if (hold) return new Promise(resolve => pending.push({resolve, value}));
          return value;
        },
        stop: async () => {
          events.push('stop');
          if (failStop) throw Error('physical retirement not proven');
          retired = true;
        }
      });
    },
    close: async () => {events.push('close'); if (failClose) throw Error('terminate failed');}
  };
  const registry = new NativeWasmActorRegistry({
    pool, maxActors: capacity, maxPendingPerActor: 1
  });
  const spawn = () => registry.spawn(new Uint8Array([0]),{
    expectedSha256: '0'.repeat(64), trusted: true
  });
  return {registry, spawn, events, pending};
}

test('unforgeable, clone-resistant, opaque host-only refs', async () => {
  const {registry,spawn}=fixture();
  const ref=await spawn();
  assert.deepEqual(Object.keys(ref),[]);
  assert.equal(JSON.stringify(ref),'{}');
  await assert.rejects(registry.send({},1n,1n),/forged/);
  await assert.rejects(registry.send(structuredClone(ref),1n,1n),/forged/);
  assert.equal(await registry.send(ref,1n,5n),5n);
  await registry.close();
});
test('rights attenuation, stop denial, parent revocation and cascading invalidation', async () => {
  const {registry,spawn}=fixture();
  const root=await spawn(), reduced=registry.attenuate(root,{send:true,stop:false});
  const child=registry.attenuate(reduced,{send:true,stop:false});
  assert.throws(()=>registry.stop(child),/permission denied/);
  assert.throws(()=>registry.attenuate(child,{send:true,stop:true}),/escalation/);
  registry.revoke(reduced);
  await assert.rejects(registry.send(child,1n,1n),/revoked/);
  assert.equal(await registry.send(root,1n,1n),1n);
  await registry.close();
});
test('stop-only rights do not permit DATA or escalation', async () => {
  const {registry,spawn}=fixture();
  const root=await spawn(), stopOnly=registry.attenuate(root,{send:false,stop:true});
  await assert.rejects(registry.send(stopOnly,1n,1n),/permission denied/);
  assert.throws(()=>registry.attenuate(stopOnly,{send:true,stop:false}),/escalation/);
  await registry.stop(stopOnly);
  await registry.close();
});
test('DATA tickets reject replay, reordering, overflow and capability-shaped payloads', async () => {
  const {registry,spawn}=fixture();
  const ref=await spawn();
  assert.equal(await registry.send(ref,10n,-3n),-3n);
  await assert.rejects(registry.send(ref,10n,5n),/replayed/);
  await assert.rejects(registry.send(ref,9n,5n),/replayed/);
  await assert.rejects(registry.send(ref,11n,1),/signed i64/);
  await assert.rejects(registry.send(ref,11n,1n<<63n),/signed i64/);
  await assert.rejects(registry.send(ref,0n,1n),/ticket/);
  await assert.rejects(registry.send(ref,11n,ref),/signed i64/);
  assert.equal(await registry.send(ref,11n,1n),-2n);
  await registry.close();
});
test('actor ticket fences and local state are independent', async () => {
  const {registry,spawn}=fixture();
  const a=await spawn(), b=await spawn();
  assert.deepEqual(await Promise.all([
    registry.send(a,1n,3n),registry.send(b,1n,7n)]),[3n,7n]);
  assert.deepEqual(await Promise.all([
    registry.send(a,42n,2n),registry.send(b,42n,1n)]),[5n,8n]);
  await registry.close();
});
test('duplicate pending turn cannot enter after async admission', async () => {
  const {registry,spawn,pending}=fixture({hold:true});
  const ref=await spawn(), first=registry.send(ref,7n,2n);
  await assert.rejects(registry.send(ref,7n,2n),/replayed/);
  await assert.rejects(registry.send(ref,8n,2n),/admission full/);
  pending[0].resolve(2n); assert.equal(await first,2n);
  const second=registry.send(ref,8n,1n);
  pending[1].resolve(3n); assert.equal(await second,3n);
  await registry.close();
});
test('stop seals new sends synchronously and never accepts retired ref', async () => {
  const {registry,spawn}=fixture();
  const ref=await spawn(), stop=registry.stop(ref);
  await assert.rejects(registry.send(ref,1n,1n),/not accepting/);
  await stop;
  assert.equal(registry.actorCount,0);
  await assert.rejects(registry.send(ref,2n,1n),/stale/);
  await registry.close();
});
test('generation rotation retires old before new; fresh state, no stale grants', async () => {
  const {registry,spawn,events}=fixture();
  const old=await spawn(), grant=registry.attenuate(old,{send:true,stop:false});
  assert.equal(await registry.send(old,1n,6n),6n);
  const next=await registry.rotate(old,new Uint8Array([1]),{
    expectedSha256:'0'.repeat(64),trusted:true});
  assert.deepEqual(events,['spawn','stop','spawn']);
  await assert.rejects(registry.send(grant,2n,1n),/stale/);
  await assert.rejects(registry.send(old,2n,1n),/stale/);
  assert.equal(await registry.send(next,1n,4n),4n);
  await registry.close();
});
test('failed stop retains retired-unconfirmed authority and refuses new generation', async () => {
  const {registry,spawn,events}=fixture({failStop:true});
  const old=await spawn();
  await assert.rejects(registry.rotate(old,new Uint8Array([1]),{
    expectedSha256:'0'.repeat(64),trusted:true}),/retirement not proven/);
  assert.equal(registry.actorCount,1);
  assert.deepEqual(events,['spawn','stop']);
  await assert.rejects(registry.send(old,2n,1n),/not accepting/);
  await registry.close();
});
test('failed pool close preserves uncertain actor identity', async () => {
  const {registry,spawn}=fixture({failClose:true});
  const ref=await spawn();
  await assert.rejects(registry.close(),/terminate failed/);
  assert.equal(registry.actorCount,1);
  await assert.rejects(registry.send(ref,1n,1n),/registry closed/);
});
test('parallel async spawns reserve capacity before first await', async () => {
  const waiting=[];
  const pool={spawn:()=>new Promise(resolve=>waiting.push(resolve)),
    close:async()=>{}};
  const registry=new NativeWasmActorRegistry({pool,maxActors:1});
  const first=registry.spawn(new Uint8Array([0]),{trusted:true});
  await assert.rejects(registry.spawn(new Uint8Array([0]),{trusted:true}),/capacity/);
  waiting[0]({send:async()=>1n,stop:async()=>{}});
  await first;
  assert.equal(registry.actorCount,1);
  await registry.close();
});

test('delegated stop-only ref cannot rotate and mint new full rights', async () => {
  const {registry,spawn}=fixture();
  const root=await spawn(), delegated=registry.attenuate(root,{send:false,stop:true});
  await assert.rejects(registry.rotate(delegated,new Uint8Array([1]),{
    expectedSha256:'0'.repeat(64),trusted:true}),/root supervisor/);
  assert.equal(await registry.send(root,1n,3n),3n);
  await registry.close();
});
test('even delegated send-and-stop ref cannot rotate into supervisor root', async () => {
  const {registry,spawn}=fixture();
  const root=await spawn(), delegated=registry.attenuate(root,{send:true,stop:true});
  await assert.rejects(registry.rotate(delegated,new Uint8Array([1]),{
    expectedSha256:'0'.repeat(64),trusted:true}),/root supervisor/);
  await registry.close();
});

test('supervisor revocation during blocked stop aborts successor generation', async () => {
  let finishStop, spawns=0;
  const pool={
    spawn: async () => {
      spawns++;
      return {send:async()=>1n,stop:()=>new Promise(resolve=>{finishStop=resolve;})};
    },
    close: async()=>{}
  };
  const registry=new NativeWasmActorRegistry({pool});
  const root=await registry.spawn(new Uint8Array([0]),{trusted:true});
  const rotating=registry.rotate(root,new Uint8Array([1]),{trusted:true});
  registry.revoke(root);
  await Promise.resolve(); await Promise.resolve();
  finishStop();
  await assert.rejects(rotating,/revoked during rotation/);
  assert.equal(spawns,1);
  await registry.close();
});

test('revocation during successor spawn tears down guest before minting new rights', async () => {
  let complete, spawns=0, retired=0;
  const handle=()=>({send:async()=>1n,stop:async()=>{retired++;}});
  const pool={
    spawn:()=>{spawns++;return spawns===1
      ? Promise.resolve(handle()) : new Promise(resolve=>{complete=resolve;});},
    close:async()=>{}
  };
  const registry=new NativeWasmActorRegistry({pool});
  const root=await registry.spawn(new Uint8Array([0]),{trusted:true});
  const rotating=registry.rotate(root,new Uint8Array([1]),{trusted:true});
  for(let i=0;i<8&&!complete;i++) await Promise.resolve();
  assert.equal(typeof complete,'function');
  registry.revoke(root); complete(handle());
  await assert.rejects(rotating,/revoked or registry closed/);
  assert.equal(spawns,2);
  assert.equal(retired,2);
  assert.equal(registry.actorCount,0);
  await registry.close();
});

test('forged ref cannot borrow another authority through poisoned WeakMap.get', async () => {
  const {registry, spawn} = fixture();
  const original = await spawn();
  const fake = Object.freeze(Object.create(null));
  const savedGet = WeakMap.prototype.get;
  WeakMap.prototype.get = function(key) {
    return savedGet.call(this, key === fake ? original : key);
  };
  try {
    assert.throws(() => registry.stop(fake), /unrecognized or forged ActorRef/);
  } finally {
    WeakMap.prototype.get = savedGet;
  }
  assert.equal(await registry.send(original, 1n, 4n), 4n);
  await registry.close();
});

test('registry Map lookup survives prototype replacement after import', async () => {
  const {registry, spawn} = fixture();
  const root = await spawn();
  const savedGet = Map.prototype.get;
  let reduced;
  Map.prototype.get = function() { throw Error('poisoned Map.get'); };
  try {
    reduced = registry.attenuate(root, {send: true, stop: false});
  } finally {
    Map.prototype.get = savedGet;
  }
  assert.equal(await registry.send(reduced, 1n, 2n), 2n);
  await registry.close();
});


test('registry close waits for a late spawn to stop physically before reporting success', async () => {
  let resolveSpawn, resolveStop, stopStarted = false, closeSettled = false;
  const pool = {
    spawn: () => new Promise(resolve => { resolveSpawn = resolve; }),
    close: async () => {}
  };
  const registry = new NativeWasmActorRegistry({pool});
  const spawning = registry.spawn(new Uint8Array([0]), {trusted:true});
  const closing = registry.close().then(() => {closeSettled = true;});
  await Promise.resolve();
  assert.equal(closeSettled, false);
  resolveSpawn({
    send: async () => 1n,
    stop: () => {stopStarted = true; return new Promise(resolve => {resolveStop = resolve;});}
  });
  for (let i = 0; i < 8 && !stopStarted; i++) await Promise.resolve();
  assert.equal(stopStarted, true, 'the late successor must not be orphaned');
  assert.equal(closeSettled, false, 'pool close alone is not a teardown barrier');
  resolveStop();
  await assert.rejects(spawning, /closed while spawning/);
  await closing;
  assert.equal(closeSettled, true);
  assert.equal(registry.actorCount, 0);
});

test('registry close retains a quarantined late spawn if its stop ACK fails', async () => {
  let resolveSpawn;
  const pool = {
    spawn: () => new Promise(resolve => {resolveSpawn = resolve;}),
    close: async () => {}
  };
  const registry = new NativeWasmActorRegistry({pool});
  const spawning = registry.spawn(new Uint8Array([0]), {trusted:true});
  const closing = registry.close();
  resolveSpawn({send: async () => 1n,
    stop: async () => {throw Error('physical retirement unknown');}});
  await assert.rejects(spawning, /late spawned actor retirement unconfirmed/);
  await assert.rejects(closing, /cannot prove late-spawn retirement/);
  assert.equal(registry.actorCount, 1,
    'an unconfirmed physical worker retains its registry identity');
});


test('rotation begun before close cannot publish a late successor after pool shutdown', async () => {
  let resolveSuccessor, stopSuccessor;
  let spawnCalls = 0, stops = 0, closeSettled = false;
  const handle = (wait = false) => ({
    send: async () => 1n,
    stop: async () => {
      stops++;
      if (wait) await new Promise(resolve => {stopSuccessor = resolve;});
    }
  });
  const pool = {
    spawn: () => ++spawnCalls === 1 ? Promise.resolve(handle()) :
      new Promise(resolve => {resolveSuccessor = resolve;}),
    close: async () => {}
  };
  const registry = new NativeWasmActorRegistry({pool});
  const root = await registry.spawn(new Uint8Array([0]), {trusted:true});
  const rotating = registry.rotate(root, new Uint8Array([1]), {trusted:true});
  for (let n = 0; n < 10 && !resolveSuccessor; n++) await Promise.resolve();
  assert.equal(typeof resolveSuccessor, 'function');
  const closing = registry.close().then(() => {closeSettled = true;});
  resolveSuccessor(handle(true));
  for (let n = 0; n < 10 && !stopSuccessor; n++) await Promise.resolve();
  assert.equal(typeof stopSuccessor, 'function');
  assert.equal(closeSettled, false, 'late successor stop must hold close barrier');
  stopSuccessor();
  await assert.rejects(rotating, /revoked or registry closed during rotation/);
  await closing;
  assert.equal(registry.actorCount, 0);
  assert.equal(spawnCalls, 2);
  assert.equal(stops, 2);
});


test('ActorRef delegated depth is bounded without revoking valid ancestors', async () => {
  const {registry,spawn} = fixture();
  const root = await spawn();
  let descendant = root;
  for (let i = 0; i < 64; i++)
    descendant = registry.attenuate(descendant, {send:true,stop:false});
  assert.throws(() => registry.attenuate(descendant, {send:true,stop:false}),
    /attenuation depth exceeded/);
  assert.equal(await registry.send(root,1n,2n),2n);
  assert.equal(await registry.send(descendant,2n,3n),5n);
  await registry.close();
});

test('ActorRef grant exhaustion is fail-atomic and revocation is not a quota refund', async () => {
  const {registry,spawn} = fixture();
  const root = await spawn();
  // One root + 4095 delegated grants: exact maximum of 4096.
  let last;
  for (let i = 0; i < 4095; i++)
    last = registry.attenuate(root, {send:true,stop:false});
  assert.throws(() => registry.attenuate(root, {send:true,stop:false}),
    /grant capacity exceeded/);
  registry.revoke(last);
  assert.throws(() => registry.attenuate(root, {send:true,stop:false}),
    /grant capacity exceeded/,
    'revoke does not prove the host/guest discarded every copy of a grant');
  assert.equal(await registry.send(root,1n,7n),7n);
  await registry.close();
});


test('poisoned native collection iterators cannot bypass in-flight shutdown fences', async () => {
  let resolveSpawn, resolveStop, stopped = false, closeSettled = false;
  const registry = new NativeWasmActorRegistry({pool: {
    spawn: () => new Promise(resolve => {resolveSpawn = resolve;}),
    close: async () => {}
  }});
  const setCursor = Object.getPrototypeOf(new Set().values());
  const mapCursor = Object.getPrototypeOf(new Map().values());
  const old = {
    setAdd: Set.prototype.add,
    setDelete: Set.prototype.delete,
    setValues: Set.prototype.values,
    setNext: setCursor.next,
    mapValues: Map.prototype.values,
    mapNext: mapCursor.next
  };
  let spawning, closing;
  try {
    Set.prototype.add = () => {throw Error('poisoned Set.add');};
    Set.prototype.delete = () => {throw Error('poisoned Set.delete');};
    Set.prototype.values = () => {throw Error('poisoned Set.values');};
    setCursor.next = () => ({done:true});
    Map.prototype.values = () => {throw Error('poisoned Map.values');};
    mapCursor.next = () => ({done:true});
    spawning = registry.spawn(new Uint8Array([0]), {trusted:true});
    closing = registry.close().then(() => {closeSettled = true;});
  } finally {
    Set.prototype.add = old.setAdd;
    Set.prototype.delete = old.setDelete;
    Set.prototype.values = old.setValues;
    setCursor.next = old.setNext;
    Map.prototype.values = old.mapValues;
    mapCursor.next = old.mapNext;
  }
  await Promise.resolve();
  assert.equal(closeSettled, false);
  resolveSpawn({send:async()=>1n, stop: () => {
    stopped = true;
    return new Promise(resolve=>{resolveStop=resolve;});
  }});
  for (let i=0; i<8 && !stopped; i++) await Promise.resolve();
  assert.equal(stopped, true, 'late actor must not survive via poisoned iterators');
  assert.equal(closeSettled, false);
  resolveStop();
  await assert.rejects(spawning, /closed while spawning/);
  await closing;
  assert.equal(closeSettled, true);
  assert.equal(registry.actorCount, 0);
});

test('poisoned Map iterator cannot conceal live actors during close', async () => {
  const {registry,spawn,events} = fixture();
  const root = await spawn();
  const mapCursor = Object.getPrototypeOf(new Map().values());
  const oldValues = Map.prototype.values, oldNext = mapCursor.next;
  let closing;
  try {
    Map.prototype.values = () => {throw Error('poisoned Map.values');};
    mapCursor.next = () => ({done:true});
    closing = registry.close();
  } finally {
    Map.prototype.values = oldValues;
    mapCursor.next = oldNext;
  }
  await closing;
  assert.deepEqual(events, ['spawn','close']);
  assert.equal(registry.actorCount, 0);
  await assert.rejects(registry.send(root,1n,1n), /registry closed/);
});
