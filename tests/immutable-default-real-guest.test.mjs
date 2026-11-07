import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, writeFile, readFile, rm, stat} from "node:fs/promises";
import {join, resolve, isAbsolute} from "node:path";
import {tmpdir} from "node:os";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

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
  const source = join(dir, "main.atto");
  const output = join(dir, "main.wasm");
  await writeFile(source, `define pub fnc main(): int { ${sourceBody} }\n`);
  return {source, output};
}
for (const [name, body, expected] of positives) {
  test("immutable-default actual wasm32 guest: " + name, async t => {
    if (!await admitted(t)) return;
    const {source, output} = await scratch(t, body);
    const built = await compileOresToWasm({
      compiler: resolve(compiler), compilerSha256: pin,
      source, output, environment: "browser", publication: "atomic",
    });
    const released = await readAtomicRelease(output);
    assert.equal(built.sourceSha256,
      createHash("sha256").update(await readFile(source)).digest("hex"),
      "compiled source bytes changed");
    assert.equal(built.compilerSha256, pin, "compiled using different compiler binary");
    assert.equal(built.wasmSha256,
      createHash("sha256").update(released.wasm).digest("hex"),
      "released wasm bytes changed");
    assert.deepEqual(released.manifest.imports, [], "no imported functions");
    assert.deepEqual(released.manifest.requiredCapabilities, [], "no host grants");
    const observed = await runIsolatedCoreGuest(released.wasm, {
      expectedSha256: built.wasmSha256, timeoutMs: 5000,
    });
    assert.equal(observed.value, expected, "wrong actual guest value");
    assert.equal(observed.admission.imports, 0);
    assert.equal(observed.admission.hostCapabilities, 0);
  });
}
for (const [index, body] of negatives.entries()) {
  test("immutable-default delegated rejection " + (index + 1), async t => {
    if (!await admitted(t)) return;
    const {source, output} = await scratch(t, body);
    await assert.rejects(() => compileOresToWasm({
      compiler: resolve(compiler), compilerSha256: pin,
      source, output, environment: "browser", publication: "atomic",
    }));
    await assert.rejects(stat(output), {code: "ENOENT"});
    await assert.rejects(stat(output + ".current.json"), {code: "ENOENT"},
      "rejected source must not publish a release pointer");
    // Generic rejection is NOT semantic immutability proof: the compiler must
    // eventually emit a resolved readonly/type/const diagnostic receipt.
  });
}
test("immutable-default unused initializer still traps in actual wasm guest", async t => {
  if (!await admitted(t)) return;
  const {source, output} = await scratch(t,
    "int unused = 9223372036854775807 + 1; return 7;");
  const built = await compileOresToWasm({
    compiler: resolve(compiler), compilerSha256: pin,
    source, output, environment: "browser", publication: "atomic",
  });
  const released = await readAtomicRelease(output);
  assert.equal(built.wasmSha256, createHash("sha256").update(released.wasm).digest("hex"));
  const {instance} = await WebAssembly.instantiate(released.wasm, {});
  assert.throws(() => instance.exports.main(), WebAssembly.RuntimeError);
});
