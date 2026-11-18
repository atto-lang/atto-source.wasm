// Host-side in-memory ActorGroup/pub-sub admission substrate.
// This is not guest source lowering. Actor and group handles are opaque
// capabilities scoped to one registry/isolate; numeric IDs never authorize use.
// Ordinary topic handles must not expose trusted system-publication bypasses.

const actorKinds = new Set(["shared", "private", "untrusted"]);
const policies = new Set(["reliable", "latest", "lossy"]);
// Hard resource ceilings are independent of caller-supplied per-instance quotas.
// An actor/topic capacity of MAX_SAFE_INTEGER is not meaningful backpressure.
const MAX_ACTORS = 4096;
const MAX_ACTOR_HISTORIES = 65536;
const MAX_GROUPS = 4096;
const MAX_MEMBERS_PER_GROUP = 4096;
const MAX_MEMBERSHIPS = 4096;
const MAX_TOPICS = 4096;
const MAX_SUBSCRIPTIONS = 1024;
const MAX_QUEUE_DEPTH = 1024;
const MAX_QUEUED_SLOTS = 65536;
const MAX_EVENT_CODE_UNITS = 4096;
const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;
// Module-private constructors: public exported class names are not grant minting.
const GROUP_HANDLE_BRAND = Symbol("WasmActorGroup capability");
const TOPIC_HANDLE_BRAND = Symbol("WasmActorTopic capability");
function requireGroupHandle(brand) {
  if (brand !== GROUP_HANDLE_BRAND) throw new TypeError("invalid ActorGroup handle authority");
}
function requireTopicHandle(brand) {
  if (brand !== TOPIC_HANDLE_BRAND) throw new TypeError("invalid Topic handle authority");
}

function positiveSafeInt(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError("invalid " + name);
  return value;
}

function boundedPositiveInt(value, name, maximum) {
  positiveSafeInt(value, name);
  if (value > maximum) throw new RangeError(name + " exceeds hard limit");
  return value;
}

// Under the Unicode /u flag paired surrogates are one scalar and unpaired
// UTF-16 surrogates are matched. Reject lossy UTF-8/MessagePack round-trips.
const malformedUtf16 = /[\uD800-\uDFFF]/u;
function topicName(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 ||
      value.trim().length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
      malformedUtf16.test(value))
    throw new TypeError("invalid topic name");
  return value;
}

function freezePayload(value) {
  if (value === null || value === undefined)
    throw new TypeError("Oreslang event payload uses Option<T>, not null");
  switch (typeof value) {
    case "string":
      // Every UTF-16 code unit takes at most 3 UTF-8 bytes; this is a
      // conservative, encoding-independent per-event memory bound.
      if (value.length > MAX_EVENT_CODE_UNITS)
        throw new RangeError("pub-sub string payload exceeds hard limit");
      if (malformedUtf16.test(value))
        throw new TypeError("pub-sub string payload contains malformed UTF-16");
      return value;
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value))
        throw new TypeError("pub-sub number payload must be finite");
      return value;
    case "bigint":
      if (value < MIN_I64 || value > MAX_I64)
        throw new RangeError("pub-sub bigint payload must fit signed i64");
      return value;
    default:
      throw new TypeError("Wasm pub-sub payload is not a proven immutable scalar/string");
  }
}

export class WasmActorPubSub {
  #actors = new Map();
  #actorIds = new Map();
  #lastIncarnation = new Map();
  #groups = new Map();
  #topics = new Map();
  #nextGroupId = 0;
  #closed = false;
  #maxGroups;
  #maxGroupsPerActor;
  #maxTopics;
  #maxSubscriptionsPerActor;
  #maxActors;
  #maxActorHistories;
  #maxQueuedSlots;
  #queuedSlots = 0;

  constructor({
    maxGroups = 4096,
    maxGroupsPerActor = 64,
    maxTopics = 4096,
    maxSubscriptionsPerActor = 1024,
    maxActors = 4096,
    maxActorHistories = 65536,
    maxQueuedSlots = 16384
  } = {}) {
    this.#maxGroups = boundedPositiveInt(maxGroups, "maxGroups", MAX_GROUPS);
    this.#maxGroupsPerActor = boundedPositiveInt(
      maxGroupsPerActor, "maxGroupsPerActor", MAX_MEMBERSHIPS);
    this.#maxTopics = boundedPositiveInt(maxTopics, "maxTopics", MAX_TOPICS);
    this.#maxSubscriptionsPerActor = boundedPositiveInt(
      maxSubscriptionsPerActor, "maxSubscriptionsPerActor", MAX_SUBSCRIPTIONS);
    this.#maxActors = boundedPositiveInt(maxActors, "maxActors", MAX_ACTORS);
    // Historical actor IDs cannot be discarded without changing monotonic
    // incarnation semantics. Bound the entire lifetime history instead.
    this.#maxActorHistories = boundedPositiveInt(
      maxActorHistories, "maxActorHistories", MAX_ACTOR_HISTORIES);
    this.#maxQueuedSlots = boundedPositiveInt(
      maxQueuedSlots, "maxQueuedSlots", MAX_QUEUED_SLOTS);
  }

  #releaseQueue(queue) {
    this.#queuedSlots -= queue.length;
    queue.length = 0;
  }

  registerActor({actorId, incarnation, kind = "shared"} = {}) {
    this.#requireOpen();
    positiveSafeInt(actorId, "actorId");
    positiveSafeInt(incarnation, "incarnation");
    if (!actorKinds.has(kind)) throw new TypeError("invalid actor kind");

    if (this.#actorIds.has(actorId))
      throw new Error("actor ID still belongs to a live incarnation");
    if (this.#actors.size >= this.#maxActors)
      throw new RangeError("actor registry capacity exceeded");
    if (!this.#lastIncarnation.has(actorId) &&
        this.#lastIncarnation.size >= this.#maxActorHistories)
      throw new RangeError("actor incarnation history capacity exceeded");
    const previousIncarnation = this.#lastIncarnation.get(actorId) ?? 0;
    if (incarnation <= previousIncarnation)
      throw new Error("actor incarnation must increase monotonically");

    const ref = Object.freeze({});
    this.#actors.set(ref, {
      actorId, incarnation, kind,
      groups: new Set(),
      subscriptions: 0
    });
    this.#actorIds.set(actorId, ref);
    this.#lastIncarnation.set(actorId, incarnation);
    return ref;
  }

  retireActor(ref) {
    const actor = this.#actors.get(ref);
    if (!actor) return false;

    for (const groupId of actor.groups)
      this.#groups.get(groupId)?.members.delete(ref);
    for (const topic of this.#topics.values()) {
      const queue = topic.subscribers.get(ref);
      if (queue) {
        this.#releaseQueue(queue);
        topic.subscribers.delete(ref);
      }
    }
    this.#actors.delete(ref);
    if (this.#actorIds.get(actor.actorId) === ref)
      this.#actorIds.delete(actor.actorId);
    return true;
  }

  createGroup({maxMembers = 1024} = {}) {
    this.#requireOpen();
    boundedPositiveInt(maxMembers, "maxMembers", MAX_MEMBERS_PER_GROUP);
    if (this.#groups.size >= this.#maxGroups)
      throw new RangeError("ActorGroup capacity exceeded");
    if (this.#nextGroupId >= Number.MAX_SAFE_INTEGER)
      throw new RangeError("ActorGroup ID space exhausted");

    const id = ++this.#nextGroupId;
    this.#groups.set(id, {maxMembers, members: new Set(), closed: false});
    return new WasmActorGroup(this, id, GROUP_HANDLE_BRAND);
  }

  _join(groupId, ref, brand) {
    requireGroupHandle(brand);
    const actor = this.#requireActor(ref);
    const group = this.#requireGroup(groupId);
    if (actor.groups.has(groupId)) return false;
    if (actor.groups.size >= this.#maxGroupsPerActor)
      throw new RangeError("actor cooperation membership quota exceeded");
    if (group.members.size >= group.maxMembers)
      throw new RangeError("ActorGroup member capacity exceeded");
    actor.groups.add(groupId);
    group.members.add(ref);
    return true;
  }

  _leave(groupId, ref, brand) {
    requireGroupHandle(brand);
    const actor = this.#actors.get(ref), group = this.#groups.get(groupId);
    if (!actor || !group || !actor.groups.delete(groupId)) return false;
    group.members.delete(ref);
    for (const topic of this.#topics.values()) {
      if (topic.groupId !== groupId) continue;
      const queue = topic.subscribers.get(ref);
      if (queue) {
        this.#releaseQueue(queue);
        topic.subscribers.delete(ref);
        actor.subscriptions--;
      }
    }
    return true;
  }

  _contains(groupId, ref, brand) {
    requireGroupHandle(brand);
    return this.#actors.has(ref) &&
      (this.#groups.get(groupId)?.members.has(ref) ?? false);
  }

  _memberCount(groupId, brand) {
    requireGroupHandle(brand);
    return this.#requireGroup(groupId).members.size;
  }

  _defineTopic(groupId, name, policy, capacity, brand) {
    requireGroupHandle(brand);
    this.#requireGroup(groupId);
    name = topicName(name);
    if (!policies.has(policy)) throw new TypeError("invalid topic policy");
    boundedPositiveInt(capacity, "topic capacity", MAX_QUEUE_DEPTH);
    if (policy === "latest" && capacity !== 1)
      throw new RangeError("LATEST topic capacity must equal one");

    const key = this.#topicKey(groupId, name);
    const existing = this.#topics.get(key);
    if (existing) {
      if (existing.policy !== policy || existing.capacity !== capacity)
        throw new Error("topic already defined with different policy/capacity");
      return new WasmActorTopic(this, groupId, name, TOPIC_HANDLE_BRAND);
    }
    if (this.#topics.size >= this.#maxTopics)
      throw new RangeError("topic capacity exceeded");

    this.#topics.set(key, {
      groupId, name, policy, capacity,
      subscribers: new Map()
    });
    return new WasmActorTopic(this, groupId, name, TOPIC_HANDLE_BRAND);
  }

  _topic(groupId, name, brand) {
    requireGroupHandle(brand);
    this.#requireTopic(groupId, topicName(name));
    return new WasmActorTopic(this, groupId, name, TOPIC_HANDLE_BRAND);
  }

  _subscribe(groupId, name, ref, brand) {
    requireTopicHandle(brand);
    const actor = this.#requireActor(ref);
    const group = this.#requireGroup(groupId);
    if (!group.members.has(ref))
      throw new Error("subscription requires live ActorGroup membership");
    if (actor.kind !== "shared")
      throw new Error("zero-copy in-memory subscription requires shared actor");

    const topic = this.#requireTopic(groupId, name);
    if (topic.subscribers.has(ref)) return false;
    if (actor.subscriptions >= this.#maxSubscriptionsPerActor)
      throw new RangeError("actor topic subscription quota exceeded");

    topic.subscribers.set(ref, []);
    actor.subscriptions++;
    return true;
  }

  _unsubscribe(groupId, name, ref, brand) {
    requireTopicHandle(brand);
    const topic = this.#requireTopic(groupId, name);
    const queue = topic.subscribers.get(ref);
    if (!queue) return false;
    this.#releaseQueue(queue);
    topic.subscribers.delete(ref);
    const actor = this.#actors.get(ref);
    if (actor && actor.subscriptions > 0) actor.subscriptions--;
    return true;
  }

  _publish(groupId, name, publisher, value, brand) {
    requireTopicHandle(brand);
    const actor = this.#requireActor(publisher);
    const group = this.#requireGroup(groupId);
    if (!group.members.has(publisher))
      throw new Error("publication requires live ActorGroup membership");
    void actor;
    return this.#publishTopic(groupId, name, freezePayload(value));
  }

  _tryRead(groupId, name, ref, brand) {
    requireTopicHandle(brand);
    this.#requireActor(ref);
    const group = this.#requireGroup(groupId);
    if (!group.members.has(ref))
      throw new Error("topic read requires live ActorGroup membership");
    const topic = this.#requireTopic(groupId, name);
    const queue = topic.subscribers.get(ref);
    if (!queue) throw new Error("actor is not subscribed to topic");
    if (!queue.length) return {present: false, value: undefined};
    const value = queue.shift();
    this.#queuedSlots--;
    return {present: true, value};
  }

  _closeGroup(groupId, brand) {
    requireGroupHandle(brand);
    const group = this.#groups.get(groupId);
    if (!group) return false;
    for (const ref of group.members)
      this.#actors.get(ref)?.groups.delete(groupId);
    for (const [key, topic] of this.#topics) {
      if (topic.groupId !== groupId) continue;
      for (const [ref, queue] of topic.subscribers) {
        this.#releaseQueue(queue);
        const actor = this.#actors.get(ref);
        if (actor && actor.subscriptions > 0) actor.subscriptions--;
      }
      this.#topics.delete(key);
    }
    this.#groups.delete(groupId);
    return true;
  }

  #publishTopic(groupId, name, value) {
    const topic = this.#requireTopic(groupId, name);
    this.#prune(groupId, topic);
    const subscribers = topic.subscribers.size;

    if (topic.policy === "reliable") {
      for (const queue of topic.subscribers.values()) {
        if (queue.length >= topic.capacity)
          return Object.freeze({
            subscribers, accepted: 0, dropped: 0, coalesced: 0,
            backpressured: true
          });
      }
      // Global admission must also be fail-atomic across every subscriber.
      if (subscribers > this.#maxQueuedSlots - this.#queuedSlots)
        return Object.freeze({
          subscribers, accepted: 0, dropped: 0, coalesced: 0,
          backpressured: true
        });
      for (const queue of topic.subscribers.values()) queue.push(value);
      this.#queuedSlots += subscribers;
      return Object.freeze({
        subscribers, accepted: subscribers, dropped: 0, coalesced: 0,
        backpressured: false
      });
    }

    let accepted = 0, dropped = 0, coalesced = 0;
    for (const queue of topic.subscribers.values()) {
      if (topic.policy === "latest") {
        if (queue.length) {
          queue[0] = value;
          coalesced++;
        } else if (this.#queuedSlots >= this.#maxQueuedSlots) {
          dropped++;
          continue;
        } else {
          queue.push(value);
          this.#queuedSlots++;
        }
        accepted++;
      } else if (queue.length >= topic.capacity ||
                 this.#queuedSlots >= this.#maxQueuedSlots) {
        dropped++;
      } else {
        queue.push(value);
        this.#queuedSlots++;
        accepted++;
      }
    }
    return Object.freeze({
      subscribers, accepted, dropped, coalesced, backpressured: false
    });
  }

  #prune(groupId, topic) {
    const group = this.#groups.get(groupId);
    for (const ref of [...topic.subscribers.keys()]) {
      if (this.#actors.has(ref) && group?.members.has(ref)) continue;
      const queue = topic.subscribers.get(ref);
      if (queue) {
        this.#releaseQueue(queue);
        topic.subscribers.delete(ref);
        const actor = this.#actors.get(ref);
        if (actor && actor.subscriptions > 0) actor.subscriptions--;
      }
    }
  }

  #requireActor(ref) {
    this.#requireOpen();
    const actor = this.#actors.get(ref);
    if (!actor) throw new Error("foreign, stale or cross-isolate ActorRef");
    return actor;
  }

  #requireGroup(groupId) {
    this.#requireOpen();
    const group = this.#groups.get(groupId);
    if (!group) throw new Error("unknown or closed ActorGroup");
    return group;
  }

  #requireTopic(groupId, name) {
    this.#requireOpen();
    const topic = this.#topics.get(this.#topicKey(groupId, name));
    if (!topic) throw new Error("unknown topic");
    return topic;
  }

  #topicKey(groupId, name) {
    return groupId + "\u0000" + name;
  }

  #requireOpen() {
    if (this.#closed) throw new Error("actor PubSub registry is closed");
  }

  // Host-runtime lifecycle only. This does not authorize guest code to stop
  // another actor or group; it revokes the whole registry at physical shutdown.
  close() {
    if (this.#closed) return false;
    this.#closed = true;
    this.#topics.clear();
    this.#groups.clear();
    this.#actors.clear();
    this.#actorIds.clear();
    this.#lastIncarnation.clear();
    this.#queuedSlots = 0;
    return true;
  }
}

export class WasmActorGroup {
  #owner;
  #id;
  #closed = false;

  constructor(owner, id, brand) {
    if (brand !== GROUP_HANDLE_BRAND) {
      throw new TypeError("ActorGroup handles must be issued by the runtime");
    }
    this.#owner = owner;
    this.#id = id;
    Object.preventExtensions(this);
  }

  get id() { return this.#id; }
  #open() {
    if (this.#closed) throw new Error("closed ActorGroup handle");
    return this.#owner;
  }

  join(ref) { return this.#open()._join(this.#id, ref, GROUP_HANDLE_BRAND); }
  leave(ref) { return this.#open()._leave(this.#id, ref, GROUP_HANDLE_BRAND); }
  contains(ref) { return this.#open()._contains(this.#id, ref, GROUP_HANDLE_BRAND); }
  get memberCount() { return this.#open()._memberCount(this.#id, GROUP_HANDLE_BRAND); }
  defineTopic(name, policy, capacity) {
    return this.#open()._defineTopic(this.#id, name, policy, capacity, GROUP_HANDLE_BRAND);
  }
  topic(name) { return this.#open()._topic(this.#id, name, GROUP_HANDLE_BRAND); }
  close() {
    if (this.#closed) return false;
    this.#closed = true;
    return this.#owner._closeGroup(this.#id, GROUP_HANDLE_BRAND);
  }
}

export class WasmActorTopic {
  #owner;
  #groupId;
  #name;

  constructor(owner, groupId, name, brand) {
    if (brand !== TOPIC_HANDLE_BRAND) {
      throw new TypeError("Topic handles must be issued by the runtime");
    }
    this.#owner = owner;
    this.#groupId = groupId;
    this.#name = name;
    Object.preventExtensions(this);
  }

  get name() { return this.#name; }
  subscribe(ref) { return this.#owner._subscribe(this.#groupId, this.#name, ref, TOPIC_HANDLE_BRAND); }
  unsubscribe(ref) { return this.#owner._unsubscribe(this.#groupId, this.#name, ref, TOPIC_HANDLE_BRAND); }
  publish(ref, value) {
    return this.#owner._publish(this.#groupId, this.#name, ref, value, TOPIC_HANDLE_BRAND);
  }
  tryRead(ref) { return this.#owner._tryRead(this.#groupId, this.#name, ref, TOPIC_HANDLE_BRAND); }
}
