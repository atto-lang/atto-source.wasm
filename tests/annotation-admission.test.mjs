import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {rejectUnsupportedAnnotationsSource} from "../scripts/compile-ores.mjs";

const bytes = source => Buffer.from(source, "utf8");

test("Wasm preflight rejects unsupported semantic attributes", () => {
 for (const attribute of [
  '@FromJson("id")', '@CallerRole(Admin)', '@CallableBy(Admin)',
  '@DefaultArgVals(x=1)', '@derive(Eq)', '@UnknownPolicy'
 ]) {
  assert.throws(() => rejectUnsupportedAnnotationsSource(bytes(
   attribute + "\npub fnc main(): int { return 42; }"
  )), /wasm annotation .* guest-AOT lowering/);
 }
 assert.throws(() => rejectUnsupportedAnnotationsSource(bytes(
  "pub fnc main(): int { return 42; }\n@UnknownPolicy"
 )), /wasm annotation @UnknownPolicy/);
});

test("Wasm preflight ignores comments and quoted annotation decoys", () => {
 assert.doesNotThrow(() => rejectUnsupportedAnnotationsSource(bytes(
  "// @CallerRole(Admin)\n/* outer /* @FromJson('id') */ @derive(Eq) */\n" +
  'pub fnc main(): int { stdio.println("@CallableBy(Admin)"); return 42; }'
 )));
});

test("Wasm annotation scanning recognizes CR-only comment boundaries", () => {
 assert.throws(() => rejectUnsupportedAnnotationsSource(bytes(
  "// inline comment\r@CallerRole(Admin)\npub fnc main(): int { return 42; }"
 )), /wasm annotation @CallerRole/);
});

test("Wasm annotation scanning does not mistake template text for attributes", () => {
 assert.doesNotThrow(() => rejectUnsupportedAnnotationsSource(bytes(
  "pub fnc main(): int { stdio.println(\`email@test.example\`); return 42; }"
 )));
});

test("Wasm preflight rejects invalid UTF-8 before token admission", () => {
 assert.throws(() => rejectUnsupportedAnnotationsSource(Uint8Array.from([0xc0, 0xaf])),
  /encoded|encoding|utf-8|UTF-8|valid/i);
});


test("Wasm preflight executes canonical five-backend annotation corpus", () => {
 const raw = readFileSync(new URL("../contracts/v1/annotation-admission-v1.tsv", import.meta.url), "utf8");
 const seen = new Set();
 let count = 0;
 for (const row of raw.split(/\r?\n/)) {
  if (!row || row.startsWith("#")) continue;
  const fields = row.split("\t");
  assert.equal(fields.length, 3, "malformed parity row");
  const [kind, id, encoded] = fields;
  assert.ok(id && encoded && !seen.has(id), "invalid/duplicate parity row " + id);
  seen.add(id);
  const source = bytes(encoded.replaceAll("\\n", "\n"));
  if (kind === "shared-deny" || kind === "bootstrap-deny") {
   assert.throws(() => rejectUnsupportedAnnotationsSource(source),
    /wasm annotation .* guest-AOT lowering/, id);
  } else if (kind === "shared-allow") {
   assert.doesNotThrow(() => rejectUnsupportedAnnotationsSource(source), id);
  } else {
   assert.fail("unknown annotation parity class " + kind);
  }
  count++;
 }
 assert.ok(count >= 12, "incomplete parity corpus");
});
