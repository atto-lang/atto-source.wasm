import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {rejectUnsupportedActorPubSubSource, rejectUnsupportedActorPipeSource} from "../scripts/compile-ores.mjs";

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

test("canonical share! try_publish is denied before Wasm bridge execution", () => {
  // These source forms may omit actor.group and Topic<T> in the unit because
  // the topic handle came from an import or an enclosing actor-bound method.
  for (const source of [
    "val receipt = topic.try_publish(share! event)?;",
    "val receipt = topic.try_publish(share!event);",
    "val receipt = topic.try_publish(rt share event);",
    "val receipt = existing_topic.try_publish(share! event)?;",
    "val callable = topic.try_publish;",
    "val rejected = topic.try_publish<String>(share! event);",
    "val receipt = topic /* nested /* c */ c */ . try_publish(share! event)?;",
    "val receipt = topic?.try_publish(share! event)?;"
  ]) {
    assert.throws(
      () => rejectUnsupportedActorPubSubSource(Buffer.from(source)),
      /wasm ActorGroup\\/Topic source lowering unsupported/,
      source
    );
  }
});

test("inert try_publish text and unrelated free function name are not Topic evidence", () => {
  for (const source of [
    "fnc try_publish(event:int):int{return event;}",
    'fnc main():int{return 42;} // topic.try_publish(share! event)?',
    'fnc main():int{return 42;} /* topic.try_publish(rt share event) */',
    'fnc main():int{return 42;} "topic.try_publish(share! event)?"',
    "fnc main():int{return try_publish(42);}",
    "fnc main():int{const n=topic.try_publisher;return 42;}"
  ]) {
    assert.doesNotThrow(
      () => rejectUnsupportedActorPubSubSource(Buffer.from(source)),source);
  }
});

test("NEL comment boundary cannot hide aliased Topic.try_publish",()=>{
  assert.throws(()=>rejectUnsupportedActorPubSubSource(Buffer.from(
    "// inert topic.try_publish(share! event)?\u0085"+
    "val receipt=alias.try_publish(share! event)?;")),
    /wasm ActorGroup\/Topic source lowering unsupported/);
});

test("actor pipe and ActorUtils static construction fail before Wasm/LLVM bridge", () => {
  for (const source of [
    "return spawn Source() pipe spawn Transform() pipe spawn Sink();",
    "return ActorUtils::pipe(spawn A(), spawn B());",
    "return ActorUtils.pipe(spawn A(), spawn B());",
    "return first pipe second;"
  ]) {
    assert.throws(
      () => rejectUnsupportedActorPipeSource(Buffer.from(source)),
      /wasm actor pipe source lowering unsupported/,
      source
    );
  }
});

test("pipe keyword preflight preserves inert text and functional |> syntax", () => {
  for (const source of [
    "fnc pipe(x:int):int{return x;}",
    "fnc main(pipe:int):int{return pipe+1;}",
    "fnc main():int{return 42;} // spawn Source() pipe spawn Sink()",
    'fnc main():int{return 42;} "ActorUtils::pipe(x,y)"',
    "fnc main(x:int):int{return x |> plus_one;}"
  ]) {
    assert.doesNotThrow(
      () => rejectUnsupportedActorPipeSource(Buffer.from(source)),
      source
    );
  }
});

test("exact cross-backend alias-only share! Atto source never reaches Wasm artifact",async()=>{
  const data=await readFile(new URL(
    "../contracts/atto-ensemble-v1/canonical-unlowered-try-publish.atto",
    import.meta.url));
  const oid=createHash("sha1")
    .update("blob "+data.length+String.fromCharCode(0))
    .update(data).digest("hex");
  assert.equal(oid,"c562ad380bb283da9ffa26160653c1186ab63462",
    "must be the exact LLVM/.NET/JS/HDL/conformance .atto Git blob");
  assert.throws(()=>rejectUnsupportedActorPubSubSource(data),
    /wasm ActorGroup\/Topic source lowering unsupported/);
});
