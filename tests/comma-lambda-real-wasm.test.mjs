import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, writeFile, readFile, rm, stat} from "node:fs/promises";
import {join, resolve, isAbsolute} from "node:path";
import {tmpdir} from "node:os";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";

const compiler = process.env.ORESLANG_LLVM_COMPILER;
const binarySha = process.env.ORESLANG_LLVM_COMPILER_SHA256;
const sourceHead = process.env.ORESLANG_LLVM_SOURCE_SHA;
const required = process.env.ORESLANG_REQUIRE_REAL_COMPILER === "1";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

const cases = Object.freeze({
  namedPipe: `fnc add_one(int n): int { return n + 1; }
fnc twice(int n): int { return n * 2; }
pub fnc main() -> int ::
    int seed = 20,
    seed |> add_one |> twice
end
`,
  typedInlineLambda: `pub fnc main(): int {
    val int callback = || => int -> 5;
    return callback();
}
`,
  inferredInlineLambda: `pub fnc main(): int {
    return (|| -> val int x = 5, x + 3)();
}
`,
  tupleLambdaPipe: `pub fnc main(): int {
    return 5 |> |n| => int -> n + 1;
}
`,
});

async function admitted(t) {
  if (!compiler || !binarySha || !sourceHead) {
    if (required) throw new Error("required real LLVM compiler + binary/source SHA pins missing");
    t.skip("no authenticated LLVM compiler available: NOT_EXECUTED for Wasm guest parity");
    return false;
  }
  assert.ok(isAbsolute(compiler), "compiler must be an absolute executable path");
  assert.match(binarySha, /^[a-f0-9]{64}$/, "compiler binary must have SHA-256 pin");
  assert.match(sourceHead, /^[a-f0-9]{40}$/, "compiler source head must have Git SHA");
  const file = await readBoundedRegularFile(compiler, 256 * 1024 * 1024);
  assert.equal(sha256(file.bytes), binarySha, "compiler executable does not match pin");
  return true;
}
async function sourceFor(t, name, text) {
  const dir = await mkdtemp(join(tmpdir(), "atto-comma-lambda-wasm-"));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const source = join(dir, name + ".atto");
  const output = join(dir, name + ".wasm");
  await writeFile(source, text, "utf8");
  return {source, output, digest: sha256(await readFile(source))};
}

test("comma and typed lambda sources are distinct contracts (HOST ONLY)", () => {
  assert.ok(cases.namedPipe.includes("-> int ::"));
  assert.ok(cases.namedPipe.includes("|> add_one |> twice"));
  assert.ok(cases.typedInlineLambda.includes("|| => int ->"));
  assert.ok(!cases.typedInlineLambda.includes("|| -> int =>"));
  assert.ok(cases.inferredInlineLambda.includes("val int x = 5, x + 3"));
  assert.ok(cases.tupleLambdaPipe.includes("5 |> |n| => int ->"));
});

test("authenticated LLVM -> wasm32 actual comma body and named pipe yields 42", async t => {
  if (!await admitted(t)) return;
  const {source, output, digest} = await sourceFor(t, "comma-pipe-42", cases.namedPipe);
  const result = await compileOresToWasm({
    compiler: resolve(compiler),
    compilerSha256: binarySha,
    source, output, environment: "browser", publication: "atomic",
  });
  assert.equal(result.sourceSha256, digest, "compiler source bytes mutated");
  assert.equal(result.compilerSha256, binarySha, "wrong compiler used");
  const released = await readAtomicRelease(output);
  assert.deepEqual(released.manifest.imports, [], "atomic release declares forbidden imports");
  const artifact = released.wasm;
  const module = new WebAssembly.Module(artifact);
  assert.deepEqual(WebAssembly.Module.imports(module), [], "guest must not import host capabilities");
  const instance = new WebAssembly.Instance(module);
  assert.equal(BigInt(instance.exports.main()), 42n, "real wasm32 guest result wrong");
  assert.equal(sha256(await readFile(source)), digest, "source changed after compile");
  assert.equal(sha256(artifact), result.wasmSha256, "wasm output differs from compiler receipt");
});

for (const [name, sourceText] of Object.entries(cases).filter(([k]) => k !== "namedPipe")) {
  test("unsupported closure form must not publish Wasm: " + name, async t => {
    if (!await admitted(t)) return;
    const {source, output, digest} = await sourceFor(t, name, sourceText);
    await assert.rejects(() => compileOresToWasm({
      compiler: resolve(compiler),
      compilerSha256: binarySha,
      source, output, environment: "browser", publication: "atomic",
    }), error => {
      assert.equal(error.signal ?? null, null, "compiler must reject without signal/crash");
      assert.ok(error.message || error.stderr, "compiler must report an error");
      return true;
    });
    await assert.rejects(stat(output), {code: "ENOENT"});
    await assert.rejects(stat(output + ".current.json"), {code: "ENOENT"});
    assert.equal(sha256(await readFile(source)), digest, "rejected guest source mutated");
  });
}
