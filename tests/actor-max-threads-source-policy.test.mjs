import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedActorThreadSource} from "../src/actor-max-threads-source-policy.mjs";
const bytes = value => new TextEncoder().encode(value);

test("WASM source bridge denies actor tier enum and LOW/MEDIUM/HIGH annotations", () => {
  const declaration = `define enum MaxActorThreads as
LOW int = 1
MEDIUM int = 2
HIGH int = 3
end
`;
  assert.throws(() => rejectUnsupportedActorThreadSource(bytes(declaration)),
    /built-in MaxActorThreads enum unsupported/);
  for (const tier of ["LOW", "MEDIUM", "HIGH"]) {
    assert.throws(() => rejectUnsupportedActorThreadSource(
      bytes(`@ActorMaxThreads(MaxActorThreads.${tier})
define actor HungryActor as end`)),
      /source actor @ActorMaxThreads unsupported/);
  }
  assert.throws(() => rejectUnsupportedActorThreadSource(
    bytes("define actor Ordinary as end")), /source actor execution unsupported/);
});

test("WASM fails closed on any unlowered annotation before invoking native LLVM", () => {
  for (const annotation of [
    "@Ret(int)", "@FromJson(\"id\")", "@Critical(1)",
    "@RequiresPermission(\"ffi\")", "@Unknown", "@inline(always)"
  ]) {
    assert.throws(
      () => rejectUnsupportedActorThreadSource(bytes(
        annotation + "\nfnc main(): int { return 42; }"
      )),
      /source annotation unsupported/, annotation
    );
  }
  assert.doesNotThrow(() => rejectUnsupportedActorThreadSource(
    bytes("fnc main(): int { return 42; }")
  ));
});

test("policy words inside comments and strings are not source annotations", () => {
  const scalar = `fnc main():int {
   const x = "define enum MaxActorThreads as LOW int = 3";
   // @ActorMaxThreads(MaxActorThreads.HIGH)
   /* outer /* @ActorMaxThreads(MaxActorThreads.LOW) */ end */
   return 42;
  }`;
  assert.doesNotThrow(() => rejectUnsupportedActorThreadSource(bytes(scalar)));
});

test("template interpolations cannot hide executable annotation syntax", () => {
  assert.throws(
    () => rejectUnsupportedActorThreadSource(bytes(
      "fnc main(): int { return `value ${@Critical(1)}`; }"
    )),
    /template interpolation unsupported/
  );
  assert.doesNotThrow(
    () => rejectUnsupportedActorThreadSource(bytes(
      "fnc main(): int { return `inert @Critical(1)`; }"
    ))
  );
});

test("Unicode line separators terminate comments before active annotations", () => {
  for (const separator of ["\r", "\r\n", "\n", "\u0085", "\u2028", "\u2029"]) {
    const active = "fnc main():int{return 42;} // inert" + separator + "@Critical(1)";
    assert.throws(() => rejectUnsupportedActorThreadSource(bytes(active)),
                  /source annotation unsupported/, JSON.stringify(separator));
    const commentOnly = "fnc main():int{return 42;} // @Critical(1)" + separator;
    assert.doesNotThrow(() => rejectUnsupportedActorThreadSource(bytes(commentOnly)),
                        JSON.stringify(separator));
  }
});

test("U+0085 separates unsupported actor and scheduler enum declarations", () => {
  assert.throws(() => rejectUnsupportedActorThreadSource(
    bytes("define\u0085actor Worker as end")), /source actor execution unsupported/);
  assert.throws(() => rejectUnsupportedActorThreadSource(
    bytes("define\u0085enum MaxActorThreads as LOW int = 1 end")),
    /built-in MaxActorThreads enum unsupported/);
});

test("policy rejects malformed source snapshots without host execution", () => {
  assert.throws(() => rejectUnsupportedActorThreadSource("not bytes"), TypeError);
  assert.throws(() => rejectUnsupportedActorThreadSource(new Uint8Array([0xff])),
    /encoded|valid/i);
  assert.throws(() => rejectUnsupportedActorThreadSource(bytes("/* unterminated")),
    /unterminated source comment/);
  assert.throws(() => rejectUnsupportedActorThreadSource(bytes('"unterminated')),
    /unterminated source string/);
});
