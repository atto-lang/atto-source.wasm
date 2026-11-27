// Internal fixed-profile host calculation. Inputs are trusted normalized metadata,
// not guest objects. No pool authorization, allocation or dispatch is performed.
const MAX_I64 = (1n << 63n) - 1n;
const positive = n => typeof n === 'bigint' && n > 0n && n <= MAX_I64;
const carrier = n => Number.isInteger(n) && n > 0 && n <= 2147483647;
const fail = code => { throw new RangeError(code); };
export function resolveSpawnCharge(policy, defaults, request) {
  const p = policy;
  if (typeof p.serial !== 'boolean' || !carrier(p.carrierCap) || !carrier(p.defaultCarriers) ||
      p.defaultCarriers > p.carrierCap ||
      ![p.liveStackSlots, p.heapLimit, p.stackLimit, p.mailboxMessagesLimit, p.mailboxByteCharge].every(positive) ||
      (p.serial && (p.carrierCap !== 1 || p.defaultCarriers !== 1))) fail('E_SPAWN_POLICY');
  function checked(cap, affinity, heap, stack, messages) {
    if (!carrier(cap) || cap > p.carrierCap || !['none','sticky','pinned'].includes(affinity) ||
        (affinity === 'pinned' && cap !== 1)) fail('E_SPAWN_POLICY');
    if (![heap,stack,messages].every(positive) || heap > p.heapLimit || stack > p.stackLimit ||
        messages > p.mailboxMessagesLimit || stack > MAX_I64 / p.liveStackSlots) fail('E_SPAWN_QUOTA');
    return Object.freeze({carrierCap:cap, affinity, stackBytes:stack, heap, stacks:stack*p.liveStackSlots,
        mailboxBytes:p.mailboxByteCharge, messages});
  }
  checked(p.defaultCarriers, defaults.affinity, defaults.heapBytes, defaults.stackBytes, defaults.mailboxMessages);
  return checked(request.carriers ?? p.defaultCarriers, request.affinity ?? defaults.affinity,
      request.heapBytes ?? defaults.heapBytes, request.stackBytes ?? defaults.stackBytes,
      request.mailboxMessages ?? defaults.mailboxMessages);
}
