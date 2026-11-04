import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rejectUnsupportedDurableM0Source } from "../scripts/compile-ores.mjs";

const bytes = source => new TextEncoder().encode(source);
const forbidden = [
  "define activity Payments as charge(int cents)->int{return cents;} end",
  "define workflow Checkout as run(int id)->int{return id;} end",
  "pub define activity Payments as charge(int cents)->int{return cents;} end",
  "pub define workflow Checkout as run(int id)->int{return id;} end",
  "define pub activity Payments as charge(int cents)->int{return cents;} end",
  "define pub workflow Checkout as run(int id)->int{return id;} end",
  "define /* normal gap */ activity Payments as end",
  "define /* outer /* nested */ outer */ workflow Checkout as end",
  "define module Billing as define activity PaymentProvider as end end",
  "define module Billing as define workflow Checkout as end end"
];

for (const [index, source] of forbidden.entries()) {
  test("Wasm M0 source admission denies durable definition #" + (index + 1), () => {
    assert.throws(() => rejectUnsupportedDurableM0Source(bytes(source)),
      /DURABLE_M0_BACKEND_UNSUPPORTED: Wasm durable (activity|workflow)/);
  });
}

for (const [index, source] of [
  "fnc main():int{return 42;}",
  "// define activity Payments as\nfnc main():int{return 42;}",
  "/* define workflow Checkout as */ fnc main():int{return 42;}",
  "/* nested /* define activity Fake as */ define workflow Fake as */ fnc main():int{return 42;}",
  'fnc main():int{const string name="define activity Fake as";return 42;}',
  "fnc main():int{let activity=1;let workflow=2;return 42;}",
  "fnc main():int{let activityName=1;return 42;}",
  "fnc main():int{/* define activity /* inner */ hide */return 42;}"
].entries()) {
  test("Wasm M0 source admission ignores nondeclarations #" + (index + 1), () => {
    assert.doesNotThrow(() => rejectUnsupportedDurableM0Source(bytes(source)));
  });
}

test("Wasm M0 checks malformed UTF-8 and unterminated comments before compiler", () => {
  assert.throws(() => rejectUnsupportedDurableM0Source(new Uint8Array([0xff])),
    /encoded|valid|UTF/i);
  assert.throws(() => rejectUnsupportedDurableM0Source(bytes("/* define activity")),
    /unterminated block comment/);
  assert.throws(() => rejectUnsupportedDurableM0Source(bytes('fnc main():int{"unterminated')),
    /unterminated source literal/);
  assert.throws(() => rejectUnsupportedDurableM0Source(bytes(
    "/*".repeat(129) + " define workflow Checkout as " + "*/".repeat(129))),
    /nesting too deep/);
});

test("Wasm compiler bridge calls durable capability gate before compiler execution", () => {
  const text = readFileSync(new URL("../scripts/compile-ores.mjs", import.meta.url), "utf8");
  const call = text.indexOf(" rejectUnsupportedDurableM0Source(sourceBytes);");
  const staging = text.indexOf(" const scratch=await mkdtemp(");
  assert.ok(call > 0 && staging > call,
    "source admission must precede compiler staging / guest artifact writes");
});
