import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {mkdtemp, readFile, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";

const manifest = readFileSync(new URL("../contracts/parity/scalar50/v1.tsv", import.meta.url));
const fingerprint = createHash("sha1").update(Buffer.from(`blob ${manifest.length}\0`))
  .update(manifest).digest("hex");
const expectedBlob = "a948dbaf594916a6ee07f65d49a0cf5ae398ca7b";

function rows() {
  assert.equal(fingerprint, expectedBlob, "reviewed canonical corpus changed");
  const text = new TextDecoder("utf-8", {fatal: true}).decode(manifest);
  assert.ok(text.endsWith("\n") && !text.includes("\r"), "manifest must use LF");
  const data = text.split("\n").filter(line => line && !line.startsWith("#"));
  assert.equal(data.length, 50, "must execute exactly fifty source cases");
  const result = data.map((line, i) => {
    const fields = line.split("\t");
    assert.equal(fields.length, 3, "bad canonical scalar record");
    assert.equal(fields[0], "scalar-" + String(i + 1).padStart(3, "0"));
    assert.match(fields[1], /^(0|[1-9][0-9]*)$/);
    const expected = BigInt(fields[1]);
    assert.ok(expected > 0n && expected < 128n, "native POSIX exit code must fit");
    assert.match(fields[2], /^pub fnc main\(\): int \{ return [-+*() 0-9]+; \}$/);
    return {id: fields[0], expected, program: fields[2]};
  });
  return result;
}

test("scalar50: source blob and all 50 immutable program records", () => {
  assert.equal(rows().length, 50);
});

test("scalar50: real Wasm compiler and guest outcomes (optional unless required)", async t => {
  const compiler = process.env.ORESLANG_LLVM_COMPILER;
  if (!compiler) {
    assert.equal(process.env.ORESLANG_REQUIRE_REAL_COMPILER, undefined,
      "real-compiler suite requested but no compiler supplied");
    t.skip("missing approved exact-head LLVM-to-Wasm compiler");
    return;
  }
  const declaredDigest = process.env.ORESLANG_LLVM_COMPILER_SHA256;
  assert.match(declaredDigest || "", /^[a-f0-9]{64}$/,
    "real compiler needs an exact binary SHA-256");
  assert.match(process.env.ORESLANG_LLVM_SOURCE_SHA || "", /^[a-f0-9]{40}$/,
    "real compiler needs an exact source commit");
  const bytes = (await readBoundedRegularFile(resolve(compiler), 256 * 1024 * 1024)).bytes;
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest, declaredDigest, "compiler binary provenance mismatch");
  const temp = await mkdtemp(join(tmpdir(), "ores-scalar50-wasm-"));
  try {
    const src = join(temp, "case.ores");
    const out = join(temp, "case.wasm");
    for (const row of rows()) {
      await t.test(row.id, async () => {
        await writeFile(src, row.program + "\n");
        await compileOresToWasm({compiler: resolve(compiler), compilerSha256: digest,
          source: src, output: out});
        const compiled = await readFile(out);
        const mod = new WebAssembly.Module(compiled);
        const guest = new WebAssembly.Instance(mod, {});
        assert.equal(guest.exports.main(), row.expected, row.id + ": guest mismatch");
      });
    }
  } finally {
    await rm(temp, {recursive: true, force: true});
  }
});
