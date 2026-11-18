import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {admitCoreGuest} from "../src/guest-admission.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

const simple = 'target triple = "wasm32-unknown-unknown"\ndefine i64 @main() { ret i64 42 }\n';
function compile(ir, {maxMemory = true, allowUndefined = false, optimize = "-Oz"} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ores-wasm-isolation-"));
  const path = join(dir, "guest.wasm");
  const args = ["--target=wasm32", "-x", "ir", optimize, "-nostdlib",
    "-Wl,--no-entry", "-Wl,--export=main",
    "-Wl,--initial-memory=131072"];
  if (maxMemory) args.push("-Wl,--max-memory=131072");
  if (allowUndefined) args.push("-Wl,--allow-undefined");
  args.push("-o", path, "-");
  try {
    const r = spawnSync(process.env.CLANG || "clang", args, {
      input: ir, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024
    });
    if (r.error || r.status !== 0) throw Error("clang wasm32 failed: " + (r.error?.message || r.stderr));
    return readFileSync(path);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}
test("scalar guest really compiles to Wasm and runs in a disposable worker", async () => {
  const wasm = compile(simple);
  const result = await runIsolatedCoreGuest(wasm);
  assert.equal(result.value, 42n);
  assert.equal(result.admission.memoryMaximumPages, 2);
  assert.equal(result.admission.hostCapabilities, 0);
  assert.match(result.admission.sha256, /^[a-f0-9]{64}$/);
});
test("zero-capability profile rejects unsupported scoped I/O options before worker publication", async () => {
  const wasm = compile(simple);
  for (const extra of [
    {permissions: {net: ["api.example.com:443"]}},
    {allowNet: ["api.example.com:443"]},
    {allowRead: ["/workspace"]},
    {allowRun: ["git"]},
    {allowEnv: ["API_KEY"]},
    {allowFfi: true},
    {wasi: {inheritEnv: true}},
    {imports: {env: {dangerous: () => 42}}},
    {allowImport: ["/workspace"]}
  ]) {
    assert.throws(() => admitCoreGuest(wasm, extra),
      /unsupported zero-capability guest option/);
    await assert.rejects(runIsolatedCoreGuest(wasm, extra),
      /unsupported zero-capability guest option/);
  }
  const result = await runIsolatedCoreGuest(wasm, {entry: "main", timeoutMs: 1000});
  assert.equal(result.value, 42n);
  assert.equal(result.admission.hostCapabilities, 0);
});
test("admission rejects incorrect expected content hash", async () => {
  const wasm = compile(simple);
  assert.throws(() => admitCoreGuest(wasm, {expectedSha256: "0".repeat(64)}), /SHA-256 mismatch/);
  await assert.rejects(runIsolatedCoreGuest(wasm, {expectedSha256: "f".repeat(64)}), /SHA-256 mismatch/);
});
test("admission rejects unbounded linear memory", () => {
  const wasm = compile(simple, {maxMemory: false});
  assert.throws(() => admitCoreGuest(wasm), /memory requires fixed|bounded/);
});
test("admission rejects any host import", async () => {
  const wasm = compile('target triple = "wasm32-unknown-unknown"\n' +
    'declare i64 @forbidden()\n' +
    'define i64 @main() { %x = call i64 @forbidden()\n ret i64 %x }\n',
    {allowUndefined: true});
  assert.ok(WebAssembly.Module.imports(new WebAssembly.Module(wasm)).length > 0);
  assert.throws(() => admitCoreGuest(wasm), /host imports denied/);
  await assert.rejects(runIsolatedCoreGuest(wasm), /host imports denied/);
});
test("unlowered actor routing imports remain denied for every self operation", () => {
  for (const method of ["forward", "forward_all", "forward_round_robin",
    "forward_to", "forward_by_key", "backward", "reply"]) {
    const name = "ores_actor_" + method;
    const module = compile('target triple = "wasm32-unknown-unknown"\n' +
      'declare i64 @' + name + '(i64)\n' +
      'define i64 @main() { %x = call i64 @' + name +
      '(i64 42)\n ret i64 %x }\n', {allowUndefined: true});
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(module));
    assert.ok(imports.some(item => item.name === name),
      "missing actor host import probe: " + method);
    assert.throws(() => admitCoreGuest(module), /host imports denied/,
      "unlowered Wasm guest routing import accepted: " + method);
  }
});
test("admission rejects unexpected start section and wrong result signature", () => {
  const wasm = compile(simple);
  const altered = Buffer.concat([wasm, Buffer.from([8, 1, 0])]);
  assert.throws(() => admitCoreGuest(altered), /start section/);
  const wrong = compile('target triple = "wasm32-unknown-unknown"\ndefine i32 @main() { ret i32 42 }\n');
  assert.throws(() => admitCoreGuest(wrong), /exact \(\) -> i64/);
});
test("fresh instances do not share mutable linear memory", async () => {
  const wasm = compile('target triple = "wasm32-unknown-unknown"\n' +
    '@counter = internal global i64 0\n' +
    'define i64 @main() {\nentry:\n' +
    ' %old = load i64, ptr @counter\n %next = add i64 %old, 1\n' +
    ' store i64 %next, ptr @counter\n ret i64 %next\n}\n');
  const first = await runIsolatedCoreGuest(wasm);
  const second = await runIsolatedCoreGuest(wasm);
  assert.equal(first.value, 1n);
  assert.equal(second.value, 1n);
});
test("looping guest is interrupted by worker execution deadline", async () => {
  const wasm = compile('target triple = "wasm32-unknown-unknown"\n' +
    'define i64 @main() {\nentry:\n br label %spin\nspin:\n br label %spin\n}\n',
    {optimize: "-O0"});
  await assert.rejects(
    runIsolatedCoreGuest(wasm, {timeoutMs: 500}),
    /execution deadline exceeded/
  );
});
test("API rejects invalid budget and byte types", async () => {
  assert.throws(() => admitCoreGuest(Buffer.from([])), /invalid core module header/);
  await assert.rejects(runIsolatedCoreGuest("not wasm"), /expected core WebAssembly bytes/);
  await assert.rejects(runIsolatedCoreGuest(Buffer.from([]), {timeoutMs: 0}), /timeoutMs/);
});

test("four simultaneous guest Workers never share scalar mutable state", async () => {
  const wasm = compile('target triple = "wasm32-unknown-unknown"\n' +
    '@counter = internal global i64 0\n' +
    'define i64 @main() {\nentry:\n' +
    ' %old = load i64, ptr @counter\n %next = add i64 %old, 1\n' +
    ' store i64 %next, ptr @counter\n ret i64 %next\n}\n');
  for (let round = 0; round < 3; ++round) {
    const results = await Promise.all(Array.from({length: 4}, () =>
      runIsolatedCoreGuest(wasm, {timeoutMs: 15000})));
    assert.deepEqual(results.map(r => r.value), [1n, 1n, 1n, 1n],
      "a guest Worker reused or shared mutable memory across tenant calls");
    assert.ok(results.every(r => r.admission.hostCapabilities === 0));
    assert.equal(new Set(results.map(r => r.admission.sha256)).size, 1,
      "all isolated instances must execute the exact same input artifact");
  }
});

test("concurrent worker limit fails closed and is released only after termination", async () => {
  const looping = compile('target triple = "wasm32-unknown-unknown"\n' +
    'define i64 @main() {\nentry:\n br label %spin\nspin:\n br label %spin\n}\n',
    {optimize: "-O0"});
  // Four calls synchronously reserve the full worker budget before any
  // timeout handlers can finish. A fifth cannot bypass the quota.
  const running = Array.from({length: 4}, () =>
    runIsolatedCoreGuest(looping, {timeoutMs: 600}));
  await assert.rejects(runIsolatedCoreGuest(looping, {timeoutMs: 600}),
    /guest worker concurrency quota exceeded/);
  const outcomes = await Promise.allSettled(running);
  assert.equal(outcomes.length, 4);
  assert.ok(outcomes.every(r => r.status === "rejected" &&
    /execution deadline exceeded/.test(r.reason.message)),
    "all running loops must terminate by the worker deadline");
  // A subsequent valid guest must be admitted after all four terminations.
  const fresh = await runIsolatedCoreGuest(compile(simple), {timeoutMs: 15000});
  assert.equal(fresh.value, 42n);
});
