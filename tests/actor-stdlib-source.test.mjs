// Structural only; NOT a compiler/guest execution proof.
// Real execution should import contracts/std-actor-v1/guest-smoke.atto and return 42.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../stdlib/actor/policy.atto", import.meta.url), "utf8");
const smoke = readFileSync(new URL("../contracts/std-actor-v1/guest-smoke.atto", import.meta.url), "utf8");
const functions = [
  "actor_mailbox_admissible", "actor_future_transition_valid",
  "actor_lifecycle_transition_valid", "actor_should_restart",
  "actor_restart_first", "actor_restart_end_exclusive",
  "actor_restart_budget_allows", "actor_next_generation",
  "actor_failure_notifies_supervisor"
];
test("native Atto actor-policy surface has no host-side substitute", () => {
  for (const name of functions) {
    assert.match(source, new RegExp("pub fnc " + name + "\\("));
    assert.match(smoke, new RegExp("import fnc " + name + " from"));
  }
  assert.doesNotMatch(source, /\b(?:native|extern|Java\.type|require\(|import\s+java)\b/);
  assert.match(source, /return pending <= maximum - requested;/);
  assert.match(source, /if current >= 2147483647 then return -1;/);
  assert.match(source, /if kind == 3 then return true;/);
  assert.match(smoke, /return 42;/);
});
