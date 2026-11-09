// Experimental, host-only v1. NOT wired to the existing two-page ActorArena ABI,
// compiled AttoLang guests, async callbacks or untrusted WebAssembly.Instance.
// Every lease has one private, non-shared WebAssembly.Memory. A pool recycles only
// fully scrubbed, retired heaps; it does not depend on JS GC to reuse capacity.
import { types } from 'node:util';

const PAGE = 65536;
const MAX_PAGES = 1024; // Explicit v1 ceiling: 64 MiB, not a ref32 width limit.
const MAX_HANDLES = 4096;
const trustedIsUint8Array = types.isUint8Array;
const TrustedMemory = WebAssembly.Memory;
const trustedGrow = WebAssembly.Memory.prototype.grow;
const TrustedUint8Array = Uint8Array;
const trustedIsSharedArrayBuffer = types.isSharedArrayBuffer;
const taPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getByteLength = Object.getOwnPropertyDescriptor(taPrototype, 'byteLength').get;
const getBuffer = Object.getOwnPropertyDescriptor(taPrototype, 'buffer').get;
const getMemoryBuffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer').get;
const apply = Reflect.apply;
const copyBytes = Uint8Array.prototype.slice;
const setBytes = Uint8Array.prototype.set;
const fillBytes = Uint8Array.prototype.fill;
const nativeBytes = memory => new TrustedUint8Array(apply(getMemoryBuffer, memory, []));
const zero = bytes => apply(fillBytes, bytes, [0]);

// Conservative ledger: resident linear pages remain charged while pooled.
// There is deliberately no public refund-on-retire or unverifiable RSS claim.
export class ElasticHeapPageLedgerV1 {
  #limit;
  #charged = 0;
  constructor(maxPages) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
      throw new RangeError('positive process page budget required');
    }
    this.#limit = maxPages;
  }
  get chargedPages() { return this.#charged; }
  get limitPages() { return this.#limit; }
  reserve(pages) {
    if (!Number.isSafeInteger(pages) || pages <= 0 || pages > this.#limit - this.#charged) return false;
    this.#charged += pages;
    return true;
  }
  rollback(pages) { // Only for a memory.grow that demonstrably failed.
    if (!Number.isSafeInteger(pages) || pages <= 0 || pages > this.#charged) {
      throw new Error('invalid page reservation rollback');
    }
    this.#charged -= pages;
  }
}

export class ElasticActorHeapPoolV1 {
  #maxPages;
  #ledger;
  #tenantLedger;
  #idle = [];
  #active = new Set();
  #activeIdentities = new Set();
  #activeActorIds = new Set();
  #closed = false;
  constructor({maxPages = 1024, processLedger, tenantLedger = processLedger} = {}) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES ||
        !(processLedger instanceof ElasticHeapPageLedgerV1) ||
        !(tenantLedger instanceof ElasticHeapPageLedgerV1)) {
      throw new RangeError('bounded actor pages and process ledger required');
    }
    this.#maxPages = maxPages;
    this.#ledger = processLedger;
    this.#tenantLedger = tenantLedger;
  }
  get chargedPages() { return this.#ledger.chargedPages; }
  get tenantChargedPages() { return this.#tenantLedger.chargedPages; }
  get idleCount() { return this.#idle.length; }
  get activeCount() { return this.#active.size; }
  get maxPages() { return this.#maxPages; }
  lease(actorId, incarnation) {
    if (this.#closed) throw new Error('actor heap pool retired');
    if (!Number.isSafeInteger(actorId) || actorId <= 0 ||
        !Number.isSafeInteger(incarnation) || incarnation <= 0) {
      throw new TypeError('invalid actor/incarnation');
    }
    const identity = `${actorId}:${incarnation}`;
    if (this.#activeIdentities.has(identity) || this.#activeActorIds.has(actorId))
      throw new Error('actor incarnation already leased');
    const memory = this.#idle.pop() ?? new TrustedMemory({initial: 0, maximum: this.#maxPages});
    const heap = new ElasticActorHeapV1(this, memory, actorId, incarnation);
    this.#active.add(heap);
    this.#activeIdentities.add(identity);
    this.#activeActorIds.add(actorId);
    return heap;
  }
  grow(heap, memory, count) {
    if (this.#closed || !this.#active.has(heap)) throw new Error('actor pool authority denied');
    if (!this.#tenantLedger.reserve(count)) throw new RangeError('tenant page budget exhausted');
    const separate = this.#tenantLedger !== this.#ledger;
    if (separate && !this.#ledger.reserve(count)) {
      this.#tenantLedger.rollback(count);
      throw new RangeError('process page budget exhausted');
    }
    try {
      apply(trustedGrow, memory, [count]);
    } catch (error) {
      // WebAssembly.Memory.grow is all-or-nothing on exception.
      if (separate) this.#ledger.rollback(count);
      this.#tenantLedger.rollback(count);
      throw error;
    }
  }
  recycle(heap, memory) {
    if (this.#closed || !this.#active.has(heap)) throw new Error('foreign/duplicate actor retirement');
    zero(nativeBytes(memory));
    this.#active.delete(heap);
    this.#activeIdentities.delete(`${heap.actorId}:${heap.incarnation}`);
    this.#activeActorIds.delete(heap.actorId);
    this.#idle.push(memory); // Accounting remains charged, backing remains reusable.
  }
  retire() {
    if (this.#active.size !== 0) throw new Error('actor turns/leases still active');
    this.#closed = true;
    // Retained pages are NOT refunded here: the JS engine, not our allocator,
    // controls physical reclamation. Process/tenant ledger is conservative.
    this.#idle.length = 0;
  }
}

class ElasticActorHeapV1 {
  #pool;
  #memory;
  #actor;
  #incarnation;
  #turn = null;
  #cursor = 0;
  #slots = new WeakMap();
  #free = [];
  #live = 0;
  #retired = false;
  constructor(pool, memory, actor, incarnation) {
    this.#pool = pool;
    this.#memory = memory;
    this.#actor = actor;
    this.#incarnation = incarnation;
  }
  get actorId() { return this.#actor; }
  get incarnation() { return this.#incarnation; }
  get committedPages() {
    if (this.#retired) return 0;
    return apply(getMemoryBuffer, this.#memory, []).byteLength / PAGE;
  }
  get liveAllocations() { return this.#live; }
  #checkTurn(turn) {
    if (this.#retired || turn === null || turn !== this.#turn) {
      throw new Error('retired or foreign actor turn');
    }
  }
  beginTurn() {
    if (this.#retired || this.#turn !== null) throw new Error('retired or active actor turn');
    return (this.#turn = Object.freeze({}));
  }
  endTurn(turn) { this.#checkTurn(turn); this.#turn = null; }
  #slot(turn, handle) {
    this.#checkTurn(turn);
    const slot = this.#slots.get(handle);
    if (!slot) throw new Error('foreign or stale actor handle');
    return slot;
  }
  allocate(turn, length, alignment = 8) {
    this.#checkTurn(turn);
    if (!Number.isSafeInteger(length) || length <= 0 ||
        !Number.isSafeInteger(alignment) || alignment < 8 || alignment > 64 ||
        (alignment & (alignment - 1)) !== 0 || this.#live >= MAX_HANDLES) {
      throw new RangeError('invalid actor allocation or handle quota');
    }
    const maxBytes = this.#pool.maxPages * PAGE;
    let index = this.#free.findIndex(s => s.length >= length && s.offset % alignment === 0);
    let offset, consumed;
    if (index >= 0) {
      const segment = this.#free[index];
      offset = segment.offset;
      consumed = true;
    } else {
      offset = Math.ceil(this.#cursor / alignment) * alignment;
      consumed = false;
    }
    if (offset > maxBytes || length > maxBytes - offset) throw new RangeError('actor heap hard quota');
    const requiredPages = Math.ceil((offset + length) / PAGE);
    const currentPages = this.committedPages;
    if (requiredPages > currentPages) this.#pool.grow(this, this.#memory, requiredPages - currentPages);
    // Stage zeroing before publishing the cursor or any handle.
    zero(new TrustedUint8Array(apply(getMemoryBuffer, this.#memory, []), offset, length));
    if (consumed) {
      const seg = this.#free[index];
      seg.offset += length;
      seg.length -= length;
      if (seg.length === 0) this.#free.splice(index, 1);
    } else this.#cursor = offset + length;
    const handle = Object.freeze({});
    this.#slots.set(handle, {offset, length});
    this.#live++;
    return handle;
  }
  word(turn, handle) {
    const {offset} = this.#slot(turn, handle);
    return offset / 8 + 1; // guest-ref32 model, NOT an authorization token.
  }
  read(turn, handle) {
    const {offset, length} = this.#slot(turn, handle);
    const live = new TrustedUint8Array(apply(getMemoryBuffer, this.#memory, []), offset, length);
    return apply(copyBytes, live, []); // Never expose a live memory alias.
  }
  write(turn, handle, data) {
    const {offset, length} = this.#slot(turn, handle);
    if (!trustedIsUint8Array(data) || apply(getByteLength, data, []) !== length ||
        trustedIsSharedArrayBuffer(apply(getBuffer, data, []))) {
      throw new TypeError('exact-size private Uint8Array required');
    }
    const live = new TrustedUint8Array(apply(getMemoryBuffer, this.#memory, []), offset, length);
    apply(setBytes, live, [data]);
  }
  drop(turn, handle) {
    const {offset, length} = this.#slot(turn, handle);
    zero(new TrustedUint8Array(apply(getMemoryBuffer, this.#memory, []), offset, length));
    this.#slots.delete(handle);
    this.#live--;
    this.#free.push({offset, length});
    this.#free.sort((a,b) => a.offset - b.offset);
    for (let i = 1; i < this.#free.length;) {
      const prior = this.#free[i-1], next = this.#free[i];
      if (prior.offset + prior.length === next.offset) {
        prior.length += next.length; this.#free.splice(i, 1);
      } else i++;
    }
  }
  retire() {
    if (this.#retired) return;
    if (this.#turn !== null) throw new Error('active actor turn blocks retirement');
    // No guest instance, async callback, FFI alias, memory/view exports or
    // continuation is allowed in this HOST-ONLY prototype.
    this.#retired = true;
    this.#slots = new WeakMap();
    this.#free = [];
    this.#live = 0;
    const memory = this.#memory;
    this.#memory = null;
    this.#pool.recycle(this, memory);
  }
}
