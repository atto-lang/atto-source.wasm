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
  const allowed = new Set(allowedNames);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError("unsupported core Wasm " + boundary + " option: " + String(key));
    }
  }
}
