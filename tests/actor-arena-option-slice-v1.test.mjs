import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena} from "../src/actor-arena.mjs";

test("Wasm actor span get returns Some(owned copy) or None without raw alias", () => {
  const arena = new ActorArena({actorId: 701, incarnation: 1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  arena.write(turn, handle, Uint8Array.of(1, 2, 3, 4));
  const hit = arena.tryReadBytes(turn, handle, 1, 2);
  assert.equal(hit.kind, "Some");
  assert.deepEqual([...hit.value], [2, 3]);
  assert.equal(Object.isFrozen(hit), true);
  hit.value[0] = 99;
  assert.deepEqual([...arena.read(turn, handle)], [1, 2, 3, 4]);
  const last = arena.tryReadBytes(turn, handle, 3n, 1n);
  assert.deepEqual([...last.value], [4]);
  const zero = arena.tryReadBytes(turn, handle, 4, 0);
  assert.equal(zero.kind, "Some");
  assert.equal(zero.value.length, 0);
  for (const [start, width] of [[-1,1],[0,-1],[4,1],[5,0],[3,2],
    [0,5], [0xffff_ffffn,1], [(1n<<63n)-1n,1]]) {
    assert.deepEqual(arena.tryReadBytes(turn, handle, start, width), {kind:"None"});
  }
  assert.deepEqual([...arena.read(turn, handle)], [1, 2, 3, 4]);
  arena.endTurn(turn);
  arena.retire();
});

test("invalid indices cannot coerce into a valid Wasm byte access", () => {
  const arena = new ActorArena({actorId: 702, incarnation: 1});
  const turn = arena.beginTurn(), handle = arena.allocPersistent(turn, 2);
  for (const x of [NaN,Infinity,-0,0.5,"0",null,undefined,
    Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(() => arena.tryReadBytes(turn, handle, x, 1), TypeError);
    assert.throws(() => arena.tryReadBytes(turn, handle, 0, x), TypeError);
  }
  arena.endTurn(turn);
  arena.retire();
});

test("actor turn, incarnation and stale handle failures precede optional miss", () => {
  const a = new ActorArena({actorId: 703, incarnation: 1});
  const b = new ActorArena({actorId: 703, incarnation: 2});
  const ta = a.beginTurn(), tb = b.beginTurn();
  const ha = a.allocPersistent(ta, 1);
  assert.throws(() => a.tryReadBytes(tb, ha, -1, 1), /turn authority/);
  assert.throws(() => b.tryReadBytes(tb, ha, -1, 1), /foreign or stale/);
  a.dropPersistent(ta, ha);
  assert.throws(() => a.tryReadBytes(ta, ha, -1, 1), /foreign or stale/);
  a.endTurn(ta);
  b.endTurn(tb);
  a.retire();
  b.retire();
  assert.throws(() => a.tryReadBytes(ta, ha, -1, 1), /retired/);
});

test("scratch span expires at actor turn and cannot reappear on next turn", () => {
  const a = new ActorArena({actorId: 704, incarnation: 1});
  const t = a.beginTurn();
  const old = a.allocScratch(t, 8);
  a.write(t, old, Uint8Array.of(1,2,3,4,5,6,7,8));
  assert.deepEqual([...a.tryReadBytes(t, old, 2, 3).value], [3,4,5]);
  a.endTurn(t);
  const next = a.beginTurn();
  assert.throws(() => a.tryReadBytes(next, old, 20, 1), /foreign or stale/);
  a.endTurn(next);
  a.retire();
});

test("late WebAssembly.Memory constructor override cannot replace actor backing pages", () => {
  // The arena module is already imported above. A plugin that mutates
  // WebAssembly.Memory afterwards must not affect newly created actors.
  const original = WebAssembly.Memory;
  let poisonCalls = 0;
  try {
    WebAssembly.Memory = class HostileMemory {
      constructor() { poisonCalls++; throw new Error("fake actor memory"); }
    };
    const arena = new ActorArena({actorId: 705, incarnation: 1});
    const turn = arena.beginTurn();
    const handle = arena.allocPersistent(turn, 3);
    arena.write(turn, handle, Uint8Array.of(7, 4, 2));
    const copied = arena.tryReadBytes(turn, handle, 0, 3);
    assert.deepEqual([...copied.value], [7, 4, 2]);
    copied.value[0] = 99;
    assert.deepEqual([...arena.read(turn, handle)], [7, 4, 2]);
    arena.endTurn(turn);
    arena.retire();
  } finally {
    WebAssembly.Memory = original;
  }
  assert.equal(poisonCalls, 0,
    "new actor arena must not invoke a late-replaced memory constructor");
});

test("retirement fences byte access while a lifetime pin remains outstanding", () => {
  const arena = new ActorArena({actorId: 706, incarnation: 2});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 1);
  arena.write(turn, handle, Uint8Array.of(42));
  const pin = arena.pinLifetime(turn);
  assert.equal(arena.pendingLifetimePins, 1);
  arena.endTurn(turn);
  arena.retire();
  assert.equal(arena.retired, true);
  assert.equal(arena.pendingLifetimePins, 1);
  assert.throws(() => arena.beginTurn(), /retired/);
  assert.throws(() => arena.tryReadBytes(turn, handle, -1, 1), /retired/);
  assert.throws(() => arena.tryReadBytes(turn, handle, 0, 1), /retired/);
  arena.releaseLifetimePin(pin);
  arena.releaseLifetimePin(pin);
  assert.equal(arena.pendingLifetimePins, 0);
  assert.throws(() => arena.releaseLifetimePin(Object.freeze({})), /unissued/);
  arena.retire();
});

test("late monkeypatch of native collections and numeric guards cannot redirect arena authority", () => {
  const nativeWeakMap = globalThis.WeakMap;
  const nativeSet = WeakMap.prototype.set;
  const nativeGet = WeakMap.prototype.get;
  const nativeHas = WeakMap.prototype.has;
  const nativeDelete = WeakMap.prototype.delete;
  const nativePush = Array.prototype.push;
  const nativeFindIndex = Array.prototype.findIndex;
  const nativeSplice = Array.prototype.splice;
  const nativeSort = Array.prototype.sort;
  const nativeSafeInteger = Number.isSafeInteger;
  const nativeObjectIs = Object.is;
  const nativeBigInt = globalThis.BigInt;
  const nativeNumber = globalThis.Number;
  const nativeSetHas = Set.prototype.has;
  let output;
  let foreignDenied = false;
  let restored = false;
  try {
    const poison = () => { throw new Error("hostile prototype method invoked"); };
    globalThis.WeakMap = class FakeWeakMap { constructor() { throw new Error("fake WeakMap"); } };
    WeakMap.prototype.set = poison;
    WeakMap.prototype.get = poison;
    WeakMap.prototype.has = poison;
    WeakMap.prototype.delete = poison;
    Array.prototype.push = poison;
    Array.prototype.findIndex = poison;
    Array.prototype.splice = poison;
    Array.prototype.sort = poison;
    Number.isSafeInteger = () => false;
    Object.is = () => true;
    globalThis.BigInt = poison;
    globalThis.Number = poison;
    Set.prototype.has = () => true;

    const first = new ActorArena({actorId: 707, incarnation: 3});
    const second = new ActorArena({actorId: 707, incarnation: 4});
    const t1 = first.beginTurn(), t2 = second.beginTurn();
    const live = first.allocPersistent(t1, 4);
    first.write(t1, live, Uint8Array.of(1, 2, 3, 4));
    first.dropPersistent(t1, live); // private free list push/sort
    const replacement = first.allocPersistent(t1, 2); // private findIndex/splice
    first.write(t1, replacement, Uint8Array.of(8, 9));
    output = first.tryReadBytes(t1, replacement, 0, 2).value;
    try {
      second.tryReadBytes(t2, replacement, -1, 1);
    } catch (err) {
      foreignDenied = /foreign or stale/.test(err.message);
    }
    const pin = first.pinLifetime(t1);
    first.endTurn(t1);
    second.endTurn(t2);
    first.retire();
    first.releaseLifetimePin(pin);
    first.retire();
    second.retire();
  } finally {
    globalThis.WeakMap = nativeWeakMap;
    WeakMap.prototype.set = nativeSet;
    WeakMap.prototype.get = nativeGet;
    WeakMap.prototype.has = nativeHas;
    WeakMap.prototype.delete = nativeDelete;
    Array.prototype.push = nativePush;
    Array.prototype.findIndex = nativeFindIndex;
    Array.prototype.splice = nativeSplice;
    Array.prototype.sort = nativeSort;
    Number.isSafeInteger = nativeSafeInteger;
    Object.is = nativeObjectIs;
    globalThis.BigInt = nativeBigInt;
    globalThis.Number = nativeNumber;
    Set.prototype.has = nativeSetHas;
    restored = true;
  }
  assert.equal(restored, true);
  assert.equal(foreignDenied, true);
  assert.deepEqual([...output], [8, 9]);
});
