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
function validate(value) {
  plain(value);
  const keys = Object.keys(value);
  if (keys.length !== FIELDS.length || FIELDS.some(k => !Object.hasOwn(value, k)) ||
      keys.some(k => !FIELDS.includes(k))) bad('unexpected or missing fields');
  const props = Object.getOwnPropertyDescriptors(value);
  for (const k of FIELDS) if (!Object.hasOwn(props[k], 'value')) bad('accessor field denied');
  if (value.type !== TERMINAL_EFFECT_TYPE) bad('unsupported notice version');
  identifier(value.actor_id, 'actor_id');
  identifier(value.parent_id, 'parent_id');
  integer(value.generation, 'generation');
  integer(value.sequence, 'sequence');
  if (!EFFECTS.has(value.effect)) bad('invalid terminal effect');
  if (typeof value.error_type !== 'string' || !ERROR_RE.test(value.error_type))
    bad('invalid Error type label');
  if (typeof value.message !== 'string' || !wellFormedUtf16(value.message) ||
      new TextEncoder().encode(value.message).byteLength > 1024 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.message)) bad('invalid message');
  return value;
}

/** Host/runtime encoder. User Atto source must not be able to invoke it. */
export function makeTerminalEffectNotice(fields) {
  plain(fields);
  // Never trust a sender-supplied cleanup_done, cursor or recoverable flag.
  const notice = Object.fromEntries(FIELDS.map(k => [k,
    k === 'type' ? TERMINAL_EFFECT_TYPE : fields[k]]));
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
