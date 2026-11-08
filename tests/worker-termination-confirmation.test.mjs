import test from 'node:test';
import assert from 'node:assert/strict';
import {confirmWorkerTermination} from '../src/worker-termination-confirmation.mjs';

test('rejected worker termination never refunds a possibly live guest admission', async () => {
  let confirmations = 0;
  const fake = {terminate() { return Promise.reject(Error('termination failed')); }};
  await assert.rejects(confirmWorkerTermination(fake, () => confirmations++),
    /termination failed/);
  assert.equal(confirmations, 0);
});

test('synchronous termination throw also keeps admission reserved', async () => {
  let confirmations = 0;
  await assert.rejects(confirmWorkerTermination(
    {terminate() { throw Error('termination threw'); }},
    () => confirmations++), /termination threw/);
  assert.equal(confirmations, 0);
});

test('credit confirmation occurs only after terminate promise resolves', async () => {
  let complete;
  const deferred = new Promise(resolve => { complete = resolve; });
  let confirmations = 0;
  const termination = confirmWorkerTermination(
    {terminate: () => deferred}, () => confirmations++);
  assert.equal(confirmations, 0);
  complete(0);
  assert.equal(await termination, 0);
  assert.equal(confirmations, 1);
});

test('invalid worker/confirmation callback cannot fabricate termination receipt', async () => {
  await assert.rejects(confirmWorkerTermination({}, () => {}), /invalid trusted/);
  await assert.rejects(confirmWorkerTermination({terminate() {}}, null), /invalid trusted/);
});

test('non-Promise termination receipt and hostile then getter never refund credit', async () => {
  let confirmations = 0;
  await assert.rejects(confirmWorkerTermination(
    {terminate() { return undefined; }}, () => confirmations++),
    /missing async worker termination confirmation/);
  await assert.rejects(confirmWorkerTermination(
    {terminate() {
      return Object.defineProperty({}, 'then', {get() { throw Error('hostile then'); }});
    }}, () => confirmations++), /hostile then/);
  assert.equal(confirmations, 0);
});
