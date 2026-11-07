// Boolean source parity: uses LLVM tests/native_bool_types.py program bodies.
// Static checks and skipped real-compiler tests are NOT guest execution evidence.
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp, writeFile, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";
import {cleanupRealCompilerWorkspace} from "../scripts/cleanup-real-compiler.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";
import {assertNativeFrontendRejection} from "../scripts/verify-real-compiler.mjs";

const CASES = Object.freeze([
  {
    "id": "literal-not",
    "kind": "execute",
    "expected": "42",
    "diagnostic": null,
    "blob": "b241dc1838f88e55c1e54e1774d0863fba4c8011"
  },
  {
    "id": "typed-let",
    "kind": "execute",
    "expected": "42",
    "diagnostic": null,
    "blob": "1a4871aa1ab5ff56eba1888fec3b4c796871f62c"
  },
  {
    "id": "nested-call",
    "kind": "execute",
    "expected": "42",
    "diagnostic": null,
    "blob": "7c2e1e3e1f68353964c8d2c3dedca553399f8d77"
  },
  {
    "id": "bool-guarded-result",
    "kind": "execute",
    "expected": "42",
    "diagnostic": null,
    "blob": "a058972b4b41dc13338822e872477d362b6a2973"
  },
  {
    "id": "false-fallthrough",
    "kind": "execute",
    "expected": "37",
    "diagnostic": null,
    "blob": "4f8f74dddc412676f2f21f97debad8ff146b0d9a"
  },
  {
    "id": "else-branch",
    "kind": "execute",
    "expected": "13",
    "diagnostic": null,
    "blob": "e1d9a677284cf05c330b0db3bf4c3cf828af60a9"
  },
  {
    "id": "bool-as-int",
    "kind": "reject",
    "expected": null,
    "diagnostic": "native function return requires int, got bool",
    "blob": "0211a57f7f8108ca467ff76f3b8c9e6e834178aa"
  },
  {
    "id": "truthy-int",
    "kind": "reject",
    "expected": null,
    "diagnostic": "native guarded return condition requires bool, got int",
    "blob": "2f917d5683fc501c282e55bccec1d52a0b2118ba"
  },
  {
    "id": "bool-arithmetic",
    "kind": "reject",
    "expected": null,
    "diagnostic": "arithmetic requires int, got bool",
    "blob": "26c4cb3ca196f5d88ed756645138c75841e50e05"
  },
  {
    "id": "comparison-type",
    "kind": "reject",
    "expected": null,
    "diagnostic": "equality operands require the same scalar type",
    "blob": "49d6d800fb043bdf06c224c8894ee997087b7ea5"
  },
  {
    "id": "not-integer",
    "kind": "reject",
    "expected": null,
    "diagnostic": "logical '!' requires bool, got int",
    "blob": "d3c8dd38ecf218f32b64df8acf785acdfe0309a4"
  }
]);
const fixtureRoot = fileURLToPath(new URL("./fixtures/boolean-v1/", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sha256 = b => createHash("sha256").update(b).digest("hex");
const gitBlob = b => createHash("sha1")
  .update(Buffer.from("blob " + b.length + "\0", "ascii")).update(b).digest("hex");
const git = args => {
  const result = spawnSync("git", args, {cwd:repositoryRoot,encoding:"utf8",
    timeout:5000,maxBuffer:64*1024,
    env:{PATH:process.env.PATH || "/usr/bin:/bin",LANG:"C",LC_ALL:"C"}});
  assert.ifError(result.error);
  assert.equal(result.status,0,"git source identity failure: "+String(result.stderr).slice(0,300));
  return result.stdout.trim();
};

async function fixture(item) {
  assert.match(item.id, /^[a-z][a-z0-9-]{1,60}$/);
  assert.match(item.blob, /^[0-9a-f]{40}$/);
  const {bytes} = await readBoundedRegularFile(
    join(fixtureRoot, item.id + ".atto"), 8192, "invalid boolean parity fixture");
  assert.ok(bytes.length > 30 && bytes.toString("utf8").includes("pub fnc main():int"));
  assert.equal(gitBlob(bytes), item.blob, item.id + " source blob drift");
  return bytes;
}
function compilerIdentity(env) {
  if (!env.ORESLANG_LLVM_COMPILER || !isAbsolute(env.ORESLANG_LLVM_COMPILER))
    throw Error("boolean Wasm parity requires absolute native compiler path");
  if (!/^[0-9a-f]{64}$/.test(env.ORESLANG_LLVM_COMPILER_SHA256 || ""))
    throw Error("boolean Wasm parity requires pinned LLVM compiler SHA-256");
  if (!/^[0-9a-f]{40}$/.test(env.ORESLANG_LLVM_SOURCE_SHA || ""))
    throw Error("boolean Wasm parity requires reviewed LLVM source SHA");
  if (!/^[0-9a-f]{40}$/.test(env.ORESLANG_LLVM_SOURCE_TREE || ""))
    throw Error("boolean Wasm parity requires reviewed LLVM source tree");
  if (!/^[0-9a-f]{40}$/.test(env.ORESLANG_BOOL_WASM_EXPECTED_HEAD || ""))
    throw Error("boolean Wasm parity requires exact expected Wasm checkout HEAD");
  return {compiler:env.ORESLANG_LLVM_COMPILER,digest:env.ORESLANG_LLVM_COMPILER_SHA256,
    sourceSha:env.ORESLANG_LLVM_SOURCE_SHA,sourceTree:env.ORESLANG_LLVM_SOURCE_TREE,
    expectedWasmHead:env.ORESLANG_BOOL_WASM_EXPECTED_HEAD};
}
async function notPublished(output) {
  for (const suffix of ["", ".artifact.json", ".provenance.json", ".current.json", ".releases"])
    await assert.rejects(stat(output + suffix), {code:"ENOENT"},
      "rejected source published " + output + suffix);
}

test("pinned .atto boolean fixture corpus is source-only evidence", async () => {
  assert.equal(CASES.length, 11);
  assert.equal(CASES.filter(x => x.kind === "execute").length, 6);
  assert.equal(CASES.filter(x => x.kind === "reject").length, 5);
  const ids = new Set();
  for (const item of CASES) {
    assert.equal(ids.has(item.id), false, "duplicate fixture id");
    ids.add(item.id);
    if (item.kind === "execute") {
      assert.match(item.expected, /^-?(?:0|[1-9][0-9]*)$/);
      assert.equal(item.diagnostic, null);
    } else {
      assert.equal(item.kind, "reject");
      assert.equal(item.expected, null);
      assert.ok(typeof item.diagnostic === "string" && item.diagnostic.length > 10);
    }
    await fixture(item);
  }
  assert.deepEqual(CASES.filter(x => x.kind === "execute").map(x => x.expected),
    ["42","42","42","42","37","13"], "keep non-42 branch controls");
});

test("required compiler admission fails closed on missing identities", () => {
  assert.throws(() => compilerIdentity({}), /absolute native compiler/);
  assert.throws(() => compilerIdentity({ORESLANG_LLVM_COMPILER:"/unused"}), /pinned LLVM compiler/);
  assert.throws(() => compilerIdentity({ORESLANG_LLVM_COMPILER:"/unused",
    ORESLANG_LLVM_COMPILER_SHA256:"a".repeat(64)}), /reviewed LLVM source SHA/);
  const validUntilTree={ORESLANG_LLVM_COMPILER:"/unused",
    ORESLANG_LLVM_COMPILER_SHA256:"a".repeat(64),ORESLANG_LLVM_SOURCE_SHA:"b".repeat(40)};
  assert.throws(() => compilerIdentity(validUntilTree), /reviewed LLVM source tree/);
  assert.throws(() => compilerIdentity({...validUntilTree,
    ORESLANG_LLVM_SOURCE_TREE:"c".repeat(40)}), /expected Wasm checkout HEAD/);
});

const demand = process.env.ORESLANG_BOOL_WASM_PARITY_REQUIRED ?? "0";
if (!["0","1"].includes(demand))
  throw Error("ORESLANG_BOOL_WASM_PARITY_REQUIRED must be 0 or 1");
const required = demand === "1";
const ready = Boolean(process.env.ORESLANG_LLVM_COMPILER);
test("real pinned LLVM-to-Wasm32 bool guest and type-rejection parity", {
  skip:!ready && !required,timeout:360000
}, async () => {
  const {compiler,digest,sourceSha,sourceTree,expectedWasmHead} = compilerIdentity(process.env);
  assert.equal(git(["rev-parse","HEAD"]),expectedWasmHead,"Wasm checkout head drift");
  const wasmTree = git(["rev-parse","HEAD^{tree}"]);
  assert.match(wasmTree,/^[0-9a-f]{40}$/);
  assert.equal(git(["status","--porcelain","--untracked-files=no"]),"",
    "tracked Wasm checkout changed during verification");
  const compilerBytes = (await readBoundedRegularFile(compiler,256*1024*1024,
    "real LLVM compiler missing or over 256 MiB")).bytes;
  assert.equal(sha256(compilerBytes),digest,"compiler executable digest mismatch");
  const dir=await mkdtemp(join(tmpdir(),"atto-bool-wasm32-"));
  let executed=0,rejected=0;
  const caseEvidence=[];
  try {
    const pinnedCompiler=join(dir,"pinned-llvm-compiler");
    await writeFile(pinnedCompiler,compilerBytes,{flag:"wx",mode:0o500});
    for (const item of CASES) {
      const bytes=await fixture(item);
      const source=join(dir,item.id+".atto"),output=join(dir,item.id+".wasm");
      await writeFile(source,bytes,{flag:"wx",mode:0o400});
      if (item.kind === "execute") {
        const built=await compileOresToWasm({compiler:pinnedCompiler,
          compilerSha256:digest,source,output,environment:"browser",publication:"atomic"});
        assert.equal(built.compilerSha256,digest);
        assert.equal(built.sourceSha256,sha256(bytes));
        const release=await readAtomicRelease(output);
        assert.equal(built.wasmSha256,sha256(release.wasm));
        assert.equal(release.manifest.wasmSha256,built.wasmSha256);
        assert.equal(release.manifest.environment,"browser");
        assert.equal(release.manifest.memory.maximumPages,2);
        assert.equal(release.manifest.producer.compilerSha256,digest);
        assert.equal(release.manifest.producer.sourceSha256,sha256(bytes));
        assert.deepEqual(release.manifest.imports,[]);
        assert.deepEqual(release.manifest.requiredCapabilities,[]);
        const actual=await runIsolatedCoreGuest(release.wasm,{
          expectedSha256:built.wasmSha256,timeoutMs:5000});
        assert.equal(actual.value,BigInt(item.expected),item.id+" executed guest result");
        assert.equal(actual.admission.imports,0);
        assert.equal(actual.admission.hostCapabilities,0);
        caseEvidence.push({id:item.id,kind:"EXECUTED_WASM32_GUEST",
          sourceGitBlob:item.blob,sourceSha256:sha256(bytes),
          wasmSha256:built.wasmSha256,expected:item.expected,
          observed:actual.value.toString(),imports:actual.admission.imports,
          hostCapabilities:actual.admission.hostCapabilities});
        executed++;
      } else {
        const frontend=spawnSync(pinnedCompiler,["--target=wasm32",source],{
          encoding:"utf8",timeout:30000,maxBuffer:4*1024*1024,
          env:{PATH:process.env.PATH || "/usr/bin:/bin",LANG:"C.UTF-8",LC_ALL:"C.UTF-8"}
        });
        assertNativeFrontendRejection(frontend);
        assert.ok(frontend.stderr.includes(item.diagnostic),
          item.id+" wrong compiler type error: "+frontend.stderr.slice(0,350));
        await assert.rejects(compileOresToWasm({compiler:pinnedCompiler,
          compilerSha256:digest,source,output,environment:"browser",publication:"atomic"}),
          error => {
            assert.equal(error.status,1,item.id+" compiler failure must be semantic");
            assert.equal(error.signal,null);
            assert.equal(error.stdout,"",item.id+" leaked LLVM IR");
            assert.ok(String(error.stderr).includes(item.diagnostic),
              item.id+" bridge did not preserve compiler type diagnostic");
            return true;
          });
        await notPublished(output);
        caseEvidence.push({id:item.id,kind:"NATIVE_LLVM_TYPE_REJECTION",
          sourceGitBlob:item.blob,sourceSha256:sha256(bytes),diagnostic:item.diagnostic,
          exitStatus:frontend.status,emittedLLVM:false,publishedArtifact:false});
        rejected++;
      }
    }
    assert.equal(executed,6,"incomplete positive guest matrix");
    assert.equal(rejected,5,"incomplete negative compiler matrix");
    assert.equal(sha256((await readBoundedRegularFile(pinnedCompiler,
      256*1024*1024,"staged compiler mutated")).bytes),digest);
    assert.equal(git(["rev-parse","HEAD"]),expectedWasmHead,"Wasm checkout moved");
    assert.equal(git(["rev-parse","HEAD^{tree}"]),wasmTree,"Wasm tree moved");
    assert.equal(git(["status","--porcelain","--untracked-files=no"]),"",
      "tracked Wasm checkout was changed during execution");
    assert.deepEqual(caseEvidence.map(x=>x.id),CASES.map(x=>x.id));
    const receipt={schema:"atto-boolean-wasm32-guest-evidence-v1",
      classification:"EXECUTED_WASM32_GUEST_AND_NATIVE_FRONTEND_REJECTIONS",
      wasm:{repository:"ores-truffle-oreslang/oreslang-source.wasm",
        head:expectedWasmHead,tree:wasmTree},
      llvm:{repository:"ores-truffle-oreslang/oreslang-source.llvm",
        sourceHeadMetadata:sourceSha,sourceTreeMetadata:sourceTree,
        compilerSha256:digest},
      executedGuests:executed,nativeFrontendRejections:rejected,cases:caseEvidence,
      javaDifferential:"NOT_EXECUTED",fiveBackendCertification:"NOT_CERTIFIED",
      caveat:"LLVM source identity metadata requires external authenticated checkout evidence; Node Worker is not a security sandbox or native AOT."};
    if(process.env.ORESLANG_BOOL_WASM_RECEIPT_PATH){
      const receiptPath=process.env.ORESLANG_BOOL_WASM_RECEIPT_PATH;
      assert.ok(isAbsolute(receiptPath),"guest receipt path must be absolute");
      await writeFile(receiptPath,JSON.stringify(receipt,null,2)+"\n",
        {flag:"wx",mode:0o600});
    }
    console.log("BOOL_WASM32_GUEST_COUNT="+executed+
      " BOOL_WASM32_FRONTEND_REJECTIONS="+rejected+
      " WASM_HEAD="+expectedWasmHead+" WASM_TREE="+wasmTree+
      " LLVM_SOURCE_SHA_METADATA="+sourceSha+" LLVM_SOURCE_TREE_METADATA="+sourceTree+
      " LLVM_COMPILER_SHA256="+digest+" JAVA_DIFFERENTIAL=NOT_EXECUTED");
  } finally {
    await cleanupRealCompilerWorkspace(dir);
  }
});
