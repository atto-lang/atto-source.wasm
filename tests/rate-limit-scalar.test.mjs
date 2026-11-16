import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

const source = fileURLToPath(new URL("../examples/rate-limit-weighted-scalar.ores", import.meta.url));
const name = "real Oreslang LLVM to Wasm rate-limit scalar executes 25";

test("rate-limit scalar source is byte-identical to LLVM and .NET fixtures", async () => {
  const bytes = await readFile(source);
  const hash = createHash("sha1")
    .update(Buffer.from("blob " + bytes.length + "\0"))
    .update(bytes).digest("hex");
  assert.equal(hash, "31a9b1097926d2ac3260f5536e6b576056f43f08");
});

test(name, async t => {
  const compiler = process.env.ORESLANG_LLVM_COMPILER;
  if (!compiler) {
    if (process.env.ORESLANG_REQUIRE_REAL_COMPILER === "1") {
      assert.fail("required Oreslang LLVM compiler is absent; never skip required guest execution");
    }
    t.skip("real native compiler opt-in required");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "ores-rate-limit-wasm-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const output = join(dir, "weighted.wasm");
  await compileOresToWasm({compiler: resolve(compiler), source, output});
  const bytes = await readFile(output);
  const {instance} = await WebAssembly.instantiate(bytes, {});
  assert.equal(typeof instance.exports.main, "function");
  assert.equal(instance.exports.main(), 25n);
});

test("rate-limit required guest CI rejects absent compiler without a silent skip", () => {
  const env = {...process.env, ORESLANG_REQUIRE_REAL_COMPILER: "1"};
  delete env.NODE_TEST_CONTEXT;
  delete env.ORESLANG_LLVM_COMPILER;
  delete env.ORESLANG_LLVM_COMPILER_SHA256;
  delete env.ORESLANG_LLVM_SOURCE_SHA;
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-name-pattern=^real Oreslang LLVM to Wasm rate-limit scalar executes 25$",
    fileURLToPath(import.meta.url)
  ], {env, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024});
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, "required compiler was skipped or stubbed");
  assert.match(result.stdout + result.stderr, /never skip required guest execution/);
});
