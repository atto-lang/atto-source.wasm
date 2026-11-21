// Host-only experimental actor-owned region. NOT attached to a guest module.
// Every SHARED actor retains a private arena; ActorRef never grants heap access.
// Guest source arena lowering and shared-domain regions are separate gates.
const PAGE = 65536;
const MAX_HANDLES = 4096;
const kinds = new Set(["shared", "private", "untrusted"]);
// Use the intrinsic brand check, not instanceof: a cross-realm SAB can back
// a local Uint8Array while failing instanceof SharedArrayBuffer.
// Own properties on a Uint8Array can shadow .buffer and .byteLength. Read
// the real typed-array internal slots instead of trusting spoofable properties.
// Capture trusted intrinsics at module initialization. Guest/host libraries
// may later mutate prototype methods; never call a replaceable method on a
// live view of actor-owned WebAssembly.Memory.
const NativeUint8Array = Uint8Array;
const nativeFreeze = Object.freeze;
const nativeIsSafeInteger = Number.isSafeInteger;
const nativeSetHas = Set.prototype.has;
const NativeTypeError = TypeError;
const nativeArrayFindIndex = Array.prototype.findIndex;
const nativeArrayPush = Array.prototype.push;
const nativeArraySplice = Array.prototype.splice;
const nativeArraySort = Array.prototype.sort;
const NativeWasmMemory = WebAssembly.Memory;
const NativeWeakMap = WeakMap;
const nativeWeakGet = WeakMap.prototype.get;
const nativeWeakSet = WeakMap.prototype.set;
const nativeWeakDelete = WeakMap.prototype.delete;
const nativeUint8Set = Uint8Array.prototype.set;
const nativeUint8Fill = Uint8Array.prototype.fill;
const nativeMemoryBuffer = Object.getOwnPropertyDescriptor(
  WebAssembly.Memory.prototype, "buffer").get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer").get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength").get;
const typedArrayTag = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, Symbol.toStringTag).get;
// A genuine non-shared ArrayBuffer passes this native internal-slot check
// across realms. SharedArrayBuffer, including cross-realm SAB, never does.
// Checking the *absence* of a native ArrayBuffer slot is safer than relying
// on globalThis.SharedArrayBuffer being defined when this module is imported:
// a hostile host/guest realm can mask that constructor before module init.
const nativeArrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype, "byteLength").get;
function isSharedBacking(buffer) {
  try {
    nativeArrayBufferByteLength.call(buffer);
    return false;
  } catch (error) {
    if (error instanceof NativeTypeError) return true;
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
    if (!nativeIsSafeInteger(actorId) || actorId <= 0 ||
        !nativeIsSafeInteger(incarnation) || incarnation <= 0 ||
        !nativeSetHas.call(kinds, kind)) throw new TypeError("invalid actor arena owner");
    this.#actor = actorId;
    this.#incarnation = incarnation;
    // Fixed, bounded linear memory; one 64-KiB persistent and one scratch page.
    // Never exported to guest code. JS GC still controls physical release.
    this.#memory = new NativeWasmMemory({initial: 2, maximum: 2});
  }

  get actorId() { return this.#actor; }
  get incarnation() { return this.#incarnation; }
  get retired() { return this.#closed; }

  #bytes() {
    if (this.#closed) throw new Error("actor arena retired");
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
    nativeUint8Fill.call(this.#bytes(), 0, PAGE, PAGE + this.#scratchTop);
    this.#scratchTop = 0;
    this.#scratchCount = 0;
    this.#scratch = new NativeWeakMap();
    this.#turn = null;
  }

  #alloc(turn, length, scratch) {
    this.#requireTurn(turn);
    if (!nativeIsSafeInteger(length) || length <= 0 || length > PAGE) {
      throw new RangeError("invalid arena allocation length");
    }
    if ((scratch ? this.#scratchCount : this.#persistentCount) >= MAX_HANDLES) {
      throw new RangeError("actor arena handle quota exhausted");
    }
    let offset;
    let freeIndex = -1;
    if (scratch) {
      if (length > PAGE - this.#scratchTop)
        throw new RangeError("actor arena quota exhausted");
      offset = PAGE + this.#scratchTop;
    } else {
      // PLAN an allocation without claiming bytes or consuming the
      // free-list entry. A failed host handle allocation must leave all
      // arena capacity reachable to a later authorized actor turn.
      freeIndex = nativeArrayFindIndex.call(
        this.#freePersistent, segment => segment.length >= length);
      if (freeIndex !== -1) {
        offset = this.#freePersistent[freeIndex].offset;
      } else {
        if (length > PAGE - this.#persistentTop)
          throw new RangeError("actor arena quota exhausted");
        offset = this.#persistentTop;
      }
    }

    // No quota or free-list mutation before construction/registration of
    // the opaque token. These steps may allocate and raise an exception.
    const handle = nativeFreeze({});
    const slot = {offset, length};
    const bytes = this.#bytes();
    nativeUint8Fill.call(bytes, 0, offset, offset + length);
    nativeWeakSet.call(scratch ? this.#scratch : this.#handles, handle, slot);

    // COMMIT: only trusted native operations remain after publication;
    // neither token metadata nor host-global prototype hooks are consulted.
    if (scratch) {
      this.#scratchTop += length;
      ++this.#scratchCount;
    } else {
      if (freeIndex !== -1) {
        const segment = this.#freePersistent[freeIndex];
        segment.offset += length;
        segment.length -= length;
        if (segment.length === 0)
          nativeArraySplice.call(this.#freePersistent, freeIndex, 1);
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
    nativeUint8Fill.call(this.#bytes(), 0, entry.offset, entry.offset + entry.length);
    nativeWeakDelete.call(this.#handles, handle);
    --this.#persistentCount;
    nativeArrayPush.call(this.#freePersistent, {...entry});
    nativeArraySort.call(this.#freePersistent, (a, b) => a.offset - b.offset);
    const coalesced = [];
    // Never use Array.prototype[Symbol.iterator] on security-critical free
    // segments. Untrusted guest JavaScript can replace that iterator and
    // inject a forged offset overlapping live actor-owned memory.
    for (let index = 0; index < this.#freePersistent.length; ++index) {
      const segment = this.#freePersistent[index];
      const prior = coalesced[coalesced.length - 1];
      if (prior && prior.offset + prior.length === segment.offset) prior.length += segment.length;
      else nativeArrayPush.call(coalesced, segment);
    }
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
    // Explicit intrinsic copy avoids mutable .slice and species hooks that
    // could otherwise leak a live view of private Wasm linear memory.
    const copy = new NativeUint8Array(length);
    const window = new NativeUint8Array(nativeMemoryBuffer.call(this.#memory),
      offset, length);
    nativeUint8Set.call(copy, window);
    return copy;
  }

  write(turn, handle, data) {
    const {offset, length} = this.#slot(turn, handle);
    // Trust the native typed-array internal slot, not mutable global
    // Uint8Array / instanceof / Symbol.hasInstance. Cross-realm Uint8Array
    // inputs remain valid; Int8Array, spoofed objects and detached views
    // never gain write authority through a forged constructor identity.
    let validBytes = false;
    try {
      validBytes = typedArrayTag.call(data) === "Uint8Array" &&
        typedArrayByteLength.call(data) === length;
    } catch (error) {
      if (!(error instanceof NativeTypeError)) throw error;
    }
    if (!validBytes) {
      throw new TypeError("arena write requires exact-size Uint8Array");
    }
    // SharedArrayBuffer allows another Worker to mutate the source mid-copy,
    // tearing the actor's snapshot. Require owned, non-shared input bytes.
    if (isSharedBacking(typedArrayBuffer.call(data))) {
      throw new TypeError("arena write rejects shared backing memory");
    }
    // Never return live memory views; callers cannot retain a raw alias.
    nativeUint8Set.call(this.#bytes(), data, offset);
  }

  retire() {
    if (this.#closed) return;
    if (this.#turn !== null) throw new Error("active actor turn blocks retirement");
    nativeUint8Fill.call(this.#bytes(), 0);
    this.#closed = true;
    this.#memory = null; // physical release is JS runtime-dependent
    this.#handles = new NativeWeakMap();
    this.#scratch = new NativeWeakMap();
    this.#persistentCount = this.#scratchCount = 0;
    this.#freePersistent = [];
  }
}
