/**
 * V1 host-owned tenant broker for signed-i64 actor DATA, not an untrusted guest ABI.
 *
 * This module MUST live in the trusted embedding, never inside an untrusted
 * guest Worker. All caller/recipient identities and dispatch targets are
 * host-minted opaque objects; guest strings, IDs and ActorRefs are not authority.
 *
 * The existing compiler lacks wasm32 guest spawn/send and the pooled Wasm actor
 * runner is trusted-only. Do not claim compiled-guest tenant containment from
 * this host broker. In particular, no network, cross-process, or native ABI is
 * admitted by this module.
 */
const MIN_I64 = -(1n << 63n), MAX_I64 = (1n << 63n) - 1n;
const MAX_RESOURCE = 2 ** 31 - 1;
const LIMIT_KEYS = Object.freeze([
  'maxMessages', 'maxBytes', 'maxCpuUnits', 'maxMemoryBytes', 'maxInflight'
]);
const fresh = () => Object.freeze(Object.create(null));
const valid_count = (n, max = MAX_RESOURCE) =>
  Number.isSafeInteger(n) && n >= 1 && n <= max;
const deny = code => {
  const error = new Error(code);
  error.code = code;
  throw error;
};
const fail = (ok, code) => { if (!ok) deny(code); };
function parse_limits(limits) {
  fail(limits !== null && typeof limits === 'object' &&
    !Array.isArray(limits) && (Object.getPrototypeOf(limits) === Object.prototype ||
      Object.getPrototypeOf(limits) === null), 'INVALID_TENANT_LIMITS');
  fail(Reflect.ownKeys(limits).length === LIMIT_KEYS.length, 'INVALID_TENANT_LIMITS');
  const out = {};
  for (const key of LIMIT_KEYS) {
    const d = Object.getOwnPropertyDescriptor(limits, key);
    fail(d && Object.hasOwn(d, 'value') && valid_count(d.value), 'INVALID_TENANT_LIMITS');
    out[key] = d.value;
  }
  return Object.freeze(out);
}
function usage() {
  return {usedMessages: 0, usedBytes: 0, usedCpuUnits: 0,
    reservedMessages: 0, reservedBytes: 0, reservedCpuUnits: 0,
    reservedMemoryBytes: 0, inflight: 0, uncertain: 0};
}
function within(account) {
  const u = account.usage, l = account.limits;
  return u.usedMessages + u.reservedMessages + 1 <= l.maxMessages &&
    u.usedBytes + u.reservedBytes + 8 <= l.maxBytes &&
    u.usedCpuUnits + u.reservedCpuUnits + 1 <= l.maxCpuUnits &&
    u.reservedMemoryBytes + 8 <= l.maxMemoryBytes &&
    u.inflight + 1 <= l.maxInflight;
}
function bump(account, direction) {
  const u = account.usage;
  u.reservedMessages += direction;
  u.reservedBytes += 8 * direction;
  u.reservedCpuUnits += direction;
  u.reservedMemoryBytes += 8 * direction;
  u.inflight += direction;
}
function commit(account) {
  bump(account, -1);
  account.usage.usedMessages++;
  account.usage.usedBytes += 8;
  account.usage.usedCpuUnits++;
}
function fresh_tenant(account) {
  account.generation++;
  account.active = true;
  return account;
}
async function await_before_dispatch(work, signal) {
  if (!work) return;
  fail(typeof work === 'function', 'INVALID_HOST_DISPATCH_HOOK');
  if (!signal) return await work();
  fail(typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function',
    'INVALID_ABORT_SIGNAL');
  if (signal.aborted) deny('DISPATCH_CANCELLED');
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => {
      const err = new Error('DISPATCH_CANCELLED');
      err.code = 'DISPATCH_CANCELLED';
      reject(err);
    };
    signal.addEventListener('abort', listener, {once: true});
  });
  try {return await Promise.race([Promise.resolve().then(work), aborted]);}
  finally {signal.removeEventListener('abort', listener);}
}

export class TrustedTenantBrokerV1 {
  #host;
  #tenants = new Map();
  #tenantRefs = new WeakMap();
  #actors = new WeakMap();
  #capabilities = new WeakMap();
  #activeActors = new Set();
  #closed = false;

  constructor({hostAuthority} = {}) {
    fail(hostAuthority !== null && typeof hostAuthority === 'object' &&
      !Array.isArray(hostAuthority), 'HOST_AUTHORITY_REQUIRED');
    this.#host = hostAuthority;
  }
  #auth(host) {
    fail(host === this.#host, 'UNAUTHENTICATED_HOST');
    fail(!this.#closed, 'BROKER_CLOSED');
  }
  #tenant(handle) {
    const ref = handle && typeof handle === 'object' ? this.#tenantRefs.get(handle) : null;
    fail(ref && ref.account.active && ref.generation === ref.account.generation,
      'STALE_OR_FORGED_TENANT');
    return ref.account;
  }
  #actor(handle) {
    const ref = handle && typeof handle === 'object' ? this.#actors.get(handle) : null;
    fail(ref && ref.active && ref.account.active &&
      ref.generation === ref.account.generation, 'STALE_OR_FORGED_ACTORREF');
    return ref;
  }
  #capability(handle) {
    const ref = handle && typeof handle === 'object' ? this.#capabilities.get(handle) : null;
    // Deny before ever resolving any foreign actor/tenant resources.
    fail(ref, 'FORGED_CAPABILITY');
    fail(!ref.revoked, 'REVOKED_CAPABILITY');
    fail(ref.source.active && ref.target.active &&
      ref.source.generation === ref.source.account.generation &&
      ref.target.generation === ref.target.account.generation,
      'STALE_CAPABILITY_GENERATION');
    fail(ref.used < ref.maxUses, 'REPLAYED_OR_EXHAUSTED_CAPABILITY');
    return ref;
  }
  admitTenant(host, tenantId, rawLimits) {
    this.#auth(host);
    fail(typeof tenantId === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(tenantId) &&
      tenantId !== '.' && tenantId !== '..', 'INVALID_TENANT_ID');
    const limits = parse_limits(rawLimits);
    let account = this.#tenants.get(tenantId);
    fail(!account || !account.active, 'DUPLICATE_TENANT');
    if (account) {
      // Quotas belong to the authenticated tenant account, not incarnation.
      fail(LIMIT_KEYS.every(k => account.limits[k] === limits[k]),
        'TENANT_LIMIT_CHANGE_REQUIRES_HOST_POLICY_REVIEW');
      fail(account.usage.inflight === 0 && account.usage.uncertain === 0,
        'TENANT_HAS_UNSETTLED_WORK');
      fresh_tenant(account);
    } else {
      account = {id:tenantId, generation:1, active:true, limits, usage:usage()};
      this.#tenants.set(tenantId, account);
    }
    const handle = fresh();
    this.#tenantRefs.set(handle, {account, generation:account.generation});
    return handle;
  }
  retireTenant(host, tenant) {
    this.#auth(host);
    const account = this.#tenant(tenant);
    fail(account.usage.inflight === 0 && account.usage.uncertain === 0,
      'TENANT_HAS_UNSETTLED_WORK');
    account.active = false;
    for (const actor of this.#activeActors) {
      if (actor.account === account) {actor.active = false;this.#activeActors.delete(actor);}
    }
  }
  registerActor(host, tenant, deliver) {
    this.#auth(host);
    const account = this.#tenant(tenant);
    fail(typeof deliver === 'function', 'TRUSTED_DELIVER_CALLBACK_REQUIRED');
    const actor = {account, generation:account.generation, active:true,
      deliver, inflight:0};
    const handle = fresh();
    this.#actors.set(handle, actor);
    this.#activeActors.add(actor);
    return handle;
  }
  retireActor(host, actorRef) {
    this.#auth(host);
    const actor = this.#actor(actorRef);
    fail(actor.inflight === 0, 'ACTOR_HAS_UNSETTLED_WORK');
    actor.active = false;
    this.#activeActors.delete(actor);
  }
  authorize(host, sourceActor, targetActor, {maxUses = 1} = {}) {
    this.#auth(host);
    const source = this.#actor(sourceActor), target = this.#actor(targetActor);
    fail(valid_count(maxUses, 1024), 'INVALID_CAPABILITY_USES');
    const record = {source, target, sourceGeneration:source.generation,
      targetGeneration:target.generation, maxUses, used:0, revoked:false};
    const handle = fresh();
    this.#capabilities.set(handle, record);
    return handle;
  }
  revoke(host, capability) {
    this.#auth(host);
    const record = capability && typeof capability === 'object' ?
      this.#capabilities.get(capability) : null;
    fail(record, 'FORGED_CAPABILITY');
    record.revoked = true;
  }

  /**
   * Called by trusted runtime after binding a guest message to the actual
   * scheduled sender actor. The guest never supplies the sender reference or
   * capability object directly as an authenticated identity.
   *
   * A callback failure after dispatch is AMBIGUOUS, not an automatic refund.
   * The reservation remains pinned and an administrator must quarantine it.
   */
  async dispatch(host, senderActor, capability, data, {beforeDispatch, signal} = {}) {
    this.#auth(host);
    const sender = this.#actor(senderActor);
    const grant = this.#capability(capability);
    fail(grant.source === sender && grant.sourceGeneration === sender.generation &&
      grant.targetGeneration === grant.target.generation, 'CAPABILITY_SENDER_MISMATCH');
    fail(typeof data === 'bigint' && data >= MIN_I64 && data <= MAX_I64,
      'INVALID_GUEST_DATA_I64');
    const target = grant.target;
    const accounts = sender.account === target.account ? [sender.account] :
      [sender.account, target.account];
    fail(sender.inflight < sender.account.limits.maxInflight &&
      target.inflight < target.account.limits.maxInflight,
    'ACTOR_INFLIGHT_QUOTA');
    fail(accounts.every(within), 'TENANT_AGGREGATE_QUOTA');
    // No await between quota inspection and reservation: atomic in this host
    // event loop. Multi-process deployments must move this to a linearizable
    // broker service, not rely on process-local maps.
    for (const a of accounts) bump(a, +1);
    sender.inflight++; target.inflight++;
    grant.used++; // Nonce/one-shot right cannot be replayed after admission.
    let settled = false, enteredDispatch = false;
    const refund = () => {
      if (settled) return;
      settled = true;
      for (const a of accounts) bump(a, -1);
      sender.inflight--;target.inflight--;
    };
    const acknowledge = () => {
      if (settled) return;
      settled = true;
      for (const a of accounts) commit(a);
      sender.inflight--;target.inflight--;
    };
    try {
      if (signal?.aborted) deny('DISPATCH_CANCELLED');
      await await_before_dispatch(beforeDispatch, signal);
      if (signal?.aborted) deny('DISPATCH_CANCELLED');
      this.#auth(host);
      this.#actor(senderActor);
      fail(!grant.revoked, 'REVOKED_CAPABILITY'); // Recheck before dispatch; admission already consumed one use.
      fail(grant.source.generation === grant.sourceGeneration &&
        grant.target.generation === grant.targetGeneration,
        'STALE_CAPABILITY_GENERATION');
      fail(grant.target.active && grant.target.generation === grant.target.account.generation,
        'STALE_TARGET_BEFORE_DISPATCH');
      enteredDispatch = true;
      const result = await target.deliver(data);
      fail(typeof result === 'bigint' && result >= MIN_I64 && result <= MAX_I64,
        'INVALID_GUEST_DATA_I64');
      acknowledge();
      return result;
    } catch (error) {
      if (!enteredDispatch) refund();
      else {
        // No retry or refund after an ambiguous target side effect.
        for (const a of accounts) a.usage.uncertain++;
      }
      throw error;
    }
  }
  snapshot(host, tenant) {
    this.#auth(host);
    const account = this.#tenant(tenant);
    return Object.freeze({...account.usage, generation:account.generation,
      tenantId:account.id});
  }
  close(host) {
    this.#auth(host);
    fail([...this.#tenants.values()].every(a => a.usage.inflight === 0),
      'BROKER_HAS_UNSETTLED_WORK');
    this.#closed = true;
    for (const a of this.#tenants.values()) a.active = false;
    this.#activeActors.clear();
  }
}
