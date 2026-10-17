// Host-only checked route selector; does not expose guest imports or actor execution.
// Pin native route-authority and UTF-8 operations before host prototype mutations.
const NativeMap = Map, NativeSet = Set, nativeFreeze = Object.freeze;
const nativeMapGet = Map.prototype.get, nativeMapSet = Map.prototype.set;
const nativeMapHas = Map.prototype.has, nativeMapEntries = Map.prototype.entries;
const nativeMapKeys = Map.prototype.keys, nativeSetHas = Set.prototype.has;
const nativeSetAdd = Set.prototype.add, nativeArrayIsArray = Array.isArray;
const nativeArrayPush = Array.prototype.push, nativeArrayFind = Array.prototype.find;
const nativeStringIncludes = String.prototype.includes;
const nativeCharCodeAt = String.prototype.charCodeAt;
const encoder = new TextEncoder();
const nativeEncode = TextEncoder.prototype.encode;
function utf8(value, limit, optional = false, allowNul = false) {
  if (typeof value !== "string" || (!optional && !value) || (!allowNul && nativeStringIncludes.call(value, "\0")))
    throw new TypeError("invalid pipeline identifier");
  if (value.length > limit) throw new RangeError("pipeline byte limit");
  for (let i = 0; i < value.length; ++i) {
    const c = nativeCharCodeAt.call(value, i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (++i >= value.length || nativeCharCodeAt.call(value, i) < 0xdc00 ||
          nativeCharCodeAt.call(value, i) > 0xdfff) throw new TypeError("invalid Unicode");
    } else if (c >= 0xdc00 && c <= 0xdfff) throw new TypeError("invalid Unicode");
  }
  const data = nativeEncode.call(encoder, value);
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
  #cursor = new NativeMap();
  #retired = false;
  constructor(stages, edges) {
    if (!nativeArrayIsArray(stages) || stages.length < 2 || stages.length > 1024 ||
        !nativeArrayIsArray(edges) || !edges.length || edges.length > 4096)
      throw new RangeError("pipeline graph budget");
    const byId = new NativeMap(), routes = new NativeMap(), parents = new NativeMap();
    for (const {id, type, role, inbound = "", outbound = ""} of stages) {
      utf8(id, 256); utf8(type, 256); utf8(inbound, 256, true);
      utf8(outbound, 256, true);
      if (nativeMapHas.call(byId, id)) throw new TypeError("duplicate pipeline instance");
      if (!((role === "readable" && !inbound && outbound) ||
            (role === "writable" && inbound && !outbound) ||
            ((role === "transform" || role === "duplex") && inbound && outbound)))
        throw new TypeError("invalid pipeline role or ports");
      nativeMapSet.call(byId, id, {role, inbound, outbound});
      nativeMapSet.call(parents, id, 0);
    }
    const seen = new NativeSet();
    for (const edge of edges) {
      const {source, target, payload} = edge;
      utf8(source, 256); utf8(target, 256); utf8(payload, 256);
      const from = nativeMapGet.call(byId, source), to = nativeMapGet.call(byId, target);
      if (!from || !to || source === target ||
          from.role === "writable" || to.role === "readable" ||
          from.outbound !== payload || to.inbound !== payload)
        throw new TypeError("unknown or mistyped pipeline edge");
      const pair = JSON.stringify([source, target]);
      if (nativeSetHas.call(seen, pair)) throw new TypeError("duplicate pipeline edge");
      nativeSetAdd.call(seen, pair);
      if (!nativeMapHas.call(routes, source)) nativeMapSet.call(routes, source, []);
      nativeArrayPush.call(nativeMapGet.call(routes, source),
        nativeFreeze({source, target, payload}));
      nativeMapSet.call(parents, target, nativeMapGet.call(parents, target) + 1);
    }
    const indegree = new NativeMap(parents), ready = [];
    let root = false;
    for (const [id, stage] of byId) {
      const input = nativeMapGet.call(parents, id), output = nativeMapGet.call(routes, id)?.length ?? 0;
      if ((!input && !output) || (stage.role === "readable" && !output) ||
          (stage.role === "writable" && !input) ||
          (stage.role === "transform" && (!input || !output)))
        throw new TypeError("pipeline actor missing port");
      if (!input) {
        nativeArrayPush.call(ready, id);
        if (stage.role === "readable" || stage.role === "duplex") root = true;
      }
    }
    if (!root) throw new TypeError("pipeline requires ingress root");
    let visited = 0;
    for (let i = 0; i < ready.length; i++) {
      const id = ready[i]; visited++;
      for (const edge of nativeMapGet.call(routes, id) ?? []) {
        const n = nativeMapGet.call(indegree, edge.target) - 1;
        nativeMapSet.call(indegree, edge.target, n);
        if (n === 0) nativeArrayPush.call(ready, edge.target);
      }
    }
    if (visited !== stages.length) throw new TypeError("cyclic pipeline graph");
    this.#routes = new NativeMap();
    for (const [id, list] of nativeMapEntries.call(routes))
      nativeMapSet.call(this.#routes, id, nativeFreeze(list));
    // Pre-seed all RR cursors at trusted graph construction, never on a turn.
    for (const source of nativeMapKeys.call(this.#routes)) nativeMapSet.call(this.#cursor, source, 0);
  }
  #connected(source) {
    if (this.#retired) throw new Error("retired pipeline generation");
    const routes = nativeMapGet.call(this.#routes, source);
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
    const routes = this.#connected(source), cursor = nativeMapGet.call(this.#cursor, source);
    nativeMapSet.call(this.#cursor, source, (cursor + 1) % routes.length);
    return routes[cursor];
  }
  forwardTo(source, target) {
    const route = nativeArrayFind.call(this.#connected(source), e => e.target === target);
    if (!route) throw new TypeError("target is not connected");
    return route;
  }
  forwardByKey(source, key) {
    const routes = this.#connected(source);
    return routes[Number(actorRouteHash64(key) % BigInt(routes.length))];
  }
  close() { this.#retired = true; }
}
