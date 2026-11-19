// An unauthenticated receipt is data, not permission to execute property
// getters, inherit identity fields or attach hidden capability-bearing keys.
export function snapshotCompilerTrustRecord(record, fields, reason) {
  if (record === null || typeof record !== 'object' || Array.isArray(record))
    throw new Error('E_TRUST: ' + reason);
  const proto = Object.getPrototypeOf(record);
  if (proto !== Object.prototype && proto !== null)
    throw new Error('E_TRUST: ' + reason);
  const keys = Reflect.ownKeys(record);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key)))
    throw new Error('E_TRUST: ' + reason);
  const result = Object.create(null);
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw new Error('E_TRUST: ' + reason);
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}
