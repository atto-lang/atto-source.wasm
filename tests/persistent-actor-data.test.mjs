import test from "node:test";
import assert from "node:assert/strict";
import {PersistentActorMap} from "../src/persistent-actor-data.mjs";

test("persistent actor map path copies and isolates private snapshots", () => {
  let root = PersistentActorMap.empty();
  for (let i = 0; i < 5000; ++i)
    root = root.with("k-" + String(i).padStart(5, "0"), i);
  const old = root;
  root = root.with("k-01024", 9001);
  assert.equal(old.get("k-01024"), 1024);
  assert.equal(root.get("k-01024"), 9001);
  assert.strictEqual(root, root.with("k-01024", 9001));
  const deleted = root.without("k-01024");
  assert.equal(deleted.has("k-01024"), false);
  assert.equal(root.get("k-01024"), 9001);

  const nested = PersistentActorMap.empty().with("v", 12n);
  const parent = PersistentActorMap.empty().with("nested", nested);
  assert.strictEqual(parent.get("nested"), nested);
  assert.strictEqual(parent, parent.with("nested", nested));
  assert.strictEqual(parent.snapshotForActor("shared"), parent);
  const isolated = parent.snapshotForActor("private");
  assert.notStrictEqual(isolated, parent);
  assert.notStrictEqual(isolated.get("nested"), nested);
  assert.equal(isolated.get("nested").get("v"), 12n);
  const sharedChild = PersistentActorMap.empty().with("leaf", 7);
  const dag = PersistentActorMap.empty()
    .with("left", sharedChild).with("right", sharedChild);
  const dagCopy = dag.snapshotForActor("private");
  assert.notStrictEqual(dagCopy.get("left"), sharedChild);
  assert.strictEqual(dagCopy.get("left"), dagCopy.get("right"),
    "isolated clone should preserve internal DAG sharing");

  const untrusted = parent.snapshotForActor("untrusted");
  assert.notStrictEqual(untrusted, parent);

  for (const bad of [null, [], new Map(), {}, new Uint8Array(1), () => 1, NaN, Infinity])
    assert.throws(() => parent.with("bad", bad), /immutable scalar/);
  assert.throws(() => new PersistentActorMap(), /use PersistentActorMap.empty/);
});

test("mutated Object.freeze and WeakSet prototypes do not forge map identity", () => {
  const map = PersistentActorMap.empty().with("x", 1);
  const oldFreeze = Object.getOwnPropertyDescriptor(Object, "freeze");
  const oldSame = Object.getOwnPropertyDescriptor(Object, "is");
  const oldHas = Object.getOwnPropertyDescriptor(WeakSet.prototype, "has");
  const oldFinite = Object.getOwnPropertyDescriptor(Number, "isFinite");
  const oldMax = Object.getOwnPropertyDescriptor(Math, "max");
  const oldPush = Object.getOwnPropertyDescriptor(Array.prototype, "push");
  const oldPop = Object.getOwnPropertyDescriptor(Array.prototype, "pop");
  try {
    Object.defineProperty(Object, "freeze", {
      configurable: true, writable: true, value(v) { return v; }
    });
    Object.defineProperty(Object, "is", {
      configurable: true, writable: true, value() { return true; }
    });
    Object.defineProperty(WeakSet.prototype, "has", {
      configurable: true, writable: true, value() { return true; }
    });
    Object.defineProperty(Number, "isFinite", {
      configurable: true, writable: true, value() { return true; }
    });
    Object.defineProperty(Math, "max", {
      configurable: true, writable: true, value() { return -999; }
    });
    Object.defineProperty(Array.prototype, "push", {
      configurable: true, writable: true, value() { throw new Error("poisoned push"); }
    });
    Object.defineProperty(Array.prototype, "pop", {
      configurable: true, writable: true, value() { throw new Error("poisoned pop"); }
    });
    assert.equal(map.get("x"), 1);
    assert.throws(() => map.with("forged", {}), /immutable scalar/);
    const next = map.with("y", 2);
    assert.equal(Object.isFrozen(next), true);
    const actuallyUpdated = map.with("x", 2);
    assert.equal(actuallyUpdated.get("x"), 2, "hostile Object.is cannot forge a no-op");
    assert.equal(map.get("x"), 1, "original persistent version stays intact");
    const privateCopy = next.snapshotForActor("private");
    assert.equal(privateCopy.get("y"), 2);
    assert.throws(() => map.with("nan", NaN), /immutable scalar/);
  } finally {
    Object.defineProperty(Object, "freeze", oldFreeze);
    Object.defineProperty(Object, "is", oldSame);
    Object.defineProperty(WeakSet.prototype, "has", oldHas);
    Object.defineProperty(Number, "isFinite", oldFinite);
    Object.defineProperty(Math, "max", oldMax);
    Object.defineProperty(Array.prototype, "push", oldPush);
    Object.defineProperty(Array.prototype, "pop", oldPop);
  }
});

test("persistent actor key bounds apply to every lookup and removal operation",()=>{
 const map=PersistentActorMap.empty().with("valid",7);
 for(const key of ["", "x".repeat(4097)]){
  assert.equal(map.get(key),undefined);
  assert.equal(map.has(key),false);
  assert.throws(()=>map.without(key),/invalid persistent actor key/);
  assert.throws(()=>map.with(key,1),/invalid persistent actor key/);
 }
 assert.equal(map.get("valid"),7);
 assert.equal(map.without("valid").size,0);
});
