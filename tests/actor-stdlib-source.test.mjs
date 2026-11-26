// Source-contract checks only: actual Atto compilation/execution is separate.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../stdlib/actor/policy.atto", import.meta.url), "utf8");
const smoke = readFileSync(new URL("../stdlib/actor/guest_smoke.atto", import.meta.url), "utf8");
const edges = readFileSync(new URL("../stdlib/actor/guest_edges.atto", import.meta.url), "utf8");
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

test("native actor adversarial boundary matrix is broad and fail-closed", () => {
  assert.match(edges, /use namespace std\.actor\.boundaries;/);
  assert.match(edges, /from "\.\/policy\.atto";/);
  assert.doesNotMatch(edges, /from "\.\.\/|from pkg/);
  for (const name of functions) {
    assert.match(edges, new RegExp("\\b" + name + "\\b"));
  }
  const codes = [...edges.matchAll(/\bthen return (1\d\d|2\d\d); fi/g)].map(match => Number(match[1]));
  assert.equal(codes.length, 133, "all 133 edge cases must be present");
  assert.equal(new Set(codes).size, 133, "each failure case needs a unique diagnostic exit");
  assert.equal(Math.min(...codes), 100);
  assert.equal(Math.max(...codes), 232);
  assert.match(edges, /return 42;/);
  assert.match(edges, /65535, 65536/);
  assert.match(edges, /2147483647/);
  assert.match(edges, /physical turn not retired/);
  assert.match(edges, /forged CONTROL/);
});
