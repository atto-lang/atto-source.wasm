import test from "node:test";
import assert from "node:assert/strict";
import {runInNewContext} from "node:vm";
import {ActorArena} from "../src/actor-arena.mjs";

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
