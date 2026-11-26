import test from 'node:test';
import assert from 'node:assert/strict';
import {HostProxyMailboxTicketsV1 as Mailbox} from '../src/proxy-mailbox-ticket-v1.mjs';

// Host event-loop orderings, not concurrent shared-memory execution or guest parity.
const route = (tenant, id) => ({protocol_major: 1, tenant, caller_incarnation: 12n,
  target_actor: 13n, target_incarnation: 14n, association_generation: 17n,
  placement_epoch: 15n, message_id: BigInt(id), attempt: 1n});
const mail = tenant => new Mailbox({tenant, actor: 13n, incarnation: 14n, capacity: 1});
test('all six terminal/foreign admission orderings preserve exact settlement', () => {
  for (const order of ['cpa', 'cap', 'pca', 'pac', 'acp', 'apc']) {
    const m = mail(11n), other = mail(88n);
    const a = m.admit(route(11n, 501), 42n), b = other.admit(route(88n, 501), 43n);
    assert.equal(a.status, 'admitted'); assert.equal(b.status, 'admitted');
    assert.deepEqual(m.admit(route(88n, 501), 99n), {status: 'stale', ticket: null});
    const t = m.begin(), u = other.begin();
    assert.equal(m.commit(u, 99n), false); assert.equal(other.commit(t, 99n), false);
    assert.equal(m.snapshot(b.ticket), null); assert.equal(other.snapshot(a.ticket), null);
    const outcomes = {};
    for (const event of order) {
      if (event === 'c') outcomes.c = m.commit(t, 42n);
      else if (event === 'p') outcomes.p = m.panic(t);
      else assert.deepEqual(m.admit(route(88n, 502), 99n), {status: 'stale', ticket: null});
    }
    assert.notEqual(outcomes.c, outcomes.p);
    const snap = m.snapshot(a.ticket);
    assert.equal(snap.stage, outcomes.c ? 'processed' : 'failed');
    assert.equal(snap.hasResult, outcomes.c);
    assert.equal(snap.result, outcomes.c ? 42n : null);
    assert.equal(m.commit(t, 99n), false); assert.equal(m.panic(t), false);
    assert.equal(other.commit(u, 43n), true);
    m.close();
    assert.deepEqual(m.admit(route(88n, 503), 99n), {status: 'stale', ticket: null});
    assert.equal(m.begin(), null); assert.equal(m.check_conservation(), true);
    assert.equal(other.check_conservation(), true);
  }
});

function permutations(events) {
  if (events.length === 0) return [''];
  return [...events].flatMap((e, i) => permutations(events.slice(0, i) + events.slice(i + 1)).map(rest => e + rest));
}
test('all 24 close/terminal/foreign orders conserve queued mail', () => {
  const orders = permutations('cpax');
  assert.equal(new Set(orders).size, 24);
  for (const order of orders) {
    const m = mail(11n);
    const a = admittedFor(m, 701, 42n);
    const t = m.begin();
    const b = admittedFor(m, 702, 43n);
    const outcomes = {};
    for (const event of order) {
      if (event === 'c') outcomes.c = m.commit(t, 42n);
      else if (event === 'p') outcomes.p = m.panic(t);
      else if (event === 'x') m.close();
      else assert.deepEqual(m.admit(route(88n, 703), 99n), {status: 'stale', ticket: null});
    }
    assert.notEqual(outcomes.c, outcomes.p);
    assert.deepEqual(m.admit(route(11n, 704), 99n), {status: 'closed', ticket: null});
    assert.equal(m.snapshot(a).stage, outcomes.c ? 'processed' : 'failed');
    assert.equal(m.snapshot(a).result, outcomes.c ? 42n : null);
    assert.equal(m.snapshot(b).hasResult, false);
    if (outcomes.c) {
      assert.equal(m.snapshot(b).stage, 'admitted');
      const drain = m.begin();
      assert.equal(drain.value, 43n);
      assert.equal(m.commit(drain, 43n), true);
      assert.equal(m.snapshot(b).result, 43n);
    } else assert.equal(m.snapshot(b).stage, 'abandoned');
    assert.equal(m.commit(t, 99n), false);
    assert.equal(m.panic(t), false);
    assert.equal(m.begin(), null);
    assert.equal(m.check_conservation(), true);
  }
});
function admittedFor(m, id, value) {
  const a = m.admit(route(11n, id), value);
  assert.equal(a.status, 'admitted');
  assert.ok(a.ticket);
  return a.ticket;
}
