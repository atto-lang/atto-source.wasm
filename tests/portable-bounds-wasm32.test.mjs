// Portable bounds v1: source identity does not imply Wasm guest parity.
// Real acceptance requires the independently pinned LLVM compiler and
// actual wasm32 execution inside the existing import-free isolated runner.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileOresToWasm, readBoundedRegularFile } from "../scripts/compile-ores.mjs";
import { readAtomicRelease } from "../scripts/atomic-release.mjs";
import { runIsolatedCoreGuest } from "../src/isolated-runner.mjs";

const root = fileURLToPath(new URL("./fixtures/portable-bounds-v1/", import.meta.url));
const checkout = fileURLToPath(new URL("../", import.meta.url));
const expectedBlob = "a8ae98d0de39596ffad3a00be02d8f1e255de777";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const gitBlob = bytes => createHash("sha1")
  .update(Buffer.from("blob " + bytes.length + "\0")).update(bytes).digest("hex");
const required = process.env.ATTO_BOUNDS_WASM_PARITY_REQUIRED === "1";

function git(args) {
  const run = spawnSync("git", args, {
    cwd: checkout, encoding: "utf8", timeout: 5000, maxBuffer: 65536
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, "Git provenance failure: " + String(run.stderr).slice(0, 300));
  return run.stdout.trim();
}

async function input(name) {
  const { bytes } = await readBoundedRegularFile(join(root, name), 65536);
  return bytes;
}

test("portable bounds canonical .atto is byte-pinned, source-only", async () => {
  const bytes = await input("bounds.atto");
  assert.equal(gitBlob(bytes), expectedBlob);
  for (const name of ["main.atto", "invalid.atto"]) {
    const b = await input(name);
    assert.ok(b.length > 50 && b.toString("utf8").includes("valid_slice"),
      "missing real .atto import/mutation fixture: " + name);
  }
});

test("required LLVM-to-Wasm portable bounds guest + negative type check", {
  skip: !required, timeout: 180000
}, async () => {
  const compiler = process.env.ORESLANG_LLVM_COMPILER;
  const digest = process.env.ORESLANG_LLVM_COMPILER_SHA256;
  const sourceHead = process.env.ORESLANG_LLVM_SOURCE_SHA;
  const sourceTree = process.env.ORESLANG_LLVM_SOURCE_TREE;
  const expectedWasmHead = process.env.ATTO_BOUNDS_WASM_EXPECTED_HEAD;
  assert.ok(compiler && isAbsolute(compiler), "absolute real LLVM compiler is required");
  assert.match(digest || "", /^[0-9a-f]{64}$/, "reviewed LLVM compiler digest required");
  assert.match(sourceHead || "", /^[0-9a-f]{40}$/, "reviewed LLVM Git head required");
  assert.match(sourceTree || "", /^[0-9a-f]{40}$/, "reviewed LLVM root tree required");
  assert.match(expectedWasmHead || "", /^[0-9a-f]{40}$/, "expected Wasm checkout head required");
  assert.equal(git(["rev-parse", "HEAD"]), expectedWasmHead, "unexpected checkout head");
  const originalTree = git(["rev-parse", "HEAD^{tree}"]);
  const compilerBefore = await readBoundedRegularFile(compiler, 256 * 1024 * 1024);
  assert.equal(sha256(compilerBefore.bytes), digest, "untrusted or changed LLVM compiler binary");
  assert.equal(gitBlob(await input("bounds.atto")), expectedBlob);

  const work = await mkdtemp(join(tmpdir(), "atto-bounds-wasm-"));
  try {
    for (const name of ["bounds.atto", "main.atto", "invalid.atto"]) {
      await copyFile(join(root, name), join(work, name));
    }
    const output = join(work, "bounds.wasm");
    const receipt = await compileOresToWasm({
      compiler, compilerSha256: digest,
      source: join(work, "main.atto"), output,
      environment: "browser", publication: "atomic"
    });
    const released = await readAtomicRelease(output);
    assert.equal(receipt.compilerSha256, digest);
    assert.equal(released.manifest.wasmSha256, sha256(released.wasm));
    const executed = await runIsolatedCoreGuest(released.wasm, {
      expectedSha256: released.manifest.wasmSha256, timeoutMs: 5000
    });
    assert.equal(executed.value, 42n, "real wasm32 bounds guest must return i64 42");
    assert.equal(executed.admission.imports, 0, "unexpected ambient guest imports");
    assert.equal(executed.admission.hostCapabilities, 0, "unexpected host authority");

    const rejected = join(work, "rejected.wasm");
    await assert.rejects(
      () => compileOresToWasm({
        compiler, compilerSha256: digest,
        source: join(work, "invalid.atto"), output: rejected,
        environment: "browser", publication: "atomic"
      }),
      "invalid typed bounds call must fail in the real compiler"
    );
    for (const suffix of ["", ".artifact.json", ".current.json", ".releases"]) {
      await assert.rejects(stat(rejected + suffix), { code: "ENOENT" },
        "invalid source published output: " + suffix);
    }
    assert.equal(gitBlob(await input("bounds.atto")), expectedBlob, "source drift during run");
    assert.equal(git(["rev-parse", "HEAD"]), expectedWasmHead, "checkout moved during run");
    assert.equal(git(["rev-parse", "HEAD^{tree}"]), originalTree, "checkout tree changed");
    const after = await readBoundedRegularFile(compiler, 256 * 1024 * 1024);
    assert.equal(sha256(after.bytes), digest, "compiler bytes changed during execution");
    console.log("ATTO_PORTABLE_BOUNDS_WASM_GUEST_EXECUTED" +
      "|result=42|negative_rejected=1|zero_imports=1|source_git_blob=" +
      expectedBlob + "|llvm_source_head=" + sourceHead +
      "|llvm_source_tree=" + sourceTree +
      "|wasm_sha256=" + receipt.wasmSha256);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
