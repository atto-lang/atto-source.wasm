/**
 * Runtime-backed WebAssembly isolation probes, not source-compiler parity.
 *
 * Each run creates a distinct disposable Node Worker and WebAssembly Instance.
 * Node Workers do not provide an OS sandbox; never represent these tests as
 * verified hostile native-code isolation or cross-backend AttoLang guest parity.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

function compileCoreWasm(ir, {allowUndefined = false, optimization = "-Oz"} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "atto-wasm-neighbor-"));
  const file = join(directory, "guest.wasm");
  const args = ["--target=wasm32", "-x", "ir", optimization, "-nostdlib",
    "-Wl,--no-entry", "-Wl,--export=main", "-Wl,--initial-memory=131072",
    "-Wl,--max-memory=131072"];
  if (allowUndefined) args.push("-Wl,--allow-undefined");
  args.push("-o", file, "-");
  try {
    const built = spawnSync(process.env.CLANG || "clang", args, {
      input: ir, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024
    });
    assert.ifError(built.error);
    assert.equal(built.signal, null, built.stderr);
    assert.equal(built.status, 0, built.stderr);
    const bytes = readFileSync(file);
    assert.ok(bytes.length > 8);
    return bytes;
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

const counterSource = 'target triple = "wasm32-unknown-unknown"\n' +
  '@counter = internal global i64 0\n' +
  'define i64 @main() {\nentry:\n' +
  ' %old = load i64, ptr @counter\n %next = add i64 %old, 1\n' +
  ' store i64 %next, ptr @counter\n ret i64 %next\n}\n';

const spinSource = 'target triple = "wasm32-unknown-unknown"\n' +
  'define i64 @main() {\nentry:\n br label %spin\n' +
  'spin:\n br label %spin\n}\n';

test("noncooperative guest is terminated while two neighboring Wasm instances remain independent", {
  timeout: 30000
}, async () => {
  const spinning = compileCoreWasm(spinSource, {optimization: "-O0"});
  const counter = compileCoreWasm(counterSource);
  const sha = createHash("sha256").update(counter).digest("hex");

  // Reserve one Worker for nonterminating computation. Attach its rejection
  // handler immediately to avoid masking it as an unhandled promise.
  const terminated = assert.rejects(
    runIsolatedCoreGuest(spinning, {timeoutMs: 1200}),
    /guest execution deadline exceeded/
  );
  const healthy = await Promise.all([
    runIsolatedCoreGuest(counter, {timeoutMs: 10000}),
    runIsolatedCoreGuest(counter, {timeoutMs: 10000})
  ]);
  assert.deepEqual(healthy.map(({value}) => value), [1n, 1n]);
  for (const {admission} of healthy) {
    assert.equal(admission.sha256, sha);
    assert.equal(admission.hostCapabilities, 0);
    assert.equal(admission.imports, 0);
    assert.equal(admission.memoryMaximumPages, 2);
  }
  await terminated;

  // A terminated Worker must release its active reservation. A subsequent
  // fresh instance must start with its own untouched mutable global.
  const resumed = await runIsolatedCoreGuest(counter, {timeoutMs: 10000});
  assert.equal(resumed.value, 1n);
  assert.equal(resumed.admission.sha256, sha);
});

test("a trapping Wasm guest cannot corrupt either neighboring instance", {
  timeout: 30000
}, async () => {
  const trapping = compileCoreWasm('target triple = "wasm32-unknown-unknown"\n' +
    'define i64 @main() {\nentry:\n unreachable\n}\n');
  const counter = compileCoreWasm(counterSource);
  const trapped = assert.rejects(
    runIsolatedCoreGuest(trapping, {timeoutMs: 10000}),
    /guest rejected or failed:.*unreachable/
  );
  const neighbors = await Promise.all([
    runIsolatedCoreGuest(counter, {timeoutMs: 10000}),
    runIsolatedCoreGuest(counter, {timeoutMs: 10000})
  ]);
  assert.deepEqual(neighbors.map(result => result.value), [1n, 1n]);
  await trapped;
  const after = await runIsolatedCoreGuest(counter, {timeoutMs: 10000});
  assert.equal(after.value, 1n);
});

test("forbidden host import is denied while another zero-capability guest executes", {
  timeout: 30000
}, async () => {
  const denied = compileCoreWasm(
    'target triple = "wasm32-unknown-unknown"\n' +
    'declare i64 @privileged_host_operation()\n' +
    'define i64 @main() {\nentry:\n' +
    ' %value = call i64 @privileged_host_operation()\n ret i64 %value\n}\n',
    {allowUndefined: true}
  );
  const healthy = compileCoreWasm(counterSource);
  assert.ok(WebAssembly.Module.imports(new WebAssembly.Module(denied)).length > 0);
  const unauthorized = assert.rejects(
    runIsolatedCoreGuest(denied, {timeoutMs: 10000}),
    /host imports denied/
  );
  const result = await runIsolatedCoreGuest(healthy, {timeoutMs: 10000});
  assert.equal(result.value, 1n);
  assert.equal(result.admission.hostCapabilities, 0);
  await unauthorized;
});
