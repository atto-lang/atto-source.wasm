import test from "node:test";
import assert from "node:assert/strict";
import {ActorIsolationAccessV1} from "../src/actor-isolation-access-v1.mjs";

test("compressed32 actor-relative access is confined to one issued allocation", () => {
  const gate = new ActorIsolationAccessV1(1, 2, 3, 64n);
  const grant = gate.issueAllocation(8n, 16n);
  assert.equal(gate.checkedOffset(grant, 2n, 16n), 8n);
  assert.equal(gate.checkedOffset(grant, 3n, 8n), 16n);
  assert.throws(() => gate.checkedOffset(grant, 1n, 1n), /outside/);
  assert.throws(() => gate.checkedOffset(grant, 3n, 9n), /outside/);
  assert.throws(() => gate.checkedOffset(grant, 4n, 1n), /outside/);
  assert.throws(() => gate.checkedOffset(grant, 0n, 8n), /invalid/);
  assert.throws(() => gate.checkedOffset(grant, 0x1_0000_0000n, 8n), /invalid/);
  assert.throws(() => gate.checkedOffset(grant, 2n, 0n), /invalid/);
  assert.throws(() => gate.checkedOffset(grant, 2n, 2n ** 64n), /outside/);
  assert.throws(() => gate.issueAllocation(16n, 8n), /overlapping/);
  assert.throws(() => gate.issueAllocation(0n, -1n), /outside/);
  assert.throws(() => gate.issueAllocation(1n, 8n), /unaligned/);
  gate.release(grant);
  assert.throws(() => gate.checkedOffset(grant, 2n, 8n), /stale/);
  const reused = gate.issueAllocation(8n, 16n);
  assert.throws(() => gate.checkedOffset(grant, 2n, 8n), /stale/);
  assert.equal(gate.checkedOffset(reused, 2n, 8n), 8n);
});

test("foreign and fabricated authority cannot cross actor or tenant", () => {
  const a = new ActorIsolationAccessV1(1, 2, 3, 64n);
  const b = new ActorIsolationAccessV1(1, 4, 3, 64n);
  const c = new ActorIsolationAccessV1(5, 2, 3, 64n);
  const restarted = new ActorIsolationAccessV1(1, 2, 4, 64n);
  const grant = a.issueAllocation(0n, 16n);
  for (const other of [b, c, restarted]) {
    assert.throws(() => other.checkedOffset(grant, 1n, 8n), /foreign/);
  }
  assert.throws(() => a.checkedOffset(Object.freeze({}), 1n, 8n), /foreign/);
  assert.throws(() => a.checkedOffset(Object.freeze({start: 0n, end: 16n}), 1n, 8n), /foreign/);
  a.retire();
  assert.throws(() => a.checkedOffset(grant, 1n, 8n), /retired/);
  assert.throws(() => a.issueAllocation(0n, 8n), /retired/);
  assert.equal(b.retired, false);
});

test("highest compressed32 word and boundary arithmetic cannot wrap", () => {
  const maxSpan = 0xffff_ffffn * 8n;
  const a = new ActorIsolationAccessV1(1, 1, 1, maxSpan);
  const last = a.issueAllocation(maxSpan - 8n, 8n);
  assert.equal(a.checkedOffset(last, 0xffff_ffffn, 8n), maxSpan - 8n);
  assert.throws(() => a.checkedOffset(last, 0xffff_ffffn, 9n), /outside/);
  assert.throws(() => a.issueAllocation(maxSpan, 1n), /outside/);
  assert.throws(() => new ActorIsolationAccessV1(1, 1, 1, maxSpan + 1n), /invalid/);
  assert.throws(() => new ActorIsolationAccessV1(0, 1, 1, 8n), /invalid/);
});
