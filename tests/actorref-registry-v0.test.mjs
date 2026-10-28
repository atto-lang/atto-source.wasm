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
