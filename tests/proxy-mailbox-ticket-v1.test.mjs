import test from 'node:test';
import assert from 'node:assert/strict';
import {HostProxyMailboxTicketsV1} from '../src/proxy-mailbox-ticket-v1.mjs';

const base = Object.freeze({protocol_major: 1, tenant: 11n,
  caller_incarnation: 12n, target_actor: 13n, target_incarnation: 14n,
  association_generation: 17n, placement_epoch: 15n, message_id: 16n, attempt: 1n});
const box = (capacity = 2) =>
  new HostProxyMailboxTicketsV1({tenant: 11n, actor: 13n, incarnation: 14n, capacity});
const route = (id, patch = {}) => ({...base, message_id: BigInt(id), ...patch});
const admitted = (mail, id, value) => {
  const a = mail.admit(route(id), BigInt(value));
  assert.equal(a.status, 'admitted');
  assert.ok(a.ticket);
  return a.ticket;
};
test('exact-mail authority rejects other actor commit, forged route and full mailbox', () => {
  const a = box(1), b = box(1);
  const first = admitted(a, 1001, 11);
  const turn = a.begin();
  assert.equal(a.snapshot(first).stage, 'started');
  const queued = admitted(a, 1002, 12);
  assert.equal(a.admit(route(1003), 13n).status, 'full');
  assert.equal(a.admit(route(1003), 13n).ticket, null);
  assert.equal(a.snapshot(queued).stage, 'admitted');
  const unrelated = admitted(b, 1004, 70);
  const bTurn = b.begin();
  assert.equal(b.commit(bTurn, 140n), true);
  assert.equal(b.snapshot(unrelated).result, 140n);
  assert.equal(a.snapshot(first).stage, 'started');
  assert.equal(a.snapshot(queued).stage, 'admitted');
  assert.equal(b.commit(turn, 999n), false);
  assert.equal(a.commit(bTurn, 999n), false);
  assert.equal(a.commit({ticket: first, value: 11n}, 999n), false);
  assert.equal(a.panic({ticket: first, value: 11n}), false);
  assert.equal(a.snapshot({}), null);
  for (const bad of [
    route(1005, {tenant: 88n}),
    route(1005, {target_actor: 99n}),
    route(1005, {target_incarnation: 99n}),
    route(1005, {attempt: 0n}),
    route(1005, {message_id: 0n})]) {
    assert.notEqual(a.admit(bad, 1n).status, 'admitted');
  }
  assert.equal(a.commit(turn, 111n), true);
  assert.equal(a.snapshot(first).result, 111n);
  const second = a.begin();
  assert.equal(second.ticket, queued);
  assert.equal(a.commit(second, 112n), true);
  assert.equal(a.snapshot(queued).result, 112n);
  assert.equal(a.check_conservation(), true);
  assert.equal(b.check_conservation(), true);
});
test('128 interleaved sends produce 128 corresponding results, never a counter-based ACK', async () => {
  const mail = box(256);
  const seen = [];
  await Promise.all(Array.from({length: 4}, async (_, producer) => {
    for (let i = 0; i < 32; i++) {
      await Promise.resolve();
      const input = BigInt(producer * 1000 + i + 1);
      const ticket = admitted(mail, producer * 1000 + i + 3000, input);
      seen.push({input, ticket});
    }
  }));
  assert.equal(mail.counters.admitted, 128);
  for (const send of seen) {
    assert.equal(mail.snapshot(send.ticket).stage, 'admitted');
  }
  for (let i = 0; i < seen.length; i++) {
    const turn = mail.begin();
    assert.ok(turn);
    assert.equal(mail.commit(turn, turn.value * 3n), true);
  }
  for (const send of seen) {
    const got = mail.snapshot(send.ticket);
    assert.equal(got.stage, 'processed');
    assert.equal(got.hasResult, true);
    assert.equal(got.result, send.input * 3n);
  }
  assert.equal(mail.check_conservation(), true);
  assert.equal(mail.counters.processed, 128);
});
test('panic fails exact active delivery, abandons queued receipts, fences stale incarnation', () => {
  const m = box();
  const failed = admitted(m, 111, -1);
  const turn = m.begin();
  const abandoned = admitted(m, 112, 20);
  assert.equal(m.panic(turn), true);
  assert.equal(m.snapshot(failed).stage, 'failed');
  assert.equal(m.snapshot(abandoned).stage, 'abandoned');
  assert.equal(m.commit(turn, 42n), false);
  assert.equal(m.admit(route(113), 10n).status, 'closed');
  assert.equal(m.begin(), null);
  assert.equal(m.check_conservation(), true);
  const next = new HostProxyMailboxTicketsV1({tenant: 11n, actor: 13n, incarnation: 15n, capacity: 1});
  assert.equal(next.admit(route(114), 1n).status, 'stale');
  const fresh = next.admit(route(114, {target_incarnation: 15n}), 8n);
  assert.equal(fresh.status, 'admitted');
  assert.equal(next.snapshot(failed), null);
  const current = next.begin();
  assert.equal(next.commit(current, 50n), true);
  assert.equal(next.snapshot(fresh.ticket).result, 50n);
  assert.equal(next.check_conservation(), true);
});
test('graceful close drains previously admitted messages but cannot mint new tickets', () => {
  const mail = box();
  const t = admitted(mail, 401, 3);
  mail.close();
  assert.equal(mail.admit(route(402), 4n).status, 'closed');
  const turn = mail.begin();
  assert.equal(turn.ticket, t);
  assert.equal(mail.commit(turn, 4n), true);
  assert.equal(mail.check_conservation(), true);
});

test('wrong tenant cannot mint a ticket even when mailbox is empty', () => {
  const mail = box(1);
  assert.equal(mail.admit(route(501, {tenant: 88n}), 7n).status, 'stale');
  assert.equal(mail.counters.admitted, 0);
  assert.equal(mail.begin(), null);
  const ticket = admitted(mail, 501, 7);
  assert.equal(mail.commit(mail.begin(), 14n), true);
  assert.equal(mail.snapshot(ticket).result, 14n);
  assert.equal(mail.check_conservation(), true);
});
