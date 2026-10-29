import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {rejectUnsupportedActorThreadSource} from "../src/actor-max-threads-source-policy.mjs";

const corpus = new URL("../contracts/v1/annotation-admission-v1.cases", import.meta.url);
const decoder = new TextDecoder("utf-8", {fatal:true});

test("shared annotation corpus is enforced at the WASM source-snapshot admission boundary", () => {
  const raw = readFileSync(corpus, "utf8");
  const seen = new Set();
  let accepted = 0, rejected = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const fields = line.split("|");
    assert.equal(fields.length, 7, "invalid parity corpus schema");
    const [id, ...rest] = fields;
    assert.match(id, /^[a-z][a-z_0-9]*$/);
    assert.ok(!seen.has(id), "duplicate parity corpus id " + id);
    seen.add(id);
    const expected = rest.slice(0, 5);
    assert.ok(expected.every(v => v === "pass" || v === "reject"),
              "invalid backend expectation " + id);
    const encoded = fields[6];
    const bytes = Buffer.from(encoded, "base64");
    assert.equal(bytes.toString("base64"), encoded, "noncanonical source base64 " + id);
    assert.equal(new TextEncoder().encode(decoder.decode(bytes)).toString("hex"),
                 bytes.toString("hex"), "invalid source UTF-8 " + id);
    if (fields[3] === "reject") {
      rejected++;
      assert.throws(() => rejectUnsupportedActorThreadSource(bytes),
                    /annotation unsupported|ActorMaxThreads unsupported|actor execution unsupported/,
                    id);
    } else {
      accepted++;
      assert.doesNotThrow(() => rejectUnsupportedActorThreadSource(bytes), id);
    }
  }
  assert.equal(seen.size, 17);
  assert.equal(accepted, 3);
  assert.equal(rejected, 14);
});
