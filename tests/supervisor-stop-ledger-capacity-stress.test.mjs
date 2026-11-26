import test from 'node:test';
import assert from 'node:assert/strict';
import {SupervisorStopLedger} from '../src/supervisor-stop-ledger.mjs';

const make = () => new SupervisorStopLedger({supervisor: 'root', group: 'workers', capacity: 1});

test('capacity-one STOP releases exactly one slot for 512 successive generations', () => {
  const ledger = make();
  let priorTicket;
  for (let incarnation = 1; incarnation <= 512; incarnation++) {
    const child = ledger.register({actorId: 'stable-physical-id', incarnation});
    assert.equal(ledger.snapshot(child).phase, 'active');
    assert.throws(() => ledger.register({actorId: `unrelated-${incarnation}`, incarnation: 1}), /capacity/);
    if (priorTicket !== undefined)
      assert.throws(() => ledger.claim_host_invocation(priorTicket), /foreign|stale|replayed/);
    ledger.assert_physically_finalized(child);
    const ticket = ledger.reserve_stop(child);
    ledger.claim_host_invocation(ticket);
    assert.throws(() => ledger.register({actorId: `blocked-${incarnation}`, incarnation: 1}), /capacity/);
    if (incarnation % 2) {
      ledger.mark_applied(ticket);
      assert.throws(() => ledger.register({actorId: `pending-${incarnation}`, incarnation: 1}), /capacity/);
      ledger.acknowledge_applied(ticket);
    } else {
      ledger.mark_uncertain(ticket);
      assert.throws(() => ledger.acknowledge_applied(ticket), /not confirmed/);
      assert.throws(() => ledger.register({actorId: `uncertain-${incarnation}`, incarnation: 1}), /capacity/);
      ledger.reconcile_verified_stop(ticket);
    }
    assert.equal(ledger.snapshot(child).phase, 'stopped');
    assert.throws(() => ledger.register({actorId: 'stable-physical-id', incarnation}), /duplicate/);
    priorTicket = ticket;
  }
  const final = ledger.register({actorId: 'stable-physical-id', incarnation: 513});
  assert.equal(ledger.snapshot(final).phase, 'active');
});

test('malformed actor identity never reserves supervisor capacity', () => {
  const ledger = make();
  for (const actorId of ['', '\u0000', 'a'.repeat(129), '\ud800', '\udc00', 42])
    assert.throws(() => ledger.register({actorId, incarnation: 1}), /identity/);
  for (const incarnation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])
    assert.throws(() => ledger.register({actorId: 'valid', incarnation}), /identity/);
  const child = ledger.register({actorId: 'valid', incarnation: 1});
  assert.equal(ledger.snapshot(child).phase, 'active');
});
