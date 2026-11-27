import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena} from "../src/actor-arena.mjs";

test("actor heap and frame reads ignore poisoned TypedArray species constructor", () => {
  const a = new ActorArena({actorId: 933, incarnation: 1});
  const turn = a.beginTurn(), e = a.startStack(turn);
  const h = a.allocPersistent(turn, 4), f = a.pushStackFrame(turn, e, 4);
  a.write(turn, h, Uint8Array.of(1, 2, 3, 4));
  a.writeStackFrame(turn, e, f, Uint8Array.of(4, 3, 2, 1));
  const original = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "constructor");
  let heapCopy, frameCopy;
  try {
    Object.defineProperty(Uint8Array.prototype, "constructor", {
      configurable: true, get() { throw new Error("mutated species getter"); }
    });
    heapCopy = a.read(turn, h);
    frameCopy = a.readStackFrame(turn, e, f);
  } finally {
    if (original) Object.defineProperty(Uint8Array.prototype, "constructor", original);
    else delete Uint8Array.prototype.constructor;
  }
  assert.deepEqual([...heapCopy], [1, 2, 3, 4]);
  assert.deepEqual([...frameCopy], [4, 3, 2, 1]);
  heapCopy.fill(99); frameCopy.fill(99);
  assert.equal(a.read(turn, h)[0], 1);
  assert.equal(a.readStackFrame(turn, e, f)[0], 4);
  a.popStackFrame(turn, e, f); a.finishStack(turn, e);
  a.endTurn(turn); a.retire();
});

test("persistent allocation and free-list coalescing bypass mutated Array methods", () => {
  const a = new ActorArena({actorId: 934, incarnation: 1});
  const t = a.beginTurn();
  const first = a.allocPersistent(t, 5), neighbor = a.allocPersistent(t, 5);
  a.write(t, neighbor, Uint8Array.from([6, 6, 6, 6, 6]));
  a.dropPersistent(t, first);
  const original = {};
  for (const key of ["findIndex", "push", "sort", "splice"]) {
    original[key] = Array.prototype[key];
  }
  const oldMinusOne = Object.getOwnPropertyDescriptor(Array.prototype, "-1");
  let reused;
  try {
    for (const key of ["findIndex", "push", "sort", "splice"]) {
      Array.prototype[key] = () => { throw Error("mutable Array primitive: " + key); };
    }
    Object.defineProperty(Array.prototype, "-1", {
      configurable: true, get() { throw Error("inherited -1 entry"); }
    });
    reused = a.allocPersistent(t, 5);
    a.write(t, reused, Uint8Array.of(1, 2, 3, 4, 5));
    a.dropPersistent(t, reused);
  } finally {
    for (const key of Object.keys(original)) Array.prototype[key] = original[key];
    if (oldMinusOne) Object.defineProperty(Array.prototype, "-1", oldMinusOne);
    else delete Array.prototype["-1"];
  }
  assert.deepEqual([...a.read(t, neighbor)], [6, 6, 6, 6, 6]);
  assert.throws(() => a.read(t, reused), /foreign or stale/);
  const second = a.allocPersistent(t, 5);
  assert.deepEqual([...a.read(t, second)], [0, 0, 0, 0, 0]);
  a.dropPersistent(t, neighbor);
  a.dropPersistent(t, second);
  a.endTurn(t); a.retire();
});

test("captured WeakMap authority survives prototype mutation for handles and pins", () => {
  const a = new ActorArena({actorId: 935, incarnation: 1});
  const t = a.beginTurn();
  const old = {};
  for (const name of ["get", "set", "has", "delete"]) old[name] = WeakMap.prototype[name];
  let pin, handle, result;
  try {
    for (const name of ["get", "set", "has", "delete"]) {
      WeakMap.prototype[name] = () => { throw Error("mutable WeakMap primitive: " + name); };
    }
    handle = a.allocPersistent(t, 2);
    a.write(t, handle, Uint8Array.of(11, 22));
    result = a.read(t, handle);
    pin = a.pinLifetime(t);
    a.dropPersistent(t, handle);
  } finally {
    for (const name of Object.keys(old)) WeakMap.prototype[name] = old[name];
  }
  assert.deepEqual([...result], [11, 22]);
  assert.throws(() => a.read(t, handle), /foreign or stale/);
  a.endTurn(t); a.retire();
  assert.equal(a.pendingLifetimePins, 1);
  a.releaseLifetimePin(pin);
  assert.equal(a.pendingLifetimePins, 0);
});


test("actor admission ignores mutated freeze, integer and kind intrinsics", () => {
  const freeze = Object.freeze, integer = Number.isSafeInteger, has = Set.prototype.has;
  let arena, turn, pin, execution, frame, ticket;
  try {
    Object.freeze = () => { throw Error("untrusted freeze"); };
    Number.isSafeInteger = () => true;
    Set.prototype.has = () => true;
    assert.throws(() => new ActorArena({actorId: -1, incarnation: 1}), /invalid actor arena owner/);
    assert.throws(() => new ActorArena({actorId: 936, incarnation: 1, kind: "invalid"}), /invalid actor arena owner/);
    arena = new ActorArena({actorId: 936, incarnation: 1});
    turn = arena.beginTurn();
    assert.throws(() => arena.allocPersistent(turn, 1.5), /invalid arena allocation length/);
    pin = arena.pinLifetime(turn);
    execution = arena.startStack(turn);
    assert.throws(() => arena.pushStackFrame(turn, execution, 1.5), /invalid actor stack frame length/);
    frame = arena.pushStackFrame(turn, execution, 4);
    arena.writeStackFrame(turn, execution, frame, Uint8Array.of(1, 2, 3, 4));
    ticket = arena.suspendStack(turn, execution);
    arena.endTurn(turn);
  } finally {
    Object.freeze = freeze; Number.isSafeInteger = integer; Set.prototype.has = has;
  }
  assert.ok(Object.isFrozen(turn) && Object.isFrozen(pin) && Object.isFrozen(ticket));
  const next = arena.beginTurn();
  assert.equal(arena.resumeStack(next, ticket), execution);
  assert.deepEqual([...arena.readStackFrame(next, execution, frame)], [1, 2, 3, 4]);
  arena.popStackFrame(next, execution, frame);
  arena.finishStack(next, execution);
  assert.throws(() => arena.resumeStack(next, ticket), /foreign, stale or consumed/);
  arena.endTurn(next);
  arena.retire();
  arena.releaseLifetimePin(pin);
  assert.equal(arena.pendingLifetimePins, 0);
});

test("full-page reuse ignores array species and retains neighbor and stale-handle fences", () => {
  const a = new ActorArena({actorId: 937, incarnation: 1});
  const t = a.beginTurn();
  const left = a.allocPersistent(t, 16384);
  const mid = a.allocPersistent(t, 32768);
  const right = a.allocPersistent(t, 16384);
  a.write(t, mid, new Uint8Array(32768).fill(7));
  assert.throws(() => a.allocPersistent(t, 1), /quota exhausted/);
  a.dropPersistent(t, left); a.dropPersistent(t, right);
  const desc = Object.getOwnPropertyDescriptor(Array.prototype, "constructor");
  let l, r;
  try {
    Object.defineProperty(Array.prototype, "constructor", {
      configurable: true, get() { throw Error("array species must not run"); }
    });
    l = a.allocPersistent(t, 16384);
    r = a.allocPersistent(t, 16384);
    a.dropPersistent(t, l); a.dropPersistent(t, r);
  } finally { Object.defineProperty(Array.prototype, "constructor", desc); }
  assert.equal(a.read(t, mid).every(x => x === 7), true);
  assert.throws(() => a.read(t, left), /foreign or stale/);
  assert.throws(() => a.read(t, l), /foreign or stale/);
  a.dropPersistent(t, mid);
  const all = a.allocPersistent(t, 65536);
  assert.equal(a.read(t, all).every(x => x === 0), true);
  const scratch = a.allocScratch(t, 65536);
  assert.throws(() => a.allocScratch(t, 1), /quota exhausted/);
  a.endTurn(t);
  const next = a.beginTurn();
  assert.throws(() => a.read(next, scratch), /foreign or stale/);
  assert.equal(a.read(next, a.allocScratch(next, 65536)).every(x => x === 0), true);
  a.dropPersistent(next, all); a.endTurn(next); a.retire();
});
