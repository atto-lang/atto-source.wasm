import {PooledWasmActors} from './pooled-actor-host.mjs';

// Host-only bridge: one dedicated Node Worker carrier per tenant incarnation,
// multiple private WASM actor instances within it. Node Workers are NOT an
// adversarial JS sandbox. Never expose this host to guest code/network peers.
const validTenantId = id => typeof id === 'string' &&
  id !== '.' && id !== '..' && /^[A-Za-z0-9_.-]{1,128}$/.test(id);
const bounded = (n, max, name) => {
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw new RangeError('invalid ' + name);
  return n;
};
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;

/**
 * Trusted-host TenantVM lifecycle prototype, not the shared-process
 * UNTRUSTED TenantVM contract. Each tenant gets its own Worker; each actor
 * gets a separate checked WebAssembly instance and bounded private memory.
 * Actor turns remain serial on the tenant's one Worker in this narrow ABI.
 */
export class TrustedTenantVMHost {
  #tenants = new Map();
  #tenantHandles = new WeakMap();
  #actorHandles = new WeakMap();
  #nextGeneration = 1;
  #hostActorSlots = 0;
  #closed = false;
  #maxTenants;
  #maxActorsPerTenant;
  #maxHostActors;
  #mailboxCapacity;
  #timeoutMs;

  constructor({maxTenants = 4, maxActorsPerTenant = 8,
    maxHostActors = 32, mailboxCapacity = 16, timeoutMs = 2000} = {}) {
    this.#maxTenants = bounded(maxTenants, 16, 'tenant capacity');
    this.#maxActorsPerTenant = bounded(maxActorsPerTenant, 64, 'tenant actor capacity');
    this.#maxHostActors = bounded(maxHostActors, 1024, 'host actor capacity');
    this.#mailboxCapacity = bounded(mailboxCapacity, 1024, 'mailbox capacity');
    this.#timeoutMs = bounded(timeoutMs, 30000, 'actor deadline');
  }
  get tenantCount() { return this.#tenants.size; }
  get reservedActorCount() { return this.#hostActorSlots; }

  open_trusted_tenant_vm(id, {trusted = false} = {}) {
    // This privileged API is only called by the trusted embedder. A caller's
    // trusted:true is NOT a deployment artifact signature or guest authority.
    if (trusted !== true) throw new Error('untrusted TenantVM requires a verified isolation boundary');
    if (!validTenantId(id)) throw new TypeError('invalid tenant identity');
    if (this.#closed) throw new Error('TenantVM root closed');
    if (this.#tenants.has(id)) throw new Error('duplicate tenant');
    if (this.#tenants.size >= this.#maxTenants) throw new Error('tenant capacity exhausted');
    if (!Number.isSafeInteger(this.#nextGeneration)) throw new Error('tenant generation exhausted');
    const generation = this.#nextGeneration++;
    const pool = new PooledWasmActors({workers: 1,
      maxActors: this.#maxActorsPerTenant,
      mailboxCapacity: this.#mailboxCapacity, timeoutMs: this.#timeoutMs});
    const handle = Object.freeze(Object.create(null));
    const tenant = {id, generation, handle, pool, phase: 'running',
      actorSlots: 0, actorRefs: new Set(), closePromise: null};
    this.#tenantHandles.set(handle, tenant);
    this.#tenants.set(id, tenant);
    return handle;
  }

  #checkedTenant(handle) {
    const tenant = handle && typeof handle === 'object' ? this.#tenantHandles.get(handle) : null;
    if (!tenant || this.#tenants.get(tenant.id) !== tenant || tenant.handle !== handle)
      throw new Error('foreign or stale TenantVM authority');
    return tenant;
  }
  #checkedActor(tenant, ref) {
    const actor = ref && typeof ref === 'object' ? this.#actorHandles.get(ref) : null;
    if (!actor || actor.tenant !== tenant || actor.phase !== 'running')
      throw new Error('foreign, stale or retired actor authority');
    return actor;
  }
  #releaseSlot(tenant) {
    // Only an ACTIVE tenant with a live worker can refund a completed
    // actor admission or stop. During quiescence/quarantine and after a
    // carrier fault, keep EVERY outstanding reservation charged until a
    // confirmed physical Worker.terminate() receipt in close_tenant_vm.
    // Otherwise an async spawn/stop could free host capacity while a guest
    // still runs and permit unrelated tenants to overcommit the host.
    if (tenant.phase !== 'running' || tenant.pool.activeWorkerCount !== 1) return;
    if (tenant.actorSlots <= 0 || this.#hostActorSlots <= 0)
      throw new Error('TenantVM actor reservation underflow');
    tenant.actorSlots--;
    this.#hostActorSlots--;
  }

  async spawn_actor(handle, bytes, {expectedSha256} = {}) {
    const tenant = this.#checkedTenant(handle);
    if (tenant.phase !== 'running') throw new Error('TenantVM admission sealed');
    if (tenant.actorSlots >= this.#maxActorsPerTenant ||
        this.#hostActorSlots >= this.#maxHostActors)
      throw new Error('TenantVM actor quota exhausted');
    // Reserve before the first await; simultaneous spawns may not oversubscribe.
    tenant.actorSlots++;
    this.#hostActorSlots++;
    try {
      const runtime = await tenant.pool.spawn(bytes, {expectedSha256, trusted: true});
      if (tenant.phase !== 'running') throw new Error('TenantVM retired during actor admission');
      const ref = Object.freeze(Object.create(null));
      this.#actorHandles.set(ref, {tenant, runtime, phase: 'running'});
      // Track only the bounded live tenant capabilities so confirmed physical
      // teardown can revoke every surviving WeakMap value. Without this,
      // callers retaining stale actor tokens also retain the retired pool.
      tenant.actorRefs.add(ref);
      return ref;
    } catch (error) {
      this.#releaseSlot(tenant);
      if (tenant.pool.activeWorkerCount === 0 && tenant.phase === 'running') {
        try { await this.close_tenant_vm(handle); }
        catch { /* leave tenant quarantined until physical stop is confirmed */ }
      }
      throw error;
    }
  }

  async send_actor(handle, ref, value) {
    const tenant = this.#checkedTenant(handle);
    if (tenant.phase !== 'running') throw new Error('TenantVM admission sealed');
    const actor = this.#checkedActor(tenant, ref);
    if (typeof value !== 'bigint' || value < I64_MIN || value > I64_MAX)
      throw new TypeError('message must be signed i64');
    try {
      return await actor.runtime.send(value);
    } catch (error) {
      // One Worker belongs exclusively to this TenantVM; a carrier failure
      // must retire that tenant only, after physical termination is confirmed.
      if (tenant.pool.activeWorkerCount === 0) {
        try { await this.close_tenant_vm(handle); }
        catch { /* quarantined: never grant fresh authority */ }
      }
      throw error;
    }
  }

  async stop_actor(handle, ref) {
    const tenant = this.#checkedTenant(handle);
    if (tenant.phase !== 'running') throw new Error('TenantVM admission sealed');
    const actor = this.#checkedActor(tenant, ref);
    actor.phase = 'stopping';
    try {
      await actor.runtime.stop();
      actor.phase = 'retired';
      this.#actorHandles.delete(ref);
      tenant.actorRefs.delete(ref);
      this.#releaseSlot(tenant);
    } catch (error) {
      actor.phase = 'quarantined';
      if (tenant.pool.activeWorkerCount === 0) {
        try { await this.close_tenant_vm(handle); }
        catch { /* quarantined: identity and reservations retained */ }
      }
      throw error;
    }
  }

  close_tenant_vm(handle) {
    const tenant = this.#checkedTenant(handle);
    if (tenant.closePromise) return tenant.closePromise;
    tenant.phase = 'quiescing';
    tenant.closePromise = tenant.pool.close().then(() => {
      // A termination receipt is necessary, but actor reservation accounting
      // must also reconcile atomically before returning the tenant ID. Never
      // silently underflow aggregate capacity or certify a corrupt drain.
      if (!Number.isSafeInteger(tenant.actorSlots) || tenant.actorSlots < 0 ||
          tenant.actorSlots > this.#hostActorSlots ||
          this.#tenants.get(tenant.id) !== tenant) {
        tenant.phase = 'quarantined';
        throw new Error('TenantVM retirement accounting inconsistent');
      }
      // Worker.terminate() must finish BEFORE reclaiming tenant generation,
      // permits, actors, actor slots or accepting a replacement tenant ID.
      this.#hostActorSlots -= tenant.actorSlots;
      tenant.actorSlots = 0;
      tenant.phase = 'stopped';
      // Only after the underlying Worker.terminate() receipt: revoke the
      // WeakMap values associated with caller-held stale capabilities. The
      // old tokens can never retain a pool or an actor runtime after drain.
      for (const ref of tenant.actorRefs) this.#actorHandles.delete(ref);
      tenant.actorRefs.clear();
      this.#tenantHandles.delete(tenant.handle);
      this.#tenants.delete(tenant.id);
    }, error => {
      tenant.phase = 'quarantined';
      throw error;
    });
    tenant.closePromise.catch(() => {});
    return tenant.closePromise;
  }

  async close() {
    this.#closed = true;
    const results = await Promise.allSettled(
      Array.from(this.#tenants.values(), tenant => this.close_tenant_vm(tenant.handle)));
    if (results.some(r => r.status === 'rejected'))
      throw new Error('TenantVM teardown unconfirmed; host remains quarantined');
  }
}
