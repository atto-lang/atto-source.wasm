import test from "node:test";
import assert from "node:assert/strict";
import {runInNewContext} from "node:vm";
import {ActorArena, actorArenaPoolStats} from "../src/actor-arena.mjs";

test("shared actors get private arenas, not transferable heap handles", () => {
  const a = new ActorArena({actorId: 1, incarnation: 1, kind: "shared"});
  const b = new ActorArena({actorId: 2, incarnation: 1, kind: "shared"});
  const twin = new ActorArena({actorId: 1, incarnation: 1, kind: "shared"});
  const ta = a.beginTurn();
  const tb = b.beginTurn();
  const tt = twin.beginTurn();
  const h = a.allocPersistent(ta, 4);
  a.write(ta, h, Uint8Array.from([1, 2, 3, 4]));
  assert.deepEqual([...a.read(ta, h)], [1, 2, 3, 4]);
  assert.throws(() => b.read(tb, h), /foreign or stale/);
  assert.throws(() => twin.read(tt, h), /foreign or stale/,
    "even matching actor and incarnation must not share an arena domain");
  assert.throws(() => a.read(tb, h), /turn authority/);
  const copy = a.read(ta, h);
  copy[0] = 99;
  assert.equal(a.read(ta, h)[0], 1);
  a.endTurn(ta);
  b.endTurn(tb);
  twin.endTurn(tt);
  const next = a.beginTurn();
  assert.equal(a.read(next, h)[0], 1);
  a.endTurn(next);
  a.retire();
  b.retire();
  twin.retire();
  assert.throws(() => a.beginTurn(), /retired/);
});

test("stolen, forged and sibling turn tokens cannot end an actor turn", () => {
  const owner = new ActorArena({actorId: 61, incarnation: 3});
  const sibling = new ActorArena({actorId: 62, incarnation: 3});
  const ownerTurn = owner.beginTurn();
  const siblingTurn = sibling.beginTurn();
  const handle = owner.allocPersistent(ownerTurn, 4);
  owner.write(ownerTurn, handle, Uint8Array.from([10, 20, 30, 40]));

  assert.throws(() => owner.endTurn(siblingTurn), /turn authority/);
  assert.throws(() => owner.endTurn(Object.freeze({})), /turn authority/);
  assert.throws(() => sibling.endTurn(ownerTurn), /turn authority/);
  assert.throws(() => owner.retire(), /active actor turn/);
  assert.deepEqual([...owner.read(ownerTurn, handle)], [10, 20, 30, 40],
    "foreign turn revocation must not clear live actor data");

  owner.endTurn(ownerTurn);
  assert.throws(() => owner.endTurn(ownerTurn), /turn authority/);
  const next = owner.beginTurn();
  assert.throws(() => owner.read(ownerTurn, handle), /turn authority/);
  assert.deepEqual([...owner.read(next, handle)], [10, 20, 30, 40]);
  owner.endTurn(next);
  sibling.endTurn(siblingTurn);
  owner.retire();
  sibling.retire();
});

test("poisoned Uint8Array instanceof cannot forge or deny byte-exact arena writes", () => {
  const arena = new ActorArena({actorId: 64, incarnation: 1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 8);
  const baseline = Uint8Array.of(11, 22, 33, 44, 55, 66, 77, 88);
  arena.write(turn, handle, baseline);
  const previous = Object.getOwnPropertyDescriptor(Uint8Array, Symbol.hasInstance);
  try {
    Object.defineProperty(Uint8Array, Symbol.hasInstance, {
      configurable: true, value() { return true; }
    });
    const forged = new Int16Array([256, 257, 258, 259]);
    Object.defineProperty(forged, Symbol.toStringTag, {
      configurable: true, value: "Uint8Array"
    });
    assert.throws(() => arena.write(turn, handle, forged), /exact-size Uint8Array/,
      "same byteLength does not make 16-bit element writes byte-safe");
    assert.deepEqual([...arena.read(turn, handle)], [...baseline],
      "forged write must not modify any actor-private bytes");
    Object.defineProperty(Uint8Array, Symbol.hasInstance, {
      configurable: true, value() { return false; }
    });
    arena.write(turn, handle, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
    assert.deepEqual([...arena.read(turn, handle)], [1, 2, 3, 4, 5, 6, 7, 8],
      "genuine bytes must still pass when instanceof is poisoned to false");
  } finally {
    if (previous) Object.defineProperty(Uint8Array, Symbol.hasInstance, previous);
    else delete Uint8Array[Symbol.hasInstance];
    arena.endTurn(turn);
    arena.retire();
  }
});

test("poisoned Object.freeze cannot steal opaque turn or memory handle", () => {
  // A hostile same-realm script can rewrite Object.freeze after this module
  // has loaded. Native ActorArena must capture the original intrinsic.
  const old = Object.getOwnPropertyDescriptor(Object, "freeze");
  const captured = [];
  let arena, turn;
  try {
    Object.defineProperty(Object, "freeze", {
      configurable: true, writable: true,
      value(value) { captured.push(value); return value; }
    });
    arena = new ActorArena({actorId: 63, incarnation: 3});
    turn = arena.beginTurn();
    const handle = arena.allocPersistent(turn, 4);
    assert.equal(captured.includes(turn), false, "turn permit leaked to forged freeze");
    assert.equal(captured.includes(handle), false, "opaque handle leaked to forged freeze");
    assert.equal(Object.isFrozen(turn), true);
    assert.equal(Object.isFrozen(handle), true);
    arena.write(turn, handle, Uint8Array.of(4, 3, 2, 1));
    assert.deepEqual([...arena.read(turn, handle)], [4, 3, 2, 1]);
  } finally {
    Object.defineProperty(Object, "freeze", old);
    if (arena && turn) {
      arena.endTurn(turn);
      arena.retire();
    }
  }
});

test("scratch invalidates and zeroes at each mailbox turn", () => {
  const arena = new ActorArena({actorId: 3, incarnation: 4});
  const turn = arena.beginTurn();
  const old = arena.allocScratch(turn, 8);
  arena.write(turn, old, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.throws(() => arena.beginTurn(), /already admitted/);
  assert.throws(() => arena.retire(), /active actor turn/);
  arena.endTurn(turn);
  const next = arena.beginTurn();
  assert.throws(() => arena.read(next, old), /foreign or stale/);
  const scratch = arena.allocScratch(next, 8);
  assert.deepEqual([...arena.read(next, scratch)], Array(8).fill(0));
  arena.endTurn(next);
  arena.retire();
  arena.retire();
});

test("bounded allocations and foreign incarnation reject closed handles", () => {
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new ActorArena({actorId: bad, incarnation: 1}), /invalid actor/);
  }
  const a = new ActorArena({actorId: 1, incarnation: 1});
  const t = a.beginTurn();
  assert.throws(() => a.allocPersistent(t, 0), /invalid arena/);
  assert.throws(() => a.allocPersistent(t, 65537), /invalid arena/);
  const h = a.allocPersistent(t, 65536);
  assert.throws(() => a.allocPersistent(t, 1), /quota exhausted/);
  assert.throws(() => a.write(t, h, new Uint8Array(1)), /exact-size/);
  a.endTurn(t);
  a.retire();
  const restarted = new ActorArena({actorId: 1, incarnation: 2});
  const tr = restarted.beginTurn();
  assert.throws(() => restarted.read(tr, h), /foreign or stale/);
  restarted.endTurn(tr);
  restarted.retire();
});

test('persistent drop reclaims memory without reviving stale handles', () => {
  const arena = new ActorArena({actorId: 31, incarnation: 1});
  const turn = arena.beginTurn();
  const first = arena.allocPersistent(turn, 65536);
  arena.write(turn, first, new Uint8Array(65536).fill(77));
  assert.throws(() => arena.allocPersistent(turn, 1), /quota exhausted/);
  arena.dropPersistent(turn, first);
  assert.throws(() => arena.read(turn, first), /foreign or stale/);
  assert.throws(() => arena.dropPersistent(turn, first), /foreign, stale/);
  const replacement = arena.allocPersistent(turn, 65536);
  assert.deepEqual([...arena.read(turn, replacement)].slice(0, 16), Array(16).fill(0));
  assert.throws(() => arena.dropPersistent(turn, arena.allocScratch(turn, 8)), /scratch arena handle/);
  arena.endTurn(turn);
  const next = arena.beginTurn();
  assert.equal(arena.read(next, replacement).length, 65536);
  arena.endTurn(next);
  arena.retire();
});

test("shared worker backing is rejected before it can tear an actor write", () => {
  const arena = new ActorArena({actorId: 34, incarnation: 1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  if (typeof SharedArrayBuffer !== "undefined") {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    shared.set([4, 3, 2, 1]);
    assert.throws(() => arena.write(turn, handle, shared), /shared backing/);
    assert.deepEqual([...arena.read(turn, handle)], [0, 0, 0, 0],
      "denied write must leave target bytes intact");
    // SAB created in another realm fails instanceof, even when a local typed
    // array views it. Its backing must still be rejected without side effects.
    const foreignShared = runInNewContext("new SharedArrayBuffer(4)");
    assert.equal(foreignShared instanceof SharedArrayBuffer, false);
    const localView = new Uint8Array(foreignShared);
    localView.set([8, 7, 6, 5]);
    assert.throws(() => arena.write(turn, handle, localView), /shared backing/);
    assert.deepEqual([...arena.read(turn, handle)], [0, 0, 0, 0]);
    Object.defineProperty(foreignShared, Symbol.toStringTag, {value: "ArrayBuffer"});
    assert.throws(() => arena.write(turn, handle, localView), /shared backing/,
      "overridden toStringTag must not bypass intrinsic shared-memory detection");
    const disguised = new Uint8Array(new SharedArrayBuffer(4));
    Object.defineProperty(disguised, "buffer", {value: new ArrayBuffer(4)});
    assert.throws(() => arena.write(turn, handle, disguised), /shared backing/,
      "shadowing .buffer must not hide a real shared backing store");
  }
  const short = Uint8Array.from([9, 8]);
  Object.defineProperty(short, "byteLength", {value: 4});
  assert.throws(() => arena.write(turn, handle, short), /exact-size/,
    "shadowing .byteLength must not permit a partial actor-memory write");
  assert.deepEqual([...arena.read(turn, handle)], [0, 0, 0, 0]);
  arena.write(turn, handle, Uint8Array.from([1, 2, 3, 4]));
  assert.deepEqual([...arena.read(turn, handle)], [1, 2, 3, 4]);
  arena.endTurn(turn);
  arena.retire();
});

test('many allocation/drop cycles reuse space and reject stale handles', () => {
  const arena = new ActorArena({actorId: 32, incarnation: 1});
  const turn = arena.beginTurn();
  let old;
  for (let i = 0; i < 12000; i++) {
    const handle = arena.allocPersistent(turn, (i % 31) + 1);
    const data = new Uint8Array((i % 31) + 1).fill(i % 251);
    arena.write(turn, handle, data);
    assert.deepEqual([...arena.read(turn, handle)], [...data]);
    if (old) assert.throws(() => arena.read(turn, old), /foreign or stale/);
    arena.dropPersistent(turn, handle);
    old = handle;
  }
  arena.endTurn(turn);
  arena.retire();
});

test('persistent and scratch handles have bounded metadata quotas', () => {
  const arena = new ActorArena({actorId: 33, incarnation: 1});
  const turn = arena.beginTurn();
  const handles = Array.from({length: 4096}, () => arena.allocPersistent(turn, 1));
  assert.throws(() => arena.allocPersistent(turn, 1), /handle quota exhausted/);
  arena.dropPersistent(turn, handles[0]);
  assert.equal(arena.read(turn, arena.allocPersistent(turn, 1))[0], 0);
  const scratch = Array.from({length: 4096}, () => arena.allocScratch(turn, 1));
  assert.throws(() => arena.allocScratch(turn, 1), /handle quota exhausted/);
  arena.endTurn(turn);
  const next = arena.beginTurn();
  assert.throws(() => arena.read(next, scratch[0]), /foreign or stale/);
  arena.endTurn(next);
  arena.retire();
});

test("arena ownership survives poisoned Uint8Array methods", () => {
  const arena = new ActorArena({actorId: 35, incarnation: 1});
  const turn = arena.beginTurn();
  const saved = new Map(["slice", "set", "fill"].map(name =>
    [name, Object.getOwnPropertyDescriptor(Uint8Array.prototype, name)]));
  const savedMemoryBuffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, "buffer");
  try {
    const persistent = arena.allocPersistent(turn, 4);
    const scratch = arena.allocScratch(turn, 4);
    arena.write(turn, persistent, Uint8Array.of(1, 2, 3, 4));
    arena.write(turn, scratch, Uint8Array.of(5, 6, 7, 8));
    // Simulate a same-realm dependency poisoning the mutable prototypes.
    // A naive .slice leaks an alias, .set loses writes, and .fill skips scrub.
    Object.defineProperty(Uint8Array.prototype, "slice", {
      configurable: true, writable: true, value: Uint8Array.prototype.subarray
    });
    Object.defineProperty(Uint8Array.prototype, "set", {
      configurable: true, writable: true, value() {}
    });
    Object.defineProperty(Uint8Array.prototype, "fill", {
      configurable: true, writable: true, value() { return this; }
    });
    // The memory.buffer getter can also be redefined. All arena operations
    // must continue using the original, truly private WebAssembly.Memory.
    const redirect = new ArrayBuffer(2 * 65536);
    Object.defineProperty(WebAssembly.Memory.prototype, "buffer", {
      configurable: true, get() { return redirect; }
    });
    const independent = arena.read(turn, persistent);
    independent[0] = 99;
    assert.deepEqual([...arena.read(turn, persistent)], [1, 2, 3, 4],
      "a poisoned slice must never expose a mutable private region alias");
    arena.write(turn, persistent, Uint8Array.of(9, 8, 7, 6));
    assert.deepEqual([...arena.read(turn, persistent)], [9, 8, 7, 6],
      "a poisoned set must not silently suppress actor writes");
    assert.equal(new Uint8Array(redirect)[0], 0,
      "a poisoned Memory.buffer getter must not redirect private actor bytes");
    arena.dropPersistent(turn, persistent);
    const recycled = arena.allocPersistent(turn, 4);
    assert.deepEqual([...arena.read(turn, recycled)], [0, 0, 0, 0],
      "a poisoned fill must not preserve private bytes on reuse");
    arena.endTurn(turn);
    const next = arena.beginTurn();
    const nextScratch = arena.allocScratch(next, 4);
    assert.deepEqual([...arena.read(next, nextScratch)], [0, 0, 0, 0],
      "scratch must be zero after turn exit despite poisoned fill");
    arena.endTurn(next);
    arena.retire();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(Uint8Array.prototype, name, descriptor);
      else delete Uint8Array.prototype[name];
    }
    Object.defineProperty(WebAssembly.Memory.prototype, "buffer", savedMemoryBuffer);
  }
});

test("read never gives Symbol.species a private actor backing buffer", () => {
  const arena = new ActorArena({actorId: 36, incarnation: 1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  arena.write(turn, handle, Uint8Array.of(1, 2, 3, 4));
  const original = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "constructor");
  let leakedBuffer = null;
  try {
    // Built-in TypedArray.subarray passes its source buffer to the species
    // constructor. The current actor read path must not invoke it at all.
    Object.defineProperty(Uint8Array.prototype, "constructor", {
      configurable: true, writable: true,
      value: {
        [Symbol.species]: function stealPrivateBuffer(buffer, offset, length) {
          leakedBuffer = buffer;
          return new Uint8Array(buffer, offset, length);
        }
      }
    });
    const copy = arena.read(turn, handle);
    assert.deepEqual([...copy], [1, 2, 3, 4]);
    assert.equal(leakedBuffer, null, "the private WebAssembly.Memory buffer must never escape");
    copy[0] = 99;
    assert.deepEqual([...arena.read(turn, handle)], [1, 2, 3, 4]);
  } finally {
    if (original) Object.defineProperty(Uint8Array.prototype, "constructor", original);
    else delete Uint8Array.prototype.constructor;
  }
  arena.endTurn(turn);
  arena.retire();
});

test("WeakMap prototype mutation cannot forge or revive actor handles", () => {
  const arena = new ActorArena({actorId: 39, incarnation: 1});
  const turn = arena.beginTurn();
  const original = arena.allocPersistent(turn, 4);
  arena.write(turn, original, Uint8Array.of(6, 7, 8, 9));
  const forged = Object.freeze({});
  const methods = new Map(["get", "delete", "set"].map(name =>
    [name, Object.getOwnPropertyDescriptor(WeakMap.prototype, name)]));
  const nativeGet = methods.get("get").value;
  try {
    Object.defineProperty(WeakMap.prototype, "get", {
      configurable: true, writable: true,
      value(handle) {
        if (handle === forged) return {offset: 0, length: 4};
        return nativeGet.call(this, handle);
      }
    });
    assert.throws(() => arena.read(turn, forged), /foreign or stale/,
      "a fake WeakMap.get entry must not grant actor memory read authority");
    Object.defineProperty(WeakMap.prototype, "delete", {
      configurable: true, writable: true, value() { return true; }
    });
    arena.dropPersistent(turn, original);
    const recycled = arena.allocPersistent(turn, 4);
    arena.write(turn, recycled, Uint8Array.of(1, 2, 3, 4));
    assert.throws(() => arena.read(turn, original), /foreign or stale/,
      "a no-op WeakMap.delete must not restore stale handle authority");
    Object.defineProperty(WeakMap.prototype, "set", {
      configurable: true, writable: true, value() { return this; }
    });
    const scratch = arena.allocScratch(turn, 4);
    arena.write(turn, scratch, Uint8Array.of(5, 5, 5, 5));
    assert.deepEqual([...arena.read(turn, scratch)], [5, 5, 5, 5],
      "new allocations must use native WeakMap.set even when poisoned");
    assert.deepEqual([...arena.read(turn, recycled)], [1, 2, 3, 4]);
    arena.endTurn(turn);
    arena.retire();
  } finally {
    for (const [name, descriptor] of methods) {
      Object.defineProperty(WeakMap.prototype, name, descriptor);
    }
  }
});

test("allocator metadata stays private when Array prototype methods are poisoned", () => {
  const arena = new ActorArena({actorId: 40, incarnation: 1});
  const turn = arena.beginTurn();
  const live = arena.allocPersistent(turn, 4);
  const freed = arena.allocPersistent(turn, 65532);
  arena.write(turn, live, Uint8Array.of(9, 8, 7, 6));
  const methods = new Map(["push", "sort", "findIndex", "splice"].map(name =>
    [name, Object.getOwnPropertyDescriptor(Array.prototype, name)]));
  const originalPush = methods.get("push").value;
  let stolenMetadata = null;
  try {
    Object.defineProperty(Array.prototype, "push", {
      configurable: true, writable: true,
      value(...items) {
        if (items.some(item => item && typeof item === "object" &&
            Object.hasOwn(item, "offset") && Object.hasOwn(item, "length"))) {
          stolenMetadata = this;
        }
        return originalPush.apply(this, items);
      }
    });
    Object.defineProperty(Array.prototype, "sort", {
      configurable: true, writable: true, value() { return this; }
    });
    Object.defineProperty(Array.prototype, "findIndex", {
      configurable: true, writable: true, value() { return -1; }
    });
    Object.defineProperty(Array.prototype, "splice", {
      configurable: true, writable: true, value() { return []; }
    });
    arena.dropPersistent(turn, freed);
    assert.equal(stolenMetadata, null, "no private free-list may enter a prototype hook");
    const reused = arena.allocPersistent(turn, 65532);
    assert.deepEqual([...arena.read(turn, live)], [9, 8, 7, 6],
      "free-list poisoning must not overlap or clear a live allocation");
    arena.dropPersistent(turn, reused);
    assert.deepEqual([...arena.read(turn, live)], [9, 8, 7, 6]);
  } finally {
    for (const [name, descriptor] of methods) {
      Object.defineProperty(Array.prototype, name, descriptor);
    }
  }
  arena.endTurn(turn);
  arena.retire();
});

test("actor admission and quotas ignore poisoned Number and Set methods", () => {
  const originalInteger = Object.getOwnPropertyDescriptor(Number, "isSafeInteger");
  const originalSetHas = Object.getOwnPropertyDescriptor(Set.prototype, "has");
  const arena = new ActorArena({actorId: 41, incarnation: 1});
  const turn = arena.beginTurn();
  try {
    Object.defineProperty(Number, "isSafeInteger", {
      configurable: true, writable: true, value() { return true; }
    });
    Object.defineProperty(Set.prototype, "has", {
      configurable: true, writable: true, value() { return true; }
    });
    assert.throws(() => new ActorArena({actorId: Number.NaN, incarnation: 1}),
      /invalid actor/, "tampered Number.isSafeInteger must not admit NaN actor IDs");
    assert.throws(() => new ActorArena({actorId: 1, incarnation: 1, kind: "forged"}),
      /invalid actor/, "tampered Set.has must not admit unsupported actor kinds");
    assert.throws(() => arena.allocPersistent(turn, Number.NaN),
      /invalid arena/, "tampered integer check must not corrupt allocation frontier");
    assert.throws(() => arena.allocPersistent(turn, Number.MAX_SAFE_INTEGER + 1),
      /invalid arena/);
    const genuine = arena.allocPersistent(turn, 4);
    arena.write(turn, genuine, Uint8Array.of(4, 3, 2, 1));
    assert.deepEqual([...arena.read(turn, genuine)], [4, 3, 2, 1]);
  } finally {
    Object.defineProperty(Number, "isSafeInteger", originalInteger);
    Object.defineProperty(Set.prototype, "has", originalSetHas);
  }
  arena.endTurn(turn);
  arena.retire();
});


test("retirement returns zeroed pages to the runtime pool without JS GC", () => {
  const before = actorArenaPoolStats();
  const first = new ActorArena({actorId: 70, incarnation: 1, kind: "private"});
  const afterLease = actorArenaPoolStats();
  assert.equal(afterLease.leasedArenas, before.leasedArenas + 1);

  const turn = first.beginTurn();
  const persistent = first.allocPersistent(turn, 8);
  const scratch = first.allocScratch(turn, 8);
  first.write(turn, persistent, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
  first.write(turn, scratch, Uint8Array.of(8, 7, 6, 5, 4, 3, 2, 1));
  first.endTurn(turn);
  first.retire();

  const retired = actorArenaPoolStats();
  assert.equal(retired.leasedArenas, before.leasedArenas);
  assert.equal(retired.freeArenas, afterLease.freeArenas + 1,
    "retirement must synchronously publish reusable arena capacity");

  // Creating another actor consumes a free arena lease without growing the
  // underlying WebAssembly.Memory. This is explicit reuse, not GC evidence.
  const second = new ActorArena({actorId: 71, incarnation: 1, kind: "untrusted"});
  const reused = actorArenaPoolStats();
  assert.equal(reused.committedPages, retired.committedPages,
    "reusing a retired arena must not require new Wasm pages");
  assert.equal(reused.freeArenas, retired.freeArenas - 1);
  assert.equal(reused.leasedArenas, before.leasedArenas + 1);

  const next = second.beginTurn();
  const nextPersistent = second.allocPersistent(next, 8);
  const nextScratch = second.allocScratch(next, 8);
  assert.deepEqual([...second.read(next, nextPersistent)], Array(8).fill(0),
    "recycled persistent bytes must be scrubbed");
  assert.deepEqual([...second.read(next, nextScratch)], Array(8).fill(0),
    "recycled scratch bytes must be scrubbed");
  second.endTurn(next);
  second.retire();

  const after = actorArenaPoolStats();
  assert.equal(after.leasedArenas, before.leasedArenas);
  assert.equal(after.freeArenas, retired.freeArenas,
    "second retirement must return exactly the reusable arena lease it consumed");
  assert.equal(after.committedPages, reused.committedPages,
    "retirement must not grow the runtime pool");
});


test("persistent free-list coalescing ignores poisoned Array iterator", () => {
  const arena = new ActorArena({actorId: 72, incarnation: 1});
  const turn = arena.beginTurn();
  const first = arena.allocPersistent(turn, 4);
  const second = arena.allocPersistent(turn, 4);
  const original = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  let observed = false;
  try {
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true,
      writable: true,
      value() {
        observed = true;
        throw new Error("poisoned iterator reached private metadata");
      }
    });
    arena.dropPersistent(turn, first);
    arena.dropPersistent(turn, second);
    assert.equal(observed, false,
      "private arena free-list metadata must not enter user Array iteration hooks");
    const recycled = arena.allocPersistent(turn, 8);
    assert.deepEqual([...arena.read(turn, recycled)], Array(8).fill(0));
  } finally {
    Object.defineProperty(Array.prototype, Symbol.iterator, original);
    arena.endTurn(turn);
    arena.retire();
  }
});
import test from "node:test";
import assert from "node:assert/strict";
import {runInNewContext} from "node:vm";
import {ActorArena} from "../src/actor-arena.mjs";

test("shared actors get private arenas, not transferable heap handles", () => {
  const a = new ActorArena({actorId: 1, incarnation: 1, kind: "shared"});
  const b = new ActorArena({actorId: 2, incarnation: 1, kind: "shared"});
  const ta = a.beginTurn();
  const tb = b.beginTurn();
  const h = a.allocPersistent(ta, 4);
  a.write(ta, h, Uint8Array.from([1, 2, 3, 4]));
  assert.deepEqual([...a.read(ta, h)], [1, 2, 3, 4]);
  assert.throws(() => b.read(tb, h), /foreign or stale/);
  assert.throws(() => a.read(tb, h), /turn authority/);
  const copy = a.read(ta, h);
  copy[0] = 99;
  assert.equal(a.read(ta, h)[0], 1);
  a.endTurn(ta);
  b.endTurn(tb);
  const next = a.beginTurn();
  assert.equal(a.read(next, h)[0], 1);
  a.endTurn(next);
  a.retire();
  b.retire();
  assert.throws(() => a.beginTurn(), /retired/);
});

test("scratch invalidates and zeroes at each mailbox turn", () => {
  const arena = new ActorArena({actorId: 3, incarnation: 4});
  const turn = arena.beginTurn();
  const old = arena.allocScratch(turn, 8);
  arena.write(turn, old, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.throws(() => arena.beginTurn(), /already admitted/);
  assert.throws(() => arena.retire(), /active actor turn/);
  arena.endTurn(turn);
  const next = arena.beginTurn();
  assert.throws(() => arena.read(next, old), /foreign or stale/);
  const scratch = arena.allocScratch(next, 8);
  assert.deepEqual([...arena.read(next, scratch)], Array(8).fill(0));
  arena.endTurn(next);
  arena.retire();
  arena.retire();
});

test("bounded allocations and foreign incarnation reject closed handles", () => {
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new ActorArena({actorId: bad, incarnation: 1}), /invalid actor/);
  }
  const a = new ActorArena({actorId: 1, incarnation: 1});
  const t = a.beginTurn();
  assert.throws(() => a.allocPersistent(t, 0), /invalid arena/);
  assert.throws(() => a.allocPersistent(t, 65537), /invalid arena/);
  const h = a.allocPersistent(t, 65536);
  assert.throws(() => a.allocPersistent(t, 1), /quota exhausted/);
  assert.throws(() => a.write(t, h, new Uint8Array(1)), /exact-size/);
  a.endTurn(t);
  a.retire();
  const restarted = new ActorArena({actorId: 1, incarnation: 2});
  const tr = restarted.beginTurn();
  assert.throws(() => restarted.read(tr, h), /foreign or stale/);
  restarted.endTurn(tr);
  restarted.retire();
});

test('persistent drop reclaims memory without reviving stale handles', () => {
  const arena = new ActorArena({actorId: 31, incarnation: 1});
  const turn = arena.beginTurn();
  const first = arena.allocPersistent(turn, 65536);
  arena.write(turn, first, new Uint8Array(65536).fill(77));
  assert.throws(() => arena.allocPersistent(turn, 1), /quota exhausted/);
  arena.dropPersistent(turn, first);
  assert.throws(() => arena.read(turn, first), /foreign or stale/);
  assert.throws(() => arena.dropPersistent(turn, first), /foreign, stale/);
  const replacement = arena.allocPersistent(turn, 65536);
  assert.deepEqual([...arena.read(turn, replacement)].slice(0, 16), Array(16).fill(0));
  assert.throws(() => arena.dropPersistent(turn, arena.allocScratch(turn, 8)), /scratch arena handle/);
  arena.endTurn(turn);
  const next = arena.beginTurn();
  assert.equal(arena.read(next, replacement).length, 65536);
  arena.endTurn(next);
  arena.retire();
});

test("actor arena input is a genuine cross-realm Uint8Array, not a mutable global check", () => {
  const arena = new ActorArena({actorId: 61, incarnation: 1, kind: "shared"});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  const crossRealmBytes = runInNewContext("new Uint8Array([5, 6, 7, 8])");
  assert.equal(crossRealmBytes instanceof Uint8Array, false);
  arena.write(turn, handle, crossRealmBytes);
  assert.deepEqual([...arena.read(turn, handle)], [5, 6, 7, 8]);

  const originalUint8Array = globalThis.Uint8Array;
  const fake = {[Symbol.toStringTag]: "Uint8Array", length: 4};
  try {
    globalThis.Uint8Array = class ForgedUint8Array {
      static [Symbol.hasInstance]() { return true; }
    };
    assert.throws(() => arena.write(turn, handle, fake), /exact-size Uint8Array/);
    assert.throws(() => arena.write(turn, handle, new Int8Array(4)),
      /exact-size Uint8Array/);
    assert.deepEqual([...arena.read(turn, handle)], [5, 6, 7, 8]);
  } finally {
    globalThis.Uint8Array = originalUint8Array;
    arena.endTurn(turn);
    arena.retire();
  }
});

test("actor arena trust checks ignore post-import Set.has and Number.isSafeInteger tampering", () => {
  const oldSafeInteger = Number.isSafeInteger;
  const oldHas = Set.prototype.has;
  let invalid = null;
  try {
    Number.isSafeInteger = () => true;
    Set.prototype.has = () => true;
    assert.throws(() => new ActorArena({
      actorId: -1, incarnation: 1, kind: "shared"}), /invalid actor/);
    assert.throws(() => new ActorArena({
      actorId: 1, incarnation: 1, kind: "invented"}), /invalid actor/);
    const a = new ActorArena({actorId: 62, incarnation: 1});
    const turn = a.beginTurn();
    assert.throws(() => a.allocScratch(turn, -1), /invalid arena allocation length/);
    assert.throws(() => a.allocPersistent(turn, 1.5), /invalid arena allocation length/);
    a.endTurn(turn);
    a.retire();
  } finally {
    Number.isSafeInteger = oldSafeInteger;
    Set.prototype.has = oldHas;
  }
});

test("mutated typed-array prototypes cannot leak, alter, or prevent arena zeroization", () => {
  const arena = new ActorArena({actorId: 35, incarnation: 1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  arena.write(turn, handle, Uint8Array.from([1, 2, 3, 4]));
  const methods = ["slice", "set", "fill"];
  const previous = methods.map(name =>
    Object.getOwnPropertyDescriptor(Uint8Array.prototype, name));
  const memoryBuffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, "buffer");
  try {
    // The vulnerable implementation used each of these replaceable methods
    // on a live Uint8Array over private actor memory.
    for (const name of methods) {
      Object.defineProperty(Uint8Array.prototype, name, {
        configurable: true, writable: true,
        value: name === "slice"
          ? function () { return this; }
          : function () { throw new Error("hijacked " + name); }
      });
    }
    if (memoryBuffer.configurable) {
      Object.defineProperty(WebAssembly.Memory.prototype, "buffer", {
        configurable: true,
        get() { throw new Error("hijacked WebAssembly.Memory.buffer"); }
      });
    }
    const snapshot = arena.read(turn, handle);
    snapshot[0] = 99;
    assert.deepEqual([...arena.read(turn, handle)], [1, 2, 3, 4],
      "read must return an owned copy, not an arena-backed live view");
    arena.write(turn, handle, Uint8Array.from([9, 8, 7, 6]));
    assert.deepEqual([...arena.read(turn, handle)], [9, 8, 7, 6]);
    arena.dropPersistent(turn, handle);
    const recycled = arena.allocPersistent(turn, 4);
    assert.deepEqual([...arena.read(turn, recycled)], [0, 0, 0, 0],
      "recycled persistent allocations must be zero even if fill is patched");
    const scratch = arena.allocScratch(turn, 4);
    arena.write(turn, scratch, Uint8Array.from([5, 4, 3, 2]));
    arena.endTurn(turn);
    const next = arena.beginTurn();
    assert.throws(() => arena.read(next, scratch), /foreign or stale/);
    const freshScratch = arena.allocScratch(next, 4);
    assert.deepEqual([...arena.read(next, freshScratch)], [0, 0, 0, 0]);
    arena.endTurn(next);
    arena.retire();
  } finally {
    for (let i = 0; i < methods.length; ++i) {
      if (previous[i]) Object.defineProperty(Uint8Array.prototype, methods[i], previous[i]);
      else delete Uint8Array.prototype[methods[i]];
    }
    Object.defineProperty(WebAssembly.Memory.prototype, "buffer", memoryBuffer);
    if (!arena.retired) {
      try { arena.endTurn(turn); } catch {}
      try { arena.retire(); } catch {}
    }
  }
});

test("tampered Array.findIndex cannot allocate over another actor-owned handle", () => {
  const arena = new ActorArena({actorId: 47, incarnation: 1});
  const turn = arena.beginTurn();
  const released = arena.allocPersistent(turn, 8);
  const retained = arena.allocPersistent(turn, 8);
  arena.write(turn, retained, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
  arena.dropPersistent(turn, released); // Free segment is only eight bytes.
  const original = Object.getOwnPropertyDescriptor(Array.prototype, "findIndex");
  let larger;
  try {
    Object.defineProperty(Array.prototype, "findIndex", {
      configurable: true, writable: true, value() { return 0; }
    });
    larger = arena.allocPersistent(turn, 12);
    arena.write(turn, larger, new Uint8Array(12).fill(99));
  } finally {
    Object.defineProperty(Array.prototype, "findIndex", original);
  }
  assert.deepEqual([...arena.read(turn, retained)], [1, 2, 3, 4, 5, 6, 7, 8],
    "an undersized free segment must never overlap live actor memory");
  arena.dropPersistent(turn, larger);
  arena.endTurn(turn);
  arena.retire();
});

test("tampered Array push/sort/splice cannot corrupt arena free-list recycling", () => {
  const arena = new ActorArena({actorId: 48, incarnation: 1});
  const turn = arena.beginTurn();
  const released = arena.allocPersistent(turn, 8);
  const methods = ["push", "sort", "splice"];
  const originals = methods.map(name => Object.getOwnPropertyDescriptor(Array.prototype, name));
  let replacement;
  try {
    for (const name of methods) Object.defineProperty(Array.prototype, name, {
      configurable: true, writable: true,
      value() { throw new Error("hijacked Array." + name); }
    });
    arena.dropPersistent(turn, released);
    replacement = arena.allocPersistent(turn, 8);
  } finally {
    methods.forEach((name, i) =>
      Object.defineProperty(Array.prototype, name, originals[i]));
  }
  assert.deepEqual([...arena.read(turn, replacement)], Array(8).fill(0));
  arena.dropPersistent(turn, replacement);
  arena.endTurn(turn);
  arena.retire();
});

test("poisoned Array iterator cannot inject forged live-overlapping free segments", () => {
  const arena = new ActorArena({actorId: 49, incarnation: 1});
  const turn = arena.beginTurn();
  const released = arena.allocPersistent(turn, 8);
  const retained = arena.allocPersistent(turn, 8);
  const retainedBytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  arena.write(turn, retained, retainedBytes);

  // The original coalescing loop used for...of on #freePersistent. Since
  // Symbol.iterator is ambient mutable prototype state, hostile guest JS
  // could replace the *entire* free-list with a segment covering retained.
  const original = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  let intercepted = 0;
  try {
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true, writable: true,
      value: function* () {
        ++intercepted;
        yield {offset: 8, length: 65528};
      }
    });
    arena.dropPersistent(turn, released);
  } finally {
    Object.defineProperty(Array.prototype, Symbol.iterator, original);
  }

  assert.equal(intercepted, 0,
    "arena free-list coalescing must not invoke untrusted array iterators");
  const recycled = arena.allocPersistent(turn, 8);
  assert.deepEqual([...arena.read(turn, recycled)], Array(8).fill(0));
  arena.write(turn, recycled, Uint8Array.from([99, 98, 97, 96, 95, 94, 93, 92]));
  assert.deepEqual([...arena.read(turn, retained)], [...retainedBytes],
    "recycled free bytes must not overlap a live actor allocation");
  arena.endTurn(turn);
  arena.retire();
});

test("mutated Object.freeze cannot capture actor turn or opaque handle authority", () => {
  const previous = Object.getOwnPropertyDescriptor(Object, "freeze");
  const intercepted = [];
  try {
    Object.defineProperty(Object, "freeze", {
      configurable: true, writable: true,
      value(value) { intercepted.push(value); return value; }
    });
    const arena = new ActorArena({actorId: 46, incarnation: 1});
    const turn = arena.beginTurn();
    const handle = arena.allocPersistent(turn, 4);
    assert.equal(Object.isFrozen(turn), true);
    assert.equal(Object.isFrozen(handle), true);
    assert.equal(intercepted.includes(turn), false,
      "untrusted monkey patch must never observe an actor turn permit");
    assert.equal(intercepted.includes(handle), false,
      "untrusted monkey patch must never observe a persistent memory handle");
    arena.write(turn, handle, Uint8Array.from([2, 7, 1, 8]));
    assert.deepEqual([...arena.read(turn, handle)], [2, 7, 1, 8]);
    arena.endTurn(turn);
    arena.retire();
  } finally {
    Object.defineProperty(Object, "freeze", previous);
  }
});

test("replaced global WebAssembly.Memory constructor cannot coalesce actor heaps", () => {
  const NativeMemory = WebAssembly.Memory;
  const reused = new NativeMemory({initial: 2, maximum: 2});
  const original = Object.getOwnPropertyDescriptor(WebAssembly, "Memory");
  try {
    Object.defineProperty(WebAssembly, "Memory", {
      configurable: true, writable: true,
      value: function () { return reused; }
    });
    const a = new ActorArena({actorId: 41, incarnation: 1});
    const b = new ActorArena({actorId: 42, incarnation: 1});
    const ta = a.beginTurn(), tb = b.beginTurn();
    const ha = a.allocPersistent(ta, 4);
    a.write(ta, ha, Uint8Array.from([1, 2, 3, 4]));
    const hb = b.allocPersistent(tb, 4);
    b.write(tb, hb, Uint8Array.from([9, 8, 7, 6]));
    assert.deepEqual([...a.read(ta, ha)], [1, 2, 3, 4],
      "an attacker-controlled constructor must not force actors to share backing memory");
    assert.deepEqual([...b.read(tb, hb)], [9, 8, 7, 6]);
    a.endTurn(ta);
    b.endTurn(tb);
    a.retire();
    b.retire();
  } finally {
    Object.defineProperty(WebAssembly, "Memory", original);
  }
});

test("replaced WeakMap constructor cannot forge cross-actor arena handles", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "WeakMap");
  const shared = new WeakMap();
  try {
    Object.defineProperty(globalThis, "WeakMap", {
      configurable: true, writable: true,
      value: function () { return shared; }
    });
    const a = new ActorArena({actorId: 43, incarnation: 1});
    const b = new ActorArena({actorId: 44, incarnation: 1});
    const ta = a.beginTurn(), tb = b.beginTurn();
    const ha = a.allocPersistent(ta, 4);
    b.allocPersistent(tb, 4);
    assert.throws(() => b.read(tb, ha), /foreign or stale/,
      "an attacker-controlled global WeakMap must not combine actors' handle maps");
    a.endTurn(ta);
    b.endTurn(tb);
    a.retire();
    b.retire();
  } finally {
    Object.defineProperty(globalThis, "WeakMap", original);
  }
});

test("replaced WeakMap prototype accessors cannot forge arena metadata", () => {
  const arena = new ActorArena({actorId: 45, incarnation: 1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  const names = ["get", "set", "delete"];
  const descriptors = names.map(name => Object.getOwnPropertyDescriptor(WeakMap.prototype, name));
  try {
    for (const name of names) Object.defineProperty(WeakMap.prototype, name, {
      configurable: true, writable: true,
      value() { throw new Error("hijacked WeakMap." + name); }
    });
    arena.write(turn, handle, Uint8Array.from([3, 1, 4, 1]));
    assert.deepEqual([...arena.read(turn, handle)], [3, 1, 4, 1]);
    arena.dropPersistent(turn, handle);
    const recycled = arena.allocPersistent(turn, 4);
    assert.deepEqual([...arena.read(turn, recycled)], [0, 0, 0, 0]);
  } finally {
    names.forEach((name, i) => Object.defineProperty(WeakMap.prototype, name, descriptors[i]));
    arena.endTurn(turn);
    arena.retire();
  }
});

test("shared worker backing is rejected before it can tear an actor write", () => {
  const arena = new ActorArena({actorId: 34, incarnation: 1});
  const turn = arena.beginTurn();
  const handle = arena.allocPersistent(turn, 4);
  if (typeof SharedArrayBuffer !== "undefined") {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    shared.set([4, 3, 2, 1]);
    assert.throws(() => arena.write(turn, handle, shared), /shared backing/);
    assert.deepEqual([...arena.read(turn, handle)], [0, 0, 0, 0],
      "denied write must leave target bytes intact");
    // SAB created in another realm fails instanceof, even when a local typed
    // array views it. Its backing must still be rejected without side effects.
    const foreignShared = runInNewContext("new SharedArrayBuffer(4)");
    assert.equal(foreignShared instanceof SharedArrayBuffer, false);
    const localView = new Uint8Array(foreignShared);
    localView.set([8, 7, 6, 5]);
    assert.throws(() => arena.write(turn, handle, localView), /shared backing/);
    assert.deepEqual([...arena.read(turn, handle)], [0, 0, 0, 0]);
    Object.defineProperty(foreignShared, Symbol.toStringTag, {value: "ArrayBuffer"});
    assert.throws(() => arena.write(turn, handle, localView), /shared backing/,
      "overridden toStringTag must not bypass intrinsic shared-memory detection");
    const disguised = new Uint8Array(new SharedArrayBuffer(4));
    Object.defineProperty(disguised, "buffer", {value: new ArrayBuffer(4)});
    assert.throws(() => arena.write(turn, handle, disguised), /shared backing/,
      "shadowing .buffer must not hide a real shared backing store");
  }
  const short = Uint8Array.from([9, 8]);
  Object.defineProperty(short, "byteLength", {value: 4});
  assert.throws(() => arena.write(turn, handle, short), /exact-size/,
    "shadowing .byteLength must not permit a partial actor-memory write");
  assert.deepEqual([...arena.read(turn, handle)], [0, 0, 0, 0]);
  arena.write(turn, handle, Uint8Array.from([1, 2, 3, 4]));
  assert.deepEqual([...arena.read(turn, handle)], [1, 2, 3, 4]);
  arena.endTurn(turn);
  arena.retire();
});

test("interleaved persistent allocations never overlap or revive stale handles", () => {
  const arena = new ActorArena({actorId: 49, incarnation: 1});
  const turn = arena.beginTurn();
  let seed = 0x12345678;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const live = [], stale = [];
  for (let i = 0; i < 5000; ++i) {
    if (live.length >= 28 || (live.length > 0 && random() % 3 === 0)) {
      const [item] = live.splice(random() % live.length, 1);
      arena.dropPersistent(turn, item.handle);
      stale.push(item.handle);
    } else {
      const length = 1 + random() % 64;
      const handle = arena.allocPersistent(turn, length);
      const data = new Uint8Array(length).fill(random() % 251);
      assert.deepEqual([...arena.read(turn, handle)], Array(length).fill(0));
      arena.write(turn, handle, data);
      live.push({handle, data});
    }
    if (i % 64 === 0) {
      for (const item of live) {
        assert.deepEqual([...arena.read(turn, item.handle)], [...item.data]);
      }
      if (stale.length) {
        assert.throws(() => arena.read(turn, stale[stale.length - 1]), /foreign or stale/);
      }
    }
  }
  for (const item of live) {
    assert.deepEqual([...arena.read(turn, item.handle)], [...item.data]);
    arena.dropPersistent(turn, item.handle);
  }
  arena.endTurn(turn);
  arena.retire();
});

test('many allocation/drop cycles reuse space and reject stale handles', () => {
  const arena = new ActorArena({actorId: 32, incarnation: 1});
  const turn = arena.beginTurn();
  let old;
  for (let i = 0; i < 12000; i++) {
    const handle = arena.allocPersistent(turn, (i % 31) + 1);
    const data = new Uint8Array((i % 31) + 1).fill(i % 251);
    arena.write(turn, handle, data);
    assert.deepEqual([...arena.read(turn, handle)], [...data]);
    if (old) assert.throws(() => arena.read(turn, old), /foreign or stale/);
    arena.dropPersistent(turn, handle);
    old = handle;
  }
  arena.endTurn(turn);
  arena.retire();
});

test('persistent and scratch handles have bounded metadata quotas', () => {
  const arena = new ActorArena({actorId: 33, incarnation: 1});
  const turn = arena.beginTurn();
  const handles = Array.from({length: 4096}, () => arena.allocPersistent(turn, 1));
  assert.throws(() => arena.allocPersistent(turn, 1), /handle quota exhausted/);
  arena.dropPersistent(turn, handles[0]);
  assert.equal(arena.read(turn, arena.allocPersistent(turn, 1))[0], 0);
  const scratch = Array.from({length: 4096}, () => arena.allocScratch(turn, 1));
  assert.throws(() => arena.allocScratch(turn, 1), /handle quota exhausted/);
  arena.endTurn(turn);
  const next = arena.beginTurn();
  assert.throws(() => arena.read(next, scratch[0]), /foreign or stale/);
  arena.endTurn(next);
  arena.retire();
});
