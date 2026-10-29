// Host-only test; not Wasm guest execution or real durable claims.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {create_agent_host_dispatch_gate as gate} from '../contracts/v1/agent-dispatch/agent-host-dispatch.mjs';
const revision='a'.repeat(40), digest='b'.repeat(64);
const request=()=>({tenant_id:'tenant',actor_id:'worker',actor_generation:7,
  activation_epoch:9,exact_revision:revision,dispatch_id:'dispatch',
  context_sha256:digest,expires_at_ms:10000,utf8_bytes:1024,measured_tokens:24});
function config(override={}) {
  return {tenant_id:'tenant',actor_id:'worker',actor_generation:7,
    activation_epoch:9,exact_revision:revision,token_cap:100,
    isCurrent:async()=>true,authorize:async()=>true,claimOnce:async()=>true,
    submitDataOnly:async()=>true,nowMs:()=>9000,...override};
}
test('admission validates exact scope, digest, expiry and resource caps', async()=>{
  for (const patch of [{tenant_id:'other'}, {actor_generation:8},
    {activation_epoch:10}, {exact_revision:'c'.repeat(40)},
    {dispatch_id:'?invalid'}, {context_sha256:'X'.repeat(64)},
    {expires_at_ms:9000}, {utf8_bytes:65537},
    {measured_tokens:101}, {measured_tokens:0}]) {
    let claims=0;
    const g=gate(config({claimOnce:async()=>{claims++;return true}}));
    assert.equal(await g.dispatch({...request(),...patch},9000),false);
    assert.equal(claims,0);
  }
});
test('host authorization, claim and post-claim revision are mandatory',async()=>{
  let sent=0;
  for(const change of [
    {authorize:async()=>false},
    {claimOnce:async()=>false},
    {claimOnce:async()=>{throw Error('storage IO')}},
    {isCurrent:(()=>{let count=0;return async()=>++count===1})()},
    {authorize:(()=>{let count=0;return async()=>++count===1})()}
  ]) {
    const g=gate(config({...change,submitDataOnly:async()=>{sent++;return true}}));
    assert.equal(await g.dispatch(request(),9000),false);
  }
  assert.equal(sent,0);
  assert.throws(()=>gate(config({claimOnce:null})),/trusted host/);
});
test('one instance admits at most one simultaneous dispatch',async()=>{
  let sent=0;
  const g=gate(config({submitDataOnly:async()=>{sent++;return true}}));
  const outcomes=await Promise.all(Array.from({length:16},()=>g.dispatch(request(),9000)));
  assert.equal(outcomes.filter(Boolean).length,1);
  assert.equal(sent,1);
});
test('unknown remote result fails closed and cannot retry',async()=>{
  let sent=0;
  const g=gate(config({submitDataOnly:async()=>{sent++;throw Error('unknown')}}));
  assert.equal(await g.dispatch(request(),9000),false);
  assert.equal(await g.dispatch(request(),9000),false);
  assert.equal(sent,1);
});
test('claim expiry before submit is rejected by trusted clock',async()=>{
  let now=9000, submits=0, claims=0;
  const g=gate(config({nowMs:()=>now,
    claimOnce:async()=>{claims++;now=10000;return true;},
    submitDataOnly:async()=>{submits++;return true}}));
  assert.equal(await g.dispatch(request(),9000),false);
  assert.equal(claims,1);
  assert.equal(submits,0);
  assert.equal(await gate(config({nowMs:()=>10000})).dispatch(request(),9000),false);
  assert.throws(()=>gate(config({nowMs:null})),/trusted host/);
});
test('forged getters, prototype or extra authorization fields are rejected',async()=>{
  for(const bad of [
    {...request(),approved:true},
    Object.assign(Object.create({approved:true}),request()),
    Object.defineProperty(request(),'tenant_id',{get(){throw Error('getter')},enumerable:true})
  ]) assert.equal(await gate(config()).dispatch(bad,9000),false);
});
