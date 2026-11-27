import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {TrustedTenantVMHost} from '../src/trusted-tenant-vm-host.mjs';

// This is a real Worker termination/host-accounting gate, NOT a compiled
// AttoLang guest fixture. Wrong SHA rejects before Wasm compilation.
const bytes = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
const wrongPin = '0'.repeat(64);

test('failed async admission cannot refund tenant slots during unconfirmed retirement', async () => {
  const original = Worker.prototype.terminate;
  let signalPhysicalStop, releaseReceipt;
  const stopped = new Promise(resolve => {signalPhysicalStop = resolve;});
  Worker.prototype.terminate = function (...args) {
    return original.apply(this, args).then(exitCode => new Promise(resolve => {
      releaseReceipt = () => resolve(exitCode);
      signalPhysicalStop();
    }));
  };
  const host = new TrustedTenantVMHost({maxTenants: 2, maxActorsPerTenant: 1, maxHostActors: 1});
  let closing;
  try {
    const a = host.open_trusted_tenant_vm('a', {trusted: true});
    const rejected = assert.rejects(
      host.spawn_actor(a, bytes, {expectedSha256: wrongPin}), /digest mismatch/);
    closing = host.close_tenant_vm(a);
    await stopped; // Actual Worker terminated; receipt still withheld.
    await rejected;
    assert.equal(host.reservedActorCount, 1,
      'quiescing tenant must retain slot until termination receipt');
    assert.equal(host.tenantCount, 1);
    assert.throws(() => host.open_trusted_tenant_vm('a', {trusted: true}), /duplicate/);
    const b = host.open_trusted_tenant_vm('b', {trusted: true});
    await assert.rejects(host.spawn_actor(b, bytes, {expectedSha256: wrongPin}),
      /actor quota/, 'unconfirmed tenant cannot grant capacity to other tenant');
    releaseReceipt();
    await closing;
    assert.equal(host.reservedActorCount, 0);
    assert.equal(host.tenantCount, 1);
    // Capacity is now available, so artifact authentication (not quota) rejects.
    await assert.rejects(host.spawn_actor(b, bytes, {expectedSha256: wrongPin}),
      /digest mismatch/);
    assert.equal(host.reservedActorCount, 0);
  } finally {
    if (releaseReceipt) releaseReceipt();
    Worker.prototype.terminate = original;
    if (closing) await closing.catch(() => {});
    await host.close();
  }
});

test('failed termination keeps tenant ID and aggregate quota quarantined', async () => {
  const original = Worker.prototype.terminate;
  Worker.prototype.terminate = function (...args) {
    return original.apply(this, args).then(() => {
      throw Error('injected unconfirmed termination receipt');
    });
  };
  const host = new TrustedTenantVMHost({maxTenants: 2, maxActorsPerTenant: 1, maxHostActors: 1});
  try {
    const a = host.open_trusted_tenant_vm('a', {trusted: true});
    const rejected = assert.rejects(
      host.spawn_actor(a, bytes, {expectedSha256: wrongPin}), /digest mismatch/);
    const closing = assert.rejects(host.close_tenant_vm(a), /termination unconfirmed/);
    await rejected;
    await closing;
    assert.equal(host.reservedActorCount, 1);
    assert.equal(host.tenantCount, 1);
    assert.throws(() => host.open_trusted_tenant_vm('a', {trusted: true}), /duplicate/);
    const b = host.open_trusted_tenant_vm('b', {trusted: true});
    await assert.rejects(host.spawn_actor(b, bytes, {expectedSha256: wrongPin}), /actor quota/);
  } finally {
    Worker.prototype.terminate = original;
    await assert.rejects(host.close(), /teardown unconfirmed/);
  }
});
