import test from "node:test";
import assert from "node:assert/strict";

// Real executable Wasm, not a simulated allocator. Imports one 2-page memory,
// exports read(index): i32 using i32.load8_u. The module can address only the
// specific WebAssembly.Memory explicitly supplied to its instance.
const wasmByteReader = Uint8Array.from([
  0,97,115,109,1,0,0,0,
  1,6,1,0x60,1,0x7f,1,0x7f,
  2,16,1,3,101,110,118,6,109,101,109,111,114,121,2,1,2,2,
  3,2,1,0,
  7,8,1,4,114,101,97,100,0,0,
  10,9,1,7,0,0x20,0,0x2d,0,0,0x0b
]);

test("shared, private and untrusted actors lease independent Wasm memories", async () => {
  const OriginalMemory = WebAssembly.Memory;
  const created = [];
  function RecordingMemory(options) {
    const memory = new OriginalMemory(options);
    created.push(memory);
    return memory;
  }
  // The arena captures the original Memory.prototype.buffer getter.
  RecordingMemory.prototype = OriginalMemory.prototype;
  let mod;
  WebAssembly.Memory = RecordingMemory;
  try {
    mod = await import("../src/actor-arena.mjs?per-actor-memory-proof");
  } finally {
    WebAssembly.Memory = OriginalMemory;
  }

  const a = new mod.ActorArena({actorId: 201, incarnation: 1, kind: "shared"});
  const b = new mod.ActorArena({actorId: 202, incarnation: 1, kind: "untrusted"});
  const c = new mod.ActorArena({actorId: 203, incarnation: 1, kind: "private"});
  assert.equal(created.length, 3, "each concurrent actor requires its own Memory");
  assert.notStrictEqual(created[0], created[1]);
  assert.notStrictEqual(created[0], created[2]);
  assert.notStrictEqual(created[1], created[2]);
  assert.notStrictEqual(created[0].buffer, created[1].buffer);
  assert.notStrictEqual(created[1].buffer, created[2].buffer);

  const ta = a.beginTurn();
  const tb = b.beginTurn();
  const tc = c.beginTurn();
  const ha = a.allocPersistent(ta, 8);
  const hb = b.allocPersistent(tb, 8);
  const hc = c.allocPersistent(tc, 8);
  a.write(ta, ha, Uint8Array.of(11, 1, 2, 3, 4, 5, 6, 7));
  b.write(tb, hb, Uint8Array.of(22, 8, 9, 10, 11, 12, 13, 14));
  c.write(tc, hc, Uint8Array.of(33, 15, 16, 17, 18, 19, 20, 21));

  assert.equal(WebAssembly.validate(wasmByteReader), true);
  const reader = new WebAssembly.Module(wasmByteReader);
  let readerA = new WebAssembly.Instance(reader, {env: {memory: created[0]}});
  let readerB = new WebAssembly.Instance(reader, {env: {memory: created[1]}});
  let readerC = new WebAssembly.Instance(reader, {env: {memory: created[2]}});
  assert.equal(readerA.exports.read(0), 11);
  assert.equal(readerB.exports.read(0), 22);
  assert.equal(readerC.exports.read(0), 33);
  assert.throws(() => readerA.exports.read(2 * 65536), WebAssembly.RuntimeError,
    "Wasm memory32 cannot read beyond its own two-page linear memory");
  assert.throws(() => b.read(tb, ha), /foreign or stale/,
    "host API also rejects cross-actor opaque handles");

  // An active actor must never donate its memory to another actor.
  assert.throws(() => a.retire(), /active actor turn/);
  a.endTurn(ta);
  b.endTurn(tb);
  c.endTurn(tc);
  // The production arena is HOST ONLY: this test alone injected memory into
  // a Wasm module through a privileged constructor spy. A future real guest
  // integration must join/terminate every guest before an arena can retire.
  // Do not test or authorize using an old guest instance after pool reuse.
  readerA = null;
  readerB = null;
  readerC = null;
  a.retire();
  assert.equal(new Uint8Array(created[0].buffer)[0], 0,
    "retirement must scrub before the memory can be reassigned");
  const reuse = new mod.ActorArena({actorId: 204, incarnation: 2, kind: "untrusted"});
  assert.equal(created.length, 3, "reuse should not allocate another Memory");
  const tr = reuse.beginTurn();
  const hr = reuse.allocPersistent(tr, 8);
  assert.equal(reuse.read(tr, hr)[0], 0);
  reuse.write(tr, hr, Uint8Array.of(44, 1, 1, 1, 1, 1, 1, 1));
  // Only trusted test instrumentation retains these original Memory objects.
  // Never hand raw Memory/ArrayBuffer authority to a real guest across reuse.
  assert.equal(new Uint8Array(created[0].buffer)[0], 44);
  assert.equal(new Uint8Array(created[1].buffer)[0], 22);
  assert.equal(new Uint8Array(created[2].buffer)[0], 33);
  assert.throws(() => a.beginTurn(), /retired/);
  assert.throws(() => reuse.read(tr, ha), /foreign or stale/);
  reuse.endTurn(tr);
  reuse.retire();
  b.retire();
  c.retire();
  const finalStats = mod.actorArenaPoolStats();
  assert.equal(finalStats.leasedArenas, 0);
  assert.equal(finalStats.freeArenas, 3);
  assert.equal(finalStats.committedPages, 6);
});

test("the host arena never gives untrusted callers Memory or ArrayBuffer authority", async () => {
  const mod = await import("../src/actor-arena.mjs?sealed-private-memory");
  const arena = new mod.ActorArena({actorId: 205, incarnation: 1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  arena.write(turn, handle, Uint8Array.of(9, 8, 7, 6));
  const publicKeys = Reflect.ownKeys(arena);
  assert.equal(publicKeys.some(key => /memory|buffer|base/i.test(String(key))), false);
  const copy = arena.read(turn, handle);
  assert.equal(copy.buffer instanceof ArrayBuffer, true);
  copy[0] = 0;
  assert.equal(arena.read(turn, handle)[0], 9);
  arena.endTurn(turn);
  arena.retire();
});

test("lifetime pins fence retirement across turns, transfers and stale replays", async () => {
  const {ActorArena, actorArenaPoolStats} =
    await import("../src/actor-arena.mjs?lifetime-pin-fencing");
  const owner = new ActorArena({actorId: 310, incarnation: 8});
  const foreign = new ActorArena({actorId: 310, incarnation: 8});
  const ta = owner.beginTurn();
  const tb = foreign.beginTurn();
  const first = owner.pinLifetime(ta);
  const second = owner.pinLifetime(ta);
  assert.throws(() => foreign.unpinLifetime(first), /foreign, stale/);
  assert.throws(() => owner.unpinLifetime(Object.freeze({})), /foreign, stale/);
  assert.throws(() => owner.unpinLifetime(Object.freeze({})), /foreign, stale/);
  owner.endTurn(ta);
  assert.throws(() => owner.retire(), /outstanding actor lifetime pins/);
  const before = actorArenaPoolStats();
  owner.requestRetirement();
  assert.equal(owner.retirementRequested, true);
  assert.throws(() => owner.beginTurn(), /retirement requested/);
  owner.unpinLifetime(first); // late CONTROL completion, no actor turn
  assert.throws(() => owner.unpinLifetime(first), /foreign, stale/);
  assert.throws(() => owner.retire(), /outstanding actor lifetime pins/);
  owner.unpinLifetime(second); // second late completion
  owner.retire();
  assert.equal(actorArenaPoolStats().leasedArenas, before.leasedArenas - 1);
  assert.throws(() => owner.beginTurn(), /retired/);
  const replacement = new ActorArena({actorId: 310, incarnation: 9});
  const tr = replacement.beginTurn();
  assert.throws(() => replacement.unpinLifetime(first), /foreign, stale/);
  assert.throws(() => replacement.unpinLifetime(second), /foreign, stale/);
  replacement.endTurn(tr);
  replacement.retire();
  foreign.endTurn(tb);
  foreign.retire();
});

test("concurrent actors never alias and pooled instances are reused only after retirement", async () => {
  const OriginalMemory = WebAssembly.Memory;
  let totalCreated = 0;
  function CountMemory(options) {
    ++totalCreated;
    return new OriginalMemory(options);
  }
  CountMemory.prototype = OriginalMemory.prototype;
  WebAssembly.Memory = CountMemory;
  let mod;
  try {
    mod = await import("../src/actor-arena.mjs?churn-isolation");
  } finally {
    WebAssembly.Memory = OriginalMemory;
  }

  const count = 96;
  const active = [];
  for (let i = 0; i < count; ++i) {
    const actor = new mod.ActorArena({
      actorId: i + 401, incarnation: 1,
      kind: i % 3 === 0 ? "shared" : i % 3 === 1 ? "private" : "untrusted"
    });
    const turn = actor.beginTurn();
    const handle = actor.allocPersistent(turn, 8);
    actor.write(turn, handle, Uint8Array.of((i % 255) + 1, 2, 3, 4, 5, 6, 7, 8));
    active.push({actor, turn, handle, value: (i % 255) + 1});
  }
  assert.equal(totalCreated, count,
    "no simultaneous actors can share the same independent Memory");
  for (const x of active)
    assert.equal(x.actor.read(x.turn, x.handle)[0], x.value);
  for (let i = 0; i < active.length; i += 2) {
    active[i].actor.endTurn(active[i].turn);
    active[i].actor.retire();
  }
  assert.equal(mod.actorArenaPoolStats().freeArenas, count / 2);
  // Exhaust reclaimed capacity but keep the other half of actors LIVE.
  const replacements = [];
  for (let i = 0; i < count / 2; ++i) {
    const actor = new mod.ActorArena({actorId: i + 501, incarnation: 2});
    const turn = actor.beginTurn();
    const handle = actor.allocPersistent(turn, 8);
    assert.equal(actor.read(turn, handle)[0], 0, "retired heap must be scrubbed");
    actor.write(turn, handle, Uint8Array.of(99, 1, 1, 1, 1, 1, 1, 1));
    replacements.push({actor, turn});
  }
  assert.equal(totalCreated, count, "retired instance pool must supply replacements");
  for (let i = 1; i < active.length; i += 2)
    assert.equal(active[i].actor.read(active[i].turn, active[i].handle)[0],
      active[i].value, "live neighbor heap was affected by memory reissue");
  for (const x of replacements) {
    x.actor.endTurn(x.turn);
    x.actor.retire();
  }
  for (let i = 1; i < active.length; i += 2) {
    active[i].actor.endTurn(active[i].turn);
    active[i].actor.retire();
  }
  assert.equal(mod.actorArenaPoolStats().leasedArenas, 0);
});

test("shutdown fences admissions before active turn ends but permits late release", async () => {
  const {ActorArena, actorArenaPoolStats} =
    await import("../src/actor-arena.mjs?shutdown-admission-lifetime");
  const actor = new ActorArena({actorId: 601, incarnation: 42});
  const turn = actor.beginTurn();
  const pin = actor.pinLifetime(turn);
  const data = actor.allocPersistent(turn, 8);
  actor.write(turn, data, Uint8Array.of(51, 1, 2, 3, 4, 5, 6, 7));
  const budget = actorArenaPoolStats();
  actor.requestRetirement();
  actor.requestRetirement(); // idempotent request
  assert.equal(actor.retirementRequested, true);
  assert.throws(() => actor.beginTurn(), /retirement requested/);
  assert.throws(() => actor.pinLifetime(turn), /retirement requested/);
  assert.equal(actor.read(turn, data)[0], 51, "in-progress turn may finish");
  assert.throws(() => actor.retire(), /active actor turn/);
  actor.endTurn(turn);
  assert.throws(() => actor.retire(), /outstanding actor lifetime pins/);
  assert.equal(actorArenaPoolStats().leasedArenas, budget.leasedArenas,
    "memory may not be reused before pin completion");
  actor.unpinLifetime(pin);
  assert.throws(() => actor.unpinLifetime(pin), /foreign, stale/);
  actor.retire();
  assert.equal(actorArenaPoolStats().leasedArenas, budget.leasedArenas - 1);
  assert.throws(() => actor.unpinLifetime(pin), /retired/);
  assert.throws(() => actor.requestRetirement(), /retired/);
});
