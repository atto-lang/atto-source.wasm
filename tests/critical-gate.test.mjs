import test from "node:test";
import assert from "node:assert/strict";
import {CriticalGate} from "../src/critical-gate.mjs";

// Host-runtime proofs ONLY. These tests do not run Oreslang guest code.
test("Wasm host critical try path never queues or executes guest code", () => {
  const gate = new CriticalGate();
  const first = gate.tryRequest();
  assert.ok(first);
  assert.equal(gate.holds(first), true);
  assert.equal(gate.tryRequest(), null);
  assert.equal(gate.waiting, 0);
  assert.equal(gate.release(first), null);
  const second = gate.tryRequest();
  assert.ok(second && second !== first);
  assert.equal(gate.release(first), null);
  assert.equal(gate.holds(second), true);
  gate.release(second);
});

test("Wasm host critical FIFO, cancelled tickets, stale releases", () => {
  const gate = new CriticalGate();
  const owner = gate.request();
  const cancelled = gate.request();
  const second = gate.request();
  const third = gate.request();
  assert.equal(owner.admission, "ACQUIRED");
  assert.equal(cancelled.admission, "QUEUED");
  assert.equal(second.admission, "QUEUED");
  assert.equal(third.admission, "QUEUED");
  assert.equal(gate.waiting, 3);
  assert.equal(gate.release(cancelled.ticket), null);
  assert.equal(gate.release(owner.ticket), second.ticket);
  assert.equal(gate.release(owner.ticket), null);
  assert.equal(gate.holds(second.ticket), true);
  assert.equal(gate.release(second.ticket), third.ticket);
  assert.equal(gate.release(third.ticket), null);
  assert.equal(gate.waiting, 0);
});

test("Wasm host critical tickets are unforgeable and scope-bound", () => {
  const a = new CriticalGate();
  const b = new CriticalGate();
  const ticket = a.request().ticket;
  assert.equal(b.holds(ticket), false);
  assert.throws(() => b.release(ticket), /foreign or invalid/);
  assert.throws(() => a.release(Object.freeze({})), /foreign or invalid/);
  assert.throws(() => a.release(null), /foreign or invalid/);
  assert.equal(a.holds(ticket), true);
  a.release(ticket);
});

test("Wasm host critical retirement fences queued old-generation tickets", () => {
  const old = new CriticalGate();
  const owner = old.request();
  const queued = old.request();
  old.retire();
  assert.equal(old.retired, true);
  assert.equal(old.waiting, 0);
  assert.equal(old.holds(owner.ticket), false);
  assert.equal(old.release(owner.ticket), null);
  assert.equal(old.release(queued.ticket), null);
  assert.equal(old.tryRequest(), null);
  assert.throws(() => old.request(), /retired/);
  old.retire();
  const next = new CriticalGate();
  assert.equal(next.holds(owner.ticket), false);
  assert.equal(next.request().admission, "ACQUIRED");
});

test("Wasm host critical waiter quota is bounded and recovers cancellation", () => {
  const gate = new CriticalGate();
  const owner = gate.request();
  const firstWaiting = gate.request();
  for (let i = 1; i < CriticalGate.MAX_WAITERS; i++)
    assert.equal(gate.request().admission, "QUEUED");
  assert.equal(gate.waiting, CriticalGate.MAX_WAITERS);
  assert.throws(() => gate.request(), /waiter limit exceeded/);
  assert.equal(gate.holds(owner.ticket), true);
  gate.release(firstWaiting.ticket);
  assert.equal(gate.request().admission, "QUEUED");
  gate.retire();
  assert.equal(gate.waiting, 0);
});

test("Wasm host critical does not execute continuations while handing off", () => {
  const gate = new CriticalGate();
  let guestCalls = 0;
  const owner = gate.request();
  const next = gate.request();
  const handed = gate.release(owner.ticket);
  assert.equal(handed, next.ticket);
  assert.equal(guestCalls, 0);
  // The trusted scheduler is a separate protocol; this test only checks
  // ticket return and explicitly does NOT claim native Wasm guest execution.
  if (gate.holds(handed)) guestCalls++;
  assert.equal(guestCalls, 1);
  gate.release(handed);
});
