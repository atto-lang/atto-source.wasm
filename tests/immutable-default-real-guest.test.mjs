import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, writeFile, readFile, stat} from "node:fs/promises";
import {cleanupRealCompilerWorkspace} from "../scripts/cleanup-real-compiler.mjs";
import {join, resolve} from "node:path";
import {tmpdir} from "node:os";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

// Required mode must not silently skip. This suite exercises the REAL
// pinned LLVM compiler -> wasm32 bridge -> WebAssembly guest, not a mock.
const compiler = process.env.ORESLANG_LLVM_COMPILER;
const required = process.env.ORESLANG_REQUIRE_REAL_COMPILER === "1";
const pin = process.env.ORESLANG_LLVM_COMPILER_SHA256;
const positives = [
  ["typed-default", "int x = 7; return x;", 7n],
  ["const-inferred", "const x = 7; return x;", 7n],
  ["const-typed", "const int x = 7; return x;", 7n],
  ["const-colon", "const x: int = 7; return x;", 7n],
  ["typed-runtime", "int x = 7; int y = x * 3; return y;", 21n],
  ["const-dependency", "const x = 7; const y = x * 3; return y;", 21n],
];
const negatives = [
  "int x = 7; x = 8; return x;",
  "const x = 7; x = 8; return x;",
  "int x = 7; x += 1; return x;",
  "int x = x + 1; return x;",
  "int x = y; int y = 7; return x;",
  "int x = 7; int x = 8; return x;",
  "const x; return 7;",
  "const x = missing_value; return x;",
  "string x = 7; return 0;",
  "int x = 7; rt mut borrow x; return x;",
  "int x = 7; const y = x + 1; return y;",
];

test("immutable-default real-Wasm evidence admission", async t => {
  if (!compiler) {
    if (required) throw Error("required real Oreslang LLVM compiler is missing");
    t.skip("real LLVM compiler unavailable; NOT a Wasm guest parity pass");
    return;
  }
  if (!pin || !/^[0-9a-f]{64}$/.test(pin)) {
    if (required) throw Error("required SHA-256 compiler pin missing/invalid");
    t.skip("SHA-256 compiler provenance absent; no parity credit");
    return;
  }
  const digest = createHash("sha256").update(await readFile(resolve(compiler))).digest("hex");
  assert.equal(digest, pin, "LLVM compiler binary digest mismatch");
});

async function admitted(t) {
  if (!compiler || !pin) {
    if (required) throw Error("required compiler and SHA-256 pin missing");
    t.skip("real compiler + pin absent: not an executed guest");
    return false;
  }
  assert.match(pin, /^[0-9a-f]{64}$/);
  const digest = createHash("sha256").update(await readFile(resolve(compiler))).digest("hex");
  assert.equal(digest, pin, "exact compiler binary must match SHA-256 pin");
  return true;
}
async function scratch(t, sourceBody) {
  const dir = await mkdtemp(join(tmpdir(), "ores-immutable-wasm-"));
  t.after(() => cleanupRealCompilerWorkspace(dir));
  const source = join(dir, "main.ores");
  const output = join(dir, "main.wasm");
  await writeFile(source, `pub fnc main(): int { ${sourceBody} }\n`);
  return {source, output};
}
for (const [name, body, expected] of positives) {
  test("immutable-default actual wasm32 guest: " + name, async t => {
    if (!await admitted(t)) return;
    const {source, output} = await scratch(t, body);
    await compileOresToWasm({compiler: resolve(compiler), compilerSha256: pin, source, output});
    const bytes = await readFile(output);
    const {instance} = await WebAssembly.instantiate(bytes, {});
    assert.equal(typeof instance.exports.main, "function");
    assert.equal(instance.exports.main(), expected);
  });
}
for (const [index, body] of negatives.entries()) {
  test("immutable-default delegated rejection " + (index + 1), async t => {
    if (!await admitted(t)) return;
    const {source, output} = await scratch(t, body);
    await assert.rejects(() => compileOresToWasm({
      compiler: resolve(compiler), compilerSha256: pin, source, output,
    }));
    await assert.rejects(stat(output), {code: "ENOENT"});
    // Generic rejection is NOT semantic immutability proof: the compiler must
    // eventually emit a resolved readonly/type/const diagnostic receipt.
  });
}
test("immutable-default unused initializer still traps in actual wasm guest", async t => {
  if (!await admitted(t)) return;
  const {source, output} = await scratch(t,
    "int unused = 9223372036854775807 + 1; return 7;");
  await compileOresToWasm({compiler: resolve(compiler), compilerSha256: pin, source, output});
  const {instance} = await WebAssembly.instantiate(await readFile(output), {});
  assert.throws(() => instance.exports.main(), WebAssembly.RuntimeError);
});
