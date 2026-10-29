import test from "node:test";
import assert from "node:assert/strict";
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

test("Wasm preflight rejects invalid UTF-8 before token admission", () => {
 assert.throws(() => rejectUnsupportedAnnotationsSource(Uint8Array.from([0xc0, 0xaf])),
  /encoded|encoding|utf-8|UTF-8|valid/i);
});
