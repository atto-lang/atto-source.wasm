// Host-only routing selector conformance v1. No guest actor capability,
// mailbox admission, Oreslang self.* lowering or reply transport is exposed.
const encoder = new TextEncoder();
const MAX_NAME = 256, MAX_KEY = 4096;
function bytes(value, limit, optional = false, forbidNul = true) {
  if (typeof value !== "string" || (!optional && value.length === 0) ||
      value.length > limit || (forbidNul && value.includes("\0")))
    throw new TypeError("invalid routing component");
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff))
        throw new TypeError("malformed routing UTF-16");
    } else if (n >= 0xdc00 && n <= 0xdfff) {
      throw new TypeError("malformed routing UTF-16");
    }
  }
  const encoded = encoder.encode(value);
  if (encoded.length > limit) throw new TypeError("routing component byte budget");
  return encoded;
}
export function routeKeySlot(key, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 4096)
    throw new RangeError("invalid downstream edge count");
  const encoded = bytes(key, MAX_KEY, true, false);
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoded) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return Number(hash % BigInt(count));
}
export class ActorPipelineSelector {
  #out = new Map();
  #roots = new Set();
  #rr = new Map();
  #generation;
  constructor(stages, links, generation = 1) {
    if (!Array.isArray(stages) || !Array.isArray(links) ||
        stages.length < 2 || stages.length > 1024 ||
        links.length < 1 || links.length > 4096 ||
        !Number.isSafeInteger(generation) || generation < 1)
      throw new RangeError("invalid actor graph or generation budget");
    const ids = new Map(), indegree = new Map();
    for (const s of stages) {
      if (!s || typeof s !== "object") throw new TypeError("missing stage");
      for (const n of [s.id, s.actorType]) bytes(n, MAX_NAME);
      for (const n of [s.inbound, s.outbound]) bytes(n, MAX_NAME, true);
      if (ids.has(s.id)) throw new TypeError("duplicate actor instance");
      const incoming = s.inbound.length !== 0, outgoing = s.outbound.length !== 0;
      const roles = {readable: !incoming && outgoing,
        writable: incoming && !outgoing, transform: incoming && outgoing,
        duplex: incoming && outgoing};
      if (roles[s.role] !== true) throw new TypeError("invalid actor port role");
      ids.set(s.id, Object.freeze({...s}));
      indegree.set(s.id, 0);
    }
    const pairs = new Set(), inboundCount = new Map(), outgoingCount = new Map();
    for (const id of ids.keys()) { this.#out.set(id, []); inboundCount.set(id, 0); outgoingCount.set(id, 0); }
    for (const edge of links) {
      if (!edge || typeof edge !== "object") throw new TypeError("missing link");
      for (const n of [edge.source, edge.target, edge.payload]) bytes(n, MAX_NAME);
      const source = ids.get(edge.source), target = ids.get(edge.target);
      if (!source || !target || source.id === target.id) throw new TypeError("invalid edge endpoints");
      if (source.role === "writable" || target.role === "readable" ||
          source.outbound !== edge.payload || target.inbound !== edge.payload)
        throw new TypeError("actor edge payload mismatch");
      const pair = JSON.stringify([edge.source, edge.target]);
      if (pairs.has(pair)) throw new TypeError("duplicate actor edge");
      pairs.add(pair);
      this.#out.get(edge.source).push(Object.freeze({...edge}));
      indegree.set(edge.target, indegree.get(edge.target) + 1);
      inboundCount.set(edge.target, inboundCount.get(edge.target) + 1);
      outgoingCount.set(edge.source, outgoingCount.get(edge.source) + 1);
    }
    for (const [id, stage] of ids) {
      const reads = inboundCount.get(id), writes = outgoingCount.get(id);
      if (!(reads || writes) ||
          (stage.role === "readable" && !writes) ||
          (stage.role === "writable" && !reads) ||
          (stage.role === "transform" && (!reads || !writes)))
        throw new TypeError("actor stage missing required connection");
      if (!reads && writes && (stage.role === "readable" || stage.role === "duplex"))
        this.#roots.add(id);
    }
    if (!this.#roots.size) throw new TypeError("graph lacks ingress root");
    const ready = [...ids.keys()].filter(id => !indegree.get(id));
    let visited = 0;
    for (let i = 0; i < ready.length; i++) {
      const id = ready[i]; visited++;
      for (const edge of this.#out.get(id)) {
        const next = indegree.get(edge.target) - 1;
        indegree.set(edge.target, next);
        if (!next) ready.push(edge.target);
      }
    }
    if (visited !== ids.size) throw new TypeError("cyclic actor graph");
    for (const [id, edges] of this.#out) this.#out.set(id, Object.freeze(edges));
    this.#generation = generation;
  }
  get generation() { return this.#generation; }
  requireIngressRoot(source) {
    if (!this.#roots.has(source)) throw new TypeError("not an ingress root");
  }
  #connected(source) {
    const edges = this.#out.get(source);
    if (!edges?.length) throw new TypeError("source has no downstream");
    return edges;
  }
  forward(source) {
    const edges = this.#connected(source);
    if (edges.length !== 1) throw new TypeError("ambiguous forward");
    return edges[0];
  }
  forwardAll(source) { return this.#connected(source); }
  forwardRoundRobin(source) {
    const edges = this.#connected(source);
    const slot = this.#rr.get(source) ?? 0;
    this.#rr.set(source, (slot + 1) % edges.length);
    return edges[slot];
  }
  forwardTo(source, target) {
    const edge = this.#connected(source).find(edge => edge.target === target);
    if (!edge) throw new TypeError("target not connected");
    return edge;
  }
  forwardByKey(source, key) {
    const edges = this.#connected(source);
    return edges[routeKeySlot(key, edges.length)];
  }
  advanceGeneration(successor, {quiescent = false, aborted = false} = {}) {
    if (!Number.isSafeInteger(successor) || successor <= this.#generation ||
        (!quiescent && !aborted))
      throw new TypeError("actor routing generation barrier required");
    this.#generation = successor;
    this.#rr.clear();
  }
}
