import {types} from "node:util";

// A caller in the embedding Node process can modify mutable globals after
// this module loads. Pin the inspection intrinsics at module initialization;
// otherwise a replacement isProxy/includes/some can bypass fail-closed checks.
const isProxy = types.isProxy;
const isArray = Array.isArray;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const ownKeys = Reflect.ownKeys;
const hasOwn = Object.hasOwn;
const createObject = Object.create;
const plainObjectPrototype = Object.prototype;
const setHas = Function.prototype.call.bind(Set.prototype.has);
const toString = String;

function isAllowedName(allowedNames, key) {
  // Do not call overridable Array.prototype.includes or @@iterator.
  for (let i = 0; i < allowedNames.length; i++) {
    if (allowedNames[i] === key) return true;
  }
  return false;
}

function hasNonstandardPrototypeKeys(prototype) {
  const keys = ownKeys(prototype);
  // Do not call overridable Array.prototype.some or @@iterator.
  for (let i = 0; i < keys.length; i++) {
    if (typeof keys[i] !== 'string' || !setHas(STANDARD_OBJECT_KEYS, keys[i]))
      return true;
  }
  return false;
}

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
  if (options === undefined) return createObject(null);
  // Proxy traps can execute arbitrary caller code during prototype/key inspection.
  // util.types.isProxy recognizes proxies without invoking those traps.
  if (isProxy(options))
    throw new TypeError('zero-capability guest option proxies are forbidden');
  if (options === null || typeof options !== 'object' || isArray(options))
    throw new TypeError('zero-capability guest options must be a plain object');
  const prototype = getPrototypeOf(options);
  if (prototype !== plainObjectPrototype && prototype !== null)
    throw new TypeError('zero-capability guest options must have no inherited settings');
  if (prototype === plainObjectPrototype && hasNonstandardPrototypeKeys(prototype))
    throw new TypeError('zero-capability guest options must have no inherited settings');
  const descriptors = getOwnPropertyDescriptors(options);
  const approved = createObject(null);
  const keys = ownKeys(descriptors);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (typeof key !== 'string' || (allowedNames !== null && !isAllowedName(allowedNames, key)))
      throw new TypeError('unsupported zero-capability guest option: ' + toString(key));
    const descriptor = descriptors[key];
    if (descriptor.enumerable !== true)
      throw new TypeError('non-enumerable zero-capability guest options are forbidden: ' + key);
    if (!hasOwn(descriptor, 'value'))
      throw new TypeError('zero-capability guest option accessors are forbidden: ' + key);
    approved[key] = descriptor.value;
  }
  return approved;
}
