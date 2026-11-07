import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";

const source = new URL("../contracts/actor-stack-containment-v1/recursive-sibling.atto", import.meta.url);
const contract = new URL("../contracts/actor-stack-containment-v1/manifest.json", import.meta.url);
const expectedBlob = "3461e6f3d42b639d0df5823781132bbb075ba2bc";
const gitBlob = bytes => createHash("sha1")
  .update(Buffer.from("blob " + bytes.length + "\0", "utf8"))
  .update(bytes).digest("hex");

test("future actor-recursion source is pinned and explicitly not an executed backend claim", async () => {
  const bytes = await readFile(source);
  assert.equal(gitBlob(bytes), expectedBlob);
  const text = bytes.toString("utf8");
  assert.match(text, /fnc descend\(int depth\): int/);
  assert.match(text, /return depth == 0 \? 0 : 1 \+ descend\(depth - 1\);/);
  assert.match(text, /define actor BoundedCounter as/);
  assert.match(text, /return descend\(depth\);/);
  assert.doesNotMatch(text, /javascript|host interpret/i);
});

test("nine proposed two-actor acceptance cases remain individually not executed", async () => {
  const c = JSON.parse(await readFile(contract, "utf8"));
  assert.equal(c.schema, "attolang.wasm.actor_stack_containment_v1");
  assert.equal(c.classification, "PROPOSED_NOT_EXECUTED");
  assert.equal(c.source_git_blob, expectedBlob);
  assert.equal(c.proposed_actor_stack_limit_frames, 64);
  assert.equal(c.workers, 1);
  assert.equal(c.actors, 2);
  assert.equal(c.scenarios.length, 9);
  assert.equal(new Set(c.scenarios.map(x => x.id)).size, 9);
  assert.deepEqual(c.scenarios.map(x => x.id), [
    "A-OVERFLOW", "A-CANCEL-QUEUED", "B-PROGRESS", "SUPERVISOR-CONTROL",
    "A-RESTART", "A-STALE-MESSAGE", "A-STALE-RESUME", "B-PRESERVED", "A-FRESH"
  ]);
  for (const scenario of c.scenarios) {
    assert.equal(scenario.status, "NOT_EXECUTED");
    assert.ok(typeof scenario.expected === "string" && scenario.expected.length);
    if (Object.hasOwn(scenario, "expected_i64"))
      assert.match(scenario.expected_i64, /^[-]?[0-9]+$/);
  }
});

test("future nested-call proof cannot be promoted by a host-model, synthetic Wasm or zero-step job", async () => {
  const c = JSON.parse(await readFile(contract, "utf8"));
  assert.equal(c.fault_code, "STACK_BUDGET_EXHAUSTED");
  assert.equal(c.fault_is_not_ordinary_i64_return, true);
  assert.equal(c.no_unchecked_wasm_engine_recursion, true);
  assert.equal(c.no_shared_guest_memory, true);
  assert.equal(c.authoritative_supervisor_control_required, true);
  assert.deepEqual(Object.keys(c.evidence).sort(), [
    "hosted_ci", "java_compiler_backed", "llvm_native_compiler_backed",
    "wasm_compiler_backed", "wasmtime_aot"
  ]);
  for (const receipt of Object.values(c.evidence))
    assert.equal(receipt, null, "unverified backend cannot be marked green");
  assert.ok(c.implementation_holds.length >= 5);
});
