import test from "node:test";
import assert from "node:assert/strict";
import {PinnedContinuationGate} from "../src/pinned-continuation-gate.mjs";

const T = Object.freeze({actorId: 11, generation: 29, operationId: 37});
function ready(g, ticket = T, result = "success") {
  assert.equal(g.settle(ticket, result), true);
  assert.equal(g.brokerAcknowledge(ticket), true);
  assert.equal(g.claimResume(ticket), true);
  assert.equal(g.finishResume(ticket), true);
}

test("reject invalid tickets and snapshot ticket identity", () => {
  for (const bad of [null, 0, {}, {actorId: 0, generation: 1, operationId: 1},
      {actorId: 1, generation: -1, operationId: 1},
      {actorId: 1, generation: 1, operationId: Number.MAX_SAFE_INTEGER + 1}]) {
    assert.throws(() => new PinnedContinuationGate(bad), /invalid continuation ticket/);
  }
  const mutable = {...T};
  const g = new PinnedContinuationGate(mutable);
  mutable.generation += 1;
  assert.equal(g.settle(mutable, "success"), false);
  assert.equal(g.settle(T, "success"), true);
});

test("all invalid terminal discriminants fail closed without mutation", () => {
  const allowed = ["success", "failure", "cancelled", "timed_out", "closed"];
  for (const terminal of allowed) {
    const g = new PinnedContinuationGate(T);
    assert.equal(g.settle(T, terminal), true);
    assert.equal(g.terminal, terminal);
    assert.equal(g.settle(T, "success"), false);
  }
  const g = new PinnedContinuationGate(T);
  for (let raw = 0; raw < 256; ++raw) assert.equal(g.settle(T, raw), false);
  for (const bad of [null, undefined, "pending", "SUCCESS", "", "panic", {}, []])
    assert.equal(g.settle(T, bad), false);
  assert.equal(g.terminal, null);
  assert.equal(g.settle(T, "cancelled"), true);
});

test("stale tickets cannot transition any stage", () => {
  const g = new PinnedContinuationGate(T);
  for (const stale of [{...T, actorId: 12}, {...T, generation: 30},
      {...T, operationId: 38}, {actorId: 0, generation: 29, operationId: 37}]) {
    assert.equal(g.acquire(stale, 5, "shared"), null);
    assert.equal(g.settle(stale, "failure"), false);
    assert.equal(g.brokerAcknowledge(stale), false);
    assert.equal(g.claimResume(stale), false);
    assert.equal(g.finishResume(stale), false);
    assert.equal(g.tryRetire(stale), false);
  }
  ready(g);
  assert.equal(g.tryRetire(T), true);
});

test("exclusive and shared admissions preserve ownership", () => {
  const g = new PinnedContinuationGate(T);
  const a = g.acquire(T, 1, "shared");
  const b = g.acquire(T, 2, "shared");
  assert.ok(a && b);
  assert.equal(g.acquire(T, 3, "exclusive"), null);
  assert.equal(g.release(T, 2, a), false);
  assert.equal(g.release(T, 1, a), true);
  assert.equal(g.release(T, 1, a), false);
  assert.equal(g.release(T, 2, b), true);
  const e = g.acquire(T, 3, "exclusive");
  assert.ok(e);
  assert.equal(g.acquire(T, 1, "shared"), null);
  assert.equal(g.release(T, 3, e), true);
  ready(g);
  assert.equal(g.tryRetire(T), true);
});

test("single-use receipts are bound to exact gate and borrower", () => {
  const g = new PinnedContinuationGate(T);
  const h = new PinnedContinuationGate(T);
  const r = g.acquire(T, 5, "shared");
  const other = h.acquire(T, 5, "shared");
  assert.equal(h.release(T, 5, r), false);
  assert.equal(g.release(T, 5, other), false);
  assert.equal(g.release(T, 4, r), false);
  assert.equal(g.release({...T, generation: 999}, 5, r), false);
  assert.equal(g.liveReceipts, 1);
  assert.equal(g.release(T, 5, r), true);
  assert.equal(g.release(T, 5, r), false);
  assert.equal(h.release(T, 5, other), true);
  ready(g); ready(h);
  assert.equal(g.tryRetire(T), true);
  assert.equal(h.tryRetire(T), true);
});

test("receipt registry has a hard 64-receipt bound and reuses quota safely", () => {
  const g = new PinnedContinuationGate(T);
  const receipts = Array.from({length: 64}, (_, i) => g.acquire(T, i + 1, "shared"));
  assert.ok(receipts.every(Boolean));
  assert.equal(g.acquire(T, 65, "shared"), null);
  assert.equal(g.release(T, 1, receipts[0]), true);
  const newReceipt = g.acquire(T, 65, "shared");
  assert.ok(newReceipt);
  assert.equal(g.release(T, 1, receipts[0]), false);
  assert.equal(g.liveReceipts, 64);
  receipts.slice(1).forEach((r, i) => assert.equal(g.release(T, i + 2, r), true));
  assert.equal(g.release(T, 65, newReceipt), true);
  ready(g);
  assert.equal(g.tryRetire(T), true);
});

test("broker quiescence and finished resume are separate retirement fences", () => {
  const g = new PinnedContinuationGate(T);
  const loan = g.acquire(T, 8, "shared");
  assert.equal(g.brokerAcknowledge(T), false);
  assert.equal(g.claimResume(T), false);
  assert.equal(g.finishResume(T), false);
  assert.equal(g.tryRetire(T), false);
  assert.equal(g.settle(T, "timed_out"), true);
  assert.equal(g.acquire(T, 9, "shared"), null);
  assert.equal(g.tryRetire(T), false);
  assert.equal(g.brokerAcknowledge(T), true);
  assert.equal(g.claimResume(T), true);
  assert.equal(g.tryRetire(T), false);
  assert.equal(g.finishResume(T), true);
  assert.equal(g.tryRetire(T), false);
  assert.equal(g.release(T, 8, loan), true);
  assert.equal(g.tryRetire(T), true);
  assert.equal(g.tryRetire(T), false);
  assert.equal(g.acquire(T, 9, "shared"), null);
  assert.equal(g.brokerAcknowledge(T), false);
});

test("invalid loan modes and borrower IDs leave the gate untouched", () => {
  const g = new PinnedContinuationGate(T);
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", NaN])
    assert.equal(g.acquire(T, bad, "shared"), null);
  for (const bad of [null, 0, 1, "SHARED", "", {}, "exclusive "])
    assert.equal(g.acquire(T, 1, bad), null);
  assert.deepEqual(g.loanState, {shared: 0, exclusive: false});
  ready(g);
  assert.equal(g.tryRetire(T), true);
});

test("async callback orderings cannot retire until all requirements hold", async () => {
  for (let i = 0; i < 256; i++) {
    const g = new PinnedContinuationGate(T);
    const r = g.acquire(T, 7, "shared");
    const actions = [() => g.settle(T, "cancelled"), () => g.release(T, 7, r)];
    if (i & 1) actions.reverse();
    await Promise.all(actions.map(f => Promise.resolve().then(f)));
    assert.equal(g.brokerAcknowledge(T), true);
    assert.equal(g.claimResume(T), true);
    assert.equal(g.finishResume(T), true);
    assert.equal(g.tryRetire(T), true);
  }
});

test("same actor ticket after restart cannot accept stale receipts", () => {
  for (let i = 0; i < 64; ++i) {
    const old = new PinnedContinuationGate(T);
    const stale = old.acquire(T, 1, "shared");
    assert.equal(old.release(T, 1, stale), true);
    ready(old);
    assert.equal(old.tryRetire(T), true);
    const fresh = new PinnedContinuationGate(T);
    const current = fresh.acquire(T, 1, "shared");
    assert.equal(fresh.release(T, 1, stale), false);
    assert.equal(fresh.release(T, 1, current), true);
    ready(fresh);
    assert.equal(fresh.tryRetire(T), true);
  }
});
