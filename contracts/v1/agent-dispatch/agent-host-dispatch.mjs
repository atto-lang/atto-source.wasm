// HOST-ONLY. Not a guest import, signed issuer, durable store or tool authority.
// The Wasm guest remains zero-import; this is a trusted embedding-host contract.
const id = v => typeof v === 'string' && /^[A-Za-z0-9_.:@/-]{1,128}$/.test(v);
const sha = (v, size) => typeof v === 'string' &&
  new RegExp('^[a-f0-9]{' + size + '}$').test(v);
function snapshot(value, fields) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const p = Object.getPrototypeOf(value);
    if (p !== Object.prototype && p !== null) return null;
    const names = Reflect.ownKeys(value);
    if (names.length !== fields.length ||
        names.some(x => typeof x !== 'string' || !fields.includes(x))) return null;
    const clean = Object.create(null);
    for (const key of fields) {
      const desc = Object.getOwnPropertyDescriptor(value,key);
      if (!desc || !Object.hasOwn(desc,'value') || !desc.enumerable) return null;
      clean[key] = desc.value;
    }
    return Object.freeze(clean);
  } catch { return null; }
}
const scopeFields = ['tenant_id','actor_id','actor_generation','activation_epoch',
  'exact_revision','dispatch_id','context_sha256','expires_at_ms','utf8_bytes',
  'measured_tokens'];
const configFields = ['tenant_id','actor_id','actor_generation','activation_epoch',
  'exact_revision','token_cap','isCurrent','authorize','claimOnce','submitDataOnly'];
export function create_agent_host_dispatch_gate(raw) {
  const config = snapshot(raw, configFields);
  if (!config || !id(config.tenant_id) || !id(config.actor_id) ||
      !sha(config.exact_revision,40) ||
      !Number.isSafeInteger(config.actor_generation) || config.actor_generation <= 0 ||
      !Number.isSafeInteger(config.activation_epoch) || config.activation_epoch <= 0 ||
      !Number.isSafeInteger(config.token_cap) || config.token_cap <= 0 ||
      config.token_cap > 16384 ||
      [config.isCurrent,config.authorize,config.claimOnce,config.submitDataOnly]
        .some(x => typeof x !== 'function')) {
    throw new TypeError('trusted host dispatch configuration required');
  }
  let spent = false;
  async function dispatch(untrusted, now_ms) {
    if (spent) return false;
    spent = true; // before any awaits; unknown outcome stays consumed
    const s = snapshot(untrusted, scopeFields);
    if (!s || !Number.isSafeInteger(now_ms) || now_ms < 0 ||
        s.tenant_id !== config.tenant_id || s.actor_id !== config.actor_id ||
        s.actor_generation !== config.actor_generation ||
        s.activation_epoch !== config.activation_epoch ||
        s.exact_revision !== config.exact_revision || !id(s.dispatch_id) ||
        !sha(s.context_sha256,64) ||
        !Number.isSafeInteger(s.expires_at_ms) || s.expires_at_ms <= now_ms ||
        !Number.isSafeInteger(s.utf8_bytes) || s.utf8_bytes <= 0 ||
        s.utf8_bytes > 65536 ||
        !Number.isSafeInteger(s.measured_tokens) || s.measured_tokens <= 0 ||
        s.measured_tokens > config.token_cap) return false;
    try {
      if (await config.isCurrent(s) !== true ||
          await config.authorize(s) !== true ||
          await config.claimOnce(s) !== true ||
          await config.isCurrent(s) !== true ||
          await config.authorize(s) !== true) return false;
      return await config.submitDataOnly(s) === true;
    } catch { return false; }
  }
  return Object.freeze({dispatch});
}
