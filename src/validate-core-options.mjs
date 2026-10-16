/** Only explicit, inert caller options are accepted for zero-import guest APIs.
 * Unknown metadata must never look like an enforced host capability grant.
 */
export function validateCoreOptions(options, allowedNames) {
  if (options === undefined) return Object.create(null);
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('zero-capability guest options must be a plain object');
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null)
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
