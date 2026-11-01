/**
 * Fail closed on unimplemented runtime authorities. Silently accepting
 * tenantId, isolateId, actorId, permissions, or similar unknown options is
 * dangerous: the scalar Node worker is not an OresVM tenant isolate.
 *
 * All ordinary caller-provided option keys must be explicitly supported by
 * the invoked entry point. Check nonenumerable and symbol keys too, before
 * opening workers or validating/compiling untrusted input.
 */
export function assertKnownCoreWasmOptions(options, allowedNames, boundary) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("core Wasm " + boundary + " options must be an object");
  }
  // Do not inherit authority requests from arbitrary prototypes, or invoke
  // accessor functions while preparing security-relevant worker options.
  // Structured-cloned workerData is a plain data object.
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("core Wasm " + boundary + " options must be a plain data object");
  }
  const allowed = new Set(allowedNames);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError("unsupported core Wasm " + boundary + " option: " + String(key));
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("core Wasm " + boundary + " option must be a data property: " + key);
    }
  }
}
