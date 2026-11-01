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
  assert.throws(() => reliable.publish(privateActor, "bad"), /publication requires/);

  assert.equal(bus.retireActor(left), true);
  assert.equal(b.contains(left), false);
  assert.equal(bus.retireActor(left), false);
  assert.equal(a.close(), true);
  assert.equal(b.close(), true);
});

test("opaque actor references reject cross-isolate numeric identity collisions", () => {
  const first = new WasmActorPubSub();
  const second = new WasmActorPubSub();
  const a = first.registerActor({actorId: 7, incarnation: 9, kind: "shared"});
  const sameNumbers = second.registerActor({actorId: 7, incarnation: 9, kind: "shared"});
  const group = second.createGroup();

  assert.throws(() => group.join(a), /cross-isolate ActorRef/);
  assert.equal(group.join(sameNumbers), true);

  const topic = group.defineTopic("events", "reliable", 1);
  topic.subscribe(sameNumbers);
  assert.throws(() => topic.publish(a, "x"), /cross-isolate ActorRef/);
  assert.equal(topic.publish(sameNumbers, "x").accepted, 1);
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
