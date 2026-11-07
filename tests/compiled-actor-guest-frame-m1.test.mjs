import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, writeFile, mkdtemp, lstat, rm} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join, isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {compileSourceActorToWasm} from "../scripts/compile-source-actor.mjs";
import {readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {PooledWasmActors} from "../src/pooled-actor-host.mjs";

const canonical = fileURLToPath(new URL("./fixtures/wasm32-single-source-actor.atto", import.meta.url));
const legacy = fileURLToPath(new URL("./fixtures/wasm32-single-source-actor.ores", import.meta.url));
const sourceGitBlob = "adfc0b43463d7ce92d32a4b1b63602f91e527329";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const gitBlob = bytes => createHash("sha1")
  .update(Buffer.from("blob " + bytes.length + "\0", "utf8"))
  .update(bytes).digest("hex");
const required = process.env.ATTO_REQUIRE_WASM_GUEST_FRAME === "1";

function identity(env) {
  const compiler = env.ORESLANG_LLVM_COMPILER || "";
  if (!isAbsolute(compiler)) throw Error("guest frame gate requires absolute native ORESLANG_LLVM_COMPILER");
  const compilerSha256 = env.ORESLANG_LLVM_COMPILER_SHA256 || "";
  if (!/^[a-f0-9]{64}$/.test(compilerSha256))
    throw Error("guest frame gate requires pinned LLVM compiler binary SHA-256");
  const sourceSha = env.ORESLANG_LLVM_SOURCE_SHA || "";
  const sourceTreeSha = env.ORESLANG_LLVM_SOURCE_TREE_SHA || "";
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^[a-f0-9]{40}$/.test(sourceTreeSha))
    throw Error("guest frame gate requires independently verified LLVM source HEAD and tree");
  return {compiler, compilerSha256, sourceSha, sourceTreeSha};
}

test("canonical .atto source actor pins exact legacy compiler source bytes", async () => {
  const [atto, ores] = await Promise.all([readFile(canonical), readFile(legacy)]);
  assert.equal(gitBlob(atto), sourceGitBlob);
  assert.equal(gitBlob(ores), sourceGitBlob);
  assert.deepEqual(atto, ores);
  assert.match(atto.toString("utf8"), /define actor Counter/);
  assert.match(atto.toString("utf8"), /on_message\(int increment\)/);
});

test("actor guest frame required gate fails closed on compiler/source provenance gaps", () => {
  assert.throws(() => identity({}), /absolute native/);
  assert.throws(() => identity({ORESLANG_LLVM_COMPILER: "relative/compiler"}), /absolute native/);
  assert.throws(() => identity({ORESLANG_LLVM_COMPILER: "/compiler"}), /binary SHA-256/);
  assert.throws(() => identity({ORESLANG_LLVM_COMPILER: "/compiler",
    ORESLANG_LLVM_COMPILER_SHA256: "a".repeat(64)}), /source HEAD and tree/);
  assert.deepEqual(identity({ORESLANG_LLVM_COMPILER: "/compiler",
    ORESLANG_LLVM_COMPILER_SHA256: "a".repeat(64),
    ORESLANG_LLVM_SOURCE_SHA: "b".repeat(40),
    ORESLANG_LLVM_SOURCE_TREE_SHA: "c".repeat(40)}).compiler, "/compiler");
});

test("native compiler emits bounded guest scalar frames and real pooled .atto actor turns", {
  skip: !required && !process.env.ORESLANG_LLVM_COMPILER,
  timeout: 240000
}, async t => {
  const {compiler, compilerSha256, sourceSha, sourceTreeSha} = identity(process.env);
  const read = await readBoundedRegularFile(compiler, 256 * 1024 * 1024,
    "native LLVM executable exceeds bounded read budget");
  assert.equal(sha256(read.bytes), compilerSha256,
    "LLVM compiler binary differs from independently approved pin");
  assert.ok(read.stat.mode & 0o111, "native compiler must be executable");
  const source = await readFile(canonical);
  assert.equal(gitBlob(source), sourceGitBlob);

  const scratch = await mkdtemp(join(tmpdir(), "atto-real-wasm-owned-frames-"));
  const privateCompiler = join(scratch, "verified-llvmc");
  try {
    // A temporary immutable compiler-byte snapshot is used for both the
    // generated-IR inspection and malformed recursive source denial.
    await writeFile(privateCompiler, read.bytes, {flag: "wx", mode: 0o500});
    const command = src => spawnSync(privateCompiler, ["--target=wasm32", src], {
      cwd: scratch, encoding: "utf8", timeout: 30000,
      maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      env: {PATH: process.env.PATH || ""}
    });
    const irResult = command(canonical);
    assert.equal(irResult.error, undefined);
    assert.equal(irResult.signal, null);
    assert.equal(irResult.status, 0, irResult.stderr);
    const ir = irResult.stdout;
    assert.match(ir, /target triple = "wasm32-unknown-unknown"/);
    assert.match(ir, /@oreslang\.wasm\.actor\.frame\.depth/);
    assert.match(ir, /@oreslang\.wasm\.actor\.frame\.slots = internal global \[64 x i64\]/);
    assert.match(ir, /atto\.actor\.guest\.frame\.message\.read/);
    assert.match(ir, /atto\.actor\.guest\.frame\.denied/);
    assert.match(ir, /atto\.actor\.guest\.frames\.clean/);
    assert.match(ir, /getelementptr inbounds \[64 x i64\]/);
    assert.match(ir, /store volatile i64/);
    assert.match(ir, /load volatile i64/);
    assert.doesNotMatch(ir, /message\.slot\s*=\s*alloca i64/,
      "guest parameter must no longer be allocated directly on engine stack");

    const built = await compileSourceActorToWasm({
      compiler, source: canonical, expectedCompilerSha256: compilerSha256
    });
    assert.equal(built.provenance.sourceSha256, sha256(source));
    assert.equal(built.provenance.compilerSha256, compilerSha256);
    assert.equal(built.provenance.llvmIrSha256, sha256(Buffer.from(ir, "utf8")),
      "IR checked independently must match compiled guest IR");
    assert.equal(built.provenance.wasmSha256, sha256(built.wasm));
    assert.equal(built.provenance.guestImports, 0);
    assert.equal(new WebAssembly.Module(built.wasm) instanceof WebAssembly.Module, true);
    assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(built.wasm)), []);

    const pool = new PooledWasmActors({workers: 1, maxActors: 3, timeoutMs: 5000});
    try {
      const a = await pool.spawn(built.wasm, {
        trusted: true, expectedSha256: built.provenance.wasmSha256
      });
      const b = await pool.spawn(built.wasm, {
        trusted: true, expectedSha256: built.provenance.wasmSha256
      });
      for (let n = 1; n <= 65; n++) {
        assert.equal(await a.send(1n), BigInt(n));
      }
      assert.equal(await b.send(7n), 7n);
      await a.stop();
      assert.equal(pool.activeWorkerCount, 1, "a healthy neighboring actor remains on its carrier");
      assert.equal(pool.actorCount, 1);
      await assert.rejects(a.send(1n), /not accepting/);
      assert.equal(await b.send(2n), 9n);
      const c = await pool.spawn(built.wasm, {
        trusted: true, expectedSha256: built.provenance.wasmSha256
      });
      assert.equal(await c.send(3n), 3n);
      assert.equal(await b.send(1n), 10n);
      await c.stop();
      await b.stop();
      assert.equal(pool.actorCount, 0);
    } finally {
      await pool.close();
    }

    // Unsupported recursive source is not evidence of an implemented
    // stackless actor frame ABI. It MUST reject before LLVM IR/artifacts.
    const original = source.toString("utf8");
    assert.ok(original.includes("    total = total + increment;\n    return total;\n"));
    const recursive = original.replace(
      "    total = total + increment;\n    return total;\n",
      "    return on_message(increment);\n");
    const recursivePath = join(scratch, "recursive-actor.atto");
    await writeFile(recursivePath, recursive, {flag: "wx", mode: 0o400});
    const denied = command(recursivePath);
    assert.equal(denied.error, undefined);
    assert.equal(denied.signal, null);
    assert.notEqual(denied.status, 0, "unsupported actor recursion was admitted");
    assert.equal(denied.stdout, "", "rejected recursive actor emitted executable LLVM IR");
    assert.match(denied.stderr || "", /oreslang-llvmc:/,
      "negative must be compiler-owned diagnostic");
    for (const artifact of ["recursive-actor.wasm", "recursive-actor.ll"]) {
      await assert.rejects(lstat(join(scratch, artifact)), {code: "ENOENT"});
    }
    t.diagnostic(JSON.stringify({
      kind: "actual-source-pooled-wasm-actor-frame-m1",
      sourceGitBlob, sourceSha256: sha256(source),
      llvmSourceHead: sourceSha, llvmSourceTree: sourceTreeSha,
      compilerSha256, wasmSha256: built.provenance.wasmSha256,
      llvmIrSha256: built.provenance.llvmIrSha256,
      workers: 1, actors: 2, actorAMessages: 65,
      siblingAliveAfterStop: true,
      checkedFrameMemory: true, recursiveActorAdmission: "REJECTED",
      actorRecursiveOverflowIsolation: "UNPROVEN",
      compiledGuestExecution: "EXECUTED"
    }));
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
});
