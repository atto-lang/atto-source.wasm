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

test("all actor-domain declaration spellings and spawns fail before scalar bridge", () => {
  for (const source of [
    "define actor A1 as end",
    "define shared actor A1 as end",
    "define pub actor A1 as end",
    "pub define actor A1 as end",
    "define untrusted actor A1 as end",
    "define isoactor A1 as end",
    "define supervisor S1 as end",
    "define class A1 extends Actor as end",
    "define class A1 extends IsoActor as end",
    "define class A1 extends UntrustedActor as end",
    "actor fnc work(): int { return 42; }",
    "actor routine work(): int { return 42; }",
    "fnc main():int { spawn Worker(); return 42; }",
    "define actor Parent as end\ndefine actor Child extends Parent as end",
    "define actor A1 implements TrainableStage as end"
  ]) assert.throws(() => rejectUnsupportedActorThreadSource(bytes(source)),
    /source actor execution unsupported/, source);
});

test("ordinary scalar source is not denied by actor-like text in comments or strings", () => {
  for (const source of [
    'fnc main():int{return 42;} // define untrusted actor Foo as end',
    'fnc main():int{return 42;} /* define isoactor B as end */',
    'fnc main():int{return 42;} /* outer /* spawn Bad() */ end */',
    'fnc main():int { const label = "define class A1 extends Actor as end"; return 42; }',
    'fnc main():int { const label = "actor fnc"; return 42; }',
    'fnc main():int{return 42;} // define shared actor S'
  ]) assert.doesNotThrow(() => rejectUnsupportedActorThreadSource(bytes(source)), source);
  assert.doesNotThrow(() => rejectUnsupportedActorThreadSource(
    bytes("define class PureValue as end\nfnc main():int{return 42;}")));
});
