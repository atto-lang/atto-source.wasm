// Exercise the REAL Wasm publication bridge's source preflight. The bridge
// currently has no authenticated std/* module graph and must not publish an
// artifact for imports it cannot resolve. No native compiler is executed here.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileOresToWasm, assertScalarSourceHasNoImports } from "../scripts/compile-ores.mjs";

const denied = [
  'import module path from "std/path";',
  'import module path from "std/path.atto";',
  'import module sync from "atto.std/sync";',
  'import module telemetry from "ores.std/telemetry.atto";',
  'import module unknown from "std/unknown";',
  'import module escaped from "std/../path";',
  'import module escaped from "../stdlib/std/path.atto";',
  'pub fnc helper(): int { return 3; }\nimport module path from "std/path";',
  '/* preceding comment */\rimport module path from "std/path";',
  '/* outer /* nested */ inner */ import module path from "std/path";'
];
const main = '\npub fnc main(): int { return 42; }\n';

test("actual wasm32 publication bridge rejects all ten unlinked imports before compiler invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "atto-wasm-std-import-denial-"));
  try {
    // Intentionally not a compiler. If an untrusted import ever reaches
    // compilation, the test must fail rather than recording a false guest PASS.
    const compiler = join(root, "compiler-not-executable");
    await writeFile(compiler, "not-a-real-compiler", { mode: 0o400 });
    for (const [index, prefix] of denied.entries()) {
      const source = join(root, "reject-" + index + ".atto");
      const output = join(root, "reject-" + index + ".wasm");
      await writeFile(source, prefix + main, { flag: "wx", mode: 0o400 });
      await assert.rejects(
        compileOresToWasm({ compiler, source, output, publication: "legacy" }),
        /source imports require verified complete Wasm module graph/,
        "unlinked std import " + index + " must fail BEFORE staging a compiler"
      );
      const entries = await readdir(root);
      assert.ok(!entries.some(name => name.startsWith("reject-" + index + ".wasm")),
        "no artifact or metadata may be published for unlinked import " + index);
      assert.ok(!entries.some(name => name.startsWith(".oreslang-wasm-")),
        "no compiler staging directory permitted for unlinked import " + index);
    }
    console.log("WASM_STD_BRIDGE_IMPORT_REJECTIONS=10|native_guest=NOT_EXECUTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lexically inert import lookalikes do not trigger false admission failures", () => {
  for (const source of [
    '// import module path from "std/path";\n' + main,
    '/* import module sync from "atto.std/sync"; */\n' + main,
    '/* outer /* import module sync from "std/sync" */ end */\n' + main,
    'pub fnc main(): int { // import module trace from "std/telemetry";\n return 42; }\n',
    'pub fnc main(): int { return 42; } // import module other from "std/path";'
  ]) assert.doesNotThrow(() => assertScalarSourceHasNoImports(Buffer.from(source)));
});

test("fail-closed when source itself is malformed, not after compilation", () => {
  assert.throws(() => assertScalarSourceHasNoImports(Buffer.from("/* unterminated")), /unterminated/);
  assert.throws(() => assertScalarSourceHasNoImports(Buffer.from('pub fnc main() {return "oops')), /unterminated/);
  assert.throws(() => assertScalarSourceHasNoImports(Buffer.from([0x66, 0, 0x69])), /NUL byte/);
});
