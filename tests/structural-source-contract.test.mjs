import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

// This is a *negative* real-compiler admission check, not Wasm structural
// parity. The Wasm backend delegates all Oreslang parsing to LLVM; once the
// positive LLVM typed/match conformance suite passes, replace this test with
// verified .ores -> wasm32 compilation and actual guest execution.
test("LLVM-backed Wasm never mislabels unsupported structural source as compiled", {
  skip: !process.env.ORESLANG_LLVM_COMPILER
}, async () => {
  const work = await mkdtemp(join(tmpdir(),"ores-wasm-structural-"));
  try {
    const source = join(work,"structural.ores");
    await writeFile(source,`
      define interface Shape
        x: int;
      end
      fnc consume(structural Shape value): int { return value.x; }
      fnc main(): int { return 1; }
    `, {flag:"wx"});
    const compile = spawnSync(process.env.ORESLANG_LLVM_COMPILER,[source],{
      encoding:"utf8",timeout:15000,maxBuffer:1024*1024
    });
    assert.equal(compile.error,undefined,"native compiler must run");
    assert.equal(compile.signal,null,"compiler must diagnose rather than crash");
    assert.ok(Number.isInteger(compile.status) && compile.status > 0,
      "unsupported structural program must reject with non-zero exit");
    assert.notEqual(compile.stderr.trim(),"","must give a diagnostic");
    assert.equal(compile.stdout.trim(),"","must not publish partial LLVM IR");
  } finally {
    await rm(work,{recursive:true,force:true});
  }
});
