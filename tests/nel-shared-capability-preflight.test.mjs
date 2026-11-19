import test from "node:test";
import assert from "node:assert/strict";
import {
  rejectUnsupportedDurableM0Source,
  rejectUnsupportedStateContainerVirtualActorSource,
  rejectUnsupportedTupleV2Source,
  rejectUnsupportedInvertedLayoutSource,
  rejectUnsupportedHeapContainerSource
} from "../scripts/compile-ores.mjs";
import {rejectUnsupportedActorThreadSource} from "../src/actor-max-threads-source-policy.mjs";

const bytes = text => new TextEncoder().encode(text);
const NEL = "\u0085";

// Source-only capability admission. A permissive native compiler must NEVER
// turn a declaration hidden with NEL into a publishable scalar wasm artifact.
test("shared Wasm tokenizer treats NEL as AttoLang whitespace in every unsupported source family", () => {
  const cases = [
    [rejectUnsupportedDurableM0Source, `define${NEL}activity${NEL}Save as end`, /DURABLE_M0_BACKEND_UNSUPPORTED/],
    [rejectUnsupportedDurableM0Source, `pub${NEL}define${NEL}workflow${NEL}Run as end`, /DURABLE_M0_BACKEND_UNSUPPORTED/],
    [rejectUnsupportedStateContainerVirtualActorSource, `define${NEL}state${NEL}container${NEL}Store as end`, /STATE_CONTAINER_BACKEND_UNSUPPORTED/],
    [rejectUnsupportedStateContainerVirtualActorSource, `define${NEL}virtual${NEL}actor${NEL}Worker as end`, /VIRTUAL_ACTOR_BACKEND_UNSUPPORTED/],
    [rejectUnsupportedInvertedLayoutSource, `define${NEL}inverted${NEL}struct${NEL}Rows as end`, /wasm inverted struct/],
    [rejectUnsupportedInvertedLayoutSource, `InvertedArray${NEL}<int>`, /wasm inverted collection/],
    [rejectUnsupportedHeapContainerSource, `Box${NEL}<int>`, /wasm heap\/container ownership ABI/],
    [rejectUnsupportedHeapContainerSource, `rt${NEL}borrow${NEL}int x`, /wasm heap loan\/transfer lowering/],
    [rejectUnsupportedTupleV2Source, `fnc${NEL}work(${NEL}structural{x:int} arg):int{return 42;}`, /wasm structural tuple v2 readonly-view ABI/],
    [rejectUnsupportedActorThreadSource, `define${NEL}pub${NEL}actor${NEL}Worker as end`, /WASM source actor execution unsupported/]
  ];
  for (const [reject, source, expected] of cases) {
    assert.throws(() => reject(bytes(source)), expected, source);
  }
});

// Do not turn comments/strings into declarations or break ordinary scalar
// source simply because NEL occurs between valid tokens.
test("NEL comments and string decoys do not falsely trigger capability gates", () => {
  const permitted = `// define activity Fake as end${NEL}fnc main():int{return 42;}`;
  const stringDecoy = `fnc main():int{const s="define workflow Fake as end";return 42;}`;
  for (const gate of [
    rejectUnsupportedDurableM0Source,
    rejectUnsupportedStateContainerVirtualActorSource,
    rejectUnsupportedTupleV2Source,
    rejectUnsupportedInvertedLayoutSource,
    rejectUnsupportedHeapContainerSource,
    rejectUnsupportedActorThreadSource
  ]) {
    assert.doesNotThrow(() => gate(bytes(permitted)));
    assert.doesNotThrow(() => gate(bytes(stringDecoy)));
  }
});
