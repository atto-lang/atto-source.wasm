import test from "node:test";
import assert from "node:assert/strict";

// Explicit-state exploration of the abstract single-actor CONTROL protocol.
// This exhaustively covers <=2 total guest starts, turn admission,
// stop, cancellation requests, exit receipts, memory retirement, and reuse.
// It is a bounded safety model, NOT a refinement proof of Node/V8 internals.
test("actor lifetime state machine forbids memory reuse before worker exit", () => {
  const initial = {
    phase: "RUNNING", turn: true, active: 0, pins: 0,
    spawned: 0, cancelRequested: false
  };
  const queue = [initial], seen = new Set();
  const paths = new Set();
  const key = s => JSON.stringify(s);
  while (queue.length > 0) {
    const s = queue.shift();
    if (seen.has(key(s))) continue;
    seen.add(key(s));
    assert.equal(s.pins, s.active, "one pin per physically live worker");
    assert.ok(s.active >= 0 && s.active <= 2);
    if (s.phase === "RETIRED" || s.phase === "REUSED") {
      assert.equal(s.turn, false, "no active turn may survive retirement");
      assert.equal(s.active, 0, "no live guest may survive retirement");
      assert.equal(s.pins, 0, "no borrowed memory may survive retirement");
    }
    const next = (label, patch) => {
      paths.add(label);
      queue.push({...s, ...patch});
    };
    if (s.phase === "RUNNING" && !s.turn)
      next("begin-turn", {turn: true});
    if (s.turn)
      next("end-turn", {turn: false});
    if (s.phase === "RUNNING" && s.turn && s.active < 2 && s.spawned < 2)
      next("spawn-worker", {active: s.active + 1, pins: s.pins + 1, spawned: s.spawned + 1});
    if (s.phase === "RUNNING")
      next("stop-admission", {phase: "STOP"});
    if (s.active > 0 && !s.cancelRequested)
      next("request-cancel", {cancelRequested: true});
    // The EXIT receipt, not a timeout/cancellation request, releases
    // both the running worker and its matching lifetime pin.
    if (s.active > 0)
      next("worker-exit-receipt", {
        active: s.active - 1, pins: s.pins - 1
      });
    if (s.phase === "STOP" && !s.turn && s.pins === 0 && s.active === 0)
      next("retire", {phase: "RETIRED"});
    if (s.phase === "RETIRED")
      next("reuse", {phase: "REUSED"});
  }
  assert.ok(seen.size >= 20, "model exploration was not vacuous");
  for (const label of ["spawn-worker", "request-cancel", "worker-exit-receipt",
    "stop-admission", "retire", "reuse"]) {
    assert.ok(paths.has(label), "missing lifecycle transition: " + label);
  }
});
