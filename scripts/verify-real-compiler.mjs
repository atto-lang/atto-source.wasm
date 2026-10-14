import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve, isAbsolute, join} from "node:path";
import {fileURLToPath} from "node:url";
import {compileOresToWasm} from "./compile-ores.mjs";
import {readAtomicRelease} from "./atomic-release.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const realSource = fileURLToPath(new URL("../examples/native-int.ores", import.meta.url));
const forwardSource = fileURLToPath(new URL("../examples/forward-call.ores", import.meta.url));

// Fail-closed integration. CI pins source checkout independently, then pins the
// built compiler executable. Supplied source revision alone is not a proof.
export async function verifyRealCompiler({
  compiler = process.env.ORESLANG_LLVM_COMPILER,
  compilerSha256 = process.env.ORESLANG_LLVM_COMPILER_SHA256,
  llvmSourceSha = process.env.ORESLANG_LLVM_SOURCE_SHA
} = {}) {
  if (!compiler || !isAbsolute(compiler))
    throw Error("ORESLANG_LLVM_COMPILER must be an absolute compiler executable path");
  if (!/^[0-9a-f]{64}$/.test(compilerSha256 || ""))
    throw Error("ORESLANG_LLVM_COMPILER_SHA256 is required");
  if (!/^[0-9a-f]{40}$/.test(llvmSourceSha || ""))
    throw Error("ORESLANG_LLVM_SOURCE_SHA is required");
  const info = await stat(compiler);
  if (!info.isFile() || info.size > 256 * 1024 * 1024)
    throw Error("compiler is not a regular file or exceeds 256 MiB");
  if (sha256(await readFile(compiler)) !== compilerSha256)
    throw Error("native compiler SHA-256 mismatch");

  const work = await mkdtemp(join(tmpdir(), "oreslang-llvm-wasm-"));
  try {
    const output = join(work, "real.wasm");
    const published = await compileOresToWasm({
      compiler, compilerSha256, source:realSource, output,
      environment:"browser", publication:"atomic"
    });
    const release = await readAtomicRelease(output);
    if (published.compilerSha256 !== compilerSha256 ||
        published.sourceSha256 !== sha256(await readFile(realSource)) ||
        published.wasmSha256 !== sha256(release.wasm) ||
        release.manifest.wasmSha256 !== published.wasmSha256 ||
        release.manifest.environment !== "browser" ||
        release.manifest.imports.length !== 0 ||
        release.manifest.memory.maximumPages !== 2)
      throw Error("native compiler artifact provenance or admission mismatch");
    const executed = await runIsolatedCoreGuest(release.wasm, {
      expectedSha256:published.wasmSha256, timeoutMs:5000
    });
    if (executed.value !== 42n || executed.admission.hostCapabilities !== 0)
      throw Error("native Oreslang Wasm guest returned incorrect result/capabilities");
    // A second distinct Oreslang program proves same-module calls and
    // prevents a constant-result smoke test from masquerading as parity.
    const forwardOutput = join(work, "forward.wasm");
    const forwardPublished = await compileOresToWasm({
      compiler, compilerSha256, source:forwardSource, output:forwardOutput,
      environment:"browser", publication:"atomic"
    });
    const forwardRelease = await readAtomicRelease(forwardOutput);
    if (forwardPublished.wasmSha256 !== sha256(forwardRelease.wasm) ||
        forwardPublished.sourceSha256 !== sha256(await readFile(forwardSource)))
      throw Error("forward-call Wasm artifact provenance mismatch");
    const forwardExecuted = await runIsolatedCoreGuest(forwardRelease.wasm, {
      expectedSha256:forwardPublished.wasmSha256, timeoutMs:5000
    });
    if (forwardExecuted.value !== 47n || forwardExecuted.admission.hostCapabilities !== 0)
      throw Error("forward-call Oreslang guest produced incorrect result/capabilities");

    const negativeSource = join(work, "bad.ores");
    const negativeOutput = join(work, "bad.wasm");
    await writeFile(negativeSource,
      "pub fnc main(): int { return missing_identifier; }\n", {flag:"wx"});
    // Check the compiler directly first. Rejection at the Clang linker
    // must never count as language frontend rejection evidence.
    const frontend = spawnSync(compiler, ["--target=wasm32", negativeSource], {
      encoding:"utf8", timeout:30000, maxBuffer:4*1024*1024
    });
    if (frontend.error || frontend.signal || frontend.status === 0 ||
        typeof frontend.status !== "number" || frontend.stdout.trim() !== "")
      throw Error("real LLVM compiler did not reject invalid source with empty IR");
    let rejected = false;
    try {
      await compileOresToWasm({
        compiler, compilerSha256, source:negativeSource, output:negativeOutput,
        environment:"browser", publication:"atomic"
      });
    } catch (e) {
      if (!/command failed|unknown|undeclared|not declared/i.test(String(e))) throw e;
      rejected = true;
    }
    if (!rejected) throw Error("LLVM compiler accepted invalid Oreslang source");
    try {
      await stat(negativeOutput + ".current.json");
      throw Error("invalid compilation published a release pointer");
    } catch (e) {if (e.code !== "ENOENT") throw e;}
    return Object.freeze({
      status:"verified", llvmSourceCommitDeclared:llvmSourceSha,
      compilerSha256, wasmSha256:published.wasmSha256,
      sourceSha256:published.sourceSha256, result:executed.value.toString(),
      forwardCallResult:forwardExecuted.value.toString(), negativeSourceRejected:true
    });
  } finally {await rm(work,{recursive:true,force:true});}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(await verifyRealCompiler(),null,2));}
  catch(e){console.error("Real-compiler gate FAILED: "+String(e.message||e));process.exitCode=1;}
}
