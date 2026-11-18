/**
 * Source-free CLI flag normalization for the scalar Wasm guest host.
 * This module does not claim any Atto source-compiler or actor scheduling support.
 */
const ALIAS = '--single-threaded';
const LIMIT = '--max-threads-per-space=';
const MODE = '--mode=';

export function parseThreadPolicyFlags(args) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string'))
    throw new TypeError('runtime arguments must be string array');
  let sawAlias = false;
  let numeric = null;
  let sawNumeric = false;
  const modes = new Set();
  const remaining = [];

  for (const arg of args) {
    if (arg === ALIAS) {
      if (sawAlias) throw Error('E_DUPLICATE_THREAD_FLAG: --single-threaded repeated');
      sawAlias = true;
    } else if (arg.startsWith(LIMIT)) {
      const raw = arg.slice(LIMIT.length);
      if (!/^[1-9][0-9]*$/.test(raw) ||
          !Number.isSafeInteger(Number(raw)))
        throw Error('E_INVALID_THREAD_LIMIT: expected canonical positive decimal');
      const value = Number(raw);
      if (sawNumeric && numeric !== value)
        throw Error('E_CONFLICTING_THREAD_POLICY: conflicting numeric limits');
      if (sawNumeric) throw Error('E_DUPLICATE_THREAD_FLAG: limit repeated');
      sawNumeric = true;
      numeric = value;
    } else if (arg.startsWith(MODE)) {
      const raw = arg.slice(MODE.length);
      for (const value of raw.split(',')) {
        if (!value) throw Error('E_EMPTY_MODE: empty runtime mode');
        // This host supports only one mode. Trace requires a separate
        // implementation and cannot be silently accepted.
        if (value !== 'single-threaded')
          throw Error('E_UNKNOWN_MODE: unsupported runtime mode ' + value);
        if (modes.has(value))
          throw Error('E_DUPLICATE_MODE: duplicate runtime mode ' + value);
        modes.add(value);
      }
    } else {
      remaining.push(arg);
    }
  }
  const requested = sawAlias || modes.has('single-threaded') || numeric === 1;
  if (numeric !== null && numeric !== 1) {
    if (requested) throw Error('E_CONFLICTING_THREAD_POLICY: single-threaded versus other limit');
    throw Error('E_UNSUPPORTED_THREAD_LIMIT: scalar Wasm host only admits limit=1');
  }
  return Object.freeze({
    threadPolicy: requested ? 'single-threaded' : null,
    remaining: Object.freeze(remaining)
  });
}
