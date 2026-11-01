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

test("policy words inside comments and strings are not source annotations", () => {
  const scalar = `fnc main():int {
   const x = "define enum MaxActorThreads as LOW int = 3";
   // @ActorMaxThreads(MaxActorThreads.HIGH)
   /* outer /* @ActorMaxThreads(MaxActorThreads.LOW) */ end */
   return 42;
  }`;
  assert.doesNotThrow(() => rejectUnsupportedActorThreadSource(bytes(scalar)));
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

test("critical/suspends v1 rejects unsupported lowering before compiler invocation", () => {
  for (const source of [
    "async fnc foo(): int { return 1; }",
    "pub async routine foo(): int { return 1; }",
  ]) {
    assert.throws(() => rejectUnsupportedActorThreadSource(bytes(source)),
      /'async' modifier removed/);
  }
  for (const source of [
    "suspends fnc foo(): int { return 1; }",
    "suspend fnc foo(): int { return 1; }",
  ]) {
    assert.throws(() => rejectUnsupportedActorThreadSource(bytes(source)),
      /suspends requires continuation lowering/);
  }
  for (const source of [
    "critical fnc foo(): void { return; }",
    "suspends fnc foo(): void { critical { return; } }",
    "fnc foo(): void { try critical { return; } }",
    "critical suspends fnc foo(): void { return; }",
  ]) {
    assert.throws(() => rejectUnsupportedActorThreadSource(bytes(source)),
      /critical requires scheduler-owned guard lowering/);
  }
});

test("critical/suspends policy ignores comments and literals", () => {
  assert.doesNotThrow(() => rejectUnsupportedActorThreadSource(bytes(
    "fnc main():int { let int critical=7; return critical; }")));
  assert.doesNotThrow(() => rejectUnsupportedActorThreadSource(bytes(`
    fnc main():int {
      const message = "critical suspends fnc async";
      /* outer /* critical async */ suspends */
      // critical { await readch ch }
      return 1;
    }`)));
});
