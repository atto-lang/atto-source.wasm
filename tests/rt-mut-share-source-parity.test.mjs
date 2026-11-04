import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp, writeFile, readFile, readdir, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {assertNativeMutShareDenial} from "../scripts/rt-mut-share-admission.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const expressions = [
  "rt mut share 42",
  "(rt mut share 42)",
  "1 + (rt mut share 2)",
  "rt mut share (rt borrow 3)",
  "rt mut share (rt mut borrow 4)",
  "rt mut share (rt mut share 5)",
  "rt mut share (SharedMutex.new(42))",
  "rt mut share (Arc.new(42))",
  "rt mut share (Box.new(42))",
  "rt mut share (Array.new(42))",
  "rt mut share (rt take owner)",
  "rt mut share (rt copy owner)"
];
const fixture = expression => "pub fnc main():int{return " + expression + ";}\n";
const preflightOnly = [
  "rt/* comment */mut share 99",
  "rt mut/* comment */share 99",
  "rt\nmut\nshare 99",
  "rt/* nested /* comment */ outer */mut share 99",
  "rt mut share 6" // One deliberate legacy .ores source-name fixture.
];
const preflightExpressions = [...expressions, ...preflightOnly];

// The Wasm bridge deliberately denies heap/shared alias operations before
// invoking LLVM. This HOST PREFLIGHT test must not pretend that a rejection
// from compileOresToWasm proves native compiler execution.
test("Wasm preflight rejects shared mutation without executing or publishing a compiler", {
  timeout: 30000
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "atto-wasm-mutshare-preflight-"));
  try {
    const marker = join(root, "compiler-was-invoked");
    const compiler = join(root, "never-run-compiler");
    const fake = "#!/bin/sh\n: > '" + marker + "'\necho 'unexpected compiler invocation' >&2\nexit 1\n";
    await writeFile(compiler, fake, {mode: 0o700});
    const compilerSha256 = digest(Buffer.from(fake));
    for (const [index, expression] of preflightExpressions.entries()) {
      const extension = index === preflightExpressions.length - 1 ? ".ores" : ".atto";
      const source = join(root, "case-" + index + extension);
      const output = join(root, "case-" + index + ".wasm");
      const sourceBytes = fixture(expression);
      await writeFile(source, sourceBytes);
      const entriesBefore = (await readdir(root)).sort();
      await assert.rejects(
        compileOresToWasm({
          compiler, compilerSha256, source, output,
          environment: "browser", publication: "atomic"
        }),
        /wasm heap loan\/transfer lowering unsupported at byte /,
        "Wasm must reject unsupported ownership at preflight, not via compiler error"
      );
      assert.equal(await readFile(source, "utf8"), sourceBytes,
        "preflight must not rewrite the source");
      assert.deepEqual((await readdir(root)).sort(), entriesBefore,
        "preflight rejection created staging or published artifacts");
      await assert.rejects(stat(marker), {code: "ENOENT"},
        "preflight unexpectedly invoked the compiler");
      await assert.rejects(stat(output + ".current.json"), {code: "ENOENT"},
        "preflight published a Wasm release pointer");
    }
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

// This is a DIFFERENT gate: direct execution of a pinned real LLVM compiler.
// It proves the native parser rejected each .atto input, but NOT that Wasm
// linked or published guest code. No copied private source or fallback compiler.
test("real exact-byte LLVM compiler rejects unsupported shared mutation", {
  timeout: 180000,
  skip: !process.env.ORESLANG_LLVM_COMPILER
    && process.env.ORESLANG_MUT_SHARE_PARITY_REQUIRED !== "1"
}, async () => {
  const compiler = process.env.ORESLANG_LLVM_COMPILER;
  assert.ok(compiler, "real LLVM compiler is required for source admission");
  const compilerSha256 = process.env.ORESLANG_LLVM_COMPILER_SHA256;
  assert.match(compilerSha256 ?? "", /^[a-f0-9]{64}$/,
    "must pin compiler binary SHA-256");
  assert.match(process.env.ORESLANG_LLVM_SOURCE_SHA ?? "", /^[a-f0-9]{40}$/,
    "must record the exact LLVM source commit (externally verified by CI)");
  assert.match(process.env.ORESLANG_LLVM_SOURCE_TREE ?? "", /^[a-f0-9]{40}$/,
    "must record the exact LLVM source tree (externally verified by CI)");
  const snapshot = await readBoundedRegularFile(compiler, 256 * 1024 * 1024,
    "invalid native LLVM compiler executable");
  assert.equal(digest(snapshot.bytes), compilerSha256,
    "native compiler bytes differ from pinned SHA-256");
  const root = await mkdtemp(join(tmpdir(), "atto-llvm-mutshare-"));
  try {
    const stagedCompiler = join(root, "compiler-exact");
    await writeFile(stagedCompiler, snapshot.bytes, {mode: 0o500, flag: "wx"});
    for (const [index, expression] of expressions.entries()) {
      const source = join(root, "case-" + index + ".atto");
      const sourceBytes = fixture(expression);
      await writeFile(source, sourceBytes);
      const entriesBefore = (await readdir(root)).sort();
      const result = spawnSync(stagedCompiler,
        ["--tree-shake", "--tree-shake-root=main", "--target=wasm32", source],
        {encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
         windowsHide: true, cwd: root});
      const failure = new Error("command failed (" + stagedCompiler + "): " +
        (result.error?.message || result.stderr || "exit " + result.status).slice(0, 4000));
      failure.status = result.status;
      failure.signal = result.signal;
      failure.stdout = result.stdout || "";
      failure.stderr = result.stderr || "";
      if (result.error) {
        failure.code = result.error.code;
        failure.errno = result.error.errno;
        failure.syscall = result.error.syscall;
        failure.cause = result.error;
      }
      assert.equal(assertNativeMutShareDenial(failure), true,
        "the real LLVM compiler must emit the controlled capability denial");
      // Parser.cpp reports the byte position of the first 'share' token.
      const at = sourceBytes.indexOf("rt mut share");
      assert.ok(at >= 0, "test fixture does not contain guarded sharing");
      const expectedByte = Buffer.byteLength(
        sourceBytes.slice(0, at + "rt mut ".length), "utf8");
      assert.match(failure.stderr, new RegExp(
        "refusing unsynchronized alias at byte " + expectedByte + "\\r?\\n?$"),
        "denial offset must identify the rejected source expression");
      assert.equal(await readFile(source, "utf8"), sourceBytes,
        "native compiler altered source input");
      assert.deepEqual((await readdir(root)).sort(), entriesBefore,
        "native rejection created artifacts");
      assert.equal(digest((await readBoundedRegularFile(stagedCompiler,
        256 * 1024 * 1024)).bytes), compilerSha256,
        "staged native compiler changed during admission");
    }
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
