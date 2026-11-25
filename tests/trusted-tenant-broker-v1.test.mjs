// This suite tests HOST enforcement only. It does not compile AttoLang guests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {TrustedTenantBrokerV1} from '../src/trusted-tenant-broker-v1.mjs';

const limits = (overrides = {}) => ({
  maxMessages: 10, maxBytes: 80, maxCpuUnits: 10,
  maxMemoryBytes: 64, maxInflight: 4, ...overrides
});
const setup = (aLimits = limits(), bLimits = limits()) => {
  const host = Object.freeze(Object.create(null));
  const broker = new TrustedTenantBrokerV1({hostAuthority: host});
  const a = broker.admitTenant(host,'tenant-a',aLimits);
  const b = broker.admitTenant(host,'tenant-b',bLimits);
  let seenA = 0, seenB = 0;
  const aSender = broker.registerActor(host,a,async n => {seenA++;return n + 1n;});
  const bReceiver = broker.registerActor(host,b,async n => {seenB++;return n + 1n;});
  const grant = () => broker.authorize(host,aSender,bReceiver);
  return {host,broker,a,b,aSender,bReceiver,grant,
    seen:()=>({a:seenA,b:seenB})};
};
const rejected = (p, code) => assert.rejects(p, {code});
const denied = (f, code) => assert.throws(f, {code});

test('real host authority is mandatory; guest-supplied tenant strings cannot impersonate it', async() => {
  const t=setup();
  denied(()=>t.broker.admitTenant({id:'tenant-a'},'tenant-c',limits()),'UNAUTHENTICATED_HOST');
  denied(()=>t.broker.registerActor(null,t.a,()=>0n),'UNAUTHENTICATED_HOST');
  await rejected(t.broker.dispatch({id:'tenant-a'},t.aSender,t.grant(),1n),'UNAUTHENTICATED_HOST');
});

test('authorized host broker delivers once and accounts for both independent tenants', async() => {
  const t=setup();
  const ticket=t.grant();
  assert.equal(await t.broker.dispatch(t.host,t.aSender,ticket,41n),42n);
  assert.deepEqual(t.seen(),{a:0,b:1});
  for(const tenant of [t.a,t.b]) {
    const s=t.broker.snapshot(t.host,tenant);
    assert.equal(s.usedMessages,1);assert.equal(s.usedBytes,8);
    assert.equal(s.usedCpuUnits,1);assert.equal(s.inflight,0);
    assert.equal(s.reservedMemoryBytes,0);
  }
  await rejected(t.broker.dispatch(t.host,t.aSender,ticket,40n),'REPLAYED_OR_EXHAUSTED_CAPABILITY');
});

test('tenant aggregate quota does not reset after actor restart or new incarnation', async() => {
  const t=setup(limits({maxMessages:1,maxBytes:8,maxCpuUnits:1}));
  assert.equal(await t.broker.dispatch(t.host,t.aSender,t.grant(),8n),9n);
  t.broker.retireActor(t.host,t.aSender);
  t.broker.retireTenant(t.host,t.a);
  const fresh=t.broker.admitTenant(t.host,'tenant-a',limits({maxMessages:1,maxBytes:8,maxCpuUnits:1}));
  const next=t.broker.registerActor(t.host,fresh,async n=>n);
  const ticket=t.broker.authorize(t.host,next,t.bReceiver);
  await rejected(t.broker.dispatch(t.host,next,ticket,8n),'TENANT_AGGREGATE_QUOTA');
  assert.equal(t.broker.snapshot(t.host,fresh).usedMessages,1);
  await rejected(t.broker.dispatch(t.host,t.aSender,ticket,9n),'STALE_OR_FORGED_ACTORREF');
  assert.equal(t.seen().b,1);
});

test('revocation after atomic quota reservation, before dispatch denies and refunds exactly once', async() => {
  const t=setup(limits({maxMessages:1,maxBytes:8}));
  let enter, release;
  const entered=new Promise(resolve=>{enter=resolve;});
  const barrier=new Promise(resolve=>{release=resolve;});
  const ticket=t.grant();
  const pending=t.broker.dispatch(t.host,t.aSender,ticket,13n,{
    beforeDispatch:()=>{enter();return barrier;}
  });
  await entered;
  let snap=t.broker.snapshot(t.host,t.a);
  assert.equal(snap.reservedMessages,1);assert.equal(snap.inflight,1);
  t.broker.revoke(t.host,ticket);release();
  await rejected(pending,'REVOKED_CAPABILITY');
  snap=t.broker.snapshot(t.host,t.a);
  assert.equal(snap.reservedMessages,0);assert.equal(snap.inflight,0);
  assert.equal(snap.usedMessages,0);assert.equal(snap.reservedMemoryBytes,0);
  assert.equal(t.broker.snapshot(t.host,t.b).inflight,0);
  assert.equal(t.seen().b,0);
  await rejected(t.broker.dispatch(t.host,t.aSender,ticket,13n),'REVOKED_CAPABILITY');
  assert.equal(t.broker.snapshot(t.host,t.a).inflight,0);
});

test('forged ActorRef/capability is rejected before any target is resolved or delivered', async() => {
  const t=setup();
  const forged=Object.freeze({id:'tenant-b',generation:1,actor:'receiver'});
  await rejected(t.broker.dispatch(t.host,t.aSender,forged,9n),'FORGED_CAPABILITY');
  await rejected(t.broker.dispatch(t.host,forged,t.grant(),9n),'STALE_OR_FORGED_ACTORREF');
  assert.deepEqual(t.seen(),{a:0,b:0});
  assert.equal(t.broker.snapshot(t.host,t.a).reservedMessages,0);
});

test('capabilities are actor-bound; sibling cannot steal sender authority', async() => {
  const t=setup();
  const sibling=t.broker.registerActor(t.host,t.a,async n=>n);
  await rejected(t.broker.dispatch(t.host,sibling,t.grant(),4n),'CAPABILITY_SENDER_MISMATCH');
  assert.equal(t.seen().b,0);
});

test('unaffected neighboring tenant can progress after A quota exhaustion', async() => {
  const t=setup(limits({maxMessages:1,maxBytes:8}),limits());
  assert.equal(await t.broker.dispatch(t.host,t.aSender,t.grant(),5n),6n);
  await rejected(t.broker.dispatch(t.host,t.aSender,t.grant(),5n),'TENANT_AGGREGATE_QUOTA');
  const bSender=t.broker.registerActor(t.host,t.b,async n=>n);
  const grant=t.broker.authorize(t.host,bSender,t.bReceiver);
  assert.equal(await t.broker.dispatch(t.host,bSender,grant,10n),11n);
  assert.equal(t.seen().b,2);
  assert.equal(t.broker.snapshot(t.host,t.b).usedMessages,2);
});

test('abort before dispatch releases all reserved credits and does not deliver', async() => {
  const t=setup();
  const c=new AbortController();
  let started,done;
  const entered=new Promise(resolve=>{started=resolve;});
  const barrier=new Promise(resolve=>{done=resolve;});
  const pending=t.broker.dispatch(t.host,t.aSender,t.grant(),9n,{
    signal:c.signal,beforeDispatch:()=>{started();return barrier;}
  });
  await entered;c.abort();done();
  await rejected(pending,'DISPATCH_CANCELLED');
  assert.equal(t.seen().b,0);
  for(const x of [t.a,t.b]){
    const s=t.broker.snapshot(t.host,x);
    assert.equal(s.usedMessages,0);assert.equal(s.reservedMessages,0);
    assert.equal(s.inflight,0);assert.equal(s.reservedMemoryBytes,0);
  }
});

test('quota reservation happens synchronously and only one inflight request fits', async() => {
  const t=setup(limits({maxInflight:1}),limits({maxInflight:1}));
  let entered,done;
  const started=new Promise(r=>{entered=r;});
  const barrier=new Promise(r=>{done=r;});
  const first=t.broker.dispatch(t.host,t.aSender,t.grant(),3n,{
    beforeDispatch:()=>{entered();return barrier;}
  });
  await started;
  await rejected(t.broker.dispatch(t.host,t.aSender,t.grant(),4n),'ACTOR_INFLIGHT_QUOTA');
  done();
  assert.equal(await first,4n);
  assert.equal(t.seen().b,1);
});

test('unknown and stale capabilities cannot reopen a retired generation', async() => {
  const t=setup();
  const ticket=t.grant();
  t.broker.retireTenant(t.host,t.b);
  await rejected(t.broker.dispatch(t.host,t.aSender,ticket,1n),'STALE_CAPABILITY_GENERATION');
  const newB=t.broker.admitTenant(t.host,'tenant-b',limits());
  assert.equal(t.broker.snapshot(t.host,newB).generation,2);
  await rejected(t.broker.dispatch(t.host,t.aSender,ticket,1n),'STALE_CAPABILITY_GENERATION');
  assert.equal(t.seen().b,0);
});

test('ambiguous recipient failure quarantines reservation; never refunds by assumption', async() => {
  const t=setup();
  const failure=t.broker.registerActor(t.host,t.b,async()=>{throw Error('ACK_LOST');});
  const ticket=t.broker.authorize(t.host,t.aSender,failure);
  await assert.rejects(t.broker.dispatch(t.host,t.aSender,ticket,3n),/ACK_LOST/);
  const state=t.broker.snapshot(t.host,t.a);
  assert.equal(state.uncertain,1);assert.equal(state.inflight,1);
  assert.equal(state.reservedMessages,1);assert.equal(state.reservedMemoryBytes,8);
  denied(()=>t.broker.retireTenant(t.host,t.a),'TENANT_HAS_UNSETTLED_WORK');
  denied(()=>t.broker.close(t.host),'BROKER_HAS_UNSETTLED_WORK');
});

test('invalid values and authority flags are rejected before quota changes', async() => {
  const t=setup();
  const ticket=t.grant();
  for(const value of [0,1.5,2**70,1n<<63n,-(1n<<63n)-1n,'9']) {
    await rejected(t.broker.dispatch(t.host,t.aSender,ticket,value),'INVALID_GUEST_DATA_I64');
  }
  assert.equal(t.broker.snapshot(t.host,t.a).inflight,0);
  assert.equal(t.seen().b,0);
});

test('explicit policy limits cannot change silently across tenant reincarnation', () => {
  const t=setup();
  t.broker.retireTenant(t.host,t.a);
  denied(()=>t.broker.admitTenant(t.host,'tenant-a',limits({maxMessages:11})),
    'TENANT_LIMIT_CHANGE_REQUIRES_HOST_POLICY_REVIEW');
});

test('invalid tenant identities and missing quotas fail closed', () => {
  const host={};const broker=new TrustedTenantBrokerV1({hostAuthority:host});
  for(const id of ['','.','..','../x','a/b','x'.repeat(129)]) {
    denied(()=>broker.admitTenant(host,id,limits()),'INVALID_TENANT_ID');
  }
  for(const opts of [{},limits({maxInflight:0}),limits({maxBytes:-1})]){
    denied(()=>broker.admitTenant(host,'valid-name',opts),'INVALID_TENANT_LIMITS');
  }
});

test('self-directed actor reserve counts one actor once under a one-inflight limit', async() => {
  const host=Object.freeze({});
  const broker=new TrustedTenantBrokerV1({hostAuthority:host});
  const tenant=broker.admitTenant(host,'self',limits({maxInflight:1}));
  let deliveries=0;
  const actor=broker.registerActor(host,tenant,async n=>{deliveries++;return n+1n;});
  const capability=broker.authorize(host,actor,actor);
  assert.equal(await broker.dispatch(host,actor,capability,4n),5n);
  assert.equal(deliveries,1);
  const snapshot=broker.snapshot(host,tenant);
  assert.equal(snapshot.usedMessages,1);
  assert.equal(snapshot.inflight,0);
  assert.equal(snapshot.reservedMemoryBytes,0);
});

test('guest ticket replay cannot exploit reusable capability allowances', () => {
  const t=setup();
  denied(()=>t.broker.authorize(t.host,t.aSender,t.bReceiver,{maxUses:2}),
    'ONE_SHOT_CAPABILITY_REQUIRED');
  const minted=t.grant();
  assert.equal(Object.keys(minted).length,0,'opaque host-only capability carries no serializable authority');
});
