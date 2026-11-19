import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedStateContainerVirtualActorSource} from "../scripts/compile-ores.mjs";

const bytes = source => new TextEncoder().encode(source);

test("two-word declaration kinds are denied before the wasm compiler bridge", () => {
  for (const [source, diagnostic] of [
    ["define state container Counter as end", "STATE_CONTAINER_BACKEND_UNSUPPORTED"],
    ["define pub state container Counter as end", "STATE_CONTAINER_BACKEND_UNSUPPORTED"],
    ["pub define state container Counter as end", "STATE_CONTAINER_BACKEND_UNSUPPORTED"],
    ["define virtual actor Cart as end", "VIRTUAL_ACTOR_BACKEND_UNSUPPORTED"],
    ["define pub virtual actor Cart as end", "VIRTUAL_ACTOR_BACKEND_UNSUPPORTED"],
    ["pub define virtual actor Cart as end", "VIRTUAL_ACTOR_BACKEND_UNSUPPORTED"],
    ["define state /* nested /* comment */ */ container Counter as end", "STATE_CONTAINER_BACKEND_UNSUPPORTED"],
    ["define virtual /* trivia */ actor Cart as end", "VIRTUAL_ACTOR_BACKEND_UNSUPPORTED"],
  ]) {
    assert.throws(() => rejectUnsupportedStateContainerVirtualActorSource(bytes(source)),
      error => error.message.includes(diagnostic), source);
  }
});

test("comments, string literals and unrelated identifiers never trigger the gate", () => {
  for (const source of [
    "fnc main():int{return 42;} // define virtual actor Cart",
    "/* define state container C as end */ fnc main():int{return 42;}",
    'fnc main():int{ let x="define virtual actor"; return 42; }',
    "fnc state() -> int { return 42; }",
    "define actor Worker as end",
    "define grain NoAlias as end",
  ]) {
    assert.doesNotThrow(() => rejectUnsupportedStateContainerVirtualActorSource(bytes(source)), source);
  }
});
