// Source-contract checks only: actual Atto compilation/execution is separate.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../stdlib/actor/policy.atto", import.meta.url), "utf8");
const smoke = readFileSync(new URL("../stdlib/actor/guest_smoke.atto", import.meta.url), "utf8");
const functions = [
  "actor_mailbox_admissible", "actor_future_transition_valid",
  "actor_lifecycle_transition_valid", "actor_should_restart",
  "actor_restart_first", "actor_restart_end_exclusive",
  "actor_restart_budget_allows", "actor_next_generation",
  "actor_failure_notifies_supervisor", "actor_cancel_request_admissible",
  "actor_stop_request_admissible", "actor_stop_completion_admissible",
  "actor_restart_generation_admissible", "actor_supervisor_notice_admissible",
  "actor_reply_admissible"
];

test("all actor policy APIs belong to std.actor namespace, not a module", () => {
  assert.match(source, /^use namespace std\.actor;\s/);
  assert.match(smoke, /^\/\/[^\n]*\n\/\/[^\n]*\nuse namespace std\.actor\.smoke;/);
  assert.doesNotMatch(source, /\bdefine\s+(?:pub\s+)?module\b/);
  assert.doesNotMatch(source, /\b(?:native|extern|Java\.type|require\(|import\s+java)\b/);
  for (const name of functions) {
    assert.match(source, new RegExp("pub fnc " + name + "\\("));
    assert.match(smoke, new RegExp("\\b" + name + "\\b"));
  }
  assert.match(smoke, /from "\.\/policy\.atto";/);
  assert.doesNotMatch(smoke, /from "\.\.\/|from pkg/);
  assert.match(smoke, /return 42;/);
});
test("restart and physical stop policies remain fail-closed", () => {
  assert.match(source, /return pending <= maximum - requested;/);
  assert.match(source, /if current >= 2147483647 then return -1;/);
  assert.match(source, /if kind == 3 then return true;/);
  assert.match(source, /if old_quiescent == false then return false;/);
  assert.match(source, /return physical_quiescent;/);
});
