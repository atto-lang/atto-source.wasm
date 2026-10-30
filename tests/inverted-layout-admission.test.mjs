import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedInvertedLayoutSource} from "../scripts/compile-ores.mjs";

const bytes = source => new TextEncoder().encode(source);
const deny = (source, diagnostic) => assert.throws(
  () => rejectUnsupportedInvertedLayoutSource(bytes(source)),
  error => error instanceof Error &&
    error.message.includes(diagnostic) &&
    /at byte [0-9]+/.test(error.message),
  "source must fail before native compiler invocation"
);

test("explicit inverted structs reject with a compiler-bridge capability diagnostic", () => {
  for(const text of [
    "define inverted struct Position as float x; end",
    "define pub inverted struct Position as float x; end",
    "pub define inverted struct Position as float x; end",
    "define /* commentary */ inverted /* layout */ struct Position as float x; end"
  ]) deny(text, "wasm inverted struct requires typed one-level SoA");
});

test("explicit inverted classes reject without a scalar or actor-shard fallback", () => {
  for(const text of [
    "define inverted class Particle as float x; end",
    "define pub inverted class Particle as float x; end",
    "pub define inverted class Particle as float x; end"
  ]) deny(text, "wasm inverted class requires typed one-level SoA");
});

test("explicit inverted collection requires source-checked owner ABI", () => {
  deny("fnc main():int{ let rows=InvertedArray<Point>.with_capacity(1); return 0; }",
    "wasm inverted collection requires checked owner/row/column ABI");
  deny("fnc main():int{ let x: InvertedArray < Point >; return 0; }",
    "wasm inverted collection requires checked owner/row/column ABI");
});

test("inert comments and literals must not look like inverted declarations", () => {
  const examples = [
    "fnc main():int{return 1;} // define inverted struct A",
    "fnc main():int{/* define inverted class A */return 1;}",
    'fnc main():int{let s="define inverted struct A";return 1;}',
    "fnc main():int{return 1;} /* define /* inverted class A */ ok */",
    "fnc main():int{return 1;} // InvertedArray<Point>"
  ];
  for(const example of examples) assert.doesNotThrow(
    () => rejectUnsupportedInvertedLayoutSource(bytes(example)));
});

test("near-matches are not declarations and ordinary arrays are not inverted", () => {
  for(const text of [
    "fnc main():int{let inverted=true;return 1;}",
    "fnc main():int{let a=Array<Point>();return 1;}",
    "fnc main():int{let a=SomeInvertedArray<Point>();return 1;}",
    "fnc main():int{let a=obj.InvertedArray;return 1;}"
  ]) assert.doesNotThrow(() => rejectUnsupportedInvertedLayoutSource(bytes(text)));
});

test("CR and Unicode line separators cannot hide a new inverted declaration", () => {
  for(const separator of ["\r", "\r\n", "\n", "\u0085", "\u2028", "\u2029"])
    deny("fnc main():int{return 1;} // comment"+separator+
         "define inverted struct Hidden as float x; end",
         "wasm inverted struct requires typed one-level SoA");
});

test("unclosed quotes and block comments reject rather than hiding source", () => {
  assert.throws(() => rejectUnsupportedInvertedLayoutSource(
    bytes('fnc main():int{return 1;} "unterminated define inverted struct')),
    /unterminated source literal/);
  assert.throws(() => rejectUnsupportedInvertedLayoutSource(
    bytes("fnc main():int{return 1;} /* unclosed inverted struct")),
    /unterminated block comment/);
});

test("nested comment depth budget rejects adversarial input", () => {
  const source="fnc main():int{return 1;} "+ "/*".repeat(129)+"*/".repeat(129);
  assert.throws(() => rejectUnsupportedInvertedLayoutSource(bytes(source)),
    /block comment nesting too deep/);
});

test("malformed UTF-8 rejects and does not call a compiler", () => {
  assert.throws(() => rejectUnsupportedInvertedLayoutSource(
    Uint8Array.of(0xff,0xfe,0xfa)), /encoded|UTF-8|valid|malformed/i);
});
