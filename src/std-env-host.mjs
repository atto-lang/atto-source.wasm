// Host-side preparation for an eventual compiler-bound std/env intrinsic.
// NOT an AttoLang guest execution bridge and NOT an authorization grant.
// Only the trusted embedder may construct this reader; guest source may not.
// No process.env, DOM globals, or ambient environment fallbacks.
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RULE = /^(?:\*|[A-Za-z_][A-Za-z0-9_]{0,127}\*?)$/;
const MAX_ENTRIES = 512;
const MAX_VALUE_BYTES = 16384;
const MAX_AGGREGATE_BYTES = 1048576;
const utf8 = new TextEncoder();
const issued_hosts = new WeakSet();

// Only real host-issued capabilities may enter guest dispatch.
export function is_scoped_env_host(value) {
  return value !== null && typeof value === 'object' && issued_hosts.has(value);
}

export class EnvHostError extends Error {
  constructor(code) { super(code); this.name = 'EnvHostError'; }
}

function policy_rules(input) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    throw new EnvHostError('ENV_INVALID_POLICY');
  const n = Object.getOwnPropertyDescriptor(input, 'length')?.value;
  if (!Number.isInteger(n) || n > 128)
    throw new EnvHostError('ENV_INVALID_POLICY');
  const rules = [];
  for (let i = 0; i < n; i++) {
    const field = Object.getOwnPropertyDescriptor(input, String(i));
    if (!field || !Object.hasOwn(field, 'value') ||
        typeof field.value !== 'string' || !RULE.test(field.value))
      throw new EnvHostError('ENV_INVALID_POLICY');
    rules.push(field.value);
  }
  return Object.freeze(rules);
}

function matches(name, pattern) {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

function valid_utf16(value) {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    // OS environment values cannot contain embedded NUL bytes.
    if (unit === 0) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (i + 1 >= value.length) return false;
      const next = value.charCodeAt(++i);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function check_name(name) {
  if (typeof name !== 'string' || !KEY.test(name))
    throw new EnvHostError('ENV_INVALID_NAME');
}

function granted(name, allow, deny) {
  return allow.some(rule => matches(name, rule)) &&
      !deny.some(rule => matches(name, rule));
}

/**
 * The host provides its own data snapshot AND grants. They are independently
 * copied once; changes to either original cannot elevate guest authority.
 * Unauthorized values are never inspected, read through a getter or copied.
 * A missing granted key differs from a denied key; denied keys cannot be
 * probed via has(). This object is not automatically exposed to guest code.
 */
export function create_scoped_env_host({values = Object.create(null), allow = [], deny = [], environmentCapability = false} = {}) {
  // This flag must come from authenticated isolate authority, NEVER from guest input.
  if (typeof environmentCapability !== 'boolean')
    throw new EnvHostError('ENV_INVALID_POLICY');
  const allowed = policy_rules(allow);
  const denied = policy_rules(deny);
  if (values === null || typeof values !== 'object')
    throw new EnvHostError('ENV_INVALID_SNAPSHOT');
  // With no coarse capability, do not even inspect the host input prototype.
  // A Proxy getPrototypeOf/ownKeys trap is host metadata observation too.
  let keys = [];
  if (environmentCapability) {
    try {
      const prototype = Object.getPrototypeOf(values);
      if (prototype !== Object.prototype && prototype !== null)
        throw new EnvHostError('ENV_INVALID_SNAPSHOT');
      keys = Reflect.ownKeys(values);
    } catch {
      throw new EnvHostError('ENV_INVALID_SNAPSHOT');
    }
  }
  if (keys.length > MAX_ENTRIES)
    throw new EnvHostError('ENV_INVALID_SNAPSHOT');
  const snapshot = new Map();
  let aggregateBytes = 0;
  for (const key of keys) {
    if (typeof key !== 'string') throw new EnvHostError('ENV_INVALID_SNAPSHOT');
    if (!KEY.test(key) || !environmentCapability || !granted(key, allowed, denied)) continue;
    const field = Object.getOwnPropertyDescriptor(values, key);
    if (!field || !Object.hasOwn(field, 'value') ||
        typeof field.value !== 'string' ||
        field.value.length > MAX_VALUE_BYTES || !valid_utf16(field.value)) {
      throw new EnvHostError('ENV_INVALID_SNAPSHOT');
    }
    const encodedBytes = utf8.encode(field.value).length;
    if (encodedBytes > MAX_VALUE_BYTES ||
        encodedBytes > MAX_AGGREGATE_BYTES - aggregateBytes) {
      throw new EnvHostError('ENV_INVALID_SNAPSHOT');
    }
    // Count only values admitted after coarse/scope/deny checks.
    // A denied secret must not be inspected or counted.
    aggregateBytes += encodedBytes;
    snapshot.set(key, field.value);
  }
  let revoked = false;
  function require_grant(name) {
    check_name(name);
    if (revoked || !environmentCapability || !granted(name, allowed, denied))
      throw new EnvHostError('ENV_PERMISSION_DENIED');
  }
  const api = Object.freeze({
    // Host-side Option envelope; compiler binding/guest ABI is still pending.
    get(name) {
      require_grant(name);
      return snapshot.has(name)
          ? Object.freeze({some: true, value: snapshot.get(name)})
          : Object.freeze({some: false});
    },
    has(name) {
      require_grant(name);
      return snapshot.has(name);
    },
    // Trusted host lifecycle hook: retire the snapshot with the isolate.
    revoke() {
      if (revoked) return false;
      revoked = true;
      snapshot.clear();
      return true;
    }
  });
  issued_hosts.add(api);
  return api;
}
