import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp, writeFile, readFile, readdir, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {assertNativeMutShareDenial} from "../scripts/rt-mut-share-admission.mjs";

// This is an executable LLVM-source -> Wasm publication gate, not a native
// SharedMutex implementation. Missing compiler evidence must not count as pass.
test("rt mut share refuses unsynchronized aliases without publishing wasm", {
  timeout: 180000,
  skip: !process.env.ORESLANG_LLVM_COMPILER
    && process.env.ORESLANG_MUT_SHARE_PARITY_REQUIRED !== "1"
}, async () => {
  const compiler = process.env.ORESLANG_LLVM_COMPILER;
  assert.ok(compiler, "real LLVM compiler is required for guarded sharing gate");
  const compilerSha256 = process.env.ORESLANG_LLVM_COMPILER_SHA256;
  assert.match(compilerSha256 ?? "", /^[a-f0-9]{64}$/, "must pin real compiler bytes");
  assert.match(process.env.ORESLANG_LLVM_SOURCE_SHA ?? "", /^[a-f0-9]{40}$/,
    "must pin the exact LLVM compiler source head");
  const snapshot = await readBoundedRegularFile(compiler, 256 * 1024 * 1024,
    "invalid native compiler binary");
  assert.equal(createHash("sha256").update(snapshot.bytes).digest("hex"),
    compilerSha256, "compiler bytes differ from attested exact head");

  const root = await mkdtemp(join(tmpdir(), "ores-wasm-mutshare-"));
  try {
    // The bridge deliberately rejects heap loans before native invocation.
    // Independently execute the same pinned compiler to prove its denial too.
    const stagedCompiler = join(root, "compiler-exact");
    await writeFile(stagedCompiler, snapshot.bytes, {mode:0o500,flag:"wx"});
    const expressions = [
      "rt mut share 42",
      "(rt mut share 42)",
      "1 + (rt mut share 2)",
      "rt mut share (rt borrow 3)",
      "rt mut share (rt mut borrow 4)",
      "rt mut share (rt mut share 5)",
      // Heap handles must never be promoted by the LLVM-to-Wasm adapter.
      "rt mut share (SharedMutex.new(42))",
      "rt mut share (Arc.new(42))",
      "rt mut share (Box.new(42))",
      "rt mut share (Array.new(42))",
      "rt mut share (rt take owner)",
      "rt mut share (rt copy owner)"
    ];
    for (const [index, expression] of expressions.entries()) {
      const source = join(root, `case-${index}.ores`);
      const output = join(root, `case-${index}.wasm`);
      const sourceBytes = `pub fnc main():int{return ${expression};}\n`;
      await writeFile(source, sourceBytes);
      const entriesBefore = (await readdir(root)).sort();
      await assert.rejects(
        compileOresToWasm({
          compiler, compilerSha256, source, output,
          environment: "browser", publication: "atomic"
        }),
        error => error instanceof Error && /^wasm heap loan\/transfer lowering unsupported at byte [0-9]+$/.test(error.message)
      );
      const result = spawnSync(stagedCompiler,
        ["--tree-shake","--tree-shake-root=main","--target=wasm32",source],
        {encoding:"utf8",timeout:15000,maxBuffer:2*1024*1024});
      assert.ifError(result.error);
      assertNativeMutShareDenial({
        message: "command failed ("+stagedCompiler+"): "+result.stderr.trimEnd(),
        stdout:result.stdout,stderr:result.stderr,status:result.status,signal:result.signal
      });
      assert.equal(createHash("sha256").update(await readFile(stagedCompiler)).digest("hex"),
        compilerSha256,"staged compiler changed during denial");
      assert.equal(await readFile(source, "utf8"), sourceBytes,
        "failed compilation must not rewrite its source fixture");
      assert.deepEqual((await readdir(root)).sort(), entriesBefore,
        "rejected mutable sharing created a temporary compiler/Wasm artifact");
      for (const candidate of [output, output + ".current.json"]) {
        await assert.rejects(stat(candidate), {code:"ENOENT"},
          "rejected mutable sharing must never publish a Wasm artifact");
      }
    }
  } finally {
    await rm(root, {recursive:true, force:true});
  }
});
