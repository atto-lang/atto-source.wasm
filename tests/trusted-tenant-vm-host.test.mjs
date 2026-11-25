import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {TrustedTenantVMHost} from '../src/trusted-tenant-vm-host.mjs';

// LLVM IR fixture directly linked to WASM. This exercises the actual host and
// guest VM, NOT the AttoLang frontend. The required .atto gate is separate.
function hostFixture({spin = false} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atto-tenant-vm-'));
  try {
    const out = join(dir, 'actor.wasm');
    const ir = [
      'target triple = "wasm32-unknown-unknown"',
      '@counter = internal global i64 0',
      'define void @oreslang_wasm_actor_init() { ret void }',
      'define i64 @oreslang_wasm_actor_on_message(i64 %value) {',
      'entry:',
      ...(spin ? ['br label %spin', 'spin:', 'br label %spin'] : [
        '%old = load i64, ptr @counter',
        '%next = add i64 %old, %value',
        'store i64 %next, ptr @counter',
        'ret i64 %next'
      ]),
      '}',
      'define void @oreslang_wasm_actor_teardown() { ret void }',
      ''
    ].join('\n');
    const r = spawnSync(process.env.CLANG || 'clang', [
      '--target=wasm32', '-x', 'ir', '-O0', '-nostdlib',
      '-Wl,--no-entry', '-Wl,--export-memory',
      '-Wl,--export=oreslang_wasm_actor_init',
      '-Wl,--export=oreslang_wasm_actor_on_message',
      '-Wl,--export=oreslang_wasm_actor_teardown',
      '-Wl,--initial-memory=131072', '-Wl,--max-memory=131072',
      '-o', out, '-'
    ], {input: ir, encoding: 'utf8', timeout: 30000});
    if (r.error || r.status !== 0) throw Error('host-only Wasm fixture failed to link: ' + (r.error?.message || r.stderr));
    return readFileSync(out);
  } finally {rmSync(dir, {recursive: true, force: true});}
}
const pin = bytes => createHash('sha256').update(bytes).digest('hex');

test('two TenantVMs contain six actors with generation-fenced cross-tenant admission', async () => {
  const wasm = hostFixture();
  const host = new TrustedTenantVMHost({maxTenants: 2, maxActorsPerTenant: 3, maxHostActors: 6});
  try {
    assert.throws(() => host.open_trusted_tenant_vm('untrusted'), /verified isolation/);
    const a = host.open_trusted_tenant_vm('tenant-a', {trusted: true});
    const b = host.open_trusted_tenant_vm('tenant-b', {trusted: true});
    assert.throws(() => host.open_trusted_tenant_vm('tenant-a', {trusted: true}), /duplicate/);
    const actorsA = await Promise.all(Array.from({length: 3}, () =>
      host.spawn_actor(a, wasm, {expectedSha256: pin(wasm)})));
    const actorsB = await Promise.all(Array.from({length: 3}, () =>
      host.spawn_actor(b, wasm, {expectedSha256: pin(wasm)})));
    assert.equal(host.tenantCount, 2);
    assert.equal(host.reservedActorCount, 6);
    await assert.rejects(host.spawn_actor(a, wasm, {expectedSha256: pin(wasm)}), /actor quota/);
    await assert.rejects(host.send_actor(a, actorsB[0], 1n), /foreign/);
    assert.deepEqual(await Promise.all([...actorsA, ...actorsB].map((actor, i) =>
      host.send_actor(i < 3 ? a : b, actor, 1n))), Array(6).fill(1n));
    assert.deepEqual(await Promise.all([...actorsA, ...actorsB].map((actor, i) =>
      host.send_actor(i < 3 ? a : b, actor, BigInt(i + 2)))),
      [3n, 4n, 5n, 6n, 7n, 8n]);
    // Physically terminating tenant A's dedicated Worker must not harm B.
    await host.close_tenant_vm(a);
    assert.equal(host.tenantCount, 1);
    assert.equal(host.reservedActorCount, 3);
    await assert.rejects(host.send_actor(a, actorsA[0], 1n), /foreign or stale/);
    assert.deepEqual(await Promise.all(actorsB.map(actor => host.send_actor(b, actor, 1n))),
      [7n, 8n, 9n]);
    const next = host.open_trusted_tenant_vm('tenant-a', {trusted: true});
    await assert.rejects(host.spawn_actor(a, wasm, {expectedSha256: pin(wasm)}), /foreign or stale/);
    const replacement = await host.spawn_actor(next, wasm, {expectedSha256: pin(wasm)});
    assert.equal(await host.send_actor(next, replacement, 4n), 4n);
    await host.stop_actor(next, replacement);
    await assert.rejects(host.send_actor(next, replacement, 1n), /retired/);
    await host.close_tenant_vm(next);
    await host.close_tenant_vm(b);
    assert.equal(host.reservedActorCount, 0);
  } finally {await host.close();}
});

test('rejected IDs, malformed artifacts and concurrent actor admission do not overcommit', async () => {
  const wasm = hostFixture();
  const host = new TrustedTenantVMHost({maxTenants: 1, maxActorsPerTenant: 2, maxHostActors: 2});
  try {
    for (const id of ['.', '..', '../other', 'tenant/other', 'tenant:other', 'ténant', 'a'.repeat(129)])
      assert.throws(() => host.open_trusted_tenant_vm(id, {trusted: true}), /invalid tenant identity/);
    const tenant = host.open_trusted_tenant_vm('tenant-a', {trusted: true});
    await assert.rejects(host.spawn_actor(tenant, wasm, {expectedSha256: '0'.repeat(64)}), /digest mismatch/);
    assert.equal(host.reservedActorCount, 0);
    const results = await Promise.allSettled(Array.from({length: 3}, () =>
      host.spawn_actor(tenant, wasm, {expectedSha256: pin(wasm)})));
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 2);
    assert.equal(results.filter(x => x.status === 'rejected').length, 1);
    assert.equal(host.reservedActorCount, 2);
    const a = results.find(x => x.status === 'fulfilled').value;
    await assert.rejects(host.send_actor(tenant, a, 1), /signed i64/);
    assert.equal(await host.send_actor(tenant, a, 1n), 1n);
    await host.stop_actor(tenant, a);
    assert.equal(host.reservedActorCount, 1);
    const next = await host.spawn_actor(tenant, wasm, {expectedSha256: pin(wasm)});
    assert.equal(await host.send_actor(tenant, next, 2n), 2n);
  } finally {await host.close();}
});

test('spinning guest kills only its TenantVM and physically retires the worker', async () => {
  const spin = hostFixture({spin: true}), good = hostFixture();
  const host = new TrustedTenantVMHost({maxTenants: 2, maxActorsPerTenant: 3,
    maxHostActors: 6, timeoutMs: 200});
  try {
    const a = host.open_trusted_tenant_vm('offender', {trusted: true});
    const b = host.open_trusted_tenant_vm('neighbor', {trusted: true});
    const culprit = await host.spawn_actor(a, spin, {expectedSha256: pin(spin)});
    const colocated = await host.spawn_actor(a, good, {expectedSha256: pin(good)});
    const survivor = await host.spawn_actor(b, good, {expectedSha256: pin(good)});
    const failure = host.send_actor(a, culprit, 1n);
    const queued = host.send_actor(a, colocated, 1n);
    assert.equal(await host.send_actor(b, survivor, 7n), 7n);
    await assert.rejects(failure, /deadline exceeded/);
    await assert.rejects(queued, /deadline exceeded|retired|closed/);
    assert.equal(host.tenantCount, 1);
    assert.equal(host.reservedActorCount, 1);
    assert.equal(await host.send_actor(b, survivor, 3n), 10n);
    const restart = host.open_trusted_tenant_vm('offender', {trusted: true});
    const fresh = await host.spawn_actor(restart, good, {expectedSha256: pin(good)});
    assert.equal(await host.send_actor(restart, fresh, 1n), 1n);
    await assert.rejects(host.send_actor(a, culprit, 1n), /foreign or stale/);
  } finally {await host.close();}
});

test('confirmed tenant retirement revokes retained actor capabilities across generation reuse', async () => {
  const wasm = hostFixture();
  const host = new TrustedTenantVMHost({maxTenants: 1, maxActorsPerTenant: 2,
    maxHostActors: 2, timeoutMs: 5000});
  const stale = [];
  try {
    for (let generation = 1; generation <= 4; generation++) {
      const tenant = host.open_trusted_tenant_vm('recycled-id', {trusted: true});
      const first = await host.spawn_actor(tenant, wasm, {expectedSha256: pin(wasm)});
      const second = await host.spawn_actor(tenant, wasm, {expectedSha256: pin(wasm)});
      assert.equal(await host.send_actor(tenant, first, 1n), 1n);
      assert.equal(await host.send_actor(tenant, second, 2n), 2n);
      for (const expired of stale) {
        await assert.rejects(host.send_actor(expired.tenant, expired.ref, 1n), /foreign or stale/);
        await assert.rejects(host.send_actor(tenant, expired.ref, 1n), /foreign|stale|retired/);
      }
      // Keep both actor references in the caller after physical termination:
      // no old token may authorize a new generation or keep registry authority.
      await host.close_tenant_vm(tenant);
      stale.push({tenant, ref: first}, {tenant, ref: second});
      assert.equal(host.tenantCount, 0);
      assert.equal(host.reservedActorCount, 0);
      await assert.rejects(host.send_actor(tenant, first, 1n), /foreign or stale/);
    }
    assert.equal(stale.length, 8);
  } finally { await host.close(); }
});
