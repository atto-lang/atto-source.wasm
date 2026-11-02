import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile, stat, lstat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {resolve, isAbsolute, join} from "node:path";
import {fileURLToPath} from "node:url";
import {compileOresToWasm, readBoundedRegularFile} from "./compile-ores.mjs";
import {readAtomicRelease} from "./atomic-release.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";
import {cleanupRealCompilerWorkspace} from "./cleanup-real-compiler.mjs";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const realSource = fileURLToPath(new URL("../contracts/v1/semantics/fixtures/add.ores", import.meta.url));
const forwardSource = fileURLToPath(new URL("../examples/forward-call.atto", import.meta.url));
const opaqueTernarySource = fileURLToPath(new URL(
  "../examples/unsupported-any-ternary.atto", import.meta.url));


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
export function assertTupleV2FrontendRejection(frontend, expectedDiagnostic) {
  assertNativeFrontendRejection(frontend);
  if (!String(frontend.stderr || "").includes(expectedDiagnostic))
    throw Error("tuple-v2 rejection did not come from the required compiler-owned gate");
  return true;
}
export function assertGeneratorV1FrontendRejection(frontend) {
  assertNativeFrontendRejection(frontend);
  if (!String(frontend.stderr || "").includes(
      "native generator v1 requires iterator-frame, ownership and LLVM continuation lowering"))
    throw Error("generator-v1 rejection did not come from the required compiler-owned gate");
  return true;
}
export function assertInvertedFrontendRejection(frontend) {
  assertNativeFrontendRejection(frontend);
  const stderr = String(frontend.stderr || "");
  if (!stderr.includes("INVERTED_BACKEND_UNSUPPORTED") &&
      !stderr.includes("expected 'module', 'class' or 'actor'") &&
      !stderr.includes("expected 'class', 'actor'"))
    throw Error("inverted-class source did not fail through the native declaration boundary");
  return true;
}
export function assertSelectFrontendRejection(frontend) {
  assertNativeFrontendRejection(frontend);
  if (!String(frontend.stderr || "").includes(
      "native async/channel/select boundary unsupported"))
    throw Error("select rejection did not come from the LLVM async/channel/select capability gate");
  return true;
}
export async function verifyRealCompiler({
  compiler = process.env.ATTOLANG_LLVM_COMPILER || process.env.ORESLANG_LLVM_COMPILER,
  compilerSha256 = process.env.ATTOLANG_LLVM_COMPILER_SHA256 || process.env.ORESLANG_LLVM_COMPILER_SHA256,
  llvmSourceSha = process.env.ATTOLANG_LLVM_SOURCE_SHA || process.env.ORESLANG_LLVM_SOURCE_SHA
} = {}) {
  if (!compiler || !isAbsolute(compiler))
    throw Error("ATTOLANG_LLVM_COMPILER must be an absolute compiler executable path (legacy ORESLANG_LLVM_COMPILER fallback supported)");
  if (!/^[0-9a-f]{64}$/.test(compilerSha256 || ""))
    throw Error("ATTOLANG_LLVM_COMPILER_SHA256 is required (legacy ORESLANG_LLVM_COMPILER_SHA256 fallback supported)");
  if (!/^[0-9a-f]{40}$/.test(llvmSourceSha || ""))
    throw Error("ATTOLANG_LLVM_SOURCE_SHA is required (legacy ORESLANG_LLVM_SOURCE_SHA fallback supported)");
  // Bind all validation and execution to the same bounded immutable snapshot.
  // The original compiler pathname is never executed after the SHA check.
  const compilerBytes = (await readBoundedRegularFile(
    compiler, 256 * 1024 * 1024, "compiler is not a regular file or exceeds 256 MiB"
  )).bytes;
  if (sha256(compilerBytes) !== compilerSha256)
    throw Error("native compiler SHA-256 mismatch");

  const work = await mkdtemp(join(tmpdir(), "oreslang-llvm-wasm-"));
  let primaryError;
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
      throw Error("native AttoLang Wasm guest returned incorrect result/capabilities");
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
      throw Error("forward-call AttoLang guest produced incorrect result/capabilities");

    // A real compiler, not an IR test double, must support independently
    // sourced scalar fixtures. Negative and zero values catch i64 ABI/sign
    // mistakes that a constant-42 smoke test cannot expose.
    const scalarMatrix = [
      {name:"return-arithmetic",expected:28n},
      // Git blob a8165323a8aa40e7cec613fdb7e645c41a901965:
      // byte-identical with the shared five-backend Wave 2 source fixture.
      {name:"arithmetic-76",expected:76n},
      {name:"negative-result",expected:-5n},
      {name:"zero-result",expected:0n},
      {name:"class-scalar-constructor",expected:40n},
      // Byte-identical to the shared value-pipeline conformance source.
      // This is scalar LLVM->wasm32 execution, not tagged Option/Result.
      {name:"value-pipe-scalar",expected:7n}
    ];
    const scalarResults=[];
    for (const {name,expected} of scalarMatrix) {
      const source = fileURLToPath(new URL("../examples/"+name+".atto", import.meta.url));
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

    // Run precisely the same byte-identical signed-i64 scalar fixture sources
    // used by the independent .NET and Forge bootstrap parity gates.
    // The negative corpus is backend-specific: LLVM may implement constructs
    // (e.g. structural match) that the bootstrap compilers must reject.
    const sharedRoot = fileURLToPath(new URL("../contracts/scalar/v1/", import.meta.url));
    const manifestBytes = await readFile(join(sharedRoot, "cases.json"));
    const sharedCorpus = JSON.parse(manifestBytes.toString("utf8"));
    if (sharedCorpus.schema_version !== "1.0.0" ||
        !Array.isArray(sharedCorpus.cases) || sharedCorpus.cases.length !== 11)
      throw Error("shared scalar corpus version or inventory drift");
    const sharedHash = createHash("sha256").update(manifestBytes);
    const sharedScalarResults = [];
    const seenIds = new Set();
    for (const testCase of sharedCorpus.cases) {
      if (!/^[a-z][a-z0-9.-]{1,79}$/.test(testCase.id) ||
          seenIds.has(testCase.id) ||
          !/^fixtures\/[a-z0-9-]+\.ores$/.test(testCase.file))
        throw Error("unsafe or duplicate shared scalar case identity");
      seenIds.add(testCase.id);
      const source = join(sharedRoot, testCase.file);
      const sourceStat = await lstat(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink() ||
          sourceStat.size < 1 || sourceStat.size > 1048576)
        throw Error("unsafe or oversized shared scalar fixture");
      const sourceBytes = (await readBoundedRegularFile(
        source, 1048576, "shared scalar fixture is not a bounded regular file"
      )).bytes;
      sharedHash.update(Buffer.from(testCase.file, "ascii"));
      sharedHash.update(Buffer.from([0]));
      sharedHash.update(sourceBytes);
      if (testCase.kind === "reject") continue; // bootstrap admission only
      if (testCase.kind !== "accept" || !/^-?(?:0|[1-9][0-9]*)$/.test(testCase.value))
        throw Error("invalid shared scalar expected result");
      const expected = BigInt(testCase.value);
      if (expected < -(1n << 63n) || expected >= (1n << 63n))
        throw Error("shared scalar expected value overflows i64");
      // The compiler must never race the original checkout fixture after
      // its content hash has been admitted. Compile a private, pinned copy.
      const stagedSource = join(work, "shared-" + testCase.id + ".ores");
      await writeFile(stagedSource, sourceBytes, {flag:"wx",mode:0o400});
      const out = join(work, "shared-" + testCase.id + ".wasm");
      const built = await compileOresToWasm({
        compiler:pinnedCompiler, compilerSha256, source:stagedSource, output:out,
        environment:"browser", publication:"atomic"
      });
      const verified = await readAtomicRelease(out);
      if (built.sourceSha256 !== sha256(sourceBytes) ||
          built.compilerSha256 !== compilerSha256 ||
          built.wasmSha256 !== sha256(verified.wasm) ||
          verified.manifest?.wasmSha256 !== built.wasmSha256)
        throw Error("shared scalar source/artifact provenance mismatch");
      const observed = await runIsolatedCoreGuest(verified.wasm, {
        expectedSha256:built.wasmSha256, timeoutMs:5000
      });
      if (observed.value !== expected ||
          observed.admission.imports !== 0 ||
          observed.admission.hostCapabilities !== 0)
        throw Error("shared scalar guest value or zero-import admission mismatch");
      sharedScalarResults.push(Object.freeze({
        name:testCase.id, expected:testCase.value, value:observed.value.toString(),
        sourceSha256:built.sourceSha256, wasmSha256:built.wasmSha256
      }));
    }
    if (sharedScalarResults.length !== 6)
      throw Error("shared scalar suite must execute exactly six guest programs");
    const sharedScalarSuiteSha256 = sharedHash.digest("hex");
    // The shared corpus is an immutable, exact-byte contract across backends.
    // Merely returning the computed hash in a report is insufficient: a
    // modified fixture could otherwise pass as established parity evidence.
    const expectedScalarSuiteSha256 =
      "5b5d1bc00def9b3a343cb3281e0bb0be4e5ca438095f621141049e2d7a1a25b3";
    if (sharedScalarSuiteSha256 !== expectedScalarSuiteSha256)
      throw Error("shared scalar corpus digest differs from pinned parity contract");

    // +/ import graph linking is not implemented for the wasm32 compiler
    // target. A scalar guest or bridge must never silently discard imports.
    // This is an executable fail-closed guard, not a parity success claim.
    for (const [name, imported] of [
      ["project-root", "+/src/lib/helper"],
      ["retired-root", "@/src/lib/helper"],
      ["package", "pkg:math/src/helper"],
      ["relative", "./helper"]
    ]) {
      const source = join(work, "deny-import-" + name + ".atto");
      await writeFile(source,
        'import fnc helper from "' + imported +
        '";\npub fnc main(): int { return helper(); }\n', {flag:"wx"});
      const frontendResult = spawnSync(pinnedCompiler, ["--target=wasm32", source], {
        encoding:"utf8", timeout:30000, maxBuffer:4*1024*1024
      });
      assertNativeFrontendRejection(frontendResult);
    }

    // Source ownership syntax is pointerless. These cases must be rejected by
    // the pinned real LLVM frontend itself, never by the Wasm linker/bridge.
    for (const [name, body] of [
      ["address-of", "pub fnc main(): int { val x = 1; return &x; }\n"],
      ["address-of-mut", "pub fnc main(): int { let mut int x = 1; return &mut x; }\n"],
      ["unary-deref", "pub fnc main(): int { val x = 1; return *x; }\n"],
      ["legacy-borrow-order", "pub fnc main(): int { let mut int x = 1; return rt borrow mut x; }\n"],
      ["pointer-type", "pub fnc main(): Pointer<int> { return value; }\n"],
      ["rt-ref", "pub fnc main(): int { val x = 1; return rt ref x; }\n"],
      ["rt-deref", "pub fnc main(): int { return rt deref value; }\n"],
      ["rt-unref", "pub fnc main(): int { return rt unref value; }\n"]
    ]) {
      const source = join(work, "deny-pointer-syntax-" + name + ".atto");
      await writeFile(source, body, {flag:"wx"});
      const frontendResult = spawnSync(pinnedCompiler, ["--target=wasm32", source], {
        encoding:"utf8", timeout:30000, maxBuffer:4*1024*1024
      });
      assertNativeFrontendRejection(frontendResult);
    }

    for (const [name, body] of [
      ["sync", "pub gen* values(): Iterator<int> { yield 1; return; }\n"],
      ["async", "pub async gen* values(): AsyncIterator<int> { yield 1; return; }\n"],
      ["suspend", "pub suspend gen* values(): AsyncIterator<int> { yield 1; return; }\n"],
      ["legacy-fnc", "pub fnc gen* values(): Iterator<int> { yield 1; return; }\n"],
      ["legacy-routine", "pub routine gen* values(): Iterator<int> { yield 1; return; }\n"],
      ["legacy-async-fnc", "pub async fnc gen* values(): AsyncIterator<int> { yield 1; return; }\n"]
    ]) {
      const source = join(work, "generator-v1-" + name + ".atto");
      await writeFile(source, body, {flag:"wx"});
      const frontendResult = spawnSync(pinnedCompiler, ["--target=wasm32", source], {
        encoding:"utf8", timeout:30000, maxBuffer:4*1024*1024
      });
      assertGeneratorV1FrontendRejection(frontendResult);
      if (sha256((await readBoundedRegularFile(
        pinnedCompiler, 256 * 1024 * 1024, "pinned compiler grew past byte budget"
      )).bytes) !== compilerSha256)
        throw Error("pinned compiler mutated during generator-v1 rejection test");
    }

    // Inverted classes have host substrate in some backends, but no verified
    // wasm32 guest lowering. The pinned native frontend must reject every
    // contextual declaration before emitting IR or publishing a Wasm artifact.
    for (const [name, body] of [
      ["root", "define inverted class Particle as x: int; end\n"],
      ["define-pub", "define pub inverted class Particle as x: int; end\n"],
      ["pub-define", "pub define inverted class Particle as x: int; end\n"],
      ["module", "define module Physics as\n define inverted class Particle as x: int; end\n pub fnc main(): int { return 0; }\nend\n"]
    ]) {
      const source = join(work, "deny-inverted-" + name + ".atto");
      await writeFile(source, body, {flag:"wx"});
      const frontendResult = spawnSync(
        pinnedCompiler, ["--target=wasm32", source],
        {encoding:"utf8", timeout:30000, maxBuffer:4*1024*1024});
      assertInvertedFrontendRejection(frontendResult);
    }

    const negativeSource = join(work, "bad.atto");
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
    // Canonical pipeline rejection must happen in the actual native
    // frontend, not in the linker or Wasm admission layer. The rejected
    // source must never publish an artifact or a current release pointer.
    const invalidPipeSource = fileURLToPath(new URL(
      "../examples/value-pipe-invalid.atto", import.meta.url));
    const invalidPipeOutput = join(work, "invalid-pipe.wasm");
    const pipeFrontend = spawnSync(pinnedCompiler,
      ["--target=wasm32", invalidPipeSource], {
        encoding:"utf8", timeout:30000, maxBuffer:4*1024*1024
      });
    assertNativeFrontendRejection(pipeFrontend);
    if (sha256((await readBoundedRegularFile(
      pinnedCompiler, 256 * 1024 * 1024, "pinned compiler grew past byte budget"
    )).bytes) !== compilerSha256)
      throw Error("pinned compiler mutated during invalid pipeline admission test");
    let invalidPipeRejected = false;
    try {
      await compileOresToWasm({
        compiler:pinnedCompiler, compilerSha256,
        source:invalidPipeSource, output:invalidPipeOutput,
        environment:"browser", publication:"atomic"
      });
    } catch (error) {
      if (!/command failed/i.test(String(error))) throw error;
      invalidPipeRejected = true;
    }
    if (!invalidPipeRejected)
      throw Error("unsupported Oreslang pipeline reached Wasm artifact publication");
    try {
      await stat(invalidPipeOutput + ".current.json");
      throw Error("unsupported Oreslang pipeline published a release pointer");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    // Static select is parsed and owned by the LLVM frontend, not by this
    // Wasm bridge. Require the compiler-owned capability diagnostic for both
    // outer delimiter families so Wasm stays fail-closed ahead of lowering.
    const selectCases = [
      ["plain-braced", "select { default: { return 1; } }"],
      ["plain-over", "select over default: { return 1; } end"],
      ["do-braced", "do select { default: { return 1; } }"],
      ["do-over", "do select over default: { return 1; } end"],
      ["nb-braced", "nb select { default: { return 1; } }"],
      ["nb-over", "nb select over default: { return 1; } end"],
      ["do-nb-braced", "do nb select { default: { return 1; } }"],
      ["do-nb-over", "do nb select over default: { return 1; } end"]
    ];
    for (const [name, form] of selectCases) {
      const source = join(work, "deny-select-" + name + ".atto");
      await writeFile(source,
        "pub fnc main(): int { " + form + " return 0; }\n", {flag:"wx"});
      const frontendResult = spawnSync(
        pinnedCompiler, ["--target=wasm32", source],
        {encoding:"utf8", timeout:30000, maxBuffer:4*1024*1024});
      assertSelectFrontendRejection(frontendResult);
      if (sha256((await readBoundedRegularFile(
        pinnedCompiler, 256 * 1024 * 1024, "pinned compiler grew past byte budget"
      )).bytes) !== compilerSha256)
        throw Error("pinned compiler mutated during select rejection test");
    }

    const selectBridgeSource = join(work, "deny-select-bridge.atto");
    const selectBridgeOutput = join(work, "deny-select-bridge.wasm");
    await writeFile(selectBridgeSource,
      "pub fnc main(): int { nb select over default: { return 1; } end return 0; }\n",
      {flag:"wx"});
    let selectBridgeRejected = false;
    try {
      await compileOresToWasm({
        compiler:pinnedCompiler, compilerSha256,
        source:selectBridgeSource, output:selectBridgeOutput,
        environment:"browser", publication:"atomic"
      });
    } catch (error) {
      if (!/command failed/i.test(String(error))) throw error;
      selectBridgeRejected = true;
    }
    if (!selectBridgeRejected)
      throw Error("unsupported static select reached Wasm artifact publication");
    try {
      await stat(selectBridgeOutput + ".current.json");
      throw Error("unsupported static select published a Wasm release pointer");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    // WASM delegates source parsing to the pinned LLVM compiler. Until the
    // native backend has a tagged opaque-value ABI plus typed ternary CFG,
    // this canonical any/unknown source form must fail in that frontend and
    // must never publish a Wasm release.
    const opaqueTernaryOutput = join(work, "unsupported-any-ternary.wasm");
    const opaqueFrontend = spawnSync(
      pinnedCompiler, ["--target=wasm32", opaqueTernarySource], {
        encoding:"utf8", timeout:30000, maxBuffer:4*1024*1024
      });
    assertNativeFrontendRejection(opaqueFrontend);
    if (!/native opaque top type requires tagged value ABI/i.test(opaqueFrontend.stderr || ""))
      throw Error("LLVM frontend lacks the explicit any/unknown tagged-ABI admission gate");
    if (sha256((await readBoundedRegularFile(
      pinnedCompiler, 256 * 1024 * 1024, "pinned compiler grew past byte budget"
    )).bytes) !== compilerSha256)
      throw Error("pinned compiler mutated during opaque-top/ternary admission test");
    let opaqueTernaryRejected = false;
    try {
      await compileOresToWasm({
        compiler:pinnedCompiler, compilerSha256,
        source:opaqueTernarySource, output:opaqueTernaryOutput,
        environment:"browser", publication:"atomic"
      });
    } catch (error) {
      if (!/command failed/i.test(String(error))) throw error;
      opaqueTernaryRejected = true;
    }
    if (!opaqueTernaryRejected)
      throw Error("unsupported any/unknown ternary source reached Wasm artifact publication");
    try {
      await stat(opaqueTernaryOutput + ".current.json");
      throw Error("unsupported any/unknown ternary source published a release pointer");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const tupleV2Cases = [
      {
        name:"tuple-explicit",
        source:"fnc take(tuple (int,int,string?) value): int { return 1; }\n",
        diagnostic:"native positional tuple parameter requires verified readonly-slot and optional-tail lowering"
      },
      {
        name:"tuple-shorthand",
        source:"fnc take((int,int,string?) value): int { return 1; }\n",
        diagnostic:"native positional tuple parameter requires verified readonly-slot and optional-tail lowering"
      },
      {
        name:"tuple-structural",
        source:"fnc take(structural (int,int,string?) value): int { return 1; }\n",
        diagnostic:"native structural positional tuple requires verified readonly-width and nonescape lowering"
      },
      {
        name:"tuple-return",
        source:"fnc take(): tuple (int,int) { return 1; }\n",
        diagnostic:"native positional tuple return requires verified tuple ABI lowering"
      }
    ];
    for (const tupleCase of tupleV2Cases) {
      const tupleSource = join(work, tupleCase.name + ".atto");
      await writeFile(tupleSource, tupleCase.source, {flag:"wx"});
      const tupleFrontend = spawnSync(
        pinnedCompiler, ["--target=wasm32", tupleSource],
        {encoding:"utf8", timeout:30000, maxBuffer:4*1024*1024});
      assertTupleV2FrontendRejection(tupleFrontend, tupleCase.diagnostic);
      if (sha256((await readBoundedRegularFile(
        pinnedCompiler, 256 * 1024 * 1024,
        "pinned compiler grew past byte budget")).bytes) !== compilerSha256)
        throw Error("pinned compiler mutated during tuple-v2 rejection test");
    }

    return Object.freeze({
      status:"verified", llvmSourceCommitDeclared:llvmSourceSha,
      compilerSha256, wasmSha256:published.wasmSha256,
      sourceSha256:published.sourceSha256, result:executed.value.toString(),
      forwardCallResult:forwardExecuted.value.toString(),
      scalarFixtures:Object.freeze(scalarResults),
      sharedScalarSuiteSha256, sharedScalarFixtures:Object.freeze(sharedScalarResults),
      negativeSourceRejected:true,
      unsupportedPipelineRejected:true,
      generatorV1Rejected:true,
      tupleV2Rejected:true,
      invertedSourceRejected:true,
      staticSelectRejected:true,
      opaqueTopTernaryRejected:true
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // Published release directories are intentionally mode 0500. A bare
    // recursive rm cannot unlink their children on Unix. Do not mask an
    // actual compiler/admission failure with a secondary cleanup error.
    try { await cleanupRealCompilerWorkspace(work); }
    catch (cleanupError) {
      if (primaryError) {
        primaryError.cleanupFailure = String(cleanupError?.message || cleanupError).slice(0,256);
      } else {
        throw cleanupError;
      }
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(await verifyRealCompiler(),null,2));}
  catch(e){console.error("Real-compiler gate FAILED: "+String(e.message||e));process.exitCode=1;}
}
