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
