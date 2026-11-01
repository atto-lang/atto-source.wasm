import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, writeFile, readFile, stat, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {readAtomicRelease} from "../scripts/atomic-release.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

// All positive cases are complete Oreslang guest programs. Host-only checks
// below protect the matrix but are NOT evidence of compiler-backed execution.
const main = body => "pub fnc main():int{" + body + "}\n";
const positive = [
  ["typed-int", main("const int x=7;return x+35;")],
  ["inferred-int", main("const x=7;return x+35;")],
  ["checked-int", main("const x=7 as int;return x+35;")],
  ["equivalent-spellings", main("const int x=7;const y=7 as int;return x+y+28;")],
  ["name-first-annotation", main("const x:int=7;return x+35;")],
  ["inferred-from-variable", main("const x=7;const y=x;return y+35;")],
  ["cast-from-variable", main("const x=7;const y=x as int;return y+35;")],
  ["cast-expression", main("const x=(2+5) as int;return x+35;")],
  ["precedence", main("const x=(2+5) as int;return (x+35) as int;")],
  ["bool-inference", main("const yes=true;if(yes){return 42;}fi return 0;")],
  ["bool-checked-cast", main("const yes=true as bool;if(yes){return 42;}fi return 0;")],
  ["bool-from-compare", main("const yes=(2 eq 2) as bool;if(yes){return 42;}fi return 0;")],
  ["conditional-inference", main("const x=true?7:8;return x+35;")],
  ["conditional-cast", main("const x=(true?7:8) as int;return x+35;")],
  ["function-result", "fnc seven():int{return 7;}"+main("const x=seven();return x+35;")],
  ["function-result-cast", "fnc seven():int{return 7;}"+main("const x=seven() as int;return x+35;")],
  ["branch-inferred", main("if(true){const x=7 as int;return x+35;}fi return 0;")],
  ["rebind-explicit-let", main("let x=7; x=42;return x;")]
];
const negative = [
  ["int-to-bool", main("const x=7 as bool;return 0;"), /impossible native cast: int as bool/],
  ["bool-to-int", main("const x=true as int;return 0;"), /impossible native cast: bool as int/],
  ["mismatched-annotation", main("const int x=true;return 0;"), /requires int, got bool/],
  ["mismatched-inference", main("const x=true;const int y=x;return 0;"), /requires int, got bool/],
  ["wrong-bool-annotation", main("const bool x=7;return 0;"), /requires bool, got int/],
  ["bool-arithmetic", main("const x=true;return x+1;"), /arithmetic requires int, got bool/],
  ["optional-cast-no-lowering", main("const x=7 as? int;return 0;"), /native as\? requires Option/],
  ["unknown-target", main("const x=7 as Phantom;return 0;"), /checked cast requires a scalar/],
  ["chained-mismatch", main("const x=7 as bool as int;return 0;"), /impossible native cast/],
  ["immutable-write", main("const x=7 as int;x=8;return 0;"), /(?:immutable|assign|readonly|cannot)/i],
  ["inferred-bool-into-int-return", main("const x=true;return x;"), /return requires int, got bool/],
  ["numeric-alias-mismatch", "declare type Flag=bool;"+main("const x=7 as Flag;return 0;"), /impossible native cast/],
  ["nominal-handle-cast", main("const Option<int> x=Some(7);const int y=x as int;return 0;"), /(?:nominal|aggregate|inferred scalar)/i]
];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const ids = [...positive, ...negative].map(row => row[0]);

test("scalar cast/inference corpus integrity and negative mutation checks (host-only)", () => {
  assert.equal(ids.length, new Set(ids).size, "duplicate scalar case ID");
  assert.equal(positive.length, 18);
  assert.equal(negative.length, 13);
  for (const [id, source] of [...positive, ...negative]) {
    assert.match(id, /^[a-z][a-z0-9-]{2,60}$/);
    assert.ok(Buffer.byteLength(source, "utf8") < 8192);
    assert.match(source, /pub fnc main\(\):int\{/);
    assert.equal(digest(Buffer.from(source)).length, 64);
  }
  const modified = positive[0][1].replace("7;return", "8;return");
  assert.notEqual(digest(modified), digest(positive[0][1]),
    "source mutation must change the bytes bound to compiler proof");
  assert.notEqual(digest(negative[0][1]), digest(positive[0][1]),
    "a negative case is not a positive guest receipt");
});

test("exact pinned LLVM compiler -> wasm32 -> isolated Oreslang guest cast/inference matrix", {
  skip: !process.env.ORESLANG_LLVM_COMPILER
    && process.env.ORESLANG_CAST_PARITY_REQUIRED !== "1",
  timeout: 240000
}, async () => {
  const compiler = process.env.ORESLANG_LLVM_COMPILER;
  assert.ok(compiler, "cast parity required: exact-head native LLVM compiler is missing");
  const compilerSha = process.env.ORESLANG_LLVM_COMPILER_SHA256;
  const llvmSourceSha = process.env.ORESLANG_LLVM_SOURCE_SHA;
  assert.match(compilerSha || "", /^[0-9a-f]{64}$/);
  assert.match(llvmSourceSha || "", /^[0-9a-f]{40}$/);
  const compilerBytes = (await readBoundedRegularFile(
    compiler,256*1024*1024,"invalid native compiler")).bytes;
  assert.equal(digest(compilerBytes), compilerSha,
    "actual compiler bytes do not match required pinned digest");
  const tmp = await mkdtemp(join(tmpdir(),"ores-cast-wasm-"));
  try {
    for (const [id, source] of positive) {
      const input=join(tmp,id+".ores"), output=join(tmp,id+".wasm");
      await writeFile(input,source,{flag:"wx"});
      const sourceSha = digest(await readFile(input));
      const receipt=await compileOresToWasm({
        compiler,compilerSha256:compilerSha,source:input,output,
        environment:"browser",publication:"atomic"
      });
      const release=await readAtomicRelease(output);
      assert.equal(receipt.compilerSha256,compilerSha,id);
      assert.equal(receipt.sourceSha256,sourceSha,id);
      assert.equal(receipt.wasmSha256,digest(release.wasm),id);
      assert.equal(release.manifest.wasmSha256,receipt.wasmSha256,id);
      assert.deepEqual(release.manifest.imports,[],id);
      assert.deepEqual(release.manifest.requiredCapabilities,[],id);
      const actual=await runIsolatedCoreGuest(release.wasm,{
        expectedSha256:receipt.wasmSha256,timeoutMs:5000
      });
      assert.equal(actual.value,42n,id);
      assert.equal(actual.admission.hostCapabilities,0,id);
    }
    for (const [id, source, expectedDiagnostic] of negative) {
      const input=join(tmp,id+".ores"), output=join(tmp,id+".wasm");
      await writeFile(input,source,{flag:"wx"});
      await assert.rejects(
        compileOresToWasm({
          compiler,compilerSha256:compilerSha,source:input,output,
          environment:"browser",publication:"atomic"
        }),
        error=>/oreslang-llvmc:/.test(String(error?.message)) &&
          expectedDiagnostic.test(String(error?.message)),
        "negative "+id+" must fail by compiler-owned type/ownership diagnosis"
      );
      await assert.rejects(stat(output+".current.json"),{code:"ENOENT"},
        "failed cast must never publish a Wasm guest");
    }
  } finally {
    await rm(tmp,{recursive:true,force:true});
  }
});
