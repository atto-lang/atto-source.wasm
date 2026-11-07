import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PooledWasmActors} from "../src/pooled-actor-host.mjs";
import {SupervisedPooledActor} from "../src/supervised-pooled-actor.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");

// These LLVM IR modules test the host/Worker transport with genuine Wasm.
// They are NOT a compiler-backed .atto guest or a stack-depth parity receipt.
function wasmFixture({fault = "typed"} = {}) {
  if (!["typed", "untyped"].includes(fault)) throw TypeError("invalid test fault");
  const folder = mkdtempSync(join(tmpdir(), "atto-supervisor-host-"));
  try {
    const file = join(folder, "actor.wasm");
    const ir = [
      'target triple = "wasm32-unknown-unknown"',
      '@status = internal global i32 0',
      'declare void @llvm.trap()',
      'define void @oreslang_wasm_actor_init() {',
      'store i32 0, ptr @status',
      'ret void',
      '}',
      'define i64 @oreslang_wasm_actor_on_message(i64 %n) {',
      '%fault = icmp eq i64 %n, 64',
      'br i1 %fault, label %trap, label %ok',
      'trap:',
      fault === "typed" ?
        'store volatile i32 1, ptr @status' :
        'store volatile i32 0, ptr @status',
      'call void @llvm.trap()',
      'unreachable',
      'ok:',
      'ret i64 %n',
      '}',
      'define i32 @oreslang_wasm_actor_frame_status() {',
      '%s = load volatile i32, ptr @status',
      'ret i32 %s',
      '}',
      'define void @oreslang_wasm_actor_teardown() { ret void }',
      ''
    ].join("\n");
    const p = spawnSync(process.env.CLANG || "clang", [
      "--target=wasm32", "-x", "ir", "-Oz", "-nostdlib",
      "-Wl,--no-entry", "-Wl,--export-memory",
      "-Wl,--export=oreslang_wasm_actor_init",
      "-Wl,--export=oreslang_wasm_actor_on_message",
      "-Wl,--export=oreslang_wasm_actor_teardown",
      "-Wl,--export=oreslang_wasm_actor_frame_status",
      "-Wl,--initial-memory=131072", "-Wl,--max-memory=131072",
      "-o", file, "-"
    ], {input: ir, encoding: "utf8", timeout: 30000});
    if (p.status !== 0 || p.error || p.signal)
      throw Error("Clang wasm32 synthetic supervisor test unavailable: " +
        String(p.stderr || p.error));
    return readFileSync(file);
  } finally {
    rmSync(folder, {recursive: true, force: true});
  }
}

test("typed terminal CONTROL allows one restart; stale A denied, same-Worker B survives", {
  timeout: 90000
}, async () => {
  const bytes = wasmFixture();
  const pool = new PooledWasmActors({workers: 1, maxActors: 3, timeoutMs: 5000});
  const observed = [];
  let supervisor;
  try {
    const b = await pool.spawn(bytes, {trusted: true, expectedSha256: digest(bytes)});
    supervisor = await SupervisedPooledActor.start(pool, bytes, {
      expectedSha256: digest(bytes), maxRestarts: 1,
      onControl: receipt => observed.push(receipt)
    });
    const first = supervisor.current();
    assert.equal(first.generation, 1);
    assert.equal(await first.send(63n), 63n);
    assert.equal(await b.send(9n), 9n);
    const replacement = supervisor.waitForGeneration(1);
    await assert.rejects(first.send(64n), /STACK_BUDGET_EXHAUSTED_V1/);
    const next = await replacement;
    assert.equal(next.generation, 2);
    assert.equal(supervisor.status.restarts, 1);
    assert.equal(pool.typedTerminalControlCount, 1);
    assert.equal(pool.isolatedGuestFaultCount, 1);
    assert.equal(pool.activeWorkerCount, 1);
    assert.equal(pool.actorCount, 2);
    await assert.rejects(first.send(1n), /STALE_ACTOR_GENERATION/);
    await assert.rejects(first.stop(), /STALE_ACTOR_GENERATION/);
    assert.equal(await next.send(1n), 1n);
    assert.equal(await b.send(7n), 7n);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(observed.length, 1);
    assert.equal(observed[0].kind, "SUPERVISOR_TERMINAL_CONTROL");
    assert.equal(observed[0].faultCode, "STACK_BUDGET_EXHAUSTED_V1");
    assert.equal(observed[0].failedGeneration, 1);
    assert.equal(observed[0].nextGeneration, 2);
    assert.equal(observed[0].restartAuthorized, true);
    assert.equal(observed[0].quiescent, true);
    assert.ok(Object.isFrozen(observed[0]));
    assert.equal(Object.hasOwn(observed[0], "incarnation"), false);

    const forbidden = supervisor.waitForGeneration(2);
    await assert.rejects(next.send(64n), /STACK_BUDGET_EXHAUSTED_V1/);
    await assert.rejects(forbidden, /restart budget exhausted/);
    assert.equal(supervisor.status.phase, "restart-budget-exhausted");
    assert.equal(pool.typedTerminalControlCount, 2);
    assert.equal(pool.actorCount, 1);
    assert.equal(pool.activeWorkerCount, 1);
    await assert.rejects(next.send(2n), /STALE_ACTOR_GENERATION/);
    assert.equal(await b.send(3n), 3n);
    await b.stop();
  } finally {
    await supervisor?.close();
    await pool.close();
  }
});

test("non-quota unreachable revokes generation but cannot authorize restart", {
  timeout: 90000
}, async () => {
  const bytes = wasmFixture({fault: "untyped"});
  const pool = new PooledWasmActors({workers: 1, maxActors: 2, timeoutMs: 5000});
  const seen = [];
  let supervisor;
  try {
    supervisor = await SupervisedPooledActor.start(pool, bytes, {
      expectedSha256: digest(bytes), maxRestarts: 3,
      onControl: control => seen.push(control)
    });
    const old = supervisor.current();
    const waiting = supervisor.waitForGeneration(1);
    await assert.rejects(old.send(64n), /WASM_UNREACHABLE_V1/);
    await assert.rejects(waiting, /unhandled guest actor terminal fault/);
    assert.equal(supervisor.status.phase, "unhandled-terminal");
    assert.equal(supervisor.status.restarts, 0);
    assert.equal(pool.typedTerminalControlCount, 0);
    assert.equal(pool.isolatedGuestFaultCount, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].restartAuthorized, false);
    assert.equal(seen[0].faultCode, "WASM_UNREACHABLE_V1");
    await assert.rejects(old.send(1n), /STALE_ACTOR_GENERATION/);
    assert.equal(pool.activeWorkerCount, 1);
  } finally {
    await supervisor?.close();
    await pool.close();
  }
});

test("explicit STOP racing with quota fault suppresses automatic restart", {
  timeout: 90000
}, async () => {
  const bytes = wasmFixture();
  const pool = new PooledWasmActors({workers: 1, maxActors: 2, timeoutMs: 5000});
  let supervisor;
  try {
    supervisor = await SupervisedPooledActor.start(pool, bytes, {
      expectedSha256: digest(bytes), maxRestarts: 2
    });
    const old = supervisor.current();
    const settled = await Promise.allSettled([old.send(64n), old.stop()]);
    assert.equal(settled[0].status, "rejected");
    assert.equal(settled[1].status, "rejected");
    assert.match(String(settled[0].reason), /STACK_BUDGET_EXHAUSTED_V1/);
    assert.match(String(settled[1].reason), /STACK_BUDGET_EXHAUSTED_V1/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(supervisor.status.phase, "stopped-after-terminal");
    assert.equal(supervisor.status.restarts, 0);
    assert.equal(pool.typedTerminalControlCount, 1);
    assert.equal(pool.actorCount, 0);
    assert.equal(pool.activeWorkerCount, 1);
    await assert.rejects(old.send(2n), /STALE_ACTOR_GENERATION/);
  } finally {
    await supervisor?.close();
    await pool.close();
  }
});

test("supervisor close does not affect a sibling actor or permit stale handles", {
  timeout: 90000
}, async () => {
  const bytes = wasmFixture();
  const pool = new PooledWasmActors({workers: 1, maxActors: 2});
  let supervisor;
  try {
    const b = await pool.spawn(bytes, {trusted: true, expectedSha256: digest(bytes)});
    supervisor = await SupervisedPooledActor.start(pool, bytes, {
      expectedSha256: digest(bytes), maxRestarts: 1
    });
    const old = supervisor.current();
    await supervisor.close();
    assert.equal(supervisor.status.phase, "closed");
    assert.equal(pool.actorCount, 1);
    assert.equal(pool.activeWorkerCount, 1);
    await assert.rejects(old.send(1n), /STALE_ACTOR_GENERATION/);
    await assert.rejects(supervisor.waitForGeneration(1), /supervised actor closed/);
    assert.equal(await b.send(3n), 3n);
    await b.stop();
  } finally {
    await supervisor?.close();
    await pool.close();
  }
});

test("supervisor denies invalid restart quotas, mutable artifact and callback types", async () => {
  const bytes = wasmFixture();
  const pool = new PooledWasmActors({workers: 1, maxActors: 1});
  try {
    for (const maxRestarts of [-1, 5, 1.5]) {
      assert.throws(() => new SupervisedPooledActor(pool, bytes, {
        expectedSha256: digest(bytes), maxRestarts
      }), /restart budget/);
    }
    assert.throws(() => new SupervisedPooledActor(pool, bytes, {
      expectedSha256: digest(bytes), onControl: "not a function"
    }), /CONTROL observer/);
    const mutated = new Uint8Array(bytes);
    const pinned = digest(mutated);
    mutated[0] ^= 0xff;
    assert.throws(() => new SupervisedPooledActor(pool, mutated, {
      expectedSha256: pinned
    }), /artifact digest mismatch/);
    await assert.rejects(pool.spawn(bytes, {
      trusted: true, expectedSha256: digest(bytes), onTerminalControl: 123
    }), /terminal CONTROL observer/);
    assert.equal(pool.actorCount, 0);
  } finally {
    await pool.close();
  }
});
