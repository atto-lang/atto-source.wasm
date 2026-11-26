// Host-side actor allocation authority, NOT an OS/process sandbox.
// Runtime integration must ensure that only trusted allocation code issues
// grants and that guest/native code cannot bypass checkedOffset().
const MAX_WORD = 0xffff_ffffn;
const MAX_SPAN = MAX_WORD * 8n;
// Cache intrinsics while in trusted host bootstrap. Guest-side monkeypatches
// must not replace WeakMap authority lookups or overlap iteration.
const TrustedWeakMap = WeakMap;
const trustedApply = Reflect.apply;
const trustedGet = WeakMap.prototype.get;
const trustedSet = WeakMap.prototype.set;
const trustedDelete = WeakMap.prototype.delete;
const trustedFreeze = Object.freeze;
const trustedCreate = Object.create;
function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function bounded(start, size, limit) {
  return typeof start === "bigint" && typeof size === "bigint" &&
    start >= 0n && size > 0n && start <= limit && size <= limit - start;
}
export class ActorIsolationAccessV1 {
  #tenant;
  #actor;
  #generation;
  #span;
  #closed = false;
  #grants = new TrustedWeakMap();
  #live = [];

  constructor(tenant, actor, generation, spanBytes) {
    if (!positiveId(tenant) || !positiveId(actor) ||
        !positiveId(generation) || typeof spanBytes !== "bigint" ||
        spanBytes <= 0n || spanBytes > MAX_SPAN)
      throw new RangeError("invalid tenant/actor incarnation or compressed32 span");
    this.#tenant = tenant;
    this.#actor = actor;
    this.#generation = generation;
    this.#span = spanBytes;
  }

  // The private WeakMap makes an object identity, not caller-supplied fields,
  // the authority. The token itself reveals no tenant/heap pointer.
  issueAllocation(startBytes, lengthBytes) {
    if (this.#closed) throw new Error("actor incarnation retired");
    if (!bounded(startBytes, lengthBytes, this.#span) || startBytes % 8n !== 0n)
      throw new RangeError("allocation outside actor span or unaligned");
    for (let i = 0; i < this.#live.length; i++) {
      const range = this.#live[i];
      if (startBytes < range.end && range.start < startBytes + lengthBytes)
        throw new RangeError("overlapping live actor allocations");
    }
    const grant = trustedFreeze(trustedCreate(null));
    const range = {start: startBytes, end: startBytes + lengthBytes};
    trustedApply(trustedSet, this.#grants, [grant, range]);
    this.#live[this.#live.length] = range;
    return grant;
  }

  checkedOffset(grant, storedWord, accessBytes) {
    if (this.#closed) throw new Error("actor incarnation retired");
    const range = trustedApply(trustedGet, this.#grants, [grant]);
    if (!range) throw new Error("foreign or stale actor allocation grant");
    let found = false;
    for (let i = 0; i < this.#live.length; i++) {
      if (this.#live[i] === range) { found = true; break; }
    }
    if (!found) throw new Error("foreign or stale actor allocation grant");
    if (typeof storedWord !== "bigint" || storedWord <= 0n ||
        storedWord > MAX_WORD || typeof accessBytes !== "bigint" ||
        accessBytes <= 0n)
      throw new RangeError("invalid compressed32 pointer or access length");
    const offset = (storedWord - 1n) * 8n;
    if (offset < range.start || offset > range.end ||
        accessBytes > range.end - offset)
      throw new RangeError("compressed32 access outside granted allocation");
    return offset; // actor-relative only; never a host address
  }

  release(grant) {
    if (this.#closed) throw new Error("actor incarnation retired");
    const range = trustedApply(trustedGet, this.#grants, [grant]);
    let found = -1;
    for (let i = 0; i < this.#live.length; i++) {
      if (this.#live[i] === range) { found = i; break; }
    }
    if (!range || found === -1)
      throw new Error("foreign or stale actor allocation grant");
    this.#live[found] = this.#live[this.#live.length - 1];
    this.#live.length--;
    trustedApply(trustedDelete, this.#grants, [grant]);
    // The actual actor heap MUST scrub before reusing these bytes.
  }

  retire() {
    this.#closed = true;
    this.#grants = new TrustedWeakMap();
    this.#live.length = 0;
    // The owning runtime MUST fence turns/pins and scrub the heap.
  }
  get retired() { return this.#closed; }
  get identity() {
    return trustedFreeze({tenant: this.#tenant, actor: this.#actor,
      generation: this.#generation});
  }
}
