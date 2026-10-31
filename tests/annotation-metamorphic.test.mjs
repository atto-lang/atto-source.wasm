import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedActorThreadSource as check} from "../src/actor-max-threads-source-policy.mjs";

const bytes = text => new TextEncoder().encode(text);
const eols = ["\n", "\r", "\r\n", "\u0085", "\u2028", "\u2029"];
const inert = [
  '/* @RequiresPermission("ffi") */',
  '/* a /* @Unsafe */ z */',
  '"@Critical(1)"',
  "'@Critical(1)'",
  '`@ActorMaxThreads(HIGH)`',
  '// @RequiresPermission("ffi")',
];
let state = 0x4f524553;
const pick = n => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % n);

test("deterministic metamorphic annotation admission over 6000 inputs", () => {
  for (let i = 0; i < 6000; i++) {
    const separator = eols[pick(eols.length)];
    const annotation = pick(2) ? '@Critical(1)' : '@RequiresPermission("ffi")';
    const head = [];
    for (let j = 0, n = pick(5); j < n; j++) {
      const item = inert[pick(inert.length)];
      head.push(item.startsWith("//") ? item + separator : item + " ");
    }
    const prefix = `fnc main():int{return 42;} ${head.join("")}`;
    assert.throws(() => check(bytes(prefix + annotation)),
                  /source annotation unsupported/, "active annotation case " + i);
    assert.doesNotThrow(() => check(bytes(prefix)),
                        "inert comment/string case " + i);
  }
});
