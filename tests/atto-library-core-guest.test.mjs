import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

const fixture = fileURLToPath(new URL("../contracts/atto-library-core-v1/core-numeric.atto", import.meta.url));
const EXPECTED_BLOB = "395695e5b1a6c40d56db323943b34f1012b76c7c";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const blob = bytes => createHash("sha1").update(
  Buffer.from("blob " + bytes.length + "\0")).update(bytes).digest("hex");
const required = process.env.ATTO_REQUIRE_COMPILER_GUEST === "1";

test("canonical atto.core fixture is byte-pinned (.atto, SOURCE ONLY)", async () => {
  const bytes = await readFile(fixture);
  assert.equal(blob(bytes), EXPECTED_BLOB, "canonical source blob drift");
  assert.match(bytes.toString("utf8"), /import module numeric from "atto\.core\/numeric";/);
  assert.doesNotMatch(bytes.toString("utf8"), /"ores\.|"alloc\//);
});

// There is no fake compiler fallback. This test is SKIPPED in source-only CI;
// explicit required mode fails closed if a compiler binary/provenance is absent.
test("LLVM -> wasm32 canonical Atto Core guest execution and negative imports", {
  skip: !required, timeout: 120000
}, async () => {
  const compiler = process.env.ORESLANG_LLVM_COMPILER;
  const compilerDigest = process.env.ORESLANG_LLVM_COMPILER_SHA256;
  const llvmHead = process.env.ORESLANG_LLVM_SOURCE_SHA;
  assert.ok(compiler && compiler.startsWith("/"), "absolute LLVM compiler path required");
  assert.match(compilerDigest || "", /^[0-9a-f]{64}$/, "compiler SHA256 required");
  assert.match(llvmHead || "", /^[0-9a-f]{40}$/, "compiler Git HEAD required");
  const actual = await readBoundedRegularFile(compiler, 256 * 1024 * 1024);
  assert.equal(sha256(actual.bytes), compilerDigest, "compiler binary mismatch");
  const original = await readFile(fixture);
  assert.equal(blob(original), EXPECTED_BLOB, "source mutation before compilation");

  const temp = await mkdtemp(join(tmpdir(), "atto-core-wasm-"));
  try {
    const output = join(temp, "numeric.wasm");
    const published = await compileOresToWasm({
      compiler, compilerSha256: compilerDigest, source: fixture,
      output, environment: "browser", publication: "atomic"
    });
    const release = await readAtomicRelease(output);
    assert.equal(published.sourceSha256, sha256(original));
    assert.equal(published.compilerSha256, compilerDigest);
    assert.equal(published.wasmSha256, sha256(release.wasm));
    assert.equal(release.manifest.wasmSha256, published.wasmSha256);
    const observed = await runIsolatedCoreGuest(release.wasm, {
      expectedSha256: published.wasmSha256, timeoutMs: 5000
    });
    assert.equal(observed.value, 42n, "real compiler-created Wasm guest result");
    assert.equal(observed.admission.imports, 0, "ambient host imports");
    assert.equal(observed.admission.hostCapabilities, 0, "ambient host capability");

    const negative = [
      ["std", 'import module fs from "atto.std/fs";\npub fnc main():int{return 42;}\n', /atto\.std/],
      ["alloc", 'import module b from "atto.alloc/int_buffer_bundle";\npub fnc main():int{return b.marker();}\n', /allocator/],
      ["unknown-core", 'import module n from "atto.core/missing";\npub fnc main():int{return 42;}\n', /unknown compiler-owned atto\.core/],
      ["traversal", 'import module n from "atto.core\/..\/numeric";\npub fnc main():int{return 42;}\n', /unknown compiler-owned atto\.core/]
    ];
    for (const [name, source, diagnostic] of negative) {
      const file = join(temp, "reject-" + name + ".atto");
      await writeFile(file, source, {flag:"wx", mode:0o400});
      const denial = spawnSync(compiler, ["--target=wasm32", "--library-profile=core", file], {
        encoding:"utf8", timeout:30000, maxBuffer:4*1024*1024
      });
      assert.equal(denial.error, undefined, name + " compiler unavailable");
      assert.equal(denial.signal, null, name + " compiler died by signal");
      assert.equal(denial.status, 1, name + " should be diagnosed at frontend");
      assert.equal(denial.stdout, "", name + " must not emit partial IR");
      assert.match(denial.stderr || "", diagnostic, name + " missing compiler diagnostic");
    }
    assert.equal(blob(await readFile(fixture)), EXPECTED_BLOB, "source drift after execution");
    console.log("ATTO_CANONICAL_CORE_WASM_GUEST_EXECUTED" +
      "|result=42|host_imports=0|host_capabilities=0" +
      "|source_git_blob=" + EXPECTED_BLOB +
      "|wasm_sha256=" + published.wasmSha256 +
      "|compiler_sha256=" + compilerDigest +
      "|llvm_head=" + llvmHead +
      "|negative_rejections=" + negative.length);
    assert.equal(sha256((await readBoundedRegularFile(
      compiler, 256 * 1024 * 1024)).bytes), compilerDigest, "compiler changed during run");
  } finally {
    await rm(temp, {recursive:true, force:true});
  }
});
