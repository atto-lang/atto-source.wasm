import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtemp,writeFile,rm,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

// Required integration CI cannot silently skip its native frontend. Normal
// Node-only smoke suites may skip compiler-dependent cases, but must not
// represent that skip as LLVM or wasm32 execution evidence.
test("required structural LLVM frontend cannot be skipped", () => {
  if (process.env.ORESLANG_REQUIRE_STRUCTURAL_COMPILER === "1") {
    assert.ok(process.env.ORESLANG_LLVM_COMPILER?.trim(),
      "required structural integration must specify ORESLANG_LLVM_COMPILER");
  }
});

test("real LLVM compiler admits a scalar positive control before tuple negatives", {
  skip: !process.env.ORESLANG_LLVM_COMPILER
}, async () => {
  const work = await mkdtemp(join(tmpdir(), "ores-wasm-positive-"));
  try {
    const source = join(work, "valid.ores");
    await writeFile(source, "pub fnc main(): int { return 42; }\\n".replace("\\n", "\n"),
      {flag:"wx"});
    const compile = spawnSync(process.env.ORESLANG_LLVM_COMPILER, [source], {
      cwd:work, encoding:"utf8", timeout:15000, maxBuffer:1024*1024
    });
    assert.equal(compile.error, undefined, "LLVM compiler must execute");
    assert.equal(compile.signal, null, "positive scalar compile must not crash");
    assert.equal(compile.status, 0, "real frontend must accept supported scalar source");
    assert.match(compile.stdout, /define i64 @__oreslang_guest_main\\(/,
      "successful frontend must produce real compiler-generated LLVM IR");
    assert.deepEqual(await readdir(work), ["valid.ores"],
      "scalar control must not write untracked side artifacts");
  } finally {
    await rm(work, {recursive:true, force:true});
  }
});

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
    const before = await readdir(work);
    const compile = spawnSync(process.env.ORESLANG_LLVM_COMPILER,[source],{
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
    const source = join(work, "tuple-width.ores");
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
