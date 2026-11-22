import test from "node:test";
import assert from "node:assert/strict";
import {WasmActorPubSub, WasmActorGroup, WasmActorTopic} from "../src/actor-pubsub.mjs";

test("bounded pub-sub preserves multi-group membership and delivery policy", () => {
  const bus = new WasmActorPubSub();
  const a = bus.createGroup({maxMembers: 8});
  const b = bus.createGroup({maxMembers: 8});
  const publisher = bus.registerActor({actorId: 1, incarnation: 1, kind: "shared"});
  const left = bus.registerActor({actorId: 2, incarnation: 1, kind: "shared"});
  const right = bus.registerActor({actorId: 3, incarnation: 1, kind: "shared"});
  const privateActor = bus.registerActor({actorId: 4, incarnation: 1, kind: "private"});
  const outsider = bus.registerActor({actorId: 5, incarnation: 1, kind: "shared"});

  assert.equal(a.join(publisher), true);
  assert.equal(a.join(left), true);
  assert.equal(a.join(right), true);
  assert.equal(b.join(publisher), true);
  assert.equal(b.join(left), true);
  assert.equal(b.join(left), false);

  const reliable = a.defineTopic("reliable", "reliable", 1);
  assert.equal(reliable.subscribe(left), true);
  assert.equal(reliable.subscribe(right), true);
  assert.equal(reliable.subscribe(right), false);

  assert.deepEqual(reliable.publish(publisher, "one"), {
    subscribers: 2, accepted: 2, dropped: 0, coalesced: 0,
    backpressured: false
  });
  assert.equal(reliable.publish(publisher, "two").backpressured, true);
  assert.deepEqual(reliable.tryRead(left), {present: true, value: "one"});
  assert.deepEqual(reliable.tryRead(right), {present: true, value: "one"});
  assert.equal(reliable.publish(publisher, "two").accepted, 2);

  assert.equal(a.leave(right), true);
  assert.equal(a.contains(right), false);
  assert.equal(b.contains(left), true);
  assert.equal(reliable.publish(publisher, "three").backpressured, true);
  assert.deepEqual(reliable.tryRead(left), {present: true, value: "two"});
  assert.equal(reliable.publish(publisher, "three").accepted, 1);

  const latest = b.defineTopic("latest", "latest", 1);
  latest.subscribe(left);
  assert.equal(latest.publish(publisher, "old").accepted, 1);
  assert.equal(latest.publish(publisher, "new").coalesced, 1);
  assert.deepEqual(latest.tryRead(left), {present: true, value: "new"});

  const lossy = b.defineTopic("lossy", "lossy", 1);
  lossy.subscribe(left);
  assert.equal(lossy.publish(publisher, "one").accepted, 1);
  assert.equal(lossy.publish(publisher, "two").dropped, 1);

  a.join(privateActor);
  assert.throws(() => reliable.subscribe(privateActor), /requires shared actor/);
  // Private actors may publish immutable data-only events after membership;
  // zero-copy subscription is the isolation-sensitive operation.
  assert.equal(reliable.publish(privateActor, "private-publish").backpressured, true);
  assert.throws(() => reliable.publish(outsider, "bad"), /publication requires/);

  assert.equal(bus.retireActor(left), true);
  assert.equal(b.contains(left), false);
  assert.equal(bus.retireActor(left), false);
  bus.retireActor(outsider);
  assert.equal(a.close(), true);
  assert.equal(b.close(), true);
});

test("opaque actor references reject cross-isolate numeric identity collisions", () => {
  const first = new WasmActorPubSub();
  const second = new WasmActorPubSub();
  const a = first.registerActor({actorId: 7, incarnation: 9, kind: "shared"});
  const sameNumbers = second.registerActor({actorId: 7, incarnation: 9, kind: "shared"});
  assert.throws(
    () => second.registerActor({actorId: 7, incarnation: 10, kind: "shared"}),
    /still belongs to a live incarnation/);
  const group = second.createGroup();

  assert.throws(() => group.join(a), /cross-isolate ActorRef/);
  assert.equal(group.join(sameNumbers), true);

  const topic = group.defineTopic("events", "reliable", 1);
  topic.subscribe(sameNumbers);
  assert.throws(() => topic.publish(a, "x"), /cross-isolate ActorRef/);
  assert.equal(topic.publish(sameNumbers, "x").accepted, 1);

  assert.equal(second.retireActor(sameNumbers), true);
  assert.throws(
    () => second.registerActor({actorId: 7, incarnation: 9, kind: "shared"}),
    /incarnation must increase monotonically/);
  const replacement = second.registerActor({actorId: 7, incarnation: 10, kind: "shared"});
  assert.equal(group.join(replacement), true);
  assert.throws(() => topic.tryRead(sameNumbers), /stale or cross-isolate/);
});

test("pub-sub payloads and topic definitions fail closed", () => {
  const bus = new WasmActorPubSub({maxGroups: 2, maxTopics: 2});
  const group = bus.createGroup();
  const actor = bus.registerActor({actorId: 1, incarnation: 1, kind: "shared"});
  group.join(actor);

  const topic = group.defineTopic("events", "reliable", 2);
  topic.subscribe(actor);
  assert.throws(() => topic.publish(actor, {mutable: true}), /immutable scalar/);
  assert.throws(() => group.defineTopic("events", "lossy", 2), /different policy/);
  assert.throws(() => group.defineTopic("latest-bad", "latest", 2), /capacity must equal one/);

  group.defineTopic("latest", "latest", 1);
  assert.throws(() => group.defineTopic("third", "lossy", 1), /topic capacity exceeded/);
});

test("ordinary Wasm topic handles cannot impersonate system publications", () => {
  const bus = new WasmActorPubSub();
  const group = bus.createGroup();
  const member = bus.registerActor({actorId: 9, incarnation: 1, kind: "shared"});
  const topic = group.defineTopic("audit", "latest", 1);

  assert.equal(topic.publishSystem, undefined,
    "system publication must not be part of the public topic surface");
  assert.equal(bus._publishSystem, undefined,
    "registry must not leak a callable unguarded system-publication bypass");
  assert.throws(() => topic.publish(member, "not-joined"),
    /publication requires live ActorGroup membership/);

  assert.equal(group.join(member), true);
  assert.equal(topic.publish(member, "joined").accepted, 0);
  assert.equal(group.leave(member), true);
  assert.throws(() => topic.publish(member, "revoked"),
    /publication requires live ActorGroup membership/,
    "a cached topic handle cannot publish after departure");
  assert.equal(group.close(), true);
  assert.throws(() => topic.publish(member, "closed"), /unknown or closed ActorGroup/);
});

test("registry shutdown revokes cached ActorGroup and topic handles without resurrection", () => {
  const bus = new WasmActorPubSub();
  const a = bus.createGroup();
  const b = bus.createGroup();
  const actor = bus.registerActor({actorId: 77, incarnation: 1, kind: "shared"});
  a.join(actor);
  b.join(actor);
  const tA = a.defineTopic("events", "reliable", 2);
  const tB = b.defineTopic("events", "latest", 1);
  tA.subscribe(actor);
  tB.subscribe(actor);
  tA.publish(actor, "before-close");

  assert.equal(bus.close(), true);
  assert.equal(bus.close(), false, "shutdown is idempotent");
  assert.equal(a.contains(actor), false);
  assert.equal(b.contains(actor), false);
  assert.equal(a.close(), false, "cached group cannot resurrect closed registry");
  assert.throws(() => a.join(actor), /registry is closed|closed ActorGroup handle/);
  assert.throws(() => b.topic("events"), /registry is closed/);
  assert.throws(() => tA.publish(actor, "after-close"), /registry is closed/);
  assert.throws(() => tA.tryRead(actor), /registry is closed/);
  assert.throws(() => tB.subscribe(actor), /registry is closed/);
  assert.throws(() => bus.createGroup(), /registry is closed/);
  assert.throws(
    () => bus.registerActor({actorId: 77, incarnation: 2, kind: "shared"}),
    /registry is closed/,
    "closing registry must prevent generation reuse");
});

test("Wasm subscription quotas release on leave and actor retirement across groups", () => {
  const bus = new WasmActorPubSub({maxSubscriptionsPerActor: 1, maxGroupsPerActor: 2});
  const a = bus.createGroup();
  const b = bus.createGroup();
  const ref = bus.registerActor({actorId: 101, incarnation: 1, kind: "shared"});
  a.join(ref);
  b.join(ref);
  const topicA = a.defineTopic("same", "latest", 1);
  const topicB = b.defineTopic("same", "latest", 1);

  assert.equal(topicA.subscribe(ref), true);
  assert.throws(() => topicB.subscribe(ref), /subscription quota exceeded/);
  assert.equal(a.leave(ref), true);
  assert.equal(b.contains(ref), true);
  assert.equal(topicB.subscribe(ref), true, "leave must refund the global subscription quota");
  assert.throws(() => topicA.tryRead(ref), /topic read requires live ActorGroup membership/);

  assert.equal(bus.retireActor(ref), true);
  const successor = bus.registerActor({actorId: 101, incarnation: 2, kind: "shared"});
  assert.equal(b.join(successor), true);
  assert.equal(topicB.subscribe(successor), true,
    "prior incarnation's subscription must not hold quota or survive retirement");
  assert.throws(() => topicB.tryRead(ref), /stale or cross-isolate ActorRef/);
  bus.close();
});

test("Wasm ActorGroup and Topic constructors cannot forge opaque handles", () => {
  const bus = new WasmActorPubSub();
  const realGroup = bus.createGroup();
  const realTopic = realGroup.defineTopic("events", "latest", 1);

  assert.throws(() => new WasmActorGroup(bus, realGroup.id),
    /must be issued by the runtime/);
  assert.throws(() => new WasmActorTopic(bus, realGroup.id, "events"),
    /must be issued by the runtime/);
  assert.throws(() => new WasmActorGroup(bus, realGroup.id, Symbol("ActorGroup")),
    /must be issued by the runtime/);
  assert.throws(() => new WasmActorTopic(bus, realGroup.id, "events", Symbol("Topic")),
    /must be issued by the runtime/);

  const member = bus.registerActor({actorId: 222, incarnation: 1, kind: "shared"});
  realGroup.join(member);
  realTopic.subscribe(member);
  assert.throws(() => bus._join(realGroup.id, member),
    /invalid ActorGroup handle authority/);
  assert.throws(() => bus._defineTopic(realGroup.id, "forged", "lossy", 1),
    /invalid ActorGroup handle authority/);
  assert.throws(() => bus._closeGroup(realGroup.id),
    /invalid ActorGroup handle authority/);
  assert.throws(() => bus._subscribe(realGroup.id, "events", member),
    /invalid Topic handle authority/);
  assert.throws(() => bus._publish(realGroup.id, "events", member, "forged"),
    /invalid Topic handle authority/);
  assert.throws(() => bus._tryRead(realGroup.id, "events", member),
    /invalid Topic handle authority/);
  assert.equal(realTopic.publish(member, "legitimate").accepted, 1);
  assert.deepEqual(realTopic.tryRead(member), {present: true, value: "legitimate"});
  assert.equal(bus.close(), true);
});

test("portable topic identifiers reject C1 controls", () => {
  const bus = new WasmActorPubSub();
  const group = bus.createGroup();
  for (const code of [0, 31, 127, 128, 133, 159]) {
    const name = "before" + String.fromCharCode(code) + "after";
    assert.throws(() => group.defineTopic(name, "lossy", 1), /invalid topic name/);
    assert.throws(() => group.topic(name), /invalid topic name/);
  }
  const topic = group.defineTopic("legal-name", "lossy", 1);
  assert.equal(group.topic("legal-name").name, topic.name);
});

test("closing one group preserves the other group's subscriptions and quota", () => {
  const bus = new WasmActorPubSub({maxSubscriptionsPerActor: 2});
  const a = bus.createGroup();
  const b = bus.createGroup();
  const actor = bus.registerActor({actorId: 99, incarnation: 1, kind: "shared"});
  a.join(actor);
  b.join(actor);
  const ta = a.defineTopic("events", "latest", 1);
  const tb = b.defineTopic("events", "latest", 1);
  ta.subscribe(actor);
  tb.subscribe(actor);
  ta.publish(actor, "A");
  tb.publish(actor, "B");
  assert.equal(a.close(), true);
  assert.equal(b.contains(actor), true);
  assert.throws(() => ta.publish(actor, "late"), /unknown or closed ActorGroup/);
  assert.deepEqual(tb.tryRead(actor), {present: true, value: "B"});
  assert.equal(tb.publish(actor, "B2").accepted, 1);
  assert.deepEqual(tb.tryRead(actor), {present: true, value: "B2"});
  bus.close();
});

test("RELIABLE partial-drain backpressure remains atomic across subscribers", () => {
  const bus = new WasmActorPubSub();
  const group = bus.createGroup();
  const publisher = bus.registerActor({actorId: 1, incarnation: 1});
  const left = bus.registerActor({actorId: 2, incarnation: 1});
  const right = bus.registerActor({actorId: 3, incarnation: 1});
  for (const actor of [publisher, left, right]) group.join(actor);
  const topic = group.defineTopic("atomic", "reliable", 1);
  topic.subscribe(left);
  topic.subscribe(right);
  assert.equal(topic.publish(publisher, "one").accepted, 2);
  assert.deepEqual(topic.tryRead(left), {present: true, value: "one"});
  const blocked = topic.publish(publisher, "two");
  assert.equal(blocked.backpressured, true);
  assert.equal(blocked.accepted, 0);
  assert.deepEqual(topic.tryRead(left), {present: false, value: undefined},
    "failed admission must not deliver to a partially drained subscriber");
  assert.deepEqual(topic.tryRead(right), {present: true, value: "one"});
  assert.equal(topic.publish(publisher, "two").accepted, 2);
  assert.deepEqual(topic.tryRead(left), {present: true, value: "two"});
  assert.deepEqual(topic.tryRead(right), {present: true, value: "two"});
});

test("512 actor reincarnations preserve group isolation and bounded topic admission", () => {
  const bus = new WasmActorPubSub({maxGroups: 2, maxGroupsPerActor: 2,
    maxTopics: 2, maxSubscriptionsPerActor: 2});
  const groupA = bus.createGroup();
  const groupB = bus.createGroup();
  const a = groupA.defineTopic("same", "latest", 1);
  const b = groupB.defineTopic("same", "latest", 1);
  for (let generation = 1; generation <= 512; generation++) {
    const actor = bus.registerActor({actorId: 37, incarnation: generation});
    assert.equal(groupA.join(actor), true);
    assert.equal(groupB.join(actor), true);
    assert.equal(a.subscribe(actor), true);
    assert.equal(b.subscribe(actor), true);
    assert.equal(a.publish(actor, "A" + generation).accepted, 1);
    assert.equal(b.publish(actor, "B" + generation).accepted, 1);
    assert.deepEqual(a.tryRead(actor), {present: true, value: "A" + generation});
    assert.deepEqual(b.tryRead(actor), {present: true, value: "B" + generation});
    assert.equal(groupA.leave(actor), true);
    assert.throws(() => a.publish(actor, "stale"), /publication requires/);
    assert.equal(b.publish(actor, "B-next").accepted, 1);
    assert.deepEqual(b.tryRead(actor), {present: true, value: "B-next"});
    assert.equal(bus.retireActor(actor), true);
    assert.equal(groupB.contains(actor), false);
    assert.throws(() => b.tryRead(actor), /stale or cross-isolate ActorRef/);
  }
  assert.equal(groupA.memberCount, 0);
  assert.equal(groupB.memberCount, 0);
  assert.equal(bus.close(), true);
});

test("topic names reject whitespace-only values without sacrificing distinct keys", () => {
  const bus = new WasmActorPubSub();
  const group = bus.createGroup();
  for (const name of [" ", "  ", "\t", "\n", "\u00a0", "\u2003", "\u202f", "\u3000"]) {
    assert.throws(() => group.defineTopic(name, "reliable", 1), /invalid topic name/);
    assert.throws(() => group.topic(name), /invalid topic name/);
  }
  assert.equal(group.defineTopic("events", "lossy", 1).name, "events");
  assert.equal(group.defineTopic("events_2", "lossy", 1).name, "events_2");
  assert.equal(group.close(), true);
});


test("hard resource ceilings cannot be disabled by per-instance configuration", () => {
  for (const option of [
    {maxActors: 4097}, {maxActorHistories: 65537},
    {maxGroups: 4097}, {maxGroupsPerActor: 4097},
    {maxTopics: 4097}, {maxSubscriptionsPerActor: 1025}
  ]) assert.throws(() => new WasmActorPubSub(option), /hard limit/);

  const bus = new WasmActorPubSub({maxActors: 2, maxActorHistories: 2});
  const a = bus.registerActor({actorId: 1, incarnation: 1});
  const b = bus.registerActor({actorId: 2, incarnation: 1});
  assert.throws(() => bus.registerActor({actorId: 3, incarnation: 1}),
    /actor registry capacity/);
  assert.equal(bus.retireActor(a), true);
  assert.throws(() => bus.registerActor({actorId: 3, incarnation: 1}),
    /incarnation history capacity/);
  // Re-incarnation of an existing ID is allowed without expanding history.
  const successor = bus.registerActor({actorId: 1, incarnation: 2});
  assert.equal(bus.retireActor(b), true);
  assert.equal(bus.retireActor(successor), true);
  assert.throws(() => bus.registerActor({actorId: 1, incarnation: 2}),
    /must increase monotonically/);
  assert.equal(bus.close(), true);
});

test("untrusted queue sizes and large scalar events fail before admission", () => {
  const bus = new WasmActorPubSub();
  assert.throws(() => bus.createGroup({maxMembers: 4097}), /hard limit/);
  const group = bus.createGroup();
  const publisher = bus.registerActor({actorId: 1, incarnation: 1});
  const subscriber = bus.registerActor({actorId: 2, incarnation: 1});
  group.join(publisher);
  group.join(subscriber);
  assert.throws(() => group.defineTopic("oversized", "lossy", 1025), /hard limit/);
  const topic = group.defineTopic("bounded", "reliable", 1);
  topic.subscribe(subscriber);

  for (const payload of ["x".repeat(4097), Infinity, -Infinity, NaN,
    1n << 63n, -(1n << 63n) - 1n]) {
    assert.throws(() => topic.publish(publisher, payload),
      /payload|hard limit|signed i64/);
    assert.deepEqual(topic.tryRead(subscriber), {present: false, value: undefined},
      "a rejected payload must never reach even one subscriber");
  }
  assert.equal(topic.publish(publisher, -(1n << 63n)).accepted, 1);
  assert.deepEqual(topic.tryRead(subscriber),
    {present: true, value: -(1n << 63n)});
  assert.equal(topic.publish(publisher, "ok").accepted, 1);
  assert.deepEqual(topic.tryRead(subscriber), {present: true, value: "ok"});
  bus.close();
});


test("global queued-slot budget is atomic and refunded across membership barriers", () => {
  const bus = new WasmActorPubSub({maxQueuedSlots: 2});
  const group = bus.createGroup(), other = bus.createGroup();
  const publisher = bus.registerActor({actorId: 1, incarnation: 1});
  const left = bus.registerActor({actorId: 2, incarnation: 1});
  const right = bus.registerActor({actorId: 3, incarnation: 1});
  for (const actor of [publisher, left, right]) group.join(actor);
  other.join(publisher);
  other.join(left);
  const reliable = group.defineTopic("reliable", "reliable", 3);
  const latest = other.defineTopic("latest", "latest", 1);
  reliable.subscribe(left);
  reliable.subscribe(right);
  latest.subscribe(left);

  assert.equal(reliable.publish(publisher, "one").accepted, 2);
  assert.equal(reliable.publish(publisher, "two").backpressured, true);
  assert.deepEqual(reliable.tryRead(left), {present: true, value: "one"});
  assert.equal(reliable.publish(publisher, "two").backpressured, true,
    "failed admission must not put a second event into the partly drained queue");
  assert.deepEqual(latest.publish(publisher, "latest"), {
    subscribers: 1, accepted: 1, dropped: 0, coalesced: 0, backpressured: false
  });
  assert.equal(latest.publish(publisher, "newer").coalesced, 1,
    "LATEST can replace an owned slot even at the global budget limit");
  assert.equal(group.leave(right), true, "leave refunds every queued slot");
  assert.equal(reliable.publish(publisher, "two").accepted, 1);
  assert.deepEqual(latest.tryRead(left), {present: true, value: "newer"});
  assert.deepEqual(reliable.tryRead(left), {present: true, value: "two"});
  assert.equal(reliable.unsubscribe(left), true);
  assert.equal(latest.unsubscribe(left), true);
  assert.equal(bus.close(), true);
});

test("LOSSY global exhaustion drops without exceeding capacity and retirement frees it", () => {
  const bus = new WasmActorPubSub({maxQueuedSlots: 1});
  const group = bus.createGroup();
  const publisher = bus.registerActor({actorId: 1, incarnation: 1});
  const subscriber = bus.registerActor({actorId: 2, incarnation: 1});
  group.join(publisher);
  group.join(subscriber);
  const topic = group.defineTopic("lossy", "lossy", 5);
  topic.subscribe(subscriber);
  assert.equal(topic.publish(publisher, "one").accepted, 1);
  assert.equal(topic.publish(publisher, "two").dropped, 1);
  assert.equal(bus.retireActor(subscriber), true);
  const successor = bus.registerActor({actorId: 2, incarnation: 2});
  group.join(successor);
  topic.subscribe(successor);
  assert.equal(topic.publish(publisher, "fresh").accepted, 1);
  assert.deepEqual(topic.tryRead(successor), {present: true, value: "fresh"});
  assert.equal(bus.close(), true);
});


test("pub-sub portable strings reject orphan UTF-16 surrogates without coalescing valid Unicode", () => {
  const bus = new WasmActorPubSub();
  const group = bus.createGroup();
  const publisher = bus.registerActor({actorId: 1, incarnation: 1});
  const subscriber = bus.registerActor({actorId: 2, incarnation: 1});
  group.join(publisher);
  group.join(subscriber);
  for (const invalid of ["\uD800", "\uDC00", "ok\uDBFFsuffix"]) {
    assert.throws(() => group.defineTopic(invalid, "lossy", 1),
      /invalid topic name/);
    assert.throws(() => group.topic(invalid), /invalid topic name/);
  }
  const topic = group.defineTopic("weather-😀", "reliable", 2);
  topic.subscribe(subscriber);
  for (const invalid of ["\uD800", "a\uDC00b", "😀\uDFFF"]) {
    assert.throws(() => topic.publish(publisher, invalid), /malformed UTF-16/);
    assert.deepEqual(topic.tryRead(subscriber), {present:false,value:undefined});
  }
  assert.equal(topic.publish(publisher, "😀").accepted, 1);
  assert.deepEqual(topic.tryRead(subscriber), {present:true,value:"😀"});
  assert.equal(group.close(), true);
  assert.equal(bus.close(), true);
});
