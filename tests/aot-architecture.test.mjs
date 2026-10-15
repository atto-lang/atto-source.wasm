import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");

test("native AOT runner uses its own compiler-free Wasmtime dependency graph", () => {
  const builder = read("native/aot-builder/Cargo.toml");
  const runner = read("native/aot-runner/Cargo.toml");
  const builderSource = read("native/aot-builder/src/main.rs");
  const runnerSource = read("native/aot-runner/src/main.rs");
  for (const file of [builder, runner]) {
    assert.match(file, /wasmtime\s*=\s*\{[^\n]*version\s*=\s*"=49\.0\.3"/);
    assert.match(file, /default-features\s*=\s*false/);
  }
  assert.match(builder, /"cranelift"/);
  assert.doesNotMatch(runner, /"cranelift"|"winch"|"parallel-compilation"/);
  assert.match(builderSource, /precompile_module\(/);
  assert.doesNotMatch(runnerSource, /\bModule::new\b|\bModule::from_binary\b|precompile_module\(|\bModule::validate\b/);
  assert.match(runnerSource, /\bModule::deserialize\(/);
  assert.match(runnerSource, /unsafe\s*\{/);
  assert.match(runnerSource, /store\.set_fuel\(/);
  assert.match(runnerSource, /store\.limiter\(/);
  assert.match(runnerSource, /digest mismatch/);
});
test("trusted AOT smoke exercises a valid guest and unsafe-artifact rejection", () => {
  const smoke = read("scripts/aot-smoke.sh");
  assert.match(smoke, /result_i64=42/);
  assert.match(smoke, /mutated native artifact accepted/);
  assert.match(smoke, /out-of-fuel guest completed/);
});
