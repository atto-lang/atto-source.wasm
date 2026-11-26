import test from "node:test";
import assert from "node:assert/strict";
import {SupervisorStopLedger} from "../src/supervisor-stop-ledger.mjs";

const create = (capacity = 2) => new SupervisorStopLedger({
  supervisor: "runtime-supervisor", group: "actor-group", capacity
});

test("host STOP requires child finalization and exactly one applied receipt", () => {
  const lane = create();
  const child = lane.register({actorId:"physical-1", incarnation:1});
  assert.throws(() => lane.reserve_stop(child), /physically finalized/);
  lane.assert_physically_finalized(child);
  assert.throws(() => lane.assert_physically_finalized(child), /duplicate or stale/);
  const ticket = lane.reserve_stop(child);
  assert.equal(lane.receipt(ticket), "pending");
  assert.deepEqual(lane.receipt_snapshot(ticket), {
    actorId: "physical-1", incarnation: 1, turnGeneration: 1, receipt: "pending"
  });
  assert.throws(() => lane.receipt_snapshot(structuredClone(ticket)), /foreign/);
  assert.throws(() => lane.receipt_snapshot(JSON.parse(JSON.stringify(ticket))), /foreign/);
  assert.throws(() => lane.reserve_stop(child), /already active/);
  assert.throws(() => lane.mark_applied(ticket), /not invoked/);
  lane.claim_host_invocation(ticket);
  assert.throws(() => lane.claim_host_invocation(ticket), /already invoked/);
  lane.mark_applied(ticket);
  assert.throws(() => lane.mark_uncertain(ticket), /downgrade/);
  lane.acknowledge_applied(ticket);
  assert.equal(lane.snapshot(child).phase, "stopped");
  assert.throws(() => lane.acknowledge_applied(ticket), /stale/);
  assert.throws(() => lane.reserve_stop(child), /physically finalized/);
});

test("uncertain host STOP fences second turn and cannot be reissued", () => {
  const lane = create();
  const first = lane.register({actorId:"physical-1",incarnation:1});
  const second = lane.register({actorId:"physical-2",incarnation:1});
  lane.assert_physically_finalized(first);
  lane.assert_physically_finalized(second);
  const ticket = lane.reserve_stop(first);
  lane.claim_host_invocation(ticket);
  lane.mark_uncertain(ticket);
  lane.mark_uncertain(ticket);
  assert.equal(lane.receipt(ticket), "uncertain");
  assert.throws(() => lane.reserve_stop(second), /already active/);
  assert.throws(() => lane.acknowledge_applied(ticket), /not confirmed/);
  assert.throws(() => lane.reconcile_verified_stop(Object.freeze({})), /foreign/);
  assert.throws(() => lane.reconcile_verified_stop(structuredClone(ticket)), /foreign/);
  lane.reconcile_verified_stop(ticket);
  assert.equal(lane.snapshot(first).phase, "stopped");
  const secondTicket = lane.reserve_stop(second);
  assert.deepEqual(lane.receipt_snapshot(secondTicket), {
    actorId: "physical-2", incarnation: 1, turnGeneration: 2, receipt: "pending"
  });
  lane.claim_host_invocation(secondTicket);
  lane.mark_applied(secondTicket);
  lane.acknowledge_applied(secondTicket);
  assert.equal(lane.snapshot(second).phase, "stopped");
});

test("serialized and cloned child handles never obtain supervisor authority", () => {
  const lane = create(1);
  const child = lane.register({actorId:"physical-X", incarnation:9});
  assert.equal(JSON.stringify(child), "{}");
  assert.throws(() => lane.snapshot(structuredClone(child)), /foreign/);
  assert.throws(() => lane.assert_physically_finalized(JSON.parse(JSON.stringify(child))), /foreign/);
  assert.throws(() => lane.register({actorId:"physical-X",incarnation:9}), /capacity/);
  assert.throws(() => lane.register({actorId:"physical-Y",incarnation:1}), /capacity/);
  assert.throws(() => create(0), /capacity/);
  assert.throws(() => lane.register({actorId:"physical-X",incarnation:Number.MAX_SAFE_INTEGER+1}),
    /identity/);
  assert.throws(() => lane.register({actorId:"physical-X",incarnation:0}), /identity/);
});

test("STOP ticket belongs to exactly one ledger instance", () => {
  const first = create(1);
  const second = create(1);
  const firstChild = first.register({actorId:"same",incarnation:1});
  const secondChild = second.register({actorId:"same",incarnation:1});
  first.assert_physically_finalized(firstChild);
  second.assert_physically_finalized(secondChild);
  const firstTicket = first.reserve_stop(firstChild);
  const secondTicket = second.reserve_stop(secondChild);
  assert.equal(first.receipt_snapshot(firstTicket).turnGeneration, 1);
  assert.equal(second.receipt_snapshot(secondTicket).turnGeneration, 1);
  assert.throws(() => second.claim_host_invocation(firstTicket), /foreign/);
  assert.equal(second.receipt(secondTicket), "pending");
  second.claim_host_invocation(secondTicket);
  second.mark_applied(secondTicket);
  second.acknowledge_applied(secondTicket);
  assert.equal(second.snapshot(secondChild).phase, "stopped");
});

test("compiler source admission remains independent of host STOP bookkeeping", async () => {
  const {rejectUnsupportedActorThreadSource} =
    await import("../src/actor-max-threads-source-policy.mjs");
  assert.throws(() => rejectUnsupportedActorThreadSource(
    new TextEncoder().encode("define supervisor S1 as on_panic(f: Failure): void { self.stop(f); } end")),
  /source supervisor unsupported/);
  const lane = create();
  const child = lane.register({actorId:"actor", incarnation:1});
  assert.equal(lane.snapshot(child).phase, "active");
});

test("acknowledged STOP frees a bounded child slot without recycling identity", () => {
  const lane = create(1);
  const first = lane.register({actorId:"physical-A",incarnation:1});
  assert.throws(() => lane.register({actorId:"physical-B",incarnation:1}), /capacity/);
  lane.assert_physically_finalized(first);
  const firstTicket = lane.reserve_stop(first);
  // Physical finalization, reservation, and invocation do not free capacity.
  assert.throws(() => lane.register({actorId:"physical-B",incarnation:1}), /capacity/);
  lane.claim_host_invocation(firstTicket);
  lane.mark_applied(firstTicket);
  assert.throws(() => lane.register({actorId:"physical-B",incarnation:1}), /capacity/);
  lane.acknowledge_applied(firstTicket);
  assert.equal(lane.snapshot(first).phase,"stopped");
  assert.throws(() => lane.register({actorId:"physical-A",incarnation:1}),
    /duplicate physical actor generation/);
  const second = lane.register({actorId:"physical-B",incarnation:1});
  assert.equal(lane.snapshot(second).phase,"active");
  assert.throws(() => lane.register({actorId:"physical-C",incarnation:1}), /capacity/);
  assert.throws(() => lane.acknowledge_applied(firstTicket), /stale/);
  // A newer generation may replace a physically retired identity, but never
  // with the same opaque child authority or its old STOP receipt.
  lane.assert_physically_finalized(second);
  const secondTicket = lane.reserve_stop(second);
  lane.claim_host_invocation(secondTicket);
  lane.mark_applied(secondTicket);
  lane.acknowledge_applied(secondTicket);
  const restarted = lane.register({actorId:"physical-B",incarnation:2});
  assert.equal(lane.snapshot(restarted).incarnation,2);
  assert.equal(lane.snapshot(second).phase,"stopped");
});

test("uncertain STOP retains capacity until trusted reconciliation", () => {
  const lane = create(1);
  const first = lane.register({actorId:"physical-A",incarnation:1});
  lane.assert_physically_finalized(first);
  const ticket = lane.reserve_stop(first);
  lane.claim_host_invocation(ticket);
  lane.mark_uncertain(ticket);
  assert.throws(() => lane.register({actorId:"physical-B",incarnation:1}), /capacity/);
  assert.throws(() => lane.acknowledge_applied(ticket), /not confirmed applied/);
  assert.equal(lane.snapshot(first).phase,"stopping");
  assert.throws(() => lane.register({actorId:"physical-B",incarnation:1}), /capacity/);
  lane.reconcile_verified_stop(ticket);
  assert.equal(lane.snapshot(first).phase,"stopped");
  assert.throws(() => lane.reconcile_verified_stop(ticket), /stale/);
  const next = lane.register({actorId:"physical-B",incarnation:1});
  assert.equal(lane.snapshot(next).phase,"active");
});
