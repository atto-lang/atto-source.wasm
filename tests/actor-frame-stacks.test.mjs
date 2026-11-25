import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena} from "../src/actor-arena.mjs";

const arena = (actorId, incarnation = 1) =>
  new ActorArena({actorId, incarnation, kind: "shared"});

test("independent actors own physically distinct managed frame byte domains", () => {
  const a = arena(801), b = arena(802);
  const ta = a.beginTurn(), tb = b.beginTurn();
  const ea = a.startStack(ta), eb = b.startStack(tb);
  const fa = a.pushStackFrame(ta, ea, 4), fb = b.pushStackFrame(tb, eb, 4);
  a.writeStackFrame(ta, ea, fa, Uint8Array.of(1, 2, 3, 4));
  b.writeStackFrame(tb, eb, fb, Uint8Array.of(9, 8, 7, 6));
  assert.deepEqual([...a.readStackFrame(ta, ea, fa)], [1, 2, 3, 4]);
  assert.deepEqual([...b.readStackFrame(tb, eb, fb)], [9, 8, 7, 6]);
  assert.throws(() => a.readStackFrame(ta, eb, fb), /authority required/);
  assert.throws(() => b.readStackFrame(tb, eb, fa), /foreign, stale/);
  assert.throws(() => a.writeStackFrame(tb, ea, fa, Uint8Array.of(0, 0, 0, 0)), /turn authority/);
  a.popStackFrame(ta, ea, fa);
  b.popStackFrame(tb, eb, fb);
  a.finishStack(ta, ea); b.finishStack(tb, eb);
  a.endTurn(ta); b.endTurn(tb);
  a.retire(); b.retire();
});

test("frames enforce LIFO, zeroize reuse and never expose a mutable alias", () => {
  const a = arena(803), t = a.beginTurn(), e = a.startStack(t);
  const outer = a.pushStackFrame(t, e, 3);
  a.writeStackFrame(t, e, outer, Uint8Array.of(1, 2, 3));
  const inner = a.pushStackFrame(t, e, 3);
  a.writeStackFrame(t, e, inner, Uint8Array.of(4, 5, 6));
  assert.throws(() => a.popStackFrame(t, e, outer), /non-top/);
  assert.throws(() => a.readStackFrame(t, e, outer), /non-top/);
  const copy = a.readStackFrame(t, e, inner);
  copy.fill(77);
  assert.deepEqual([...a.readStackFrame(t, e, inner)], [4, 5, 6]);
  a.popStackFrame(t, e, inner);
  assert.throws(() => a.readStackFrame(t, e, inner), /stale/);
  const reused = a.pushStackFrame(t, e, 3);
  assert.deepEqual([...a.readStackFrame(t, e, reused)], [0, 0, 0]);
  a.popStackFrame(t, e, reused);
  assert.deepEqual([...a.readStackFrame(t, e, outer)], [1, 2, 3]);
  a.popStackFrame(t, e, outer);
  assert.equal(a.stackBytesInUse, 0);
  a.finishStack(t, e);
  a.endTurn(t); a.retire();
});

test("suspension retains frame bytes across turns with one-use resume authority", () => {
  const a = arena(804);
  const t1 = a.beginTurn(), e = a.startStack(t1);
  const f = a.pushStackFrame(t1, e, 4);
  a.writeStackFrame(t1, e, f, Uint8Array.of(44, 33, 22, 11));
  assert.throws(() => a.endTurn(t1), /must suspend or finish/);
  const receipt = a.suspendStack(t1, e);
  assert.throws(() => a.readStackFrame(t1, e, f), /authority required/);
  a.endTurn(t1);
  const t2 = a.beginTurn();
  assert.throws(() => a.resumeStack(t2, structuredClone(receipt)), /stale or consumed/);
  assert.equal(a.resumeStack(t2, receipt), e);
  assert.deepEqual([...a.readStackFrame(t2, e, f)], [44, 33, 22, 11]);
  assert.throws(() => a.resumeStack(t2, receipt), /already active/);
  a.popStackFrame(t2, e, f);
  a.finishStack(t2, e);
  assert.throws(() => a.resumeStack(t2, receipt), /stale or consumed/);
  a.endTurn(t2); a.retire();
});

test("suspended tasks retain separate stacks and have bounded actor aggregate admission", () => {
  const a = arena(805), t = a.beginTurn();
  const tasks = [];
  for (let i = 0; i < 8; i++) {
    const e = a.startStack(t);
    const f = a.pushStackFrame(t, e, 1);
    a.writeStackFrame(t, e, f, Uint8Array.of(i + 1));
    const ticket = a.suspendStack(t, e);
    tasks.push({e, f, ticket});
  }
  assert.equal(a.stackExecutionCount, 8);
  assert.equal(a.stackBytesInUse, 8);
  assert.throws(() => a.startStack(t), /execution quota exhausted/);
  a.endTurn(t);
  const next = a.beginTurn();
  for (let i = tasks.length - 1; i >= 0; --i) {
    const {e, f, ticket} = tasks[i];
    assert.equal(a.resumeStack(next, ticket), e);
    assert.equal(a.readStackFrame(next, e, f)[0], i + 1);
    a.popStackFrame(next, e, f);
    a.finishStack(next, e);
  }
  assert.equal(a.stackExecutionCount, 0);
  a.endTurn(next); a.retire();
});

test("bounded frame depth and bytes reject before corrupting live neighbors", () => {
  const a = arena(806), t = a.beginTurn(), e = a.startStack(t);
  const full = a.pushStackFrame(t, e, 65536);
  a.writeStackFrame(t, e, full, new Uint8Array(65536).fill(13));
  assert.throws(() => a.pushStackFrame(t, e, 1), /byte quota/);
  assert.equal(a.readStackFrame(t, e, full)[65535], 13);
  assert.throws(() => a.pushStackFrame(t, e, 65537), /invalid/);
  a.popStackFrame(t, e, full);
  const frames = Array.from({length: 64}, () => a.pushStackFrame(t, e, 1));
  assert.throws(() => a.pushStackFrame(t, e, 1), /frame quota/);
  assert.equal(a.stackBytesInUse, 64);
  for (const frame of frames.reverse()) a.popStackFrame(t, e, frame);
  a.finishStack(t, e); a.endTurn(t); a.retire();
});

test("cancellation revokes suspended tickets and leases, allowing actor reuse", () => {
  const a = arena(807), t = a.beginTurn(), e = a.startStack(t);
  const f = a.pushStackFrame(t, e, 4);
  a.writeStackFrame(t, e, f, Uint8Array.of(1, 2, 3, 4));
  const ticket = a.suspendStack(t, e);
  a.cancelStack(t, e);
  assert.equal(a.stackExecutionCount, 0);
  assert.throws(() => a.resumeStack(t, ticket), /stale or consumed/);
  assert.throws(() => a.cancelStack(t, e), /foreign or stale/);
  const next = a.startStack(t);
  const reused = a.pushStackFrame(t, next, 4);
  assert.deepEqual([...a.readStackFrame(t, next, reused)], [0, 0, 0, 0]);
  assert.throws(() => a.readStackFrame(t, next, f), /stale/);
  a.cancelStack(t, next);
  a.endTurn(t); a.retire();
});

test("STOP rejects active turns and drains stack bytes only after external lifetime pin", () => {
  const a = arena(808), t = a.beginTurn(), e = a.startStack(t);
  const f = a.pushStackFrame(t, e, 2);
  a.writeStackFrame(t, e, f, Uint8Array.of(5, 9));
  const pin = a.pinLifetime(t);
  const ticket = a.suspendStack(t, e);
  assert.throws(() => a.retire(), /active actor turn/);
  a.endTurn(t);
  a.retire();
  assert.equal(a.retired, true);
  assert.equal(a.pendingLifetimePins, 1);
  assert.equal(a.stackExecutionCount, 1, "physical bytes remain pinned");
  assert.throws(() => a.beginTurn(), /retired/);
  a.releaseLifetimePin(pin);
  assert.equal(a.stackExecutionCount, 0);
  assert.equal(a.stackBytesInUse, 0);
  a.releaseLifetimePin(pin);
  const restarted = arena(808, 2), fresh = restarted.beginTurn();
  assert.throws(() => restarted.resumeStack(fresh, ticket), /stale or consumed/);
  assert.throws(() => restarted.cancelStack(fresh, e), /foreign or stale/);
  restarted.endTurn(fresh); restarted.retire();
});

test("byte writes deny shared/forged/detached views without mutating frame bytes", () => {
  const a = arena(809), t = a.beginTurn(), e = a.startStack(t);
  const f = a.pushStackFrame(t, e, 4);
  a.writeStackFrame(t, e, f, Uint8Array.of(1, 2, 3, 4));
  const forged = Object.create(Uint8Array.prototype);
  Object.defineProperty(forged, "byteLength", {value: 4});
  assert.throws(() => a.writeStackFrame(t, e, f, forged), /exact-size/);
  assert.throws(() => a.writeStackFrame(t, e, f, new Uint8Array(3)), /exact-size/);
  if (typeof SharedArrayBuffer === "function") {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    Object.defineProperty(shared, "buffer", {value: new ArrayBuffer(4)});
    assert.throws(() => a.writeStackFrame(t, e, f, shared), /shared backing/);
  }
  const backing = new ArrayBuffer(4);
  const detached = new Uint8Array(backing);
  structuredClone(backing, {transfer: [backing]});
  assert.throws(() => a.writeStackFrame(t, e, f, detached), /exact-size/);
  assert.deepEqual([...a.readStackFrame(t, e, f)], [1, 2, 3, 4]);
  a.popStackFrame(t, e, f);
  a.finishStack(t, e);
  a.endTurn(t); a.retire();
});

test("stack-budget failure in one actor does not damage sibling actor execution", () => {
  const bad = arena(810), good = arena(811);
  const bt = bad.beginTurn(), gt = good.beginTurn();
  const be = bad.startStack(bt), ge = good.startStack(gt);
  const bf = bad.pushStackFrame(bt, be, 65536);
  assert.throws(() => bad.pushStackFrame(bt, be, 1), /byte quota/);
  const gf = good.pushStackFrame(gt, ge, 4);
  good.writeStackFrame(gt, ge, gf, Uint8Array.of(42, 0, 0, 0));
  assert.equal(good.readStackFrame(gt, ge, gf)[0], 42);
  bad.cancelStack(bt, be);
  good.popStackFrame(gt, ge, gf);
  good.finishStack(gt, ge);
  bad.endTurn(bt); good.endTurn(gt);
  bad.retire(); good.retire();
});

test("cancel one suspended invocation without disturbing a sibling", () => {
  const a = arena(812), t = a.beginTurn();
  const first = a.startStack(t), f = a.pushStackFrame(t, first, 2);
  a.writeStackFrame(t, first, f, Uint8Array.of(11, 12));
  const canceled = a.suspendStack(t, first);
  const second = a.startStack(t), g = a.pushStackFrame(t, second, 2);
  a.writeStackFrame(t, second, g, Uint8Array.of(42, 7));
  const survivor = a.suspendStack(t, second);
  a.endTurn(t);
  const next = a.beginTurn();
  a.cancelStack(next, first);
  assert.equal(a.stackExecutionCount, 1);
  assert.equal(a.stackBytesInUse, 2);
  assert.throws(() => a.resumeStack(next, canceled), /stale or consumed/);
  assert.equal(a.resumeStack(next, survivor), second);
  assert.deepEqual([...a.readStackFrame(next, second, g)], [42, 7]);
  a.popStackFrame(next, second, g);
  a.finishStack(next, second);
  assert.equal(a.stackExecutionCount, 0);
  assert.equal(a.stackBytesInUse, 0);
  a.endTurn(next); a.retire();
});

test("cancel suspended sibling during another active invocation", () => {
  const a = arena(813), turn = a.beginTurn();
  const old = a.startStack(turn), f = a.pushStackFrame(turn, old, 2);
  a.writeStackFrame(turn, old, f, Uint8Array.of(1, 2));
  const ticket = a.suspendStack(turn, old);
  const active = a.startStack(turn), g = a.pushStackFrame(turn, active, 2);
  a.writeStackFrame(turn, active, g, Uint8Array.of(42, 9));
  a.cancelStack(turn, old);
  assert.equal(a.stackExecutionCount, 1);
  assert.equal(a.stackBytesInUse, 2);
  assert.deepEqual([...a.readStackFrame(turn, active, g)], [42, 9]);
  a.popStackFrame(turn, active, g);
  a.finishStack(turn, active);
  assert.throws(() => a.resumeStack(turn, ticket), /stale or consumed/);
  assert.equal(a.stackExecutionCount, 0);
  assert.equal(a.stackBytesInUse, 0);
  a.endTurn(turn); a.retire();
});


test("stack lifecycle preserves current-main allocation-free arena readInto", () => {
  const a = arena(91), t = a.beginTurn();
  const handle = a.allocPersistent(t, 4);
  const source = new Uint8Array([42, 7, 9, 11]);
  a.write(t, handle, source);
  const stack = a.startStack(t), frame = a.pushStackFrame(t, stack, 4);
  a.writeStackFrame(t, stack, frame, new Uint8Array([1, 2, 3, 4]));
  const result = new Uint8Array(4);
  a.readInto(t, handle, result);
  assert.deepEqual(result, source);
  a.popStackFrame(t, stack, frame);
  a.finishStack(t, stack);
  a.dropPersistent(t, handle);
  a.endTurn(t);
  a.retire();
});


test("same-turn resume is denied without consuming the suspension ticket", () => {
  const a = arena(814), t = a.beginTurn();
  const e = a.startStack(t), f = a.pushStackFrame(t, e, 2);
  a.writeStackFrame(t, e, f, Uint8Array.of(42, 9));
  const ticket = a.suspendStack(t, e);
  assert.throws(() => a.resumeStack(t, ticket), /new physical turn/);
  assert.equal(a.stackExecutionCount, 1);
  a.endTurn(t);
  const next = a.beginTurn();
  assert.equal(a.resumeStack(next, ticket), e);
  assert.deepEqual([...a.readStackFrame(next, e, f)], [42, 9]);
  a.popStackFrame(next, e, f);
  a.finishStack(next, e);
  assert.throws(() => a.resumeStack(next, ticket), /stale or consumed/);
  a.endTurn(next);
  a.retire();
});


test("caller-owned frame reads preserve bytes and physical turn authority", () => {
  const a = arena(815), t = a.beginTurn();
  const e = a.startStack(t), f = a.pushStackFrame(t, e, 2);
  a.writeStackFrame(t, e, f, Uint8Array.of(42, 9));
  const target = new Uint8Array(2);
  a.readStackFrameInto(t, e, f, target);
  assert.deepEqual([...target], [42, 9]);
  target[0] = 0;
  a.readStackFrameInto(t, e, f, target);
  assert.deepEqual([...target], [42, 9]);
  assert.throws(() => a.readStackFrameInto(t, e, f, new Uint8Array(1)), /exact-size/);
  const receipt = a.suspendStack(t, e);
  assert.throws(() => a.readStackFrameInto(t, e, f, target), /active actor stack/);
  a.endTurn(t);
  const next = a.beginTurn();
  a.resumeStack(next, receipt);
  a.readStackFrameInto(next, e, f, target);
  assert.deepEqual([...target], [42, 9]);
  a.popStackFrame(next, e, f);
  a.finishStack(next, e);
  a.endTurn(next);
  a.retire();
});
