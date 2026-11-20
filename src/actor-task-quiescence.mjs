import {types} from 'node:util';
import {ActorTaskLedger} from './actor-task-lifecycle.mjs';

const isProxy = types.isProxy;
const FIELDS = Object.freeze(['schemaVersion', 'authority', 'outstanding', 'stopped']);

// Separate from the #415 canonical actor-frame receipt: an ACK must prove
// BOTH completed host-frame turns and zero outstanding actor tasks.
export function makeActorTaskReceipt(ledger, operation) {
  if (!(ledger instanceof ActorTaskLedger))
    throw TypeError('actor task ledger authority required');
  if (!['init', 'send', 'stop'].includes(operation))
    throw TypeError('unsupported actor task receipt operation');
  if (ledger.outstanding !== 0 || ledger.isQuiescent() !== true ||
      ledger.stopped !== (operation === 'stop'))
    throw Error('actor task physical quiescence not proven');
  return Object.freeze({
    schemaVersion: 1,
    authority: 'actor-task-ledger-v1',
    outstanding: 0,
    stopped: operation === 'stop'
  });
}

export function assertActorTaskReceipt(receipt, operation) {
  if (!['init', 'send', 'stop'].includes(operation))
    throw TypeError('unsupported actor task operation');
  if (receipt === null || typeof receipt !== 'object' ||
      isProxy(receipt) || Array.isArray(receipt) ||
      Object.getPrototypeOf(receipt) !== Object.prototype)
    throw Error('missing or malformed actor task quiescence receipt');
  const keys = Reflect.ownKeys(receipt);
  if (keys.length !== FIELDS.length || !keys.every(key => FIELDS.includes(key)))
    throw Error('incomplete actor task quiescence receipt');
  const data = Object.create(null);
  for (const key of FIELDS) {
    const desc = Object.getOwnPropertyDescriptor(receipt, key);
    if (!desc || !Object.hasOwn(desc, 'value'))
      throw Error('forged actor task quiescence receipt');
    data[key] = desc.value;
  }
  if (data.schemaVersion !== 1 ||
      data.authority !== 'actor-task-ledger-v1' ||
      data.outstanding !== 0 ||
      data.stopped !== (operation === 'stop'))
    throw Error('invalid actor task quiescence receipt');
  return true;
}
