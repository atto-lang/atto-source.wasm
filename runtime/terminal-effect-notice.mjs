/**
 * AttoLang terminal effect transport across Web Worker boundaries (v1).
 * Transport ONLY: no language catch/recover/defer, unwinding or AOT lowering.
 * A trusted guest runtime must complete any permitted local cleanup before
 * sending. The parent cannot resume a child stack or run its recover callback.
 * Never expose these functions as an import/capability to untrusted guest code.
 */
export const TERMINAL_EFFECT_TYPE = 'atto.actor.terminal-effect.v1';
const EFFECTS = new Set(['throw', 'raise', 'panic']);
const FIELDS = ['type', 'actor_id', 'parent_id', 'generation', 'sequence',
  'effect', 'error_type', 'message'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ERROR_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;

export class EffectNoticeProtocolError extends Error {
  constructor(message) {
    super('E_EFFECT_PROTOCOL: ' + message);
    this.name = 'EffectNoticeProtocolError';
  }
}
function bad(message) { throw new EffectNoticeProtocolError(message); }
function plain(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    bad('notice must be a plain object');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) bad('notice prototype denied');
  return value;
}
function integer(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) bad('invalid ' + field);
}
function identifier(value, field) {
  if (typeof value !== 'string' || !ID_RE.test(value)) bad('invalid ' + field);
}
function wellFormedUtf16(s) {
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u >= 0xD800 && u <= 0xDBFF) {
      const next = s.charCodeAt(++i);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
    } else if (u >= 0xDC00 && u <= 0xDFFF) return false;
  }
  return true;
}
// Capture exact own data descriptors once; never read the original record
// again after checking it. Proxy get-traps can lie independently of descriptors.
function snapshot(value, fields) {
  plain(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length ||
      keys.some(k => typeof k !== 'string' || !fields.includes(k)))
    bad('unexpected or missing fields');
  const data = Object.create(null);
  for (const k of fields) {
    const d = Object.getOwnPropertyDescriptor(value, k);
    if (!d || !Object.hasOwn(d, 'value') || d.enumerable !== true)
      bad('accessor, hidden or missing notice field');
    data[k] = d.value;
  }
  return data;
}
function validate(value) {
  const data = snapshot(value, FIELDS);
  if (data.type !== TERMINAL_EFFECT_TYPE) bad('unsupported notice version');
  identifier(data.actor_id, 'actor_id');
  identifier(data.parent_id, 'parent_id');
  integer(data.generation, 'generation');
  integer(data.sequence, 'sequence');
  if (!EFFECTS.has(data.effect)) bad('invalid terminal effect');
  if (typeof data.error_type !== 'string' || !ERROR_RE.test(data.error_type))
    bad('invalid Error type label');
  if (typeof data.message !== 'string' || !wellFormedUtf16(data.message) ||
      new TextEncoder().encode(data.message).byteLength > 1024 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(data.message)) bad('invalid message');
  return Object.freeze(data);
}

/** Host/runtime encoder. User Atto source must not be able to invoke it. */
export function makeTerminalEffectNotice(fields) {
  // The guest cannot assert authority by supplying a 'type', cleanup_done,
  // recoverable or other extra property. Snapshot a trusted-host field set
  // before encoding, without executing getters or inconsistent Proxy get traps.
  const allowed = FIELDS.slice(1);
  const data = snapshot(fields, allowed);
  const notice = Object.fromEntries(FIELDS.map(k => [k,
    k === 'type' ? TERMINAL_EFFECT_TYPE : data[k]]));
  validate(notice);
  return Object.freeze(notice);
}

/**
 * Each receiver binds an ACTUAL Worker identity and actor generation;
 * structured-clone messages cannot authenticate themselves. A JS-transpiled
 * actor with raw postMessage access cannot satisfy this trust model.
 * Cancellation and forced termination are separate HOST events, not guest
 * throw/raise/panic messages, and do not guarantee guest defer execution.
 */
export function terminalEffectReceiver({ actor_id, parent_id, generation, worker }) {
  identifier(actor_id, 'actor_id');
  identifier(parent_id, 'parent_id');
  integer(generation, 'generation');
  if ((typeof worker !== 'object' && typeof worker !== 'function') || worker === null)
    bad('bound Worker reference required');
  let closed = false;
  return {
    accept(value, sourceWorker) {
      if (sourceWorker !== worker) bad('untrusted Worker source');
      if (closed) bad('actor generation is already terminal');
      const notice = validate(value);
      if (notice.actor_id !== actor_id || notice.parent_id !== parent_id ||
          notice.generation !== generation) bad('wrong actor, parent or generation');
      if (notice.sequence !== 0) bad('stale or noncontiguous terminal sequence');
      closed = true;
      // This is a *terminal* CONTROL notification, never a parent-side recover.
      return Object.freeze({
        lane: 'CONTROL', terminal: true, recoverable: false,
        effect: notice.effect, actor_id, parent_id, generation,
        error_type: notice.error_type, message: notice.message
      });
    },
    get closed() { return closed; }
  };
}
