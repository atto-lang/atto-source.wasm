import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile, stat, readdir, chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve, isAbsolute, join} from "node:path";
import {fileURLToPath} from "node:url";
import {compileOresToWasm, readBoundedRegularFile} from "./compile-ores.mjs";
import {readAtomicRelease} from "./atomic-release.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const realSource = fileURLToPath(new URL("../examples/native-int.ores", import.meta.url));
const forwardSource = fileURLToPath(new URL("../examples/forward-call.ores", import.meta.url));

// Fail-closed integration. CI pins source checkout independently, then pins the
// built compiler executable. Supplied source revision alone is not a proof.
export function assertNativeFrontendRejection(frontend) {
  if (frontend.error || frontend.signal || frontend.status !== 1 ||
      frontend.stdout?.trim() !== "" ||
      !/^oreslang-llvmc:\s+\S.+/m.test(frontend.stderr || "")) {
    throw Error("native LLVM frontend rejection must be a diagnosed error (exit 1, no IR)");
  }
  return true;
}
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
  // Bind all validation and execution to the same bounded immutable snapshot.
  // The original compiler pathname is never executed after the SHA check.
  const compilerBytes = (await readBoundedRegularFile(
    compiler, 256 * 1024 * 1024, "compiler is not a regular file or exceeds 256 MiB"
  )).bytes;
  if (sha256(compilerBytes) !== compilerSha256)
    throw Error("native compiler SHA-256 mismatch");

  const work = await mkdtemp(join(tmpdir(), "oreslang-llvm-wasm-"));
  try {
    const pinnedCompiler = join(work, "pinned-oreslang-llvmc");
    await writeFile(pinnedCompiler, compilerBytes, {flag:"wx",mode:0o500});
    const output = join(work, "real.wasm");
    const published = await compileOresToWasm({
      compiler:pinnedCompiler, compilerSha256, source:realSource, output,
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
      compiler:pinnedCompiler, compilerSha256, source:forwardSource, output:forwardOutput,
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

    // A real compiler, not an IR test double, must support independently
    // sourced scalar fixtures. Negative and zero values catch i64 ABI/sign
    // mistakes that a constant-42 smoke test cannot expose.
    const scalarMatrix = [
      {name:"return-arithmetic",expected:28n},
      {name:"negative-result",expected:-5n},
      {name:"zero-result",expected:0n}
    ];
    const scalarResults=[];
    for (const {name,expected} of scalarMatrix) {
      const source = fileURLToPath(new URL("../examples/"+name+".ores", import.meta.url));
      const fixtureOutput = join(work,name+".wasm");
      const pinnedSourceSha = sha256(await readFile(source));
      const built = await compileOresToWasm({
        compiler:pinnedCompiler,compilerSha256,source,output:fixtureOutput,
        environment:"browser",publication:"atomic"
      });
      const verified = await readAtomicRelease(fixtureOutput);
      if (built.sourceSha256 !== pinnedSourceSha ||
          built.compilerSha256 !== compilerSha256 ||
          built.wasmSha256 !== sha256(verified.wasm) ||
          verified.manifest?.wasmSha256 !== built.wasmSha256)
        throw Error("scalar fixture "+name+" produced mismatched source or artifact provenance");
      const observed = await runIsolatedCoreGuest(verified.wasm,{
        expectedSha256:built.wasmSha256,timeoutMs:5000
      });
      if (observed.value !== expected ||
          observed.admission.imports !== 0 ||
          observed.admission.hostCapabilities !== 0)
        throw Error("scalar fixture "+name+" returned incorrect result or capabilities");
      scalarResults.push(Object.freeze({name,value:observed.value.toString(),
        wasmSha256:built.wasmSha256,sourceSha256:built.sourceSha256}));
    }

    const negativeSource = join(work, "bad.ores");
    const negativeOutput = join(work, "bad.wasm");
    await writeFile(negativeSource,
      "pub fnc main(): int { return missing_identifier; }\n", {flag:"wx"});
    // Check the compiler directly first. Rejection at the Clang linker
    // must never count as language frontend rejection evidence.
    const frontend = spawnSync(pinnedCompiler, ["--target=wasm32", negativeSource], {
      encoding:"utf8", timeout:30000, maxBuffer:4*1024*1024
    });
    assertNativeFrontendRejection(frontend);
    // The direct rejection test bypasses the bridge's own per-run executable
    // rehash. Ensure that even a self-mutating compiler cannot be reported as
    // the pinned, trusted compiler after the frontend call.
    if (sha256((await readBoundedRegularFile(
      pinnedCompiler, 256 * 1024 * 1024, "pinned compiler grew past byte budget"
    )).bytes) !== compilerSha256)
      throw Error("pinned compiler mutated during direct rejection test");
    let rejected = false;
    try {
      await compileOresToWasm({
        compiler:pinnedCompiler, compilerSha256, source:negativeSource, output:negativeOutput,
        environment:"browser", publication:"atomic"
      });
    } catch (e) {
      if (!/command failed/i.test(String(e))) throw e;
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
      forwardCallResult:forwardExecuted.value.toString(),
      scalarFixtures:Object.freeze(scalarResults), negativeSourceRejected:true
    });
  } finally {
    // Only this invocation owns these temporary releases. Production readers
    // never unseal directories; the test must restore write permission before
    // removing sealed 0500 releases on POSIX filesystems.
    async function unseal(directory) {
      await chmod(directory, 0o700);
      for (const entry of await readdir(directory, {withFileTypes:true}))
        if (entry.isDirectory()) await unseal(join(directory, entry.name));
    }
    await unseal(work);
    await rm(work,{recursive:true,force:true});
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(await verifyRealCompiler(),null,2));}
  catch(e){console.error("Real-compiler gate FAILED: "+String(e.message||e));process.exitCode=1;}
}
