import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena} from "../src/actor-arena.mjs";

test("frame storage uses captured capability primordials after shared-realm mutation", () => {
  const push = Array.prototype.push, pop = Array.prototype.pop;
  const get = Map.prototype.get, set = Map.prototype.set, del = Map.prototype.delete;
  const clear = Map.prototype.clear, for_each = Map.prototype.forEach;
  const wGet = WeakMap.prototype.get, wSet = WeakMap.prototype.set;
  const wDel = WeakMap.prototype.delete;
  const ctor = WebAssembly.Memory;
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "-1");
  let outcome = null;
  try {
    const denied = () => { throw new Error("mutable global primitive invoked"); };
    Array.prototype.push = denied;
    Array.prototype.pop = denied;
    Object.defineProperty(Array.prototype, "-1", {
      configurable: true, get: denied
    });
    Map.prototype.get = denied;
    Map.prototype.set = denied;
    Map.prototype.delete = denied;
    Map.prototype.clear = denied;
    Map.prototype.forEach = denied;
    WeakMap.prototype.get = denied;
    WeakMap.prototype.set = denied;
    WeakMap.prototype.delete = denied;
    WebAssembly.Memory = class { constructor() { denied(); } };

    const a = new ActorArena({actorId: 899, incarnation: 1});
    const t = a.beginTurn();
    const e = a.startStack(t);
    const f = a.pushStackFrame(t, e, 2);
    a.writeStackFrame(t, e, f, Uint8Array.of(7, 8));
    const read = a.readStackFrame(t, e, f);
    a.popStackFrame(t, e, f);
    a.finishStack(t, e);
    a.endTurn(t);
    a.retire();
    outcome = [read[0], read[1], a.stackExecutionCount];
  } finally {
    Array.prototype.push = push;
    Array.prototype.pop = pop;
    if (descriptor) Object.defineProperty(Array.prototype, "-1", descriptor);
    else delete Array.prototype["-1"];
    Map.prototype.get = get;
    Map.prototype.set = set;
    Map.prototype.delete = del;
    Map.prototype.clear = clear;
    Map.prototype.forEach = for_each;
    WeakMap.prototype.get = wGet;
    WeakMap.prototype.set = wSet;
    WeakMap.prototype.delete = wDel;
    WebAssembly.Memory = ctor;
  }
  assert.deepEqual(outcome, [7, 8, 0]);
});
