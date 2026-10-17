// Host-only checked route selector; does not expose guest imports or actor execution.
const NativeMap = Map;
const NativeSet = Set;
const NativeNumber = Number;
const NativeBigInt = BigInt;
const NativeTextEncoder = TextEncoder;
const encoder = new NativeTextEncoder();
// Capture graph-authority operations at module import. Guest libraries may
// subsequently replace these prototype methods; selector authority must
// never follow those replacements.
const safeMapGet = Map.prototype.get;
const safeMapSet = Map.prototype.set;
const safeMapKeys = Map.prototype.keys;
const safeMapHas = Map.prototype.has;
const safeSetHas = Set.prototype.has;
const safeSetAdd = Set.prototype.add;
const safeArrayPush = Array.prototype.push;
const safeArrayIsArray = Array.isArray;
const safeStringIncludes = String.prototype.includes;
const safeEncode = TextEncoder.prototype.encode;
const safeArrayFind = Array.prototype.find;
const safeFreeze = Object.freeze;
function utf8(value, limit, optional = false, allowNul = false) {
  if (typeof value !== "string" || (!optional && !value) || (!allowNul && safeStringIncludes.call(value, "\0")))
    throw new TypeError("invalid pipeline identifier");
  if (value.length > limit) throw new RangeError("pipeline byte limit");
  for (let i = 0; i < value.length; ++i) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (++i >= value.length || value.charCodeAt(i) < 0xdc00 ||
          value.charCodeAt(i) > 0xdfff) throw new TypeError("invalid Unicode");
    } else if (c >= 0xdc00 && c <= 0xdfff) throw new TypeError("invalid Unicode");
  }
  const data = safeEncode.call(encoder, value);
  if (data.length > limit) throw new RangeError("pipeline UTF-8 byte budget");
  return data;
}
export function actorRouteHash64(key) {
  let hash = 0xcbf29ce484222325n;
  for (const b of utf8(key, 4096, true, true))
    hash = ((hash ^ NativeBigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return hash;
}
export class ActorPipelinePolicy {
  #routes;
  #cursor = new Map();
  #retired = false;
  constructor(stages, edges) {
    if (!safeArrayIsArray(stages) || !safeArrayIsArray(edges))
      throw new RangeError("pipeline graph budget");
    // Snapshot bounded caller-owned graph arrays by numeric index only.
    // A proxy iterator or a mutated length must not bypass budget/cycle
    // checks or inject an edge after the graph was accepted.
    const stageCount = stages.length, edgeCount = edges.length;
    if (stageCount < 2 || stageCount > 1024 || edgeCount < 1 || edgeCount > 4096)
      throw new RangeError("pipeline graph budget");
    const stageSnapshot = [], edgeSnapshot = [];
    for (let i = 0; i < stageCount; ++i) {
      const item = stages[i];
      if (!item || typeof item !== "object")
        throw new TypeError("invalid pipeline stage");
      const {id, type, role, inbound = "", outbound = ""} = item;
      safeArrayPush.call(stageSnapshot, {id, type, role, inbound, outbound});
    }
    for (let i = 0; i < edgeCount; ++i) {
      const item = edges[i];
      if (!item || typeof item !== "object")
        throw new TypeError("invalid pipeline edge");
      const {source, target, payload} = item;
      safeArrayPush.call(edgeSnapshot, {source, target, payload});
    }
    const byId = new NativeMap(), routes = new NativeMap(), parents = new NativeMap();
    for (const {id, type, role, inbound, outbound} of stageSnapshot) {
      utf8(id, 256); utf8(type, 256); utf8(inbound, 256, true);
      utf8(outbound, 256, true);
      if (safeMapHas.call(byId, id)) throw new TypeError("duplicate pipeline instance");
      if (!((role === "readable" && !inbound && outbound) ||
            (role === "writable" && inbound && !outbound) ||
            ((role === "transform" || role === "duplex") && inbound && outbound)))
        throw new TypeError("invalid pipeline role or ports");
      safeMapSet.call(byId, id, {role, inbound, outbound});
      safeMapSet.call(parents, id, 0);
    }
    const seen = new NativeSet();
    for (const edge of edgeSnapshot) {
      const {source, target, payload} = edge;
      utf8(source, 256); utf8(target, 256); utf8(payload, 256);
      const from = safeMapGet.call(byId, source), to = safeMapGet.call(byId, target);
      if (!from || !to || source === target ||
          from.role === "writable" || to.role === "readable" ||
          from.outbound !== payload || to.inbound !== payload)
        throw new TypeError("unknown or mistyped pipeline edge");
      const pair = JSON.stringify([source, target]);
      if (safeSetHas.call(seen, pair)) throw new TypeError("duplicate pipeline edge");
      safeSetAdd.call(seen, pair);
      if (!safeMapHas.call(routes, source)) safeMapSet.call(routes, source, []);
      safeArrayPush.call(safeMapGet.call(routes, source), safeFreeze({source, target, payload}));
      safeMapSet.call(parents, target, safeMapGet.call(parents, target) + 1);
    }
    const indegree = new NativeMap(parents), ready = [];
    let root = false;
    for (const [id, stage] of byId) {
      const input = safeMapGet.call(parents, id), output = safeMapGet.call(routes, id)?.length ?? 0;
      if ((!input && !output) || (stage.role === "readable" && !output) ||
          (stage.role === "writable" && !input) ||
          (stage.role === "transform" && (!input || !output)))
        throw new TypeError("pipeline actor missing port");
      if (!input) {
        safeArrayPush.call(ready, id);
        if (stage.role === "readable" || stage.role === "duplex") root = true;
      }
    }
    if (!root) throw new TypeError("pipeline requires ingress root");
    let visited = 0;
    for (let i = 0; i < ready.length; i++) {
      const id = ready[i]; visited++;
      for (const edge of safeMapGet.call(routes, id) ?? []) {
        const n = safeMapGet.call(indegree, edge.target) - 1;
        safeMapSet.call(indegree, edge.target, n);
        if (n === 0) safeArrayPush.call(ready, edge.target);
      }
    }
    if (visited !== stageCount) throw new TypeError("cyclic pipeline graph");
    this.#routes = new NativeMap([...routes].map(([id, list])=>[id, safeFreeze(list)]));
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
    return routes[NativeNumber(actorRouteHash64(key) % NativeBigInt(routes.length))];
  }
  close() { this.#retired = true; }
}
