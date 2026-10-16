import {types} from "node:util";

/** Only explicit, inert caller options are accepted for zero-import guest APIs.
 * Unknown metadata must never look like an enforced host capability grant.
 */
// Reject prototype pollution before treating a normal {} as inert options.
// These are the standard, non-option keys on Object.prototype in Node 22.
const STANDARD_OBJECT_KEYS = new Set([
  'constructor', '__defineGetter__', '__defineSetter__', 'hasOwnProperty',
  '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf',
  'propertyIsEnumerable', 'toString', 'valueOf', '__proto__', 'toLocaleString'
]);

export function validateCoreOptions(options, allowedNames) {
  if (options === undefined) return Object.create(null);
  // Proxy traps can execute arbitrary caller code during prototype/key inspection.
  // util.types.isProxy recognizes proxies without invoking those traps.
  if (types.isProxy(options))
    throw new TypeError('zero-capability guest option proxies are forbidden');
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('zero-capability guest options must be a plain object');
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('zero-capability guest options must have no inherited settings');
  if (prototype === Object.prototype &&
      Reflect.ownKeys(prototype).some(key => typeof key !== 'string' ||
        !STANDARD_OBJECT_KEYS.has(key)))
    throw new TypeError('zero-capability guest options must have no inherited settings');
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const approved = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedNames.includes(key))
      throw new TypeError('unsupported zero-capability guest option: ' + String(key));
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value'))
      throw new TypeError('zero-capability guest option accessors are forbidden: ' + key);
    approved[key] = descriptor.value;
  }
  return approved;
}
