// Host-only experimental actor-owned region. NOT attached to a guest module.
// Every SHARED actor retains a private arena; ActorRef never grants heap access.
// Guest source arena lowering and shared-domain regions are separate gates.
const PAGE = 65536;
const MAX_HANDLES = 4096;
const kinds = new Set(["shared", "private", "untrusted"]);
// Identity/admission checks must not trust mutable standard-library hooks.
const safeInteger = Number.isSafeInteger;
const nativeFreeze = Object.freeze;
const setHas = Set.prototype.has;
// Use the intrinsic brand check, not instanceof: a cross-realm SAB can back
// a local Uint8Array while failing instanceof SharedArrayBuffer.
// Own properties on a Uint8Array can shadow .buffer and .byteLength. Read
// the real typed-array internal slots instead of trusting spoofable properties.
// Bind allocator/copy/zero primitives before user code can monkeypatch them.
// Never dispatch a mutable Uint8Array prototype method on private region bytes.
const NativeUint8Array = Uint8Array;
const NativeMemory = WebAssembly.Memory;
const NativeWeakMap = WeakMap;
// WeakMap authority operations must bypass mutable userland prototypes.
const weakMapGet = NativeWeakMap.prototype.get;
const weakMapSet = NativeWeakMap.prototype.set;
const weakMapDelete = NativeWeakMap.prototype.delete;
// The free-list is also private authority metadata. Prototype-dispatched
// Array methods can leak or corrupt the internal list through a user hook.
const arrayFindIndex = Array.prototype.findIndex;
const arraySplice = Array.prototype.splice;
const arrayPush = Array.prototype.push;
const arraySort = Array.prototype.sort;
// The WebAssembly.Memory.prototype.buffer getter is configurable in Node.
// Capture its native internal-slot accessor before unrelated user code can
// redirect arena reads and scrubs to an attacker-chosen ArrayBuffer.
const memoryBuffer = Object.getOwnPropertyDescriptor(NativeMemory.prototype, "buffer").get;
const typedArrayPrototype = Object.getPrototypeOf(NativeUint8Array.prototype);
const typedArraySet = typedArrayPrototype.set;
const typedArrayFill = typedArrayPrototype.fill;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer").get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength").get;
const sharedByteLength = typeof SharedArrayBuffer === "function"
  ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength").get
  : null;
function isSharedBacking(buffer) {
  if (sharedByteLength === null) return false;
  try {
    sharedByteLength.call(buffer); // Native internal-slot check, including cross-realm SAB.
    return true;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

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
    if (!safeInteger(actorId) || actorId <= 0 ||
        !safeInteger(incarnation) || incarnation <= 0 ||
        !setHas.call(kinds, kind)) throw new TypeError("invalid actor arena owner");
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
    return new NativeUint8Array(memoryBuffer.call(this.#memory));
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
    typedArrayFill.call(this.#bytes(), 0, PAGE, PAGE + this.#scratchTop);
    this.#scratchTop = 0;
    this.#scratchCount = 0;
    this.#scratch = new NativeWeakMap();
    this.#turn = null;
  }

  #alloc(turn, length, scratch) {
    this.#requireTurn(turn);
    if (!safeInteger(length) || length <= 0 || length > PAGE) {
      throw new RangeError("invalid arena allocation length");
    }
    if ((scratch ? this.#scratchCount : this.#persistentCount) >= MAX_HANDLES) {
      throw new RangeError("actor arena handle quota exhausted");
    }
    let offset;
    if (scratch) {
      if (length > PAGE - this.#scratchTop) throw new RangeError("actor arena quota exhausted");
      offset = PAGE + this.#scratchTop;
      this.#scratchTop += length;
      ++this.#scratchCount;
    } else {
      // First-fit over bounded free segments. Removed persistent handles cannot
      // regain authority, even when their bytes are reused at the same offset.
      const index = arrayFindIndex.call(this.#freePersistent, segment => segment.length >= length);
      if (index !== -1) {
        const segment = this.#freePersistent[index];
        offset = segment.offset;
        segment.offset += length;
        segment.length -= length;
        if (segment.length === 0) arraySplice.call(this.#freePersistent, index, 1);
      } else {
        if (length > PAGE - this.#persistentTop) throw new RangeError("actor arena quota exhausted");
        offset = this.#persistentTop;
        this.#persistentTop += length;
      }
      ++this.#persistentCount;
    }
    const handle = nativeFreeze({});
    const slot = {offset, length};
    weakMapSet.call(scratch ? this.#scratch : this.#handles, handle, slot);
    typedArrayFill.call(this.#bytes(), 0, offset, offset + length);
    return handle;
  }

  allocPersistent(turn, length) { return this.#alloc(turn, length, false); }
  allocScratch(turn, length) { return this.#alloc(turn, length, true); }

  dropPersistent(turn, handle) {
    this.#requireTurn(turn);
    const entry = weakMapGet.call(this.#handles, handle);
    if (!entry) throw new Error("foreign, stale or scratch arena handle");
    typedArrayFill.call(this.#bytes(), 0, entry.offset, entry.offset + entry.length);
    weakMapDelete.call(this.#handles, handle);
    --this.#persistentCount;
    arrayPush.call(this.#freePersistent, {...entry});
    arraySort.call(this.#freePersistent, (a, b) => a.offset - b.offset);
    const coalesced = [];
    for (const segment of this.#freePersistent) {
      const prior = coalesced[coalesced.length - 1];
      if (prior && prior.offset + prior.length === segment.offset) prior.length += segment.length;
      else arrayPush.call(coalesced, segment);
    }
    this.#freePersistent = coalesced;
  }

  #slot(turn, handle) {
    this.#requireTurn(turn);
    const entry = weakMapGet.call(this.#handles, handle) ?? weakMapGet.call(this.#scratch, handle);
    if (!entry) throw new Error("foreign or stale arena handle");
    return entry;
  }

  read(turn, handle) {
    const {offset, length} = this.#slot(turn, handle);
    const source = this.#bytes();
    const copy = new NativeUint8Array(length);
    // TypedArray.prototype.subarray/slice invoke Symbol.species. A poisoned
    // constructor can receive the private backing buffer as an argument.
    // Indexed byte reads never invoke a constructor, getter or species hook.
    for (let i = 0; i < length; ++i) copy[i] = source[offset + i];
    return copy; // true owned copy, no private backing reference escapes
  }

  write(turn, handle, data) {
    const {offset, length} = this.#slot(turn, handle);
    if (!(data instanceof NativeUint8Array) || typedArrayByteLength.call(data) !== length) {
      throw new TypeError("arena write requires exact-size Uint8Array");
    }
    // SharedArrayBuffer allows another Worker to mutate the source mid-copy,
    // tearing the actor's snapshot. Require owned, non-shared input bytes.
    if (isSharedBacking(typedArrayBuffer.call(data))) {
      throw new TypeError("arena write rejects shared backing memory");
    }
    // Never return live memory views; callers cannot retain a raw alias.
    typedArraySet.call(this.#bytes(), data, offset);
  }

  retire() {
    if (this.#closed) return;
    if (this.#turn !== null) throw new Error("active actor turn blocks retirement");
    typedArrayFill.call(this.#bytes(), 0);
    this.#closed = true;
    this.#memory = null; // physical release is JS runtime-dependent
    this.#handles = new NativeWeakMap();
    this.#scratch = new NativeWeakMap();
    this.#persistentCount = this.#scratchCount = 0;
    this.#freePersistent = [];
  }
}
