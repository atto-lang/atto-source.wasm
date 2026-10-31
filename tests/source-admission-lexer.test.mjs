import test from "node:test";
import assert from "node:assert/strict";
import {lexSourceAdmission} from "../src/source-admission-lexer.mjs";

const bytes = text => new TextEncoder().encode(text);
const words = text => lexSourceAdmission(bytes(text)).map(token => token.text);

test("shared admission lexer terminates comments at all six line boundaries", () => {
  for (const sep of ["\r", "\r\n", "\n", "\u0085", "\u2028", "\u2029"]) {
    assert.deepEqual(words("// inert" + sep + "@Critical(1)"),
                     ["@", "Critical", "(", "1", ")"], JSON.stringify(sep));
    assert.deepEqual(words("// @Critical(1)" + sep + "define actor X as end"),
                     ["define", "actor", "X", "as", "end"], JSON.stringify(sep));
  }
});

test("NEL is a declaration separator and cannot glue keywords together", () => {
  assert.deepEqual(words("define\u0085actor X as end"),
                   ["define", "actor", "X", "as", "end"]);
  assert.deepEqual(words("on\u0085structural Shape"),
                   ["on", "structural", "Shape"]);
});

test("nested comments and quoted decoys do not create executable tokens", () => {
  assert.deepEqual(words('/* outer /* @Critical(1) */ end */ "@Unsafe" '
                         + "'@RequiresPermission'"),
                   []);
  assert.deepEqual(words('/* nested /* ok */ closed */ @Critical'),
                   ["@", "Critical"]);
});

test("shared source admission rejects invalid UTF-8 and malformed literals", () => {
  assert.throws(() => lexSourceAdmission(new Uint8Array([0xc0, 0xaf])), /encoded|valid/i);
  assert.throws(() => words("/* unterminated"), /unterminated source comment/);
  assert.throws(() => words('"unterminated'), /unterminated source string/);
  const tick = String.fromCharCode(96);
  assert.throws(() => words(tick + "$" + "{x}" + tick), /template interpolation unsupported/);
});

test("shared source admission enforces bounded depth and token count", () => {
  assert.throws(() => words("/*".repeat(129) + "*/".repeat(129)),
                /source comment nesting exceeded/);
  assert.throws(() => words(";".repeat(100_001)), /source token budget exceeded/);
});

test("shared scanner preserves token shape and identifier source offset", () => {
  const items = lexSourceAdmission(bytes('fnc f():int{return 42;}'));
  assert.deepEqual(items.slice(0, 3), [
    {text:"fnc",offset:0,id:true},
    {text:"f",offset:4,id:true},
    {text:"(",offset:5,id:false}
  ]);
});
