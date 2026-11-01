import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {rejectUnsupportedActorPubSubSource} from "../scripts/compile-ores.mjs";

const fixtures = [
  "actor-pubsub-v1.ores",
  "actor-pubsub-multigroup-v1.ores",
  "actor-pubsub-reject-payload-type.ores",
  "actor-pubsub-reject-actor-authority.ores",
  "actor-pubsub-reject-private-subscribe.ores",
  "actor-pubsub-reject-mailbox-capability.ores",
  "actor-pubsub-reject-async-capability.ores"
];

test("shared pub-sub source corpus fails before Wasm/LLVM bridge execution", async () => {
  for (const name of fixtures) {
    const source = await readFile(new URL(
      "../contracts/v1/fixtures/" + name, import.meta.url));
    assert.throws(
      () => rejectUnsupportedActorPubSubSource(source),
      /wasm ActorGroup\/Topic source lowering unsupported/,
      name
    );
  }
});

test("pub-sub spellings in comments and strings are not capability evidence", () => {
  assert.doesNotThrow(() => rejectUnsupportedActorPubSubSource(Buffer.from(
    'fnc main():int{return 42;} // actor.group("x") Topic<String>\n'
  )));
  assert.doesNotThrow(() => rejectUnsupportedActorPubSubSource(Buffer.from(
    'fnc main():int{return 42;} // Subscription<String> .topic<String>\n'
  )));
});
