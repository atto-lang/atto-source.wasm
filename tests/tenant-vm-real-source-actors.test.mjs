import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {compileSourceActorToWasm} from '../scripts/compile-source-actor.mjs';
import {TrustedTenantVMHost} from '../src/trusted-tenant-vm-host.mjs';

// This MUST use a real, independently authenticated LLVM compiler binary.
// A SHA-256 pin identifies the bytes, but is not itself compiler provenance.
const compiler = process.env.ORESLANG_LLVM_COMPILER;
const required = process.env.REQUIRE_REAL_TENANTVM_ACTOR === '1';
const skip = !compiler && !required ? 'requires real, authenticated LLVM source compiler' : false;

test('real .atto guest: two TenantVMs contain six independent actor instances', {skip}, async () => {
  assert.ok(compiler, 'NOT_EXECUTED: real LLVM source compiler required');
  assert.match(process.env.ORESLANG_LLVM_COMPILER_SHA256 || '', /^[a-f0-9]{64}$/,
    'NOT_EXECUTED: exact compiler binary pin required');
  const built = await compileSourceActorToWasm({
    compiler,
    source: fileURLToPath(new URL('./fixtures/tenant-vm-counter.atto', import.meta.url)),
    expectedCompilerSha256: process.env.ORESLANG_LLVM_COMPILER_SHA256
  });
  assert.equal(built.provenance.guestImports, 0);
  assert.equal(built.provenance.actorAbi, 'pooled-actor-i64-v0');
  const host = new TrustedTenantVMHost({maxTenants: 2, maxActorsPerTenant: 3,
    maxHostActors: 6, timeoutMs: 5000});
  try {
    const a = host.open_trusted_tenant_vm('tenant-a', {trusted: true});
    const b = host.open_trusted_tenant_vm('tenant-b', {trusted: true});
    const spawn = tenant => host.spawn_actor(tenant, built.wasm,
      {expectedSha256: built.provenance.wasmSha256});
    const actorsA = await Promise.all(Array.from({length: 3}, () => spawn(a)));
    const actorsB = await Promise.all(Array.from({length: 3}, () => spawn(b)));
    assert.equal(host.reservedActorCount, 6);
    for (let turn = 1n; turn <= 25n; turn++) {
      assert.deepEqual(await Promise.all([...actorsA, ...actorsB].map((actor, i) =>
        host.send_actor(i < 3 ? a : b, actor, 1n))), Array(6).fill(turn));
    }
    await assert.rejects(host.send_actor(b, actorsA[0], 1n), /foreign/);
    await host.close_tenant_vm(a);  // worker termination confirmed first
    assert.equal(host.reservedActorCount, 3);
    await assert.rejects(host.send_actor(a, actorsA[0], 1n), /stale/);
    assert.deepEqual(await Promise.all(actorsB.map(actor => host.send_actor(b, actor, 1n))),
      [26n, 26n, 26n], 'healthy tenant must continue after neighbor teardown');
    const fresh = host.open_trusted_tenant_vm('tenant-a', {trusted: true});
    const restarted = await spawn(fresh);
    assert.equal(await host.send_actor(fresh, restarted, 1n), 1n);
    await assert.rejects(host.send_actor(a, restarted, 1n), /stale/);
    await host.stop_actor(fresh, restarted);
    await host.close_tenant_vm(fresh);
    await host.close_tenant_vm(b);
    assert.equal(host.reservedActorCount, 0);
  } finally {await host.close();}
});
