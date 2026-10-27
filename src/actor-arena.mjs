import {types} from "node:util";

// Host-only experimental actor-owned region. NOT attached to a guest module.
// Every SHARED actor retains a private arena; ActorRef never grants heap access.
// Guest source arena lowering and shared-domain regions are separate gates.
const PAGE = 65536;
const MAX_HANDLES = 4096;
const kinds = new Set(["shared", "private", "untrusted"]);
const nativeFreeze = Object.freeze;
const nativeFindIndex = Array.prototype.findIndex;
const nativeSplice = Array.prototype.splice;
const nativeWeakSet = WeakMap.prototype.set;
const nativeWeakGet = WeakMap.prototype.get;
const nativeWeakDelete = WeakMap.prototype.delete;
const nativeMap = Array.prototype.map;
const nativePush = Array.prototype.push;
const nativeSort = Array.prototype.sort;
const nativeFill = Uint8Array.prototype.fill;
const nativeSlice = Uint8Array.prototype.slice;
const nativeSet = Uint8Array.prototype.set;
const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const nativeBuffer = Object.getOwnPropertyDescriptor(typedArrayProto, "buffer").get;
const nativeByteLength = Object.getOwnPropertyDescriptor(typedArrayProto, "byteLength").get;

export class ActorArena {
  #memory;
  #actor;
  #incarnation;
  #turn = null;
  #handles = new WeakMap();
  #scratch = new WeakMap();
  #persistentTop = 0;
  #scratchTop = 0;
  #persistentCount = 0;
  #scratchCount = 0;
  #freePersistent = [];
  #closed = false;

  constructor({actorId, incarnation, kind = "shared"} = {}) {
    if (!Number.isSafeInteger(actorId) || actorId <= 0 ||
        !Number.isSafeInteger(incarnation) || incarnation <= 0 ||
        !kinds.has(kind)) throw new TypeError("invalid actor arena owner");
    this.#actor = actorId;
    this.#incarnation = incarnation;
    // Fixed, bounded linear memory; one 64-KiB persistent and one scratch page.
    // Never exported to guest code. JS GC still controls physical release.
    this.#memory = new WebAssembly.Memory({initial: 2, maximum: 2});
  }

  get actorId() { return this.#actor; }
  get incarnation() { return this.#incarnation; }
  get retired() { return this.#closed; }

  #bytes() {
    if (this.#closed) throw new Error("actor arena retired");
    return new Uint8Array(this.#memory.buffer);
  }

  #requireTurn(token) {
    this.#bytes();
    if (token === null || token !== this.#turn) {
      throw new Error("actor turn authority required");
    }
  }

  beginTurn() {
    this.#bytes();
    if (this.#turn !== null) throw new Error("actor already admitted");
    const turn = Object.freeze({});
    this.#turn = turn;
    return turn;
  }

  endTurn(turn) {
    this.#requireTurn(turn);
    nativeFill.call(this.#bytes(), 0, PAGE, PAGE + this.#scratchTop);
    this.#scratchTop = 0;
    this.#scratchCount = 0;
    this.#scratch = new WeakMap();
    this.#turn = null;
  }

  #alloc(turn, length, scratch) {
    this.#requireTurn(turn);
    if (!Number.isSafeInteger(length) || length <= 0 || length > PAGE)
      throw new RangeError("invalid arena allocation length");
    if ((scratch ? this.#scratchCount : this.#persistentCount) >= MAX_HANDLES)
      throw new RangeError("actor arena handle quota exhausted");

    // PLAN without consuming a byte or a free-list segment. Token creation,
    // zeroing and WeakMap registration can fail: none may strand actor credit.
    let offset, freeIndex = -1;
    if (scratch) {
      if (length > PAGE - this.#scratchTop)
        throw new RangeError("actor arena quota exhausted");
      offset = PAGE + this.#scratchTop;
    } else {
      freeIndex = nativeFindIndex.call(
        this.#freePersistent, segment => segment.length >= length);
      if (freeIndex !== -1) {
        offset = this.#freePersistent[freeIndex].offset;
      } else {
        if (length > PAGE - this.#persistentTop)
          throw new RangeError("actor arena quota exhausted");
        offset = this.#persistentTop;
      }
    }

    const handle = nativeFreeze({});
    const slot = {offset, length};
    nativeFill.call(this.#bytes(), 0, offset, offset + length);
    nativeWeakSet.call(scratch ? this.#scratch : this.#handles, handle, slot);

    // COMMIT only after every fallible token/byte operation succeeded. Use
    // captured host intrinsics instead of dynamic prototype dispatch.
    if (scratch) {
      this.#scratchTop += length;
      ++this.#scratchCount;
    } else {
      if (freeIndex !== -1) {
        const segment = this.#freePersistent[freeIndex];
        segment.offset += length;
        segment.length -= length;
        if (segment.length === 0)
          nativeSplice.call(this.#freePersistent, freeIndex, 1);
      } else {
        this.#persistentTop += length;
      }
      ++this.#persistentCount;
    }
    return handle;
  }

  allocPersistent(turn, length) { return this.#alloc(turn, length, false); }
  allocScratch(turn, length) { return this.#alloc(turn, length, true); }

  dropPersistent(turn, handle) {
    this.#requireTurn(turn);
    const entry = nativeWeakGet.call(this.#handles, handle);
    if (!entry) throw new Error("foreign, stale or scratch arena handle");
    // Stage all free-list work before revoking the handle. A failed array
    // operation must not lose the allocation or leave a live handle aliased
    // with a future allocation. Clone segments before coalescing.
    const staged = nativeMap.call(this.#freePersistent, segment => ({...segment}));
    nativePush.call(staged, {...entry});
    nativeSort.call(staged, (a, b) => a.offset - b.offset);
    const coalesced = [];
    // Never invoke mutable Array.prototype[Symbol.iterator] for ownership.
    // Host-realm guest code could conceal a freed span or inject overlapping
    // segments into for...of, corrupting persistent arena allocation rights.
    for (let i = 0; i < staged.length; ++i) {
      const segment = staged[i];
      const prior = coalesced[coalesced.length - 1];
      if (prior && prior.offset + prior.length === segment.offset) prior.length += segment.length;
      else nativePush.call(coalesced, segment);
    }
    // Zero while ownership is still valid; then commit only infallible
    // internal-slot operations, using captured intrinsics for revocation.
    nativeFill.call(this.#bytes(), 0, entry.offset, entry.offset + entry.length);
    nativeWeakDelete.call(this.#handles, handle);
    --this.#persistentCount;
    this.#freePersistent = coalesced;
  }

  #slot(turn, handle) {
    this.#requireTurn(turn);
    const entry = nativeWeakGet.call(this.#handles, handle) ??
      nativeWeakGet.call(this.#scratch, handle);
    if (!entry) throw new Error("foreign or stale arena handle");
    return entry;
  }

  read(turn, handle) {
    const {offset, length} = this.#slot(turn, handle);
    return nativeSlice.call(this.#bytes(), offset, offset + length); // owned copy
  }

  write(turn, handle, data) {
    const {offset, length} = this.#slot(turn, handle);
    // Native internal slots prevent instance property overrides from changing
    // the exact-size and shared-memory admission checks.
    if (!types.isUint8Array(data) || nativeByteLength.call(data) !== length) {
      throw new TypeError("arena write requires exact-size Uint8Array");
    }
    if (types.isSharedArrayBuffer(nativeBuffer.call(data))) {
      throw new TypeError("arena write rejects shared backing memory");
    }
    // Never return live memory views; callers cannot retain a raw alias.
    nativeSet.call(this.#bytes(), data, offset);
  }

  retire() {
    if (this.#closed) return;
    if (this.#turn !== null) throw new Error("active actor turn blocks retirement");
    nativeFill.call(this.#bytes(), 0);
    this.#closed = true;
    this.#memory = null; // physical release is JS runtime-dependent
    this.#handles = new WeakMap();
    this.#scratch = new WeakMap();
    this.#persistentCount = this.#scratchCount = 0;
    this.#freePersistent = [];
  }
}
