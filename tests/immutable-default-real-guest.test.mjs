import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, writeFile, readFile, rm, stat} from "node:fs/promises";
import {join, resolve, isAbsolute} from "node:path";
import {tmpdir} from "node:os";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";

// Required mode must not silently skip. This suite exercises the REAL
// pinned LLVM compiler -> wasm32 bridge -> WebAssembly guest, not a mock.
const compiler = process.env.ORESLANG_LLVM_COMPILER;
const required = process.env.ORESLANG_REQUIRE_REAL_COMPILER === "1";
const pin = process.env.ORESLANG_LLVM_COMPILER_SHA256;
const compilerHead = process.env.ORESLANG_LLVM_SOURCE_SHA;
const positives = [
  ["typed-default", "int x = 7; return x;", 7n],
  ["const-inferred", "const x = 7; return x;", 7n],
  ["const-typed", "const int x = 7; return x;", 7n],
  ["const-colon", "const x: int = 7; return x;", 7n],
  ["typed-runtime", "int x = 7; int y = x * 3; return y;", 21n],
  ["const-dependency", "const x = 7; const y = x * 3; return y;", 21n],
  ["typed-to-const-dependency", "int x = 7; const y = x + 1; return y;", 8n],
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
];


test("immutable-default source matrix does not misclassify permitted dependencies", () => {
  const positiveBodies = new Set(positives.map(([, body]) => body));
  assert.equal(positiveBodies.size, positives.length, "duplicate positive fixture");
  for (const body of negatives) {
    assert.ok(!positiveBodies.has(body), "valid initializer also listed as rejection");
  }
  assert.ok(positiveBodies.has("int x = 7; const y = x + 1; return y;"),
    "immutable-to-immutable dependency must remain positive");
});

test("immutable-default real-Wasm evidence admission", async t => {
  if (!compiler) {
    if (required) throw Error("required real Oreslang LLVM compiler is missing");
    t.skip("real LLVM compiler unavailable; NOT a Wasm guest parity pass");
    return;
  }
  if (!pin || !/^[0-9a-f]{64}$/.test(pin) ||
      !compilerHead || !/^[0-9a-f]{40}$/.test(compilerHead)) {
    if (required) throw Error("required compiler SHA-256 or source commit pin missing/invalid");
    t.skip("compiler source/byte provenance absent; no parity credit");
    return;
  }
  assert.ok(isAbsolute(compiler), "compiler path must be absolute");
  const binary = await readBoundedRegularFile(compiler, 256 * 1024 * 1024);
  const digest = createHash("sha256").update(binary.bytes).digest("hex");
  assert.equal(digest, pin, "LLVM compiler binary digest mismatch");
});

async function admitted(t) {
  if (!compiler || !pin || !compilerHead) {
    if (required) throw Error("required compiler, source commit and SHA-256 pin missing");
    t.skip("real compiler or source/byte pin absent: not an executed guest");
    return false;
  }
  assert.ok(isAbsolute(compiler), "compiler path must be absolute");
  assert.match(pin, /^[0-9a-f]{64}$/);
  assert.match(compilerHead, /^[0-9a-f]{40}$/);
  const binary = await readBoundedRegularFile(compiler, 256 * 1024 * 1024);
  const digest = createHash("sha256").update(binary.bytes).digest("hex");
  assert.equal(digest, pin, "exact compiler binary must match SHA-256 pin");
  return true;
}
async function scratch(t, sourceBody) {
  const dir = await mkdtemp(join(tmpdir(), "ores-immutable-wasm-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const source = join(dir, "main.ores");
  const output = join(dir, "main.wasm");
  await writeFile(source, `define pub fnc main(): int { ${sourceBody} }\n`);
  return {source, output};
}
for (const [name, body, expected] of positives) {
  test("immutable-default actual wasm32 guest: " + name, async t => {
    if (!await admitted(t)) return;
    const {source, output} = await scratch(t, body);
    await compileOresToWasm({compiler: resolve(compiler), source, output});
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
      compiler: resolve(compiler), source, output,
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
  await compileOresToWasm({compiler: resolve(compiler), source, output});
  const {instance} = await WebAssembly.instantiate(await readFile(output), {});
  assert.throws(() => instance.exports.main(), WebAssembly.RuntimeError);
});
