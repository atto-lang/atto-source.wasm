// Explicit negative admission for native .atto imports in the single-source
// wasm32 compiler bridge. This is not a linked Wasm guest execution proof.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {assertScalarSourceHasNoImports} from "../scripts/compile-ores.mjs";

const bytes = file => readFileSync(new URL(file, import.meta.url));

test("single-source wasm32 bridge admits an import-free real Atto scalar", () => {
  const source = new TextEncoder().encode(
    "pub fnc main(): int { return 40 + 2; }\n");
  assert.doesNotThrow(() => assertScalarSourceHasNoImports(source));
});

test("37 and 109 native Atto protocol guests are not silently flattened by wasm32 bridge", () => {
  for (const entry of [
    "./stdlib/websocket_quic_compute_smoke.atto",
    "./stdlib/protocol_boundaries.atto",
  ]) {
    const source = bytes(entry);
    assert.ok(source.toString("utf8").includes("import fnc "),
      "negative fixture must contain actual source dependency declarations");
    assert.throws(() => assertScalarSourceHasNoImports(source),
      /source imports require verified complete Wasm module graph/,
      "do not publish scalar wasm with unverified imported source: " + entry);
  }
});

test("comments and strings are not treated as file import authority", () => {
  for (const source of [
    "// import fnc fake from 'x';\npub fnc main(): int { return 42; }",
    "pub fnc main(): int { return 42; } // import ignored\n",
  ]) assert.doesNotThrow(
    () => assertScalarSourceHasNoImports(new TextEncoder().encode(source)));
});
