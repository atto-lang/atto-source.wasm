const nativeFreeze = Object.freeze;
const numberIsFinite = Number.isFinite;
const mathMax = Math.max;
const arrayPush = Array.prototype.push;
const arrayPop = Array.prototype.pop;
const NativeWeakSet = WeakSet;
const NativeWeakMap = WeakMap;
const weakSetAdd = NativeWeakSet.prototype.add;
const weakSetHas = NativeWeakSet.prototype.has;
const weakMapGet = NativeWeakMap.prototype.get;
const weakMapSet = NativeWeakMap.prototype.set;
const maps = new NativeWeakSet();
const TOKEN = nativeFreeze({});
const MAX_KEY = 4096;
const MAX_CLONE_DEPTH = 256;
const MAX_CLONE_NODES = 100000;

function h(n) { return n === null ? 0 : n.height; }
function makeNode(key, value, left, right) {
  return nativeFreeze({key, value, left, right, height: 1 + mathMax(h(left), h(right))});
}
function rotateLeft(n) {
  const p = n.right;
  if (p === null) throw new Error("persistent AVL right invariant");
  return makeNode(p.key, p.value, makeNode(n.key, n.value, n.left, p.left), p.right);
}
function rotateRight(n) {
  const p = n.left;
  if (p === null) throw new Error("persistent AVL left invariant");
  return makeNode(p.key, p.value, p.left, makeNode(n.key, n.value, p.right, n.right));
}
function balance(n) {
  const f = h(n.left) - h(n.right);
  if (f > 1) {
    let left = n.left;
    if (h(left.left) < h(left.right)) left = rotateLeft(left);
    return rotateRight(makeNode(n.key, n.value, left, n.right));
  }
  if (f < -1) {
    let right = n.right;
    if (h(right.left) > h(right.right)) right = rotateRight(right);
    return rotateLeft(makeNode(n.key, n.value, n.left, right));
  }
  return n;
}
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
function isMap(v) {
  return v !== null && typeof v === "object" && weakSetHas.call(maps, v);
}
function sameValue(a, b) {
  if (a === b) return true;
  if (isMap(a) || isMap(b)) return false;
  return Object.is(a, b);
}
function admitValue(v) {
  const t = typeof v;
  if (t === "string" || t === "boolean" || t === "bigint") return;
  if (t === "number" && numberIsFinite(v)) return;
  if (isMap(v)) return;
  throw new TypeError("persistent actor value must be immutable scalar or PersistentActorMap");
}
function put(n, key, value, state) {
  if (n === null) {
    state.added = state.changed = true;
    return makeNode(key, value, null, null);
  }
  const c = compare(key, n.key);
  if (c === 0) {
    if (sameValue(n.value, value)) return n;
    state.changed = true;
    return makeNode(n.key, value, n.left, n.right);
  }
  if (c < 0) {
    const left = put(n.left, key, value, state);
    return state.changed ? balance(makeNode(n.key, n.value, left, n.right)) : n;
  }
  const right = put(n.right, key, value, state);
  return state.changed ? balance(makeNode(n.key, n.value, n.left, right)) : n;
}
function minNode(n) { while (n.left !== null) n = n.left; return n; }
function deleteMin(n) {
  if (n.left === null) return n.right;
  return balance(makeNode(n.key, n.value, deleteMin(n.left), n.right));
}
function remove(n, key, state) {
  if (n === null) return null;
  const c = compare(key, n.key);
  if (c < 0) {
    const left = remove(n.left, key, state);
    return state.removed ? balance(makeNode(n.key, n.value, left, n.right)) : n;
  }
  if (c > 0) {
    const right = remove(n.right, key, state);
    return state.removed ? balance(makeNode(n.key, n.value, n.left, right)) : n;
  }
  state.removed = true;
  if (n.left === null) return n.right;
  if (n.right === null) return n.left;
  const successor = minNode(n.right);
  return balance(makeNode(successor.key, successor.value, n.left, deleteMin(n.right)));
}
function lookup(n, key) {
  while (n !== null) {
    const c = compare(key, n.key);
    if (c === 0) return n.value;
    n = c < 0 ? n.left : n.right;
  }
  return undefined;
}

export class PersistentActorMap {
  #root;
  #count;
  constructor(token = null, root = null, count = 0) {
    if (token !== TOKEN) throw new TypeError("use PersistentActorMap.empty()");
    this.#root = root;
    this.#count = count;
    weakSetAdd.call(maps, this);
    nativeFreeze(this);
  }
  static empty() { return new PersistentActorMap(TOKEN, null, 0); }
  get size() { return this.#count; }
  get(key) {
    if (typeof key !== "string") return undefined;
    return lookup(this.#root, key);
  }
  has(key) {
    return typeof key === "string" && lookup(this.#root, key) !== undefined;
  }
  with(key, value) {
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY)
      throw new TypeError("invalid persistent actor key");
    admitValue(value);
    const state = {added: false, changed: false};
    const root = put(this.#root, key, value, state);
    return state.changed
      ? new PersistentActorMap(TOKEN, root, this.#count + (state.added ? 1 : 0))
      : this;
  }
  without(key) {
    if (typeof key !== "string" || key.length === 0)
      throw new TypeError("invalid persistent actor key");
    const state = {removed: false};
    const root = remove(this.#root, key, state);
    if (!state.removed) return this;
    return root === null
      ? PersistentActorMap.empty()
      : new PersistentActorMap(TOKEN, root, this.#count - 1);
  }
  snapshotForActor(kind) {
    if (kind === "shared") return this;
    if (kind !== "private" && kind !== "untrusted")
      throw new TypeError("unknown actor isolation kind");
    return this.#clone(0, new NativeWeakMap(), {nodes: 0});
  }
  #clone(depth, memo, budget) {
    if (depth > MAX_CLONE_DEPTH)
      throw new RangeError("persistent actor clone depth");
    const prior = weakMapGet.call(memo, this);
    if (prior !== undefined) return prior;
    let copy = PersistentActorMap.empty();
    const stack = [];
    let n = this.#root;
    while (n !== null || stack.length !== 0) {
      while (n !== null) { arrayPush.call(stack, n); n = n.left; }
      n = arrayPop.call(stack);
      if (++budget.nodes > MAX_CLONE_NODES)
        throw new RangeError("persistent actor clone node budget");
      let value = n.value;
      if (isMap(value)) value = value.#clone(depth + 1, memo, budget);
      copy = copy.with(n.key, value);
      n = n.right;
    }
    weakMapSet.call(memo, this, copy);
    return copy;
  }
}
