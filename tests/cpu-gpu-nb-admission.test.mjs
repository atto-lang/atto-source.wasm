import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync} from "node:fs";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join, isAbsolute} from "node:path";
import {spawnSync} from "node:child_process";

// Wasm has no independently implemented source frontend. Validate the REAL
// LLVM frontend only when it is supplied; never pass via a pretend compiler.
const compiler = process.env.ORESLANG_LLVM_COMPILER;
const pinnedSha256 = process.env.ORESLANG_LLVM_COMPILER_SHA256;

// A syntax error mentioning "gpu" is not proof of fail-closed domain admission.
// Require a domain identifier AND an explicit capability/refusal reason.
function isDomainRefusal(stderr) {
  return /\b(cpu|gpu|nb|nonblocking)\b|execution[- ]domain/i.test(stderr) &&
    /\b(unsupported|unavailable|reserved|disabled|unimplemented)\b|not[ -](?:yet[ -])?(?:implemented|supported|lowered)/i.test(stderr) &&
    /\b(execution|regions?|graph|lowering|source|placement)\b|execution[- ]domain/i.test(stderr);
}

test("source-free refusal classifier rejects unrelated diagnostics", () => {
  for (const diagnostic of [
    "error: syntax error near gpu",
    "error: CPU input file could not be opened",
    "error: parse failed on nb",
    "error: unsupported integer syntax"
  ]) assert.equal(isDomainRefusal(diagnostic), false, diagnostic);
  for (const diagnostic of [
    "CPU/GPU execution domain and nb graph lowering unsupported; no implicit CPU fallback",
    "gpu source execution is not yet lowered",
    "nb CPU regions disabled"
  ]) assert.equal(isDomainRefusal(diagnostic), true, diagnostic);
});

test("CPU/GPU/nb nested regions fail closed before Wasm compilation", {
  skip: !compiler && !pinnedSha256 && "requires the pinned real oreslang-llvmc"
}, () => {
  // Runner configuration is not proof of a genuine compiler. Require
  // an independently reviewed binary SHA-256 before interpreting any
  // negative-source diagnostic or emitted LLVM IR as conformance.
  assert.match(pinnedSha256 ?? "", /^[0-9a-f]{64}$/i,
    "ORESLANG_LLVM_COMPILER_SHA256 must pin the exact executable");
  assert.ok(isAbsolute(compiler), "compiler path must be absolute");
  assert.ok(statSync(compiler).isFile(), "compiler must be a regular file");
  const digest = createHash("sha256").update(readFileSync(compiler)).digest("hex");
  assert.equal(digest, pinnedSha256.toLowerCase(),
    "actual LLVM compiler bytes differ from approved binary SHA-256");
  const dir = mkdtempSync(join(tmpdir(), "ores-wasm-domain-"));
  try {
    const file = join(dir, "main.ores");
    const negatives = [
      "fnc main():int{const x = gpu {}; return 1;}",
      "fnc main():int{const x = cpu {}; return 1;}",
      "fnc main():int{const x = nb gpu {}; return 1;}",
      "fnc main():int{const x = nb cpu {}; return 1;}",
      "fnc main():int{gpu { cpu { gpu {} } }; return 1;}",
      "fnc main():int{nb gpu { nb cpu {} }; return 1;}",
    ];
    for (const source of negatives) {
      writeFileSync(file, source);
      const compiled = spawnSync(compiler, [file], {
        encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
        cwd: dir
      });
      assert.equal(compiled.error, undefined, compiled.error?.message);
      assert.equal(compiled.signal, null, "compiler timed out or was killed");
      assert.equal(compiled.status, 1, source);
      assert.equal(compiled.stdout, "", "invalid source emitted LLVM IR");
      assert.equal(isDomainRefusal(compiled.stderr), true,
        "rejection must give a domain-specific unsupported/unavailable reason, not a generic syntax or IO error");
      assert.deepEqual(readdirSync(dir).sort(), ["main.ores"],
        "failed compilation published an unexpected artifact");
    }
    writeFileSync(file, "fnc main():int{return 42;} // nb gpu { cpu {} }");
    const positive = spawnSync(compiler, [file], {
      encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
      cwd: dir
    });
    assert.equal(positive.error, undefined, positive.error?.message);
    assert.equal(positive.signal, null, "positive scalar compiler timed out");
    assert.equal(positive.status, 0, positive.stderr);
    assert.match(positive.stdout, /^; ModuleID/);
    assert.deepEqual(readdirSync(dir).sort(), ["main.ores"],
      "scalar control unexpectedly published an artifact");
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
