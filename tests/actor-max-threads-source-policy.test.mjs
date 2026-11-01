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

test("supervisor source, inheritance, interfaces, and traits fail before Wasm compilation", () => {
  for (const source of [
    "define supervisor S1 as on_panic(f: Failure): void { return; } end",
    "pub define supervisor S1 as end",
    "define pub supervisor S1 as end",
    "define supervisor actor S1 as end",
    "define supervisor S1 extends Actor as end",
    "define supervisor S1 implements Observer as end",
    "define supervisor S1 with RestartPolicy as end",
    "define module Workers as define supervisor S1 as end end"
  ]) {
    assert.throws(() => rejectUnsupportedActorThreadSource(bytes(source)),
      /WASM source supervisor unsupported: no typed Failure or CONTROL lowering/, source);
  }
});

test("supervisor-like strings, comments and identifiers do not forge CONTROL", () => {
  const source = `fnc main():int {
    const description = "define supervisor Fake extends Actor as end";
    // define supervisor InComment as end
    /* define /* supervisor */ supervisor S1 implements Fake as end */
    const supervisor_count = 42;
    return supervisor_count;
  }`;
  assert.doesNotThrow(() => rejectUnsupportedActorThreadSource(bytes(source)));
});
