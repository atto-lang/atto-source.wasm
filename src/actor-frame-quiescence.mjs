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
      Array.isArray(receipt) ||
      Object.getPrototypeOf(receipt) !== Object.prototype)
    throw Error('missing or malformed actor frame quiescence receipt');
  const keys = Reflect.ownKeys(receipt);
  if (keys.length !== RECEIPT_FIELDS.length ||
      !RECEIPT_FIELDS.every(key => {
        const desc = Object.getOwnPropertyDescriptor(receipt, key);
        return desc !== undefined && Object.hasOwn(desc, 'value');
      }) ||
      !keys.every(key => RECEIPT_FIELDS.includes(key)))
    throw Error('incomplete or forged actor frame quiescence receipt');
  if (receipt.schemaVersion !== 1 ||
      receipt.authority !== 'actor-arena-v1' ||
      receipt.frameBytes !== 16 ||
      receipt.activeExecutions !== 0 ||
      receipt.frameBytesInUse !== 0 ||
      receipt.retired !== (operation === 'stop'))
    throw Error('invalid actor frame quiescence receipt');
  return true;
}
