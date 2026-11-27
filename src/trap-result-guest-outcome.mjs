/**
 * Narrow host-verifier outcome classification, not a guest compiler or Error.
 * Only a native WebAssembly trap with panic_code=1 can demonstrate checked
 * overflow bypassing the canonical trap-to-Result boundary.
 */
export function isRuntimeTrapWithPanicCode(error, panicCode, expectedCode = 1) {
  return (expectedCode === 1 || expectedCode === 7) && error instanceof WebAssembly.RuntimeError && panicCode === expectedCode;
}

/**
 * A JS callback imported by a guest may itself throw WebAssembly.RuntimeError.
 * If allowed through unchanged, it could impersonate a native guest trap.
 * Always replace any host import exception with an explicitly host-originated
 * error, without carrying guest-controlled exception objects or causes.
 * This wrapper is for the verifier's own fixed, trusted print callbacks.
 */
export class HostImportFault extends Error {
  constructor(name) {
    super('host import failed: ' + name);
    this.name = 'HostImportFault';
  }
}

export function guardHostImport(name, callback) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(name) ||
      typeof callback !== 'function') {
    throw new TypeError('invalid trusted Wasm host import');
  }
  return (...args) => {
    try {
      return callback(...args);
    } catch {
      throw new HostImportFault(name);
    }
  };
}
