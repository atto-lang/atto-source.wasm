import test from "node:test";
import assert from "node:assert/strict";
import {WasmActorPubSub} from "../src/actor-pubsub.mjs";

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
  assert.throws(() => a.join(actor), /registry is closed/);
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
