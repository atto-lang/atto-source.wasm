import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena} from "../src/actor-arena.mjs";

test("fixed backing supports repeated caller-buffer reads without a new result", () => {
  const arena = new ActorArena({actorId: 901, incarnation: 1});
  const turn = arena.beginTurn();
  const h = arena.allocPersistent(turn, 8);
  const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
  const result = new Uint8Array(8);
  arena.write(turn, h, bytes);
  for (let i = 0; i < 20_000; ++i) {
    arena.readInto(turn, h, result);
    assert.equal(result[0], 1);
    assert.equal(result[7], 8);
  }
  assert.deepEqual([...result], [...bytes]);
  result[0] = 99;
  assert.equal(arena.read(turn, h)[0], 1, "output is a copy, not a live actor view");
  arena.endTurn(turn);
  const later = arena.beginTurn();
  result.fill(0);
  arena.readInto(later, h, result);
  assert.deepEqual([...result], [...bytes], "persistent bytes survive actor turns");
  arena.endTurn(later);
  arena.retire();
  assert.throws(() => arena.readInto(turn, h, result), /retired/);
});

test("readInto rejects shared, malformed and detached external byte destinations", () => {
  const arena = new ActorArena({actorId: 902, incarnation: 1});
  const t = arena.beginTurn();
  const h = arena.allocPersistent(t, 4);
  arena.write(t, h, Uint8Array.of(7, 8, 9, 10));
  assert.throws(() => arena.readInto(t, h, new Uint8Array(3)), /exact-size/);
  assert.throws(() => arena.readInto(t, h, new Uint16Array(2)), /exact-size/);
  if (typeof SharedArrayBuffer === "function") {
    assert.throws(() => arena.readInto(t, h, new Uint8Array(new SharedArrayBuffer(4))),
      /shared backing/);
  }
  const backing = new ArrayBuffer(4);
  const detached = new Uint8Array(backing);
  structuredClone(backing, {transfer: [backing]});
  assert.throws(() => arena.readInto(t, h, detached), /exact-size/);
  assert.deepEqual([...arena.read(t, h)], [7, 8, 9, 10],
    "rejected outputs cannot modify the source arena");
  arena.endTurn(t);
  arena.retire();
});

test("Wasm host copy boundary rejects forged access to private linear memory", () => {
  const OriginalMemory = WebAssembly.Memory;
  let backing;
  WebAssembly.Memory = class extends OriginalMemory {
    constructor(options) { super(options); backing = this.buffer; }
  };
  let arena;
  try { arena = new ActorArena({actorId: 903, incarnation: 1}); }
  finally { WebAssembly.Memory = OriginalMemory; }
  const turn = arena.beginTurn();
  const h = arena.allocPersistent(turn, 4);
  const safe = Uint8Array.of(42, 43, 44, 45);
  arena.write(turn, h, safe);
  const privateBytes = new Uint8Array(backing, 0, 4);
  assert.throws(() => arena.write(turn, h, privateBytes), /private backing alias/);
  assert.throws(() => arena.readInto(turn, h, privateBytes), /private backing alias/);
  assert.deepEqual([...arena.read(turn, h)], [...safe]);
  const scratch = arena.allocScratch(turn, 4);
  arena.write(turn, scratch, safe);
  arena.endTurn(turn);
  const second = arena.beginTurn();
  assert.throws(() => arena.readInto(second, scratch, safe), /foreign or stale/);
  arena.endTurn(second);
  arena.retire();
  assert.deepEqual([...new Uint8Array(backing, 0, 4)], [0, 0, 0, 0],
    "retirement must scrub even if external host retained original ArrayBuffer");
});

test("zero-page memory.grow detaches cached view without losing live actor bytes", () => {
  const OriginalMemory = WebAssembly.Memory;
  let memory;
  WebAssembly.Memory = class extends OriginalMemory {
    constructor(options) { super(options); memory = this; }
  };
  let arena;
  try { arena = new ActorArena({actorId: 904, incarnation: 1}); }
  finally { WebAssembly.Memory = OriginalMemory; }

  const turn = arena.beginTurn();
  const persistent = arena.allocPersistent(turn, 4);
  const scratch = arena.allocScratch(turn, 4);
  arena.write(turn, persistent, Uint8Array.of(11, 12, 13, 14));
  arena.write(turn, scratch, Uint8Array.of(21, 22, 23, 24));
  const oldBacking = memory.buffer;
  assert.equal(memory.grow(0), 2);
  assert.notEqual(memory.buffer, oldBacking,
    "a successful grow(0) must replace the nonshared backing");
  assert.equal(oldBacking.byteLength, 0, "old cached bytes are detached");
  const output = new Uint8Array(4);
  arena.readInto(turn, persistent, output);
  assert.deepEqual([...output], [11, 12, 13, 14]);
  assert.deepEqual([...arena.read(turn, scratch)], [21, 22, 23, 24]);
  const privateAlias = new Uint8Array(memory.buffer, 0, 4);
  assert.throws(() => arena.readInto(turn, persistent, privateAlias),
    /private backing alias/, "buffer check must use the refreshed backing");
  assert.throws(() => arena.write(turn, persistent, privateAlias),
    /private backing alias/);
  arena.endTurn(turn);
  const next = arena.beginTurn();
  assert.deepEqual([...arena.read(next, persistent)], [11, 12, 13, 14]);
  assert.throws(() => arena.read(next, scratch), /foreign or stale/);
  arena.endTurn(next);
  arena.retire();
  assert.deepEqual([...new Uint8Array(memory.buffer, 0, 4)], [0, 0, 0, 0],
    "logical actor retirement must scrub the newest physical backing");
});

test("late lifetime-pin release scrubs current memory after grow(0)", () => {
  const OriginalMemory = WebAssembly.Memory;
  let memory;
  WebAssembly.Memory = class extends OriginalMemory {
    constructor(options) { super(options); memory = this; }
  };
  let arena;
  try { arena = new ActorArena({actorId: 905, incarnation: 1}); }
  finally { WebAssembly.Memory = OriginalMemory; }
  const turn = arena.beginTurn();
  const h = arena.allocPersistent(turn, 4);
  arena.write(turn, h, Uint8Array.of(31, 32, 33, 34));
  const pin = arena.pinLifetime(turn);
  arena.endTurn(turn);
  arena.retire();
  assert.equal(arena.pendingLifetimePins, 1);
  assert.equal(memory.grow(0), 2);
  assert.deepEqual([...new Uint8Array(memory.buffer, 0, 4)], [31, 32, 33, 34],
    "STOP with an outstanding pin must not prematurely reclaim");
  arena.releaseLifetimePin(pin);
  assert.equal(arena.pendingLifetimePins, 0);
  assert.deepEqual([...new Uint8Array(memory.buffer, 0, 4)], [0, 0, 0, 0],
    "last release must scrub newly reattached backing, not detached view");
  arena.releaseLifetimePin(pin);
});
