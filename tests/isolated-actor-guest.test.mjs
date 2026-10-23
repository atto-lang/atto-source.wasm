import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {ActorArena, actorArenaPoolStats} from "../src/actor-arena.mjs";
import {
  runIsolatedActorGuest, isolatedActorWorkerStats
} from "../src/isolated-actor-runner.mjs";

// Real executable Wasm, importing ONLY fixed 2-page env.memory:
// (func (export "read") (param i32) (result i32)
//   local.get 0; i32.load8_u)
const reader = Uint8Array.from([
  0,97,115,109,1,0,0,0, 1,6,1,0x60,1,0x7f,1,0x7f,
  2,16,1,3,101,110,118,6,109,101,109,111,114,121,2,1,2,2,
  3,2,1,0, 7,8,1,4,114,101,97,100,0,0,
  10,9,1,7,0,0x20,0,0x2d,0,0,0x0b
]);
// Same imported-memory interface but the guest intentionally never returns:
// loop { br 0 }; i32.const 0. Used to prove physical worker termination.
const spin = Uint8Array.from([
  ...reader.slice(0, -11),
  10,11,1,9,0,3,0x40,0x0c,0,0x0b,0x41,0,0x0b
]);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

test("two untrusted actors execute Wasm on separate disposable worker heaps", async () => {
  assert.equal(WebAssembly.validate(reader), true);
  const poolBefore = actorArenaPoolStats();
  const a = new ActorArena({actorId: 910, incarnation: 7, kind: "untrusted"});
  const b = new ActorArena({actorId: 911, incarnation: 2, kind: "untrusted"});
  const ta = a.beginTurn(), tb = b.beginTurn();
  const ha = a.allocPersistent(ta, 4), hb = b.allocPersistent(tb, 4);
  a.write(ta, ha, Uint8Array.of(37, 2, 3, 4));
  b.write(tb, hb, Uint8Array.of(89, 8, 9, 10));
  assert.throws(() => a.attachGuest(ta, reader), /isolated worker/);
  const opts = {expectedSha256: sha(reader), timeoutMs: 2500};
  const pa = a.invokeIsolatedGuest(ta, reader, "read", ha, opts);
  const pb = b.invokeIsolatedGuest(tb, reader, "read", hb, opts);
  a.endTurn(ta); b.endTurn(tb);
  a.requestRetirement(); b.requestRetirement();
  assert.throws(() => a.retire(), /outstanding actor lifetime pins/);
  assert.throws(() => b.retire(), /outstanding actor lifetime pins/);
  const [ra, rb] = await Promise.all([pa, pb]);
  assert.deepEqual({value: ra.value, actorId: ra.actorId, incarnation: ra.incarnation,
    terminated: ra.terminated}, {value: 37, actorId: 910, incarnation: 7, terminated: true});
  assert.equal(rb.value, 89);
  assert.equal(rb.actorId, 911);
  assert.equal(rb.terminated, true);
  assert.equal(isolatedActorWorkerStats().active, 0);
  a.retire(); b.retire();
  const poolAfter = actorArenaPoolStats();
  assert.equal(poolAfter.quarantinedArenas, poolBefore.quarantinedArenas,
    "worker-only Wasm may never touch or taint the host actor's linear memory");
  assert.equal(poolAfter.freeArenas, poolBefore.freeArenas + 2,
    "the copied worker heap may not disable ordinary host arena recycling");
  const newcomer = new ActorArena({actorId: 910, incarnation: 8, kind: "untrusted"});
  const tc = newcomer.beginTurn();
  const hc = newcomer.allocPersistent(tc, 4);
  assert.equal(newcomer.read(tc, hc)[0], 0,
    "reissued host arena must not retain predecessor data");
  newcomer.endTurn(tc); newcomer.retire();
});

test("infinite-loop Wasm cannot outlive its supervisor retirement pin", async () => {
  assert.equal(WebAssembly.validate(spin), true);
  const arena = new ActorArena({actorId: 912, incarnation: 1, kind: "untrusted"});
  const turn = arena.beginTurn();
  const p = arena.invokeIsolatedGuest(turn, spin, "read", undefined,
    {expectedSha256: sha(spin), timeoutMs: 300});
  arena.endTurn(turn);
  arena.requestRetirement();
  assert.throws(() => arena.retire(), /outstanding actor lifetime pins/);
  await assert.rejects(p, /deadline exceeded/);
  assert.equal(isolatedActorWorkerStats().active, 0);
  arena.retire(); // only after the worker EXIT receipt and pin release
});

test("abort of executing Wasm waits for physical exit before reclamation", async () => {
  const actor = new ActorArena({actorId: 913, incarnation: 3, kind: "untrusted"});
  const signal = new AbortController();
  const turn = actor.beginTurn();
  const p = actor.invokeIsolatedGuest(turn, spin, "read", undefined, {
    expectedSha256: sha(spin), timeoutMs: 2000, signal: signal.signal
  });
  actor.endTurn(turn);
  actor.requestRetirement();
  assert.throws(() => actor.retire(), /outstanding actor lifetime pins/);
  signal.abort();
  await assert.rejects(p, /cancelled/);
  actor.retire();
  assert.equal(isolatedActorWorkerStats().active, 0);
});

test("missing pins, shared input and forged provenance fail before worker admission", async () => {
  await assert.rejects(runIsolatedActorGuest(reader, {
    actorId: 920, incarnation: 1
  }), /pinned actor guest SHA-256 required/);
  await assert.rejects(runIsolatedActorGuest(reader, {
    actorId: 920, incarnation: 1, expectedSha256: "0".repeat(64)
  }), /artifact hash mismatch/);
  await assert.rejects(runIsolatedActorGuest(reader, {
    actorId: 920, incarnation: 1, expectedSha256: sha(reader),
    initialData: Uint8Array.of(1), args: [{}]
  }), /scalar argument/);
  if (typeof SharedArrayBuffer === "function") {
    const shared = new Uint8Array(new SharedArrayBuffer(reader.length));
    shared.set(reader);
    await assert.rejects(runIsolatedActorGuest(shared, {
      actorId: 920, incarnation: 1, expectedSha256: sha(reader)
    }), /SharedArrayBuffer/);
  }
  assert.equal(isolatedActorWorkerStats().active, 0);
});

test("cancellation wins after a valid worker reply but before physical exit", async () => {
  const {Worker} = await import("node:worker_threads");
  const nativeTerminate = Worker.prototype.terminate;
  const signal = new AbortController();
  let intercepted = false;
  // Deliberately defer physical termination to create the reply/exit race.
  // This patch is confined to this test process; it is not a production
  // dependency injection mechanism or a guest capability.
  Worker.prototype.terminate = function delayTermination() {
    intercepted = true;
    signal.abort(); // synchronous re-entry: reply has been accepted, no exit yet
    assert.equal(isolatedActorWorkerStats().active, 1,
      "worker quota cannot release on a reply or cancellation request");
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        Promise.resolve(nativeTerminate.call(this)).then(resolve, reject);
      }, 80);
    });
  };
  try {
    const pending = runIsolatedActorGuest(reader, {
      expectedSha256: sha(reader),
      actorId: 921, incarnation: 1, exportName: "read",
      initialData: Uint8Array.of(57), timeoutMs: 4000,
      signal: signal.signal
    });
    await assert.rejects(pending, /isolated actor cancelled/,
      "a reply never overrides cancellation before the worker exits");
    assert.equal(intercepted, true, "termination was requested after worker reply");
    assert.equal(isolatedActorWorkerStats().active, 0);
  } finally {
    Worker.prototype.terminate = nativeTerminate;
  }
});

test("bounded worker admission rejects the fifth guest and restores quota only after exits", async () => {
  const active = [];
  for (let i = 0; i < 4; ++i) {
    active.push(runIsolatedActorGuest(spin, {
      expectedSha256: sha(spin), actorId: 930 + i,
      incarnation: 1, exportName: "read", timeoutMs: 500
    }));
  }
  assert.equal(isolatedActorWorkerStats().active, 4);
  await assert.rejects(runIsolatedActorGuest(spin, {
    expectedSha256: sha(spin), actorId: 934,
    incarnation: 1, exportName: "read", timeoutMs: 500
  }), /worker quota exceeded/);
  assert.equal(isolatedActorWorkerStats().active, 4);
  // Attach all rejection observers together; individual worker deadlines
  // can fire on the same event-loop tick and must not go unobserved.
  await Promise.all(active.map(operation =>
    assert.rejects(operation, /deadline exceeded/)));
  assert.equal(isolatedActorWorkerStats().active, 0,
    "all four worker exit receipts must retire before quota is reusable");
});
