import {createHash} from "node:crypto";
import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {dirname, isAbsolute, resolve} from "node:path";
import {compileOresToWasm, readBoundedRegularFile} from "./compile-ores.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const expectedGitBlob = "8e4f76fa1e4752f4996d464cd02a86f609430118";

function optionMap(argv) {
  const allowed = new Set([
    "compiler", "compiler-sha256", "llvm-source-sha", "source",
    "output", "receipt", "wasm-source-head", "wasm-source-tree"
  ]);
  const result = new Map();
  for (const arg of argv) {
    const m = /^--([a-z0-9-]+)=(.*)$/.exec(arg);
    if (!m || !allowed.has(m[1]) || result.has(m[1])) {
      throw Error("unexpected or duplicate option: " + arg);
    }
    result.set(m[1], m[2]);
  }
  return result;
}

function requireHex(value, n, label) {
  if (!new RegExp("^[a-f0-9]{" + n + "}$").test(value || "")) {
    throw Error(label + " must be " + n + " lowercase hex digits");
  }
}

const options = optionMap(process.argv.slice(2));
const compiler = options.get("compiler");
const source = options.get("source");
const output = options.get("output");
const receipt = options.get("receipt");
if (![compiler, source, output, receipt].every(x => x && isAbsolute(x))) {
  throw Error("--compiler, --source, --output and --receipt must be absolute paths");
}
const compilerSha256 = options.get("compiler-sha256");
const llvmSourceSha = options.get("llvm-source-sha");
const wasmSourceHead = options.get("wasm-source-head");
const wasmSourceTree = options.get("wasm-source-tree");
requireHex(compilerSha256, 64, "compiler sha256");
requireHex(llvmSourceSha, 40, "LLVM source sha");
requireHex(wasmSourceHead, 40, "Wasm source head");
requireHex(wasmSourceTree, 40, "Wasm source tree");

const sourceBytes = (await readBoundedRegularFile(
  source, 1024 * 1024, "checked-i64 source exceeds source budget"
)).bytes;
const compilerBytes = (await readBoundedRegularFile(
  compiler, 256 * 1024 * 1024, "LLVM compiler exceeds executable budget"
)).bytes;
if (sha256(compilerBytes) !== compilerSha256) {
  throw Error("LLVM compiler binary sha256 mismatch");
}

await mkdir(dirname(output), {recursive:true});
await mkdir(dirname(receipt), {recursive:true});
try {
  const built = await compileOresToWasm({
    compiler,
    compilerSha256,
    source,
    output,
    environment:"browser",
    publication:"legacy"
  });
  const wasm = (await readBoundedRegularFile(
    output, 16 * 1024 * 1024, "checked-i64 Wasm exceeds guest budget"
  )).bytes;
  if (built.sourceSha256 !== sha256(sourceBytes) ||
      built.compilerSha256 !== compilerSha256 ||
      built.wasmSha256 !== sha256(wasm)) {
    throw Error("checked-i64 source/compiler/Wasm provenance mismatch");
  }
  const executed = await runIsolatedCoreGuest(wasm, {
    expectedSha256: built.wasmSha256,
    timeoutMs: 5000
  });
  if (executed.value !== 42n ||
      executed.admission.imports !== 0 ||
      executed.admission.hostCapabilities !== 0) {
    throw Error("checked-i64 Wasm guest returned wrong value or capabilities");
  }
  const proof = {
    schema:"oreslang.checked-i64-guest-proof-v1",
    backend:"wasm",
    sourceGitBlob:expectedGitBlob,
    sourceSha256:built.sourceSha256,
    llvmSourceHead:llvmSourceSha,
    compilerSha256,
    wasmSourceHead,
    wasmSourceTree,
    guestArtifactSha256:built.wasmSha256,
    oracle:{kind:"i64-value",expected:"42",actual:executed.value.toString()},
    zeroImports:executed.admission.imports === 0,
    zeroHostCapabilities:executed.admission.hostCapabilities === 0
  };
  await writeFile(receipt, JSON.stringify(proof, null, 2) + "\n", {flag:"wx"});
  console.log(JSON.stringify(proof));
} catch (error) {
  await rm(receipt, {force:true});
  throw error;
}
