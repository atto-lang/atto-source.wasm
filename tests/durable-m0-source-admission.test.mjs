import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

test("Wasm preflight rejects raw NUL before comment and string elision", () => {
  const examples = [
    ["/* hidden\0 */ fnc main():int{return 42;}", 9],
    ["// hidden\0 tail\nfnc main():int{return 42;}", 9],
    ['fnc main():int{val s="hidden\0";return 42;}', 28]
  ];
  for(const [source,offset] of examples)
    assert.throws(() => rejectUnsupportedDurableM0Source(bytes(source)),
      new RegExp("WASM source preflight contains NUL byte at byte offset "+offset+"$"));
  const unicode="/* 😀 */\0 fnc main():int{return 42;}";
  assert.throws(() => rejectUnsupportedDurableM0Source(bytes(unicode)),
    /WASM source preflight contains NUL byte at byte offset 10$/);
  assert.doesNotThrow(() =>
    rejectUnsupportedDurableM0Source(bytes("/* café */ fnc main():int{return 42;}")));
});

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

test("Wasm M0 golden manifest reference is byte/sha-identical to LLVM and .NET contract", () => {
  const path = new URL("../contracts/durable-m0/v1/manifest-v1.json", import.meta.url);
  const shaPath = new URL("../contracts/durable-m0/v1/manifest-v1.sha256", import.meta.url);
  const raw = readFileSync(path);
  const pinned = "aa1eed7637b99d8c270c3cd7a3f15ab83acf0463b00ebaa58f0f52c8dd525784";
  const sha = data => createHash("sha256").update(data).digest("hex");
  assert.equal(raw.length, 1671);
  assert.equal(sha(raw), pinned);
  assert.equal(readFileSync(shaPath, "utf8").trim(), pinned);
  const manifest = JSON.parse(raw.toString("utf8"));
  assert.equal(manifest.format, "atto.durable.manifest.v1");
  assert.deepEqual(manifest.workflows[0].commands.map(c => c.order), [0, 1, 2]);
  assert.equal(manifest.workflows[0].commands[0].target, "Billing.PaymentProvider.charge");
  assert.equal(manifest.workflows[0].queries[0].endpoint, "status");
  assert.equal(JSON.stringify(manifest), raw.toString("utf8"),
    "JSON canonical bytes cannot silently reformat or reorder");
  const altered = Buffer.from(raw); altered[0] ^= 1;
  assert.notEqual(sha(altered), pinned, "a one-byte mutation must invalidate digest");
  console.log("DURABLE_M0_REFERENCE_ONLY|sha256=" + pinned + "|bytes=1671|not_guest_execution");
});

test("Wasm bridge rejects shared 464-byte corpus before LLVM compilation", () => {
  const raw = readFileSync(new URL("../contracts/durable-m0/v1/checkout.atto", import.meta.url));
  assert.equal(raw.length, 464);
  assert.throws(() => rejectUnsupportedDurableM0Source(raw),
    /DURABLE_M0_BACKEND_UNSUPPORTED: Wasm durable activity/);
});
