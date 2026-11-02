import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,writeFile,rm,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

// This is a *negative* real-compiler admission check, not Wasm structural
// parity. The Wasm backend delegates all AttoLang parsing to LLVM; once the
// positive LLVM typed/match conformance suite passes, replace this test with
// verified .atto -> wasm32 compilation and actual guest execution.
test("LLVM-backed Wasm never mislabels unsupported structural source as compiled", {
  skip: !(process.env.ATTOLANG_LLVM_COMPILER || process.env.ORESLANG_LLVM_COMPILER)
}, async () => {
  const work = await mkdtemp(join(tmpdir(),"ores-wasm-structural-"));
  try {
    const source = join(work,"structural.atto");
    await writeFile(source,`
      define interface Shape
        x: int;
      end
      fnc consume(structural Shape value): int { return value.x; }
      fnc main(): int { return 1; }
    `, {flag:"wx"});
    const before = await readdir(work);
    const compile = spawnSync((process.env.ATTOLANG_LLVM_COMPILER || process.env.ORESLANG_LLVM_COMPILER),[source],{
      cwd: work, encoding:"utf8",timeout:15000,maxBuffer:1024*1024
    });
    assert.deepEqual(await readdir(work), before, "rejected source must leave no new artifacts");
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

 
// A distinct negative gate for the proposed positional width contract.
// It must be replaced with a positive wasm32 guest test when LLVM lowers it.
test("Wasm bridge refuses unimplemented structural tuple width and optional-tail code", {
  skip: !process.env.ORESLANG_LLVM_COMPILER
}, async () => {
  const work = await mkdtemp(join(tmpdir(), "ores-wasm-tuple-width-"));
  try {
    const source = join(work, "tuple-width.atto");
    await writeFile(source, `
      fnc take(structural (int, int, string?) value): int { return 1; }
      fnc main(): int { return take(...(5, 3, "foo", "start")); }
    `, {flag: "wx"});
    const before = await readdir(work);
    const compile = spawnSync(process.env.ORESLANG_LLVM_COMPILER, [source], {
      cwd: work, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024
    });
    assert.deepEqual(await readdir(work), before, "rejected source must leave no new artifacts");
    assert.equal(compile.error, undefined, "native compiler must actually run");
    assert.equal(compile.signal, null, "compiler must diagnose instead of crashing");
    assert.ok(Number.isInteger(compile.status) && compile.status > 0,
      "unimplemented tuple-width source must not publish a guest artifact");
    assert.notEqual(compile.stderr.trim(), "", "rejection requires a diagnostic");
    assert.equal(compile.stdout.trim(), "", "rejected source must not emit LLVM IR");
  } finally {
    await rm(work, {recursive: true, force: true});
  }
});
