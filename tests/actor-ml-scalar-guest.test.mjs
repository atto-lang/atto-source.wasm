import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve, join} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

const fixtureUrl = new URL("../examples/actor-ml-scalar-step.ores", import.meta.url);
const expectedSha = "37dfb0ba856762dc656b628a085684558e5ac1d0392ccd6947d6ccdc35ed7d8e";

test("actor/ML scalar guest source is byte-identical to all other toolchains", async () => {
  const source = await readFile(fixtureUrl);
  assert.equal(createHash("sha256").update(source).digest("hex"), expectedSha);
  assert.equal(source.toString("utf8"),
    "pub fnc main(): int { return 2 - 1 * (2 * 1 - 42) * 1; }\\n");
});

test("actual LLVM-to-Wasm guest must compute identical scalar gradient step 42", async t => {
  const compiler = process.env.ORESLANG_LLVM_COMPILER;
  if (!compiler) {
    if (process.env.ORESLANG_REQUIRE_REAL_COMPILER === "1")
      assert.fail("required Oreslang Wasm guest was skipped: missing compiler");
    t.skip("real LLVM-to-Wasm compiler is not available");
    return;
  }
  const temp = await mkdtemp(join(tmpdir(), "oreslang-wasm-actor-ml-scalar-"));
  t.after(async () => rm(temp, {recursive:true, force:true}));
  const output = join(temp, "actor-ml-scalar-step.wasm");
  // Never substitute a JavaScript numerical oracle for native guest output.
  await compileOresToWasm({
    compiler:resolve(compiler),
    source:resolve(new URL(fixtureUrl).pathname),
    output
  });
  const bytes = await readFile(output);
  const {instance} = await WebAssembly.instantiate(bytes, {});
  assert.equal(typeof instance.exports.main, "function",
    "missing canonical WASM exported main");
  assert.equal(instance.exports.main(), 42n);
});
