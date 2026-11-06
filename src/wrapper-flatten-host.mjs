// Host-only reference semantics for future/option wrappers; not Oreslang guest lowering.
const optionBrand = new WeakSet();
const none = Object.freeze({tag: 'none'});
optionBrand.add(none);

export const None = none;
export function Some(value) {
  const option = Object.freeze({tag: 'some', value});
  optionBrand.add(option);
  return option;
}
export function flattenOption(value) {
  if (!optionBrand.has(value)) throw new TypeError('Option required');
  let result = value;
  const seen = new Set();
  while (result.tag === 'some' && optionBrand.has(result.value)) {
    if (seen.has(result)) throw new TypeError('cyclic Option');
    seen.add(result);
    result = result.value;
  }
  return result;
}
// Javascript Promise resolution intrinsically assimilates nested promises;
// this observer adds revocation, but never cancels a shared producer.
export function flattenFuture(source, {signal} = {}) {
  if (!(source instanceof Promise)) throw new TypeError('Promise required');
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('AbortSignal required');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      // An event notification alone is not cancellation authority: callers
      // can dispatch synthetic abort events without aborting the signal.
      if (settled || !signal.aborted) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    // Cancellation revokes only this observer. Always observe producer failure,
    // even when cancellation preceded registration, to avoid an unhandled
    // rejection from abandoned work. Keep the original producer unchanged.
    if (signal?.aborted) onAbort();
    // Remove explicitly on settlement: once:true would let a synthetic event
    // consume the listener before a later genuine cancellation.
    else signal?.addEventListener('abort', onAbort);
    source.then(value => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

