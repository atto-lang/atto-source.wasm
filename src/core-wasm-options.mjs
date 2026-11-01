/**
 * Fail closed on unimplemented runtime authorities. Silently accepting
 * tenantId, isolateId, actorId, permissions, or similar unknown options is
 * dangerous: the scalar Node worker is not an OresVM tenant isolate.
 *
 * All ordinary caller-provided option keys must be explicitly supported by
 * the invoked entry point. Check nonenumerable and symbol keys too, before
 * opening workers or validating/compiling untrusted input.
 */
import {types} from "node:util";

const OPTION_TYPES = Object.freeze({
  expectedSha256: "string",
  entry: "string",
  maxModuleBytes: "number",
  maxMemoryPages: "number",
  timeoutMs: "number",
  ioMode: "string",
  guestNetworkIo: "boolean",
  nioReactors: "number",
  actorPhysicalTurns: "number",
  hardRealtime: "boolean"
});

export function assertKnownCoreWasmOptions(options, allowedNames, boundary) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("core Wasm " + boundary + " options must be an object");
  }
  // A Proxy can run arbitrary traps for [[GetPrototypeOf]], OwnKeys and
  // descriptor queries. Reject it before touching any of those hooks.
  if (types.isProxy(options)) {
    throw new TypeError("core Wasm " + boundary + " options cannot be Proxy objects");
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
    // Typed primitive admission prevents host callbacks triggered by string
    // coercion, for example RegExp.test on a hostile entry object.
    // Undefined retains the existing optional-parameter default semantics.
    const expectedType = OPTION_TYPES[key];
    if (expectedType === undefined ||
        (descriptor.value !== undefined &&
         typeof descriptor.value !== expectedType)) {
      throw new TypeError("core Wasm " + boundary + " option has invalid type: " + key);
    }
  }
}
