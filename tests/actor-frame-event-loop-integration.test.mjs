// Host integration only: real timers + ActorArena + PinnedContinuationGate.
// Not compiled guest await, a browser reactor, or a production scheduler.
import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena} from "../src/actor-arena.mjs";
import {PinnedContinuationGate} from "../src/pinned-continuation-gate.mjs";

const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));

function suspend(actorId, byte) {
  const arena = new ActorArena({actorId, incarnation: 1, kind: "shared"});
  const turn = arena.beginTurn();
  const heap = arena.allocPersistent(turn, 1);
  const execution = arena.startStack(turn);
  const frame = arena.pushStackFrame(turn, execution, 1);
  arena.write(turn, heap, Uint8Array.of(byte));
  arena.writeStackFrame(turn, execution, frame, Uint8Array.of(byte + 1));
  const pin = arena.pinLifetime(turn);
  const receipt = arena.suspendStack(turn, execution);
  arena.endTurn(turn);
  const ticket = {actorId, generation: 1, operationId: 1};
  return {arena, turn, heap, execution, frame, pin, receipt, ticket,
    gate: new PinnedContinuationGate(ticket)};
}

test("interleaved timer completion and CONTROL retirement conserve actor heap and stack ownership", async () => {
  const stopped = suspend(901, 11);
  const live = suspend(902, 41);
  const trace = [];

  await macrotask();
  // Reactor/producer callback publishes terminal state; no guest turn.
  assert.equal(live.gate.settle(live.ticket, "success"), true);
  assert.equal(live.gate.claimResume(live.ticket), false, "broker has not acknowledged");
  assert.throws(() => live.arena.read(live.turn, live.heap), /turn authority/);
  assert.equal(live.arena.stackBytesInUse, 1);
  trace.push("completion");

  await macrotask();
  // CONTROL retires a different actor while its external operation is pinned.
  stopped.arena.retire();
  assert.equal(stopped.arena.retired, true);
  assert.equal(stopped.arena.pendingLifetimePins, 1);
  assert.equal(stopped.arena.stackExecutionCount, 1);
  assert.throws(() => stopped.arena.beginTurn(), /retired/);
  trace.push("stop");

  await macrotask();
  assert.equal(live.gate.brokerAcknowledge(live.ticket), true);
  live.arena.releaseLifetimePin(live.pin);
  assert.equal(live.gate.claimResume(stopped.ticket), false);
  assert.equal(live.gate.claimResume(live.ticket), true);
  assert.equal(live.gate.claimResume(live.ticket), false);
  const next = live.arena.beginTurn();
  assert.throws(() => live.arena.resumeStack(next, stopped.receipt), /foreign, stale or consumed/);
  assert.throws(() => live.arena.read(next, stopped.heap), /foreign or stale/);
  assert.equal(live.arena.resumeStack(next, live.receipt), live.execution);
  assert.deepEqual([...live.arena.read(next, live.heap)], [41]);
  assert.deepEqual([...live.arena.readStackFrame(next, live.execution, live.frame)], [42]);
  live.arena.popStackFrame(next, live.execution, live.frame);
  live.arena.finishStack(next, live.execution);
  assert.throws(() => live.arena.resumeStack(next, live.receipt), /stale or consumed/);
  live.arena.dropPersistent(next, live.heap);
  live.arena.endTurn(next);
  assert.equal(live.gate.finishResume(live.ticket), true);
  assert.equal(live.gate.tryRetire(live.ticket), true);
  live.arena.retire();
  trace.push("sibling-resume");

  await macrotask();
  // A late producer release can retire backing memory, never revive the actor.
  stopped.arena.releaseLifetimePin(stopped.pin);
  stopped.arena.releaseLifetimePin(stopped.pin);
  assert.equal(stopped.arena.pendingLifetimePins, 0);
  assert.equal(stopped.arena.stackBytesInUse, 0);
  assert.equal(stopped.arena.stackExecutionCount, 0);
  const replacement = new ActorArena({actorId: 901, incarnation: 2});
  const fresh = replacement.beginTurn();
  assert.throws(() => replacement.resumeStack(fresh, stopped.receipt), /stale or consumed/);
  assert.throws(() => replacement.read(fresh, stopped.heap), /foreign or stale/);
  replacement.endTurn(fresh);
  replacement.retire();
  assert.equal(live.arena.stackBytesInUse, 0);
  assert.equal(live.arena.stackExecutionCount, 0);
  assert.deepEqual(trace, ["completion", "stop", "sibling-resume"]);
});
