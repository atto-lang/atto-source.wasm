// Real bounded wasm32 guest -> Node worker -> signed64 BigInt result.
// This C-generated ABI test does NOT prove Oreslang compiler codegen, actors,
// source-language Integer.mod/rem support, Wasmtime, or OS isolation.
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {readFileSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

const cases = [
  ["negative remainder", "-9 % 4", -1n],
  ["negative modulus", "(-9 % 4) + 4", 3n],
  ["positive with negative divisor", "9 % -4", 1n],
  ["negative divisor modulus", "(-9 % -4) - (-4)", 3n],
  ["min remainder guarded", "(INT64_MIN == INT64_MIN ? 0 : INT64_MIN % -1)", 0n],
  ["min/max Euclidean modulus",
    "(INT64_MIN % INT64_MAX) + INT64_MAX", 9223372036854775806n],
  ["min divisor Euclidean modulus",
    "(-1 % INT64_MIN) - INT64_MIN", 9223372036854775807n],
  // Reference-only C arithmetic expressions corresponding to composed
  // Integer.* guest-source vectors shared by Java/.NET/Cranelift.
  ["xor(mod(-9,4), pow(2,3))",
    "(((-9 % 4) + 4) ^ (2 * 2 * 2))", 11n],
  ["rem(xor(5,3), pow(2,2))", "((5 ^ 3) % (2 * 2))", 2n],
  ["pow(rem(-9,4)+3,3)",
    "(((-9 % 4) + 3) * ((-9 % 4) + 3) * ((-9 % 4) + 3))", 8n],
  ["mod(pow(-2,3),5)", "((-2 * -2 * -2) % 5) + 5", 2n]
];

test("real Clang wasm32 signed64 ABI edge cases execute in disposable worker", async () => {
  const folder = mkdtempSync(join(tmpdir(), "ores-wasm-signed64-"));
  try {
    for (const [name, expression, expected] of cases) {
      const path = join(folder, "guest.wasm");
      const source = [
        "#include <stdint.h>",
        "__attribute__((export_name(\"main\"))) int64_t ores_entry(void) {",
        "  return (int64_t)(" + expression + ");",
        "}"
      ].join("\n");
      const compilation = spawnSync("clang", [
        "--target=wasm32", "-O2", "-nostdlib", "-x", "c", "-",
        "-Wl,--no-entry", "-Wl,--export-memory",
        "-Wl,--initial-memory=131072", "-Wl,--max-memory=131072",
        "-o", path
      ], {input: source, encoding: "utf8", timeout: 20000});
      assert.equal(compilation.status, 0, name + ": " +
        (compilation.stderr || compilation.error?.message || "clang failed"));
      const bytes = readFileSync(path);
      const module = new WebAssembly.Module(bytes);
      assert.deepEqual(WebAssembly.Module.imports(module), [], name + ": no imports");
      assert.deepEqual(WebAssembly.Module.exports(module).map(item =>
        [item.name, item.kind]), [["memory", "memory"], ["main", "function"]],
        name + ": strict scalar exports");
      const result = await runIsolatedCoreGuest(bytes, {
        entry: "main", maxMemoryPages: 2, timeoutMs: 10000
      });
      assert.equal(result.value, expected, name + ": native Wasm guest result");
      assert.equal(result.admission.hostCapabilities, 0, name + ": no ambient authority");
      assert.equal(result.admission.memoryMaximumPages, 2,
        name + ": bounded maximum memory");
    }
  } finally {
    rmSync(folder, {recursive: true, force: true});
  }
});
