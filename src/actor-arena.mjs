import {types} from "node:util";

// Host-only experimental actor-owned region. NOT attached to a guest module.
// Every SHARED actor retains a private arena; ActorRef never grants heap access.
// Guest source arena lowering and shared-domain regions are separate gates.
const PAGE = 65536;
const MAX_HANDLES = 4096;
// Capture trusted startup constructors and predicates as well as methods.
// Later shared-realm mutation must not merge capability registries or weaken
// the prohibition on concurrently mutable source buffers.
const NativeWeakMap = WeakMap;
const nativeIsUint8Array = types.isUint8Array;
const nativeIsSharedArrayBuffer = types.isSharedArrayBuffer;
const kinds = new Set(["shared", "private", "untrusted"]);
const nativeFreeze = Object.freeze;
const nativeIsSafeInteger = Number.isSafeInteger;
const nativeSetHas = Set.prototype.has;
const nativeFindIndex = Array.prototype.findIndex;
const nativeSplice = Array.prototype.splice;
const nativePush = Array.prototype.push;
const nativeSort = Array.prototype.sort;
const nativeWeakGet = WeakMap.prototype.get;
const nativeWeakDelete = WeakMap.prototype.delete;
const nativeWeakSet = WeakMap.prototype.set;
const nativeFill = Uint8Array.prototype.fill;
const NativeUint8Array = Uint8Array;
const NativeMemory = WebAssembly.Memory;
const nativeMemoryBuffer = Object.getOwnPropertyDescriptor(NativeMemory.prototype, "buffer").get;
const nativeSet = Uint8Array.prototype.set;
const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const nativeBuffer = Object.getOwnPropertyDescriptor(typedArrayProto, "buffer").get;
const nativeByteLength = Object.getOwnPropertyDescriptor(typedArrayProto, "byteLength").get;

export class ActorArena {
  #memory;
  #actor;
  #incarnation;
  #turn = null;
  #handles = new NativeWeakMap();
  #scratch = new NativeWeakMap();
  #persistentTop = 0;
  #scratchTop = 0;
  #persistentCount = 0;
  #scratchCount = 0;
  #freePersistent = [];
  #closed = false;

  constructor({actorId, incarnation, kind = "shared"} = {}) {
    if (!nativeIsSafeInteger(actorId) || actorId <= 0 ||
        !nativeIsSafeInteger(incarnation) || incarnation <= 0 ||
        !nativeSetHas.call(kinds, kind)) throw new TypeError("invalid actor arena owner");
    this.#actor = actorId;
    this.#incarnation = incarnation;
    // Fixed, bounded linear memory; one 64-KiB persistent and one scratch page.
    // Never exported to guest code. JS GC still controls physical release.
    this.#memory = new NativeMemory({initial: 2, maximum: 2});
  }

  get actorId() { return this.#actor; }
  get incarnation() { return this.#incarnation; }
  get retired() { return this.#closed; }

  #bytes() {
    if (this.#closed) throw new Error("actor arena retired");
    // A mutable WebAssembly.Memory.prototype.buffer getter could redirect
    // private zeroing/writes to an attacker-held decoy ArrayBuffer.
    return new NativeUint8Array(nativeMemoryBuffer.call(this.#memory));
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
    const turn = nativeFreeze({});
    this.#turn = turn;
    return turn;
  }

  endTurn(turn) {
    this.#requireTurn(turn);
    nativeFill.call(this.#bytes(), 0, PAGE, PAGE + this.#scratchTop);
    this.#scratchTop = 0;
    this.#scratchCount = 0;
    this.#scratch = new NativeWeakMap();
    this.#turn = null;
  }

  #alloc(turn, length, scratch) {
    this.#requireTurn(turn);
    if (!nativeIsSafeInteger(length) || length <= 0 || length > PAGE)
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

    // PLAN the complete free list before revoking the handle or credit.
    // A poisoned host Array prototype must not strand an unreachable segment.
    const planned = [];
    for (let i = 0; i < this.#freePersistent.length; ++i) {
      const segment = this.#freePersistent[i];
      nativePush.call(planned, {offset: segment.offset, length: segment.length});
    }
    nativePush.call(planned, {offset: entry.offset, length: entry.length});
    nativeSort.call(planned, (a, b) => a.offset - b.offset);
    const coalesced = [];
    for (let i = 0; i < planned.length; ++i) {
      const segment = planned[i];
      const prior = coalesced.length === 0 ? null : coalesced[coalesced.length - 1];
      if (prior && prior.offset + prior.length === segment.offset)
        prior.length += segment.length;
      else nativePush.call(coalesced, segment);
    }

    // PREPARE zeroing, then COMMIT the revocation and quota together.
    // Native WeakMap deletion on a valid private map/key cannot call guest code.
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
    // TypedArray.prototype.slice consults mutable constructor[Symbol.species],
    // even when the slice method itself was captured. Construct the owned
    // result and exact source view with the captured native constructor.
    const bytes = this.#bytes();
    const copy = new NativeUint8Array(length);
    nativeSet.call(copy, new NativeUint8Array(nativeBuffer.call(bytes), offset, length));
    return copy; // owned copy
  }

  write(turn, handle, data) {
    const {offset, length} = this.#slot(turn, handle);
    // Native internal slots prevent instance property overrides from changing
    // the exact-size and shared-memory admission checks.
    if (!nativeIsUint8Array(data) || nativeByteLength.call(data) !== length) {
      throw new TypeError("arena write requires exact-size Uint8Array");
    }
    if (nativeIsSharedArrayBuffer(nativeBuffer.call(data))) {
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
    this.#handles = new NativeWeakMap();
    this.#scratch = new NativeWeakMap();
    this.#persistentCount = this.#scratchCount = 0;
    this.#freePersistent = [];
  }
}

