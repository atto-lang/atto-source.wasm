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
  const untrusted = parent.snapshotForActor("untrusted");
  assert.notStrictEqual(untrusted, parent);

  for (const bad of [null, [], new Map(), {}, new Uint8Array(1), () => 1, NaN, Infinity])
    assert.throws(() => parent.with("bad", bad), /immutable scalar/);
  assert.throws(() => new PersistentActorMap(), /use PersistentActorMap.empty/);
});

test("mutated Object.freeze and WeakSet prototypes do not forge map identity", () => {
  const map = PersistentActorMap.empty().with("x", 1);
  const oldFreeze = Object.getOwnPropertyDescriptor(Object, "freeze");
  const oldHas = Object.getOwnPropertyDescriptor(WeakSet.prototype, "has");
  try {
    Object.defineProperty(Object, "freeze", {
      configurable: true, writable: true, value(v) { return v; }
    });
    Object.defineProperty(WeakSet.prototype, "has", {
      configurable: true, writable: true, value() { return true; }
    });
    assert.equal(map.get("x"), 1);
    assert.throws(() => map.with("forged", {}), /immutable scalar/);
    const next = map.with("y", 2);
    assert.equal(Object.isFrozen(next), true);
  } finally {
    Object.defineProperty(Object, "freeze", oldFreeze);
    Object.defineProperty(WeakSet.prototype, "has", oldHas);
  }
});
