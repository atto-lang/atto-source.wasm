import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedActorThreadSource as check} from "../src/actor-max-threads-source-policy.mjs";
const bytes = text => new TextEncoder().encode(text);
const annotation = '@RequiresPermission("ffi")';

for (const [label, separator] of [
  ["CR", "\r"], ["CRLF", "\r\n"], ["LF", "\n"],
  ["NEL", "\u0085"], ["LS", "\u2028"], ["PS", "\u2029"],
]) {
  test(`active annotation after ${label} comment is rejected`, () => {
    assert.throws(() => check(bytes(`// inert${separator}${annotation}\nfnc main():int{return 42;}`)),
                  /source annotation unsupported/);
  });
  test(`annotation within ${label} comment remains inert`, () => {
    assert.doesNotThrow(() => check(bytes(`fnc main():int{return 42;} // ${annotation}${separator}`)));
  });
}

test("nested comments remain inert, but a directive after closing is active", () => {
  assert.doesNotThrow(() => check(bytes(`/* outer /* ${annotation} */ end */ fnc main():int{return 42;}`)));
  assert.throws(() => check(bytes(`/* outer /* inert */ end */ ${annotation}`)), /source annotation unsupported/);
});
test("unterminated and over-deep nested comments fail closed", () => {
  assert.throws(() => check(bytes("/* outer /* inner */")), /unterminated source comment/);
  assert.throws(() => check(bytes("/*".repeat(129) + "*/".repeat(129))), /comment nesting exceeded/);
});
test("invalid UTF-8 fails before policy tokenization", () => {
  assert.throws(() => check(new Uint8Array([0xc3, 0x28])), /encoded|valid/i);
});
test("string-contained annotations are inert; template interpolation fails closed", () => {
  assert.doesNotThrow(() => check(bytes(`fnc main():int{const x="${annotation}";return 42;}`)));
  assert.throws(() => check(bytes('fnc main():int{return `value ${@RequiresPermission("ffi")}`;}')),
                /template interpolation unsupported/);
});
test("unterminated strings are rejected", () => {
  assert.throws(() => check(bytes('fnc main():int{return "unterminated;}')), /unterminated source string/);
});
