import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {readFile, writeFile, mkdtemp, rm} from "node:fs/promises";
import {join, isAbsolute} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {assertScalarActorAbi} from "../scripts/actor-scalar-abi.mjs";
import {compileSourceActorToWasm} from "../scripts/compile-source-actor.mjs";
import {readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {PooledWasmActors} from "../src/pooled-actor-host.mjs";

const canonical = fileURLToPath(
  new URL("../contracts/actor-stack-containment-v1/recursive-sibling.atto", import.meta.url));
const scalar = fileURLToPath(
  new URL("./fixtures/wasm32-single-source-actor.atto", import.meta.url));
const pinnedBlob = "947781cddf09d8e3e08c51cff2b7d8960e2d4750";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const gitBlob = bytes => createHash("sha1")
  .update(Buffer.from("blob " + bytes.length + "\0", "ascii"))
  .update(bytes).digest("hex");
const required = process.env.ATTO_REQUIRE_REAL_ACTOR_RECURSION === "1";
const compilerPath = process.env.ORESLANG_LLVM_COMPILER;

function identity(env = process.env) {
  const compiler = env.ORESLANG_LLVM_COMPILER || "";
  if (!isAbsolute(compiler)) throw Error("real checked recursion requires absolute native LLVM compiler path");
  const compilerSha256 = env.ORESLANG_LLVM_COMPILER_SHA256 || "";
  const sourceHead = env.ORESLANG_LLVM_SOURCE_SHA || "";
  const sourceTree = env.ORESLANG_LLVM_SOURCE_TREE_SHA || "";
  if (!/^[a-f0-9]{64}$/.test(compilerSha256))
    throw Error("real checked recursion requires pinned LLVM compiler binary SHA-256");
  if (!/^[a-f0-9]{40}$/.test(sourceHead) || !/^[a-f0-9]{40}$/.test(sourceTree))
    throw Error("real checked recursion requires independently reviewed LLVM source HEAD and tree");
  return {compiler, compilerSha256, sourceHead, sourceTree};
}

// These synthetic modules only exercise the host's binary ABI *admission*;
// they are not claimed to be .atto-compiled guest or stack-parity receipts.
function compiledSyntheticActor({statusType = "i32", statusReturn = "ret i32 0"} = {}) {
  const folder = mkdtempSync(join(tmpdir(), "atto-checked-actor-abi-"));
  try {
    const output = join(folder, "abi.wasm");
    const ir = [
      'target triple = "wasm32-unknown-unknown"',
      'define void @oreslang_wasm_actor_init() { ret void }',
      'define i64 @oreslang_wasm_actor_on_message(i64 %n) { ret i64 %n }',
      'define void @oreslang_wasm_actor_teardown() { ret void }',
      'define ' + statusType + ' @oreslang_wasm_actor_frame_status() { ' +
        (statusType === "i64" ? "ret i64 0" : statusReturn) + ' }',
      ""
    ].join("\n");
    const r = spawnSync(process.env.CLANG || "clang", [
      "--target=wasm32", "-x", "ir", "-Oz", "-nostdlib", "-Wl,--no-entry",
      "-Wl,--initial-memory=131072", "-Wl,--max-memory=131072",
      "-Wl,--export-memory",
      "-Wl,--export=oreslang_wasm_actor_init",
      "-Wl,--export=oreslang_wasm_actor_on_message",
      "-Wl,--export=oreslang_wasm_actor_teardown",
      "-Wl,--export=oreslang_wasm_actor_frame_status",
      "-o", output, "-"
    ], {input:ir,encoding:"utf8",timeout:30000});
    if(r.status !== 0 || r.error || r.signal)
      throw Error("Clang wasm32 synthetic ABI unavailable: " + String(r.stderr || r.error));
    return readFileSync(output);
  } finally {rmSync(folder,{recursive:true,force:true})}
}

test("real recursive actor source is byte-pinned across Wasm and LLVM", async () => {
  const source = await readFile(canonical);
  assert.equal(gitBlob(source), pinnedBlob);
  assert.match(source.toString("utf8"), /1 \+ descend\(depth - 1\)/);
  assert.match(source.toString("utf8"), /return descend\(depth\)/);
});

test("typed five-export actor ABI is opt-in and signature-checked", () => {
  const compiled = compiledSyntheticActor();
  assert.throws(() => assertScalarActorAbi(compiled), /expected exact actor lifecycle/);
  assert.equal(assertScalarActorAbi(compiled,{checkedRecursionV1:true}),true);
  assert.throws(() => assertScalarActorAbi(compiled,{checkedRecursionV1:"yes"}),
    /invalid checked recursion ABI selector/);
  const wrong = compiledSyntheticActor({statusType:"i64"});
  assert.throws(() => assertScalarActorAbi(wrong,{checkedRecursionV1:true}),
    /incorrect function signature: oreslang_wasm_actor_frame_status/);
});

test("checked compiler source + binary identity cannot default to implicit trust", () => {
  assert.throws(() => identity({}), /absolute native LLVM compiler path/);
  assert.equal(pinnedBlob.length,40);
});

test("real LLVM-compiled recursive .atto actor A fails at frame 65; B survives SAME Worker", {
  skip: !required && !compilerPath, timeout: 240000
}, async t => {
  const pin = identity();
  const executable = await readBoundedRegularFile(pin.compiler,256*1024*1024);
  assert.equal(sha256(executable.bytes),pin.compilerSha256);
  assert.ok(executable.stat.mode & 0o111,"native compiler must be executable");

  const atto = await readFile(canonical);
  assert.equal(gitBlob(atto),pinnedBlob);
  const compiled = await compileSourceActorToWasm({
    compiler:pin.compiler, source:canonical,
    expectedCompilerSha256:pin.compilerSha256,checkedRecursionV1:true
  });
  assert.equal(compiled.provenance.checkedRecursionV1,true);
  assert.equal(compiled.provenance.maxGuestFrames,64);
  assert.equal(compiled.provenance.sourceSha256,sha256(atto));
  assert.equal(compiled.provenance.compilerSha256,pin.compilerSha256);
  assert.equal(compiled.provenance.wasmSha256,sha256(compiled.wasm));
  assert.equal(compiled.provenance.guestImports,0);
  assert.equal(assertScalarActorAbi(compiled.wasm,{checkedRecursionV1:true}),true);

  const pool=new PooledWasmActors({workers:1,maxActors:3,timeoutMs:10000});
  try {
    const a=await pool.spawn(compiled.wasm,{
      trusted:true,expectedSha256:compiled.provenance.wasmSha256});
    const b=await pool.spawn(compiled.wasm,{
      trusted:true,expectedSha256:compiled.provenance.wasmSha256});
    assert.equal(pool.actorCount,2);
    assert.equal(pool.activeWorkerCount,1);
    for(const n of [0n,1n,7n,63n]){
      assert.equal(await a.send(n),n,"64 nested frames must be admitted");
    }
    assert.equal(await b.send(5n),5n);
    await assert.rejects(a.send(64n),/STACK_BUDGET_EXHAUSTED_V1/,
      "65th guest frame must return a typed terminal actor fault");
    assert.equal(pool.isolatedGuestFaultCount,1);
    assert.equal(pool.actorCount,1);
    assert.equal(pool.activeWorkerCount,1,"same physical carrier survives actor A overflow");
    await assert.rejects(a.send(1n),/not accepting/);
    assert.equal(await b.send(2n),2n,"actor B guest frame/heap unaffected");
    const fresh=await pool.spawn(compiled.wasm,{
      trusted:true,expectedSha256:compiled.provenance.wasmSha256});
    assert.equal(await fresh.send(1n),1n,"fresh incarnation starts with private guest frame");
    assert.equal(await b.send(3n),3n);
    await fresh.stop();
    await b.stop();
    assert.equal(pool.actorCount,0);
  } finally {await pool.close()}

  // Ordinary 75 is a legal result: legacy scalar actor ABI returns a
  // signed i64. The typed recursion status MUST NOT infer failure from 75.
  const legacy=await compileSourceActorToWasm({
    compiler:pin.compiler,source:scalar,
    expectedCompilerSha256:pin.compilerSha256
  });
  assert.equal(legacy.provenance.checkedRecursionV1,false);
  const legacyPool=new PooledWasmActors({workers:1,maxActors:1});
  try {
    const normal=await legacyPool.spawn(legacy.wasm,{
      trusted:true,expectedSha256:legacy.provenance.wasmSha256});
    assert.equal(await normal.send(75n),75n);
    assert.equal(legacyPool.isolatedGuestFaultCount,0);
    await normal.stop();
  } finally {await legacyPool.close()}

  const scratch=await mkdtemp(join(tmpdir(),"atto-checked-recursion-neg-"));
  try {
    const mutated=atto.toString("utf8").replace(
      "1 + descend(depth - 1)","1 + descend(depth - 2)");
    assert.notEqual(mutated,atto.toString("utf8"));
    const invalidSource=join(scratch,"wrong-recursive-step.atto");
    await writeFile(invalidSource,mutated,{mode:0o400,flag:"wx"});
    await assert.rejects(compileSourceActorToWasm({
      compiler:pin.compiler,source:invalidSource,
      checkedRecursionV1:true,expectedCompilerSha256:pin.compilerSha256
    }),/actor compilation command failed/);
  } finally {await rm(scratch,{recursive:true,force:true})}

  t.diagnostic(JSON.stringify({
    schema:"attolang.pooled_compiled_checked_actor_stack_v1",
    sourceGitBlob:pinnedBlob,sourceSha256:sha256(atto),
    llvmSourceHead:pin.sourceHead,llvmSourceTree:pin.sourceTree,
    compilerSha256:pin.compilerSha256,wasmSha256:compiled.provenance.wasmSha256,
    workers:1,admittedGuestFrames:64,firstRejectedFrame:65,
    actorATerminal:"STACK_BUDGET_EXHAUSTED_V1",
    actorBHealthyOnSameCarrier:true,freshActorResult:"1",
    normalI64Return75Accepted:true,
    supervisorControlReceipt:"NOT_EXECUTED",
    javaNativeLLVMIndependentGuestParity:"NOT_EXECUTED"
  }));
});
