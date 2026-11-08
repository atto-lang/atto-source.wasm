// Host-side actor allocation authority, NOT an OS/process sandbox.
// Runtime integration must ensure that only trusted allocation code issues
// grants and that guest/native code cannot bypass checkedOffset().
const MAX_WORD = 0xffff_ffffn;
const MAX_SPAN = MAX_WORD * 8n;
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
  #grants = new WeakMap();
  #live = new Set();

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
    for (const range of this.#live) {
      if (startBytes < range.end && range.start < startBytes + lengthBytes)
        throw new RangeError("overlapping live actor allocations");
    }
    const grant = Object.freeze(Object.create(null));
    const range = {start: startBytes, end: startBytes + lengthBytes};
    this.#grants.set(grant, range);
    this.#live.add(range);
    return grant;
  }

  checkedOffset(grant, storedWord, accessBytes) {
    if (this.#closed) throw new Error("actor incarnation retired");
    const range = this.#grants.get(grant);
    if (!range || !this.#live.has(range))
      throw new Error("foreign or stale actor allocation grant");
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
    const range = this.#grants.get(grant);
    if (!range || !this.#live.delete(range))
      throw new Error("foreign or stale actor allocation grant");
    this.#grants.delete(grant);
    // The actual actor heap MUST scrub before reusing these bytes.
  }

  retire() {
    this.#closed = true;
    this.#grants = new WeakMap();
    this.#live.clear();
    // The owning runtime MUST fence turns/pins and scrub the heap.
  }
  get retired() { return this.#closed; }
  get identity() {
    return Object.freeze({tenant: this.#tenant, actor: this.#actor,
      generation: this.#generation});
  }
}
