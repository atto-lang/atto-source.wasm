import {types} from 'node:util';
const isProxy = types.isProxy;
// Canonical #415-style, trusted Worker -> parent actor-turn quiescence receipt.
// A receipt is host bookkeeping, not proof of compiler-lowered guest frames.
const RECEIPT_FIELDS = Object.freeze([
  'schemaVersion', 'authority', 'frameBytes',
  'activeExecutions', 'frameBytesInUse', 'retired'
]);

export function makeActorFrameReceipt(retired = false) {
  if (typeof retired !== 'boolean') throw TypeError('invalid actor frame retirement state');
  return Object.freeze({
    schemaVersion: 1,
    authority: 'actor-arena-v1',
    frameBytes: 16,
    activeExecutions: 0,
    frameBytesInUse: 0,
    retired
  });
}

export function assertActorFrameReceipt(receipt, operation) {
  if (operation !== 'init' && operation !== 'send' && operation !== 'stop')
    throw Error('unknown actor frame operation');
  if (receipt === null || typeof receipt !== 'object' ||
      isProxy(receipt) || Array.isArray(receipt) ||
      Object.getPrototypeOf(receipt) !== Object.prototype)
    throw Error('missing or malformed actor frame quiescence receipt');
  const keys = Reflect.ownKeys(receipt);
  if (keys.length !== RECEIPT_FIELDS.length ||
      !keys.every(key => RECEIPT_FIELDS.includes(key)))
    throw Error('incomplete or forged actor frame quiescence receipt');
  // Snapshot own *data descriptor values once*, never read record[key] after
  // an accessor/proxy was supposedly checked (TOCTOU/ambient getter hazard).
  const data = Object.create(null);
  for (const key of RECEIPT_FIELDS) {
    const desc = Object.getOwnPropertyDescriptor(receipt, key);
    if (!desc || !Object.hasOwn(desc, 'value'))
      throw Error('incomplete or forged actor frame quiescence receipt');
    data[key] = desc.value;
  }
  if (data.schemaVersion !== 1 ||
      data.authority !== 'actor-arena-v1' ||
      data.frameBytes !== 16 ||
      data.activeExecutions !== 0 ||
      data.frameBytesInUse !== 0 ||
      data.retired !== (operation === 'stop'))
    throw Error('invalid actor frame quiescence receipt');
  return true;
}
