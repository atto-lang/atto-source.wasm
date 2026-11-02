import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const fixtures = [
  "arithmetic-76",
  "class-scalar-constructor",
  "forward-call",
  "native-int",
  "negative-result",
  "return-arithmetic",
  "unsupported-any-ternary",
  "value-pipe-invalid",
  "value-pipe-scalar",
  "zero-result",
];
test("AttoLang example sources are byte-identical to retained legacy .ores inputs", async () => {
  for (const name of fixtures) {
    const [atto, legacy] = await Promise.all([
      readFile(new URL("../examples/" + name + ".atto", import.meta.url)),
      readFile(new URL("../examples/" + name + ".ores", import.meta.url)),
    ]);
    assert.ok(atto.equals(legacy), name + ": .atto/legacy .ores source bytes differ");
  }
});
