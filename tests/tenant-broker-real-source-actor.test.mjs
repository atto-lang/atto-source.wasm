/**
 * Real source-compiler/actor bridge probe; intentionally NOT a full tenant
 * enforcement certificate. The current LLVM wasm32 actor compiler cannot emit
 * guest spawn/send. Guest DATA is returned via the compiled on_message export,
 * and a trusted host then binds it to a broker-authorized sender ActorRef.
 *
 * Separate one-Worker-per-tenant pools are NOT Wasmtime Stores or an OS
 * security boundary. The pool refuses untrusted guests. This test can prove
 * real compiler-produced actor turns plus host-broker dispatch ONLY.
 *
 * REQUIRE_TENANT_COMPILER_GUEST=1 makes a missing compiler a hard failure, not
 * a silent skipped security gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TrustedTenantBrokerV1} from '../src/trusted-tenant-broker-v1.mjs';

const compiler = process.env.ORESLANG_LLVM_COMPILER;
const compilerPin = process.env.ORESLANG_LLVM_COMPILER_SHA256;
const compilerSource = process.env.ORESLANG_LLVM_SOURCE_SHA;
const required = process.env.REQUIRE_TENANT_COMPILER_GUEST === '1';
const missing = !compiler || !compilerPin || !compilerSource;
const budget = overrides => ({
  maxMessages: 32, maxBytes: 256, maxCpuUnits: 32,
  maxMemoryBytes: 128, maxInflight: 4, ...overrides
});
const rejects = (promise, code) => assert.rejects(promise, {code});

test('required compiled tenant guest gate cannot degrade into a host-only PASS', () => {
  if (required) {
    assert.ok(!missing, 'REQUIRED_COMPILER_GUEST_NOT_EXECUTED: compiler, SHA-256, and LLVM source SHA must be supplied');
  }
  assert.equal(typeof TrustedTenantBrokerV1, 'function');
});

test('actual Atto source guest turns feed host-authenticated two-tenant broker across five scenarios',
  {skip: !required && missing ? 'NOT_EXECUTED: missing exact-pinned Atto LLVM compiler; no guest/security claim' : false,
   timeout: 120000}, async t => {
    assert.ok(isAbsolute(compiler || ''), 'real compiler must be an absolute path');
    assert.match(compilerPin || '', /^[a-f0-9]{64}$/, 'real compiler executable pin required');
    assert.match(compilerSource || '', /^[a-f0-9]{40}$/, 'real LLVM source commit required');
    const {compileSourceActorToWasm} = await import('../scripts/compile-source-actor.mjs');
    const {PooledWasmActors} = await import('../src/pooled-actor-host.mjs');
    const fixture = fileURLToPath(new URL('./fixtures/tenant-broker-actor.atto', import.meta.url));
    const built = await compileSourceActorToWasm({compiler, source:fixture,
      expectedCompilerSha256:compilerPin});
    assert.equal(built.provenance.compilerSha256, compilerPin);
    assert.equal(built.provenance.guestImports, 0, 'no guest broker import exists yet');
    assert.match(built.provenance.wasmSha256, /^[a-f0-9]{64}$/);

    const poolA = new PooledWasmActors({workers:1,maxActors:16,timeoutMs:10000});
    const poolB = new PooledWasmActors({workers:1,maxActors:16,timeoutMs:10000});
    const spawn = pool => pool.spawn(built.wasm,{
      expectedSha256:built.provenance.wasmSha256,trusted:true
    });
    const setup = async (aLimits=budget(),bLimits=budget()) => {
      const host=Object.freeze(Object.create(null));
      const broker=new TrustedTenantBrokerV1({hostAuthority:host});
      const a=broker.admitTenant(host,'source-tenant',aLimits);
      const b=broker.admitTenant(host,'receiver-tenant',bLimits);
      const source=await spawn(poolA), receiver=await spawn(poolB);
      let delivered=0;
      const sender=broker.registerActor(host,a,n=>source.send(n));
      const target=broker.registerActor(host,b,async n=>{delivered++;return receiver.send(n);});
      return {host,broker,a,b,source,receiver,sender,target,delivered:()=>delivered,
        authorize:()=>broker.authorize(host,sender,target)};
    };
    try {
      await assert.rejects(poolA.spawn(built.wasm,{
        expectedSha256:built.provenance.wasmSha256,trusted:false
      }), /trusted guest admission/);

      await t.test('quota persists across restart with actual guest emission and receiver delivery',async()=>{
        const x=await setup(budget({maxMessages:1,maxBytes:8,maxCpuUnits:1}));
        const payload=await x.source.send(3n);
        assert.equal(await x.broker.dispatch(x.host,x.sender,x.authorize(),payload),3n);
        assert.equal(x.delivered(),1);
        // Confirm a real compiled actor has stopped before authorizing its replacement.
        // Rotating the broker handle alone is not an actual guest restart.
        await x.source.stop();
        x.broker.retireActor(x.host,x.sender);
        x.broker.retireTenant(x.host,x.a);
        const nextTenant=x.broker.admitTenant(x.host,'source-tenant',
          budget({maxMessages:1,maxBytes:8,maxCpuUnits:1}));
        const replacement=await spawn(poolA);
        const restarted=x.broker.registerActor(x.host,nextTenant,n=>replacement.send(n));
        const cap=x.broker.authorize(x.host,restarted,x.target);
        const nextPayload=await replacement.send(1n);
        await rejects(x.broker.dispatch(x.host,restarted,cap,nextPayload),'TENANT_AGGREGATE_QUOTA');
        assert.equal(x.delivered(),1);
      });
      await t.test('revocation wins before compiler-produced receiver dispatch',async()=>{
        const x=await setup();
        const payload=await x.source.send(7n);
        const cap=x.authorize();
        await rejects(x.broker.dispatch(x.host,x.sender,cap,payload,{
          beforeDispatch:()=>x.broker.revoke(x.host,cap)
        }),'REVOKED_CAPABILITY');
        assert.equal(x.delivered(),0);
        assert.equal(x.broker.snapshot(x.host,x.a).reservedMessages,0);
      });
      await t.test('forged foreign ActorRef and capability denied before guest delivery',async()=>{
        const x=await setup();
        const payload=await x.source.send(5n);
        await rejects(x.broker.dispatch(x.host,x.sender,Object.freeze({tenant:'receiver-tenant'}),payload),
          'FORGED_CAPABILITY');
        await rejects(x.broker.dispatch(x.host,Object.freeze({tenant:'source-tenant'}),
          x.authorize(),payload),'STALE_OR_FORGED_ACTORREF');
        assert.equal(x.delivered(),0);
      });
      await t.test('authorized compiler-produced output delivers once to a second guest actor',async()=>{
        const x=await setup();
        const payload=await x.source.send(9n);
        const cap=x.authorize();
        assert.equal(await x.broker.dispatch(x.host,x.sender,cap,payload),9n);
        assert.equal(x.delivered(),1);
        await rejects(x.broker.dispatch(x.host,x.sender,cap,payload),
          'REPLAYED_OR_EXHAUSTED_CAPABILITY');
      });
      await t.test('tenant B continues when A exhausted',async()=>{
        const x=await setup(budget({maxMessages:1,maxBytes:8,maxCpuUnits:1}));
        const first=await x.source.send(1n);
        assert.equal(await x.broker.dispatch(x.host,x.sender,x.authorize(),first),1n);
        await rejects(x.broker.dispatch(x.host,x.sender,x.authorize(),1n),'TENANT_AGGREGATE_QUOTA');
        const bSenderGuest=await spawn(poolB);
        const bSender=x.broker.registerActor(x.host,x.b,n=>bSenderGuest.send(n));
        const bTicket=x.broker.authorize(x.host,bSender,x.target);
        const emitted=await bSenderGuest.send(2n);
        assert.equal(await x.broker.dispatch(x.host,bSender,bTicket,emitted),3n);
        assert.equal(x.delivered(),2);
      });
    } finally {
      await Promise.all([poolA.close(),poolB.close()]);
    }
  });
