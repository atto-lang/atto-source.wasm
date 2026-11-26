import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {Worker} from "node:worker_threads";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {isAbsolute} from "node:path";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PooledWasmActors} from "../src/pooled-actor-host.mjs";
import {SupervisedPooledActor} from "../src/supervised-pooled-actor.mjs";
import {compileSourceActorToWasm} from "../scripts/compile-source-actor.mjs";
import {readBoundedRegularFile} from "../scripts/compile-ores.mjs";

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


const compiledActorSource = fileURLToPath(
  new URL("../contracts/actor-stack-containment-v1/recursive-sibling.atto",import.meta.url));
const sourceBlob = "947781cddf09d8e3e08c51cff2b7d8960e2d4750";
const realCompilerRequired = process.env.ATTO_REQUIRE_REAL_SUPERVISOR_GUEST === "1";

test("real .atto compiler-backed actor supervisor CONTROL, restart and stale generation", {
  skip: !realCompilerRequired && !process.env.ORESLANG_LLVM_COMPILER,
  timeout: 240000
}, async t => {
  const compiler = process.env.ORESLANG_LLVM_COMPILER || "";
  const expectedCompilerSha256 = process.env.ORESLANG_LLVM_COMPILER_SHA256 || "";
  const sourceHead = process.env.ORESLANG_LLVM_SOURCE_SHA || "";
  const sourceTree = process.env.ORESLANG_LLVM_SOURCE_TREE_SHA || "";
  if (!isAbsolute(compiler) ||
      !/^[a-f0-9]{64}$/.test(expectedCompilerSha256) ||
      !/^[a-f0-9]{40}$/.test(sourceHead) ||
      !/^[a-f0-9]{40}$/.test(sourceTree))
    throw Error("real supervisor guest requires approved LLVM compiler path/hash/source HEAD/tree");

  const approved = await readBoundedRegularFile(compiler, 256*1024*1024,
    "native compiler exceeds bounded read quota");
  assert.equal(digest(approved.bytes),expectedCompilerSha256);
  assert.ok(approved.stat.mode & 0o111,"compiler executable required");
  const original = await readFile(compiledActorSource);
  assert.equal(createHash("sha1").update(Buffer.from(
    "blob " + original.length + "\0", "ascii")).update(original).digest("hex"),
    sourceBlob);

  const guest = await compileSourceActorToWasm({
    compiler, source:compiledActorSource,
    checkedRecursionV1:true,expectedCompilerSha256
  });
  assert.equal(guest.provenance.checkedRecursionV1,true);
  assert.equal(guest.provenance.maxGuestFrames,64);
  assert.equal(guest.provenance.sourceSha256,digest(original));
  assert.equal(guest.provenance.compilerSha256,expectedCompilerSha256);
  assert.equal(guest.provenance.wasmSha256,digest(guest.wasm));
  assert.equal(guest.provenance.guestImports,0);

  const pool = new PooledWasmActors({workers:1,maxActors:3,timeoutMs:10000});
  const seen=[];
  let controller;
  try {
    const b = await pool.spawn(guest.wasm,{
      trusted:true,expectedSha256:guest.provenance.wasmSha256
    });
    controller=await SupervisedPooledActor.start(pool,guest.wasm,{
      expectedSha256:guest.provenance.wasmSha256,maxRestarts:1,
      onControl:record=>seen.push(record)
    });
    const old=controller.current();
    assert.equal(old.generation,1);
    assert.equal(await old.send(63n),63n,"exact 64 actor-owned source frames");
    assert.equal(await b.send(3n),3n);
    const nextPromise=controller.waitForGeneration(1);
    await assert.rejects(old.send(64n),/STACK_BUDGET_EXHAUSTED_V1/,
      "65th frame must be typed actor-terminal fault, never i64 sentinel");
    const next=await nextPromise;
    assert.equal(next.generation,2);
    assert.equal(controller.status.restarts,1);
    assert.equal(pool.typedTerminalControlCount,1);
    assert.equal(pool.activeWorkerCount,1);
    assert.equal(pool.actorCount,2);
    await assert.rejects(old.send(1n),/STALE_ACTOR_GENERATION/);
    await assert.rejects(old.stop(),/STALE_ACTOR_GENERATION/);
    assert.equal(await next.send(1n),1n,"restarted actor has a private fresh guest stack");
    assert.equal(await b.send(2n),2n,"original B retained on same carrier");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(seen.length,1);
    assert.equal(seen[0].faultCode,"STACK_BUDGET_EXHAUSTED_V1");
    assert.equal(seen[0].failedGeneration,1);
    assert.equal(seen[0].nextGeneration,2);
    assert.equal(seen[0].restartAuthorized,true);
    assert.equal(pool.isolatedGuestFaultCount,1);
    await next.stop();
    assert.equal(controller.status.phase,"stopped");
    assert.equal(await b.send(1n),1n);
    await b.stop();
  } finally {
    await controller?.close();
    await pool.close();
  }

  // This receipt is emitted ONLY after real source/compiler/Wasm/Worker
  // execution. It intentionally excludes unimplemented guest continuation
  // tickets, physical supervisor recovery across carrier death and backend
  // parity evidence.
  t.diagnostic(JSON.stringify({
    schema:"attolang.compiled_wasm_supervisor_control_v1",
    kind:"REAL_ATTO_GUEST_EXECUTED",
    fixtureGitBlob:sourceBlob,
    sourceSha256:digest(original),
    llvmSourceHead:sourceHead,
    llvmSourceTree:sourceTree,
    compilerSha256:expectedCompilerSha256,
    wasmSha256:guest.provenance.wasmSha256,
    guestsOnSameWorker:2,
    firstRejectedGuestFrame:65,
    typedTerminalControlCount:1,
    supervisorRestarts:1,
    oldGenerationSendDenied:true,
    oldGenerationStopDenied:true,
    originalSiblingSurvived:true,
    guestResumeTicketFencing:"NOT_EXECUTED",
    javaLlvmWasmFullParity:"NOT_EXECUTED"
  }));
});


test("forged typed CONTROL without retirement causes physical carrier exit, not restart", {
  timeout: 90000
}, async () => {
  const bytes = wasmFixture();
  const pool = new PooledWasmActors({workers: 1, maxActors: 1,
    timeoutMs: 5000, terminationTimeoutMs: 5000});
  const original = Worker.prototype.postMessage;
  const controls = [];
  let supervisor;
  try {
    supervisor = await SupervisedPooledActor.start(pool, bytes, {
      expectedSha256: digest(bytes), maxRestarts: 3,
      onControl: control => controls.push(control)
    });
    const old = supervisor.current();
    const awaitNext = supervisor.waitForGeneration(1);
    let injected = false;
    Worker.prototype.postMessage = function(message, ...rest) {
      if (!injected && message?.kind === "send") {
        injected = true;
        queueMicrotask(() => this.emit("message", {
          kind: "actor_fault", id: message.id,
          incarnation: message.incarnation, ticket: message.ticket,
          code: "STACK_BUDGET_EXHAUSTED_V1", result: null,
          frame: {schemaVersion: 1, frameBytes: 16,
            activeExecutions: 1, frameBytesInUse: 16, retired: false}
        }));
        return;
      }
      return original.call(this, message, ...rest);
    };
    await assert.rejects(old.send(64n),
      /invalid actor-local fault retirement receipt/);
    assert.equal(injected, true);
    await assert.rejects(awaitNext, /carrier physically retired/);
    assert.equal(supervisor.status.phase, "carrier-retired");
    assert.equal(supervisor.status.restarts, 0);
    assert.equal(pool.typedTerminalControlCount, 0,
      "malformed receipt cannot mint a typed terminal-control event");
    assert.equal(pool.isolatedGuestFaultCount, 0);
    assert.equal(pool.actorCount, 0);
    assert.equal(pool.activeWorkerCount, 0);
    assert.equal(controls.length, 1);
    assert.equal(controls[0].kind, "SUPERVISOR_CARRIER_TERMINAL_CONTROL");
    assert.equal(controls[0].physicalExitConfirmed, true);
    assert.equal(controls[0].restartAuthorized, false);
    await assert.rejects(old.send(1n), /STALE_ACTOR_GENERATION/);
  } finally {
    Worker.prototype.postMessage = original;
    await supervisor?.close();
    await pool.close();
  }
});


test("manual STOP rejects all 64 bounded pending generation waiters without restarting", {
  timeout: 90000
}, async () => {
  const bytes = wasmFixture();
  const pool = new PooledWasmActors({workers: 1, maxActors: 1});
  let supervisor;
  try {
    supervisor = await SupervisedPooledActor.start(pool, bytes, {
      expectedSha256: digest(bytes), maxRestarts: 4
    });
    const handle = supervisor.current();
    const waiters = Array.from({length: 64},
      () => supervisor.waitForGeneration(handle.generation));
    const settled = Promise.allSettled(waiters);
    await assert.rejects(supervisor.waitForGeneration(handle.generation),
      /waiter quota exceeded/);
    await handle.stop();
    const outcomes = await settled;
    assert.equal(outcomes.length, 64);
    for (const value of outcomes) {
      assert.equal(value.status, "rejected");
      assert.match(String(value.reason), /supervisor explicitly stopped/);
    }
    assert.equal(supervisor.status.phase, "stopped");
    assert.equal(supervisor.status.restarts, 0);
    assert.equal(pool.typedTerminalControlCount, 0);
    assert.equal(pool.actorCount, 0);
    assert.equal(pool.activeWorkerCount, 1);
    await assert.rejects(handle.send(1n), /STALE_ACTOR_GENERATION/);
  } finally {
    await supervisor?.close();
    await pool.close();
  }
});


test("concurrent close calls share one physical retirement barrier and exact settlement", {
  timeout: 90000
}, async () => {
  const bytes = wasmFixture();
  const pool = new PooledWasmActors({workers: 1, maxActors: 1});
  let supervisor;
  try {
    supervisor = await SupervisedPooledActor.start(pool, bytes, {
      expectedSha256: digest(bytes)
    });
    const old = supervisor.current();
    const first = supervisor.close();
    const second = supervisor.close();
    assert.strictEqual(first, second,
      "a second close cannot return success before first STOP has settled");
    assert.equal(supervisor.status.retirementHold, true);
    await Promise.all([first, second]);
    assert.equal(supervisor.status.phase, "closed");
    assert.equal(supervisor.status.retirementHold, false);
    assert.equal(pool.actorCount, 0);
    assert.equal(pool.activeWorkerCount, 1);
    await assert.rejects(old.send(1n), /STALE_ACTOR_GENERATION/);
    await supervisor.close();
  } finally {
    await supervisor?.close();
    await pool.close();
  }
});

test("failed STOP keeps a shared rejected close barrier and never reports retired", {
  timeout: 90000
}, async () => {
  const bytes = wasmFixture();
  const pool = new PooledWasmActors({workers: 1, maxActors: 1,
    timeoutMs: 5000, terminationTimeoutMs: 5000});
  const oldPost = Worker.prototype.postMessage;
  let supervisor;
  try {
    supervisor = await SupervisedPooledActor.start(pool, bytes, {
      expectedSha256: digest(bytes)
    });
    const handle = supervisor.current();
    let sabotaged = false;
    Worker.prototype.postMessage = function(message, ...rest) {
      if (!sabotaged && message?.kind === "stop") {
        sabotaged = true;
        queueMicrotask(() => this.emit("message", {
          kind: "fatal", id: message.id, incarnation: message.incarnation,
          ticket: message.ticket, reason: "forced STOP carrier fault"
        }));
        return;
      }
      return oldPost.call(this, message, ...rest);
    };
    const first = supervisor.close();
    const second = supervisor.close();
    assert.strictEqual(first, second);
    await assert.rejects(first, /forced STOP carrier fault/);
    await assert.rejects(second, /forced STOP carrier fault/);
    await assert.rejects(supervisor.close(), /forced STOP carrier fault/);
    assert.equal(sabotaged, true);
    assert.equal(supervisor.status.phase, "close-failed");
    assert.equal(supervisor.status.closed, true);
    assert.equal(supervisor.status.retirementHold, true,
      "a failed STOP must retain supervisor-owned retirement authority");
    assert.equal(pool.actorCount, 0);
    assert.equal(pool.activeWorkerCount, 0);
    await assert.rejects(handle.send(1n), /STALE_ACTOR_GENERATION/);
  } finally {
    Worker.prototype.postMessage = oldPost;
    await pool.close();
  }
});

test("invalid internal CONTROL must retain raw actor until an acknowledged STOP", {
  timeout: 90000
}, async () => {
  const bytes = wasmFixture();
  const pool = new PooledWasmActors({workers: 1, maxActors: 1});
  let observer;
  let stopCalls = 0;
  let supervisor;
  const original = pool.spawn;
  try {
    // Model-only hostile internal host callback; no guest or real carrier is
    // involved in this test. It verifies the explicit cleanup hold.
    pool.spawn = async (_bytes, {onTerminalControl}) => {
      observer = onTerminalControl;
      return {
        send: async value => value,
        stop: async () => {++stopCalls;}
      };
    };
    supervisor = await SupervisedPooledActor.start(pool, bytes, {
      expectedSha256: digest(bytes)
    });
    const handle = supervisor.current();
    observer({
      schemaVersion: 1, kind: "ACTOR_TERMINAL_CONTROL",
      reason: "STACK_BUDGET_EXHAUSTED_V1",
      actorRetired: false, frameQuiescent: false
    });
    assert.equal(supervisor.status.phase, "invalid-control");
    assert.equal(supervisor.status.restarts, 0);
    await assert.rejects(handle.send(1n), /STALE_ACTOR_GENERATION/);
    await supervisor.close();
    assert.equal(stopCalls, 1,
      "invalid CONTROL cannot discard raw resource before confirmed STOP");
    assert.equal(supervisor.status.phase, "closed");
    assert.equal(supervisor.status.retirementHold, false);
  } finally {
    pool.spawn = original;
    await supervisor?.close();
    await pool.close();
  }
});

test("abortable generation waiters free bounded slots and reject canceled tickets", {
  timeout: 90000
}, async () => {
  const bytes = wasmFixture();
  const pool = new PooledWasmActors({workers: 1, maxActors: 1});
  let supervisor;
  try {
    supervisor = await SupervisedPooledActor.start(pool, bytes, {
      expectedSha256: digest(bytes)
    });
    const generation = supervisor.current().generation;
    const controllers = Array.from({length: 64}, () => new AbortController());
    const waiters = controllers.map(({signal}) =>
      supervisor.waitForGeneration(generation, {signal}));
    const settled = Promise.allSettled(waiters);
    await assert.rejects(supervisor.waitForGeneration(generation),
      /waiter quota exceeded/);
    controllers.forEach(c => c.abort());
    const canceled = await settled;
    assert.equal(canceled.length, 64);
    for (const outcome of canceled) {
      assert.equal(outcome.status, "rejected");
      assert.match(String(outcome.reason), /generation waiter canceled/);
    }
    const next = supervisor.waitForGeneration(generation);
    await supervisor.current().stop();
    await assert.rejects(next, /supervisor explicitly stopped/);
    const already = new AbortController();
    already.abort();
    await assert.rejects(supervisor.waitForGeneration(generation, {
      signal: already.signal
    }), /generation waiter canceled|cannot publish another generation/);
    await assert.rejects(supervisor.waitForGeneration(generation, {
      signal: {}
    }), /host AbortSignal required/);
    assert.equal(pool.actorCount, 0);
  } finally {
    await supervisor?.close();
    await pool.close();
  }
});

test("retired actor slots can be reused without restoring old authority", {timeout: 90000}, async () => {
  const bytes = wasmFixture();
  const pool = new PooledWasmActors({workers: 1, maxActors: 1, timeoutMs: 5000});
  let old;
  try {
    for (let i = 0; i < 128; i++) {
      const actor = await pool.spawn(bytes, {trusted: true, expectedSha256: digest(bytes)});
      assert.equal(pool.actorCount, 1);
      if (old) await assert.rejects(old.send(1n), /actor not accepting messages/);
      assert.equal(await actor.send(7n), 7n);
      await actor.stop();
      assert.equal(pool.actorCount, 0);
      old = actor;
    }
    assert.equal(pool.activeWorkerCount, 1);
  } finally { await pool.close(); }
});
