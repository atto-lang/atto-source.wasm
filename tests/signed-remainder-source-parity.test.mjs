import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, writeFile, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";
import {cleanupRealCompilerWorkspace} from "../scripts/cleanup-real-compiler.mjs";

// Depend on a real, separately reviewed LLVM compiler with signed-literal
// remainder lowering. This file never ships a mock parser or Wasm module.
const required = process.env.ORESLANG_SIGNED_REMAINDER_REQUIRED === "1";
const compiler = process.env.ORESLANG_LLVM_COMPILER;
const enabled = Boolean(compiler) || required;
const positives = [
  ["minus-seven-mod-three", "-7 % 3", -1n],
  ["seven-mod-minus-three", "7 % -3", 1n],
  ["both-negative", "-7 % -3", -1n],
  ["precedence", "8 % 3 * 2", 4n],
  ["left-associative", "20 % 6 % 3", 2n],
  ["minimum-minus-one", "-9223372036854775808 % -1", 0n],
  ["minimum-minus-minimum", "-9223372036854775808 % -9223372036854775808", 0n],
  ["maximum-minus-minimum", "9223372036854775807 % -9223372036854775808", 9223372036854775807n]
];
const negatives = [
  ["zero-divisor", "7 % 0", /nonzero signed integer literal divisor/],
  ["computed-divisor", "7 % (1+1)", /nonzero signed integer literal divisor/],
  ["negative-computed-divisor", "7 % -(1+1)", /nonzero signed integer literal divisor/],
  ["out-of-range-divisor", "7 % -9223372036854775809",
    /integer|literal|out.of.range|overflow/i],
  ["float-division-not-int", "7 / 2", /floating division|float result/i]
];

test("pinned LLVM signed-literal remainder compiles and executes in a real isolated wasm32 guest", {
  skip: !enabled,
  timeout: 180000
}, async () => {
  assert.ok(compiler, "required real compiler missing; no skipped parity success");
  const compilerSha256 = process.env.ORESLANG_LLVM_COMPILER_SHA256;
  const sourceSha = process.env.ORESLANG_LLVM_SOURCE_SHA;
  assert.match(compilerSha256 || "", /^[0-9a-f]{64}$/,
    "real LLVM executable SHA-256 pin is mandatory");
  assert.match(sourceSha || "", /^[0-9a-f]{40}$/,
    "reviewed LLVM source HEAD pin is mandatory");
  const compilerBytes = (await readBoundedRegularFile(
    compiler, 256 * 1024 * 1024, "invalid bounded LLVM compiler"
  )).bytes;
  assert.equal(createHash("sha256").update(compilerBytes).digest("hex"), compilerSha256);

  const work = await mkdtemp(join(tmpdir(), "ores-wasm-remainder-"));
  const input = join(work, "source.ores");
  try {
    for (const [id, expression, expected] of positives) {
      const source = "pub fnc main():int{return " + expression + ";}\n";
      const sourceSha256 = createHash("sha256").update(source).digest("hex");
      await writeFile(input, source);
      const output = join(work, id + ".wasm");
      const compiled = await compileOresToWasm({
        compiler, compilerSha256, source: input, output,
        environment: "browser", publication: "atomic"
      });
      const release = await readAtomicRelease(output);
      assert.equal(compiled.compilerSha256, compilerSha256);
      assert.equal(compiled.sourceSha256, sourceSha256);
      assert.equal(compiled.wasmSha256, release.manifest.wasmSha256);
      assert.equal(release.provenance.sourceSha256, sourceSha256);
      assert.deepEqual(release.manifest.imports, []);
      assert.deepEqual(release.manifest.requiredCapabilities, []);
      const observed = await runIsolatedCoreGuest(release.wasm, {
        expectedSha256: compiled.wasmSha256, timeoutMs: 5000
      });
      assert.equal(observed.value, expected, id + " full-width signed i64");
      assert.equal(observed.admission.hostCapabilities, 0);
      assert.equal(observed.admission.imports, 0);
    }
    for (const [id, expression, requiredDiagnostic] of negatives) {
      await writeFile(input, "pub fnc main():int{return " + expression + ";}\n");
      const output = join(work, "rejected-" + id + ".wasm");
      await assert.rejects(
        compileOresToWasm({
          compiler, compilerSha256, source: input, output,
          environment: "browser", publication: "atomic"
        }),
        error => {
          const message = String(error?.message || "");
          // A broken compiler invocation, linker, runner or bridge is not
          // evidence that Oreslang diagnosed the intended source error.
          const diagnostic = message.match(/oreslang-llvmc:([^\\n]*)/i)?.[1] || "";
          return requiredDiagnostic.test(diagnostic) &&
            !/unknown option|not found|permission denied|failed to execute/i.test(message);
        },
        id + " must return the expected native compiler semantic diagnostic"
      );
      await assert.rejects(stat(output + ".current.json"), {code: "ENOENT"},
        "rejected guest may not publish an atomic release pointer");
    }
    // A modulo -1 must *not* erase a checked-overflow trap in its
    // numerator: returning zero here would violate Java's i64 contract.
    const overflowSource =
      "pub fnc main():int{return (9223372036854775807 + 1) % -1;}\\n";
    await writeFile(input, overflowSource);
    const overflowOutput = join(work, "overflow-before-minus-one.wasm");
    let overflowPublished = false;
    try {
      const compiled = await compileOresToWasm({
        compiler, compilerSha256, source: input, output: overflowOutput,
        environment: "browser", publication: "atomic"
      });
      overflowPublished = true;
      const release = await readAtomicRelease(overflowOutput);
      await assert.rejects(
        runIsolatedCoreGuest(release.wasm, {
          expectedSha256: compiled.wasmSha256, timeoutMs: 5000
        }),
        error => /^guest rejected or failed: (?:unreachable|integer overflow)/i
          .test(String(error?.message || "")),
        "overflow-before-remainder must execute a real guest trap, not wrap to zero"
      );
    } catch (error) {
      if (overflowPublished) throw error;
      const message = String(error?.message || "");
      assert.match(message, /oreslang-llvmc:/,
        "compiler rejection must come from the verified native frontend");
      assert.match(message, /overflow|out.of.range|invalid i64/i,
        "compiler rejection must explain the checked overflow");
      await assert.rejects(stat(overflowOutput + ".current.json"), {code: "ENOENT"});
    }
  } finally {
    await cleanupRealCompilerWorkspace(work);
  }
});
