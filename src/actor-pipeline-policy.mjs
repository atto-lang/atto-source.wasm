// Host-only checked route selector; does not expose guest imports or actor execution.
const encoder = new TextEncoder();
// Capture graph-authority operations at module import. Guest libraries may
// subsequently replace these prototype methods; selector authority must
// never follow those replacements.
const safeMapGet = Map.prototype.get;
const safeMapSet = Map.prototype.set;
const safeMapKeys = Map.prototype.keys;
const safeArrayFind = Array.prototype.find;
const safeFreeze = Object.freeze;
function utf8(value, limit, optional = false, allowNul = false) {
  if (typeof value !== "string" || (!optional && !value) || (!allowNul && value.includes("\0")))
    throw new TypeError("invalid pipeline identifier");
  if (value.length > limit) throw new RangeError("pipeline byte limit");
  for (let i = 0; i < value.length; ++i) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (++i >= value.length || value.charCodeAt(i) < 0xdc00 ||
          value.charCodeAt(i) > 0xdfff) throw new TypeError("invalid Unicode");
    } else if (c >= 0xdc00 && c <= 0xdfff) throw new TypeError("invalid Unicode");
  }
  const data = encoder.encode(value);
  if (data.length > limit) throw new RangeError("pipeline UTF-8 byte budget");
  return data;
}
export function actorRouteHash64(key) {
  let hash = 0xcbf29ce484222325n;
  for (const b of utf8(key, 4096, true, true))
    hash = ((hash ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return hash;
}
export class ActorPipelinePolicy {
  #routes;
  #cursor = new Map();
  #retired = false;
  constructor(stages, edges) {
    if (!Array.isArray(stages) || stages.length < 2 || stages.length > 1024 ||
        !Array.isArray(edges) || !edges.length || edges.length > 4096)
      throw new RangeError("pipeline graph budget");
    const byId = new Map(), routes = new Map(), parents = new Map();
    for (const {id, type, role, inbound = "", outbound = ""} of stages) {
      utf8(id, 256); utf8(type, 256); utf8(inbound, 256, true);
      utf8(outbound, 256, true);
      if (byId.has(id)) throw new TypeError("duplicate pipeline instance");
      if (!((role === "readable" && !inbound && outbound) ||
            (role === "writable" && inbound && !outbound) ||
            (["transform", "duplex"].includes(role) && inbound && outbound)))
        throw new TypeError("invalid pipeline role or ports");
      byId.set(id, {role, inbound, outbound});
      parents.set(id, 0);
    }
    const seen = new Set();
    for (const edge of edges) {
      const {source, target, payload} = edge;
      utf8(source, 256); utf8(target, 256); utf8(payload, 256);
      const from = byId.get(source), to = byId.get(target);
      if (!from || !to || source === target ||
          from.role === "writable" || to.role === "readable" ||
          from.outbound !== payload || to.inbound !== payload)
        throw new TypeError("unknown or mistyped pipeline edge");
      const pair = JSON.stringify([source, target]);
      if (seen.has(pair)) throw new TypeError("duplicate pipeline edge");
      seen.add(pair);
      if (!routes.has(source)) routes.set(source, []);
      routes.get(source).push(Object.freeze({source, target, payload}));
      parents.set(target, parents.get(target) + 1);
    }
    const indegree = new Map(parents), ready = [];
    let root = false;
    for (const [id, stage] of byId) {
      const input = parents.get(id), output = routes.get(id)?.length ?? 0;
      if ((!input && !output) || (stage.role === "readable" && !output) ||
          (stage.role === "writable" && !input) ||
          (stage.role === "transform" && (!input || !output)))
        throw new TypeError("pipeline actor missing port");
      if (!input) {
        ready.push(id);
        if (stage.role === "readable" || stage.role === "duplex") root = true;
      }
    }
    if (!root) throw new TypeError("pipeline requires ingress root");
    let visited = 0;
    for (let i = 0; i < ready.length; i++) {
      const id = ready[i]; visited++;
      for (const edge of routes.get(id) ?? []) {
        const n = indegree.get(edge.target) - 1;
        indegree.set(edge.target, n);
        if (n === 0) ready.push(edge.target);
      }
    }
    if (visited !== stages.length) throw new TypeError("cyclic pipeline graph");
    this.#routes = new Map([...routes].map(([id, list])=>[id, safeFreeze(list)]));
    // Pre-seed all RR cursors at trusted graph construction, never on a turn.
    for (const source of safeMapKeys.call(this.#routes)) safeMapSet.call(this.#cursor, source, 0);
  }
  #connected(source) {
    if (this.#retired) throw new Error("retired pipeline generation");
    const routes = safeMapGet.call(this.#routes, source);
    if (!routes?.length) throw new TypeError("source has no downstream");
    return routes;
  }
  forward(source) {
    const routes = this.#connected(source);
    if (routes.length !== 1) throw new TypeError("ambiguous forward");
    return routes[0];
  }
  forwardAll(source) { return this.#connected(source); }
  forwardRoundRobin(source) {
    const routes = this.#connected(source), cursor = safeMapGet.call(this.#cursor, source);
    safeMapSet.call(this.#cursor, source, (cursor + 1) % routes.length);
    return routes[cursor];
  }
  forwardTo(source, target) {
    const route = safeArrayFind.call(this.#connected(source), e => e.target === target);
    if (!route) throw new TypeError("target is not connected");
    return route;
  }
  forwardByKey(source, key) {
    const routes = this.#connected(source);
    return routes[Number(actorRouteHash64(key) % BigInt(routes.length))];
  }
  close() { this.#retired = true; }
}
