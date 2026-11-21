// Host-only experimental actor-owned region. NOT attached to a guest module.
// Every SHARED actor retains a private arena; ActorRef never grants heap access.
// Guest source arena lowering and shared-domain regions are separate gates.
const PAGE = 65536;
const MAX_HANDLES = 4096;
const kinds = new Set(["shared", "private", "untrusted"]);
const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const nativeBuffer = Object.getOwnPropertyDescriptor(typedArrayProto, "buffer").get;
const nativeByteLength = Object.getOwnPropertyDescriptor(typedArrayProto, "byteLength").get;
// Capture byte operations before untrusted or plugin code can mutate globals.
// A no-op monkeypatch of .fill must never bypass actor-memory zeroization.
// Capture the constructor itself, not only the Memory.prototype.buffer
// getter. A late host/plugin monkeypatch of the global WebAssembly.Memory
// must not substitute a fake backing store for a new actor arena.
const trustedWasmMemory = WebAssembly.Memory;
const trustedBytes = Uint8Array;
const trustedApply = Reflect.apply;
const trustedFill = Uint8Array.prototype.fill;
const trustedSlice = Uint8Array.prototype.slice;
const trustedSet = Uint8Array.prototype.set;
// Browser/Web Worker compatible, intrinsic brand checks. Do not import
// node:util: production actor arenas must load in browsers as native ESM.
// The %TypedArray%.prototype Symbol.toStringTag getter reads the actual
// Uint8Array internal slot, ignoring user-provided toStringTag properties,
// fake prototypes, proxies, and cross-realm constructor identity.
const nativeTypedArrayTag = Object.getOwnPropertyDescriptor(
  typedArrayProto, Symbol.toStringTag).get;
// ArrayBuffer.prototype.byteLength rejects SharedArrayBuffer via internal
// slots (also cross-realm). Any non-ArrayBuffer/detached backing fails closed.
const nativeArrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype, "byteLength").get;
const trustedIsUint8Array = value => {
  try { return trustedApply(nativeTypedArrayTag, value, []) === "Uint8Array"; }
  catch { return false; }
};
const trustedIsSharedArrayBuffer = value => {
  try {
    trustedApply(nativeArrayBufferByteLength, value, []);
    return false;
  } catch { return true; }
};
const trustedIsSafeInteger = Number.isSafeInteger;
const trustedObjectIs = Object.is;
const trustedBigInt = BigInt;
const trustedNumber = Number;
const nativeKindsHas = Set.prototype.has;
// Capture native collection operations before late plugin prototype changes.
// Arena identity, handle lookup, free-list recycling and lease retirement
// must not be redirected by an untrusted library monkeypatch.
const trustedWeakMap = WeakMap;
const nativeWeakSet = trustedWeakMap.prototype.set;
const nativeWeakGet = trustedWeakMap.prototype.get;
const nativeWeakHas = trustedWeakMap.prototype.has;
const nativeWeakDelete = trustedWeakMap.prototype.delete;
const nativeListPush = Array.prototype.push;
const nativeListFindIndex = Array.prototype.findIndex;
const nativeListSplice = Array.prototype.splice;
const nativeListSort = Array.prototype.sort;
const weakSet = (map, key, value) => trustedApply(nativeWeakSet, map, [key, value]);
const weakGet = (map, key) => trustedApply(nativeWeakGet, map, [key]);
const weakHas = (map, key) => trustedApply(nativeWeakHas, map, [key]);
const weakDelete = (map, key) => trustedApply(nativeWeakDelete, map, [key]);
const listPush = (list, value) => trustedApply(nativeListPush, list, [value]);
const listFindIndex = (list, predicate) => trustedApply(nativeListFindIndex, list, [predicate]);
const listSplice = (list, index, count) => trustedApply(nativeListSplice, list, [index, count]);
const listSort = (list, comparison) => trustedApply(nativeListSort, list, [comparison]);
const trustedMemoryBuffer = Object.getOwnPropertyDescriptor(
  trustedWasmMemory.prototype, "buffer").get;
const ownedBytes = memory => new trustedBytes(trustedApply(trustedMemoryBuffer, memory, []));
const scrub = (bytes, start = 0, end = trustedApply(nativeByteLength, bytes, [])) =>
  trustedApply(trustedFill, bytes, [0, start, end]);

// Host-only Option shape; not a guest Option<T> object or a borrowed view.
const NO_RANGE = Object.freeze({kind: "None"});
function strictIndex(value, label) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && trustedIsSafeInteger(value) &&
      !trustedObjectIs(value, -0)) return trustedBigInt(value);
  throw new TypeError(label + " requires an exact integer");
}

export class ActorArena {
  #memory;
  #actor;
  #incarnation;
  #turn = null;
  #handles = new trustedWeakMap();
  #scratch = new trustedWeakMap();
  // Issued lifetime-only leases keep the backing memory reachable until the
  // last async/FFI/IO owner acknowledges retirement. They grant no byte access.
  #lifetimePins = new trustedWeakMap();
  #pendingLifetimePins = 0;
  #persistentTop = 0;
  #scratchTop = 0;
  #persistentCount = 0;
  #scratchCount = 0;
  #freePersistent = [];
  #closed = false;

  constructor({actorId, incarnation, kind = "shared"} = {}) {
    if (!trustedIsSafeInteger(actorId) || actorId <= 0 ||
        !trustedIsSafeInteger(incarnation) || incarnation <= 0 ||
        !trustedApply(nativeKindsHas, kinds, [kind])) throw new TypeError("invalid actor arena owner");
    this.#actor = actorId;
    this.#incarnation = incarnation;
    // Fixed, bounded linear memory; one 64-KiB persistent and one scratch page.
    // Never exported to guest code. JS GC still controls physical release.
    this.#memory = new trustedWasmMemory({initial: 2, maximum: 2});
  }

  get actorId() { return this.#actor; }
  get incarnation() { return this.#incarnation; }
  get retired() { return this.#closed; }
  get pendingLifetimePins() { return this.#pendingLifetimePins; }

  #bytes() {
    if (this.#closed) throw new Error("actor arena retired");
    return ownedBytes(this.#memory);
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
    scrub(this.#bytes(), PAGE, PAGE + this.#scratchTop);
    this.#scratchTop = 0;
    this.#scratchCount = 0;
    this.#scratch = new trustedWeakMap();
    this.#turn = null;
  }

  // Acquire during an admitted physical turn, before publishing external work.
  // Callback completions may release the lease off-turn, including after STOP.
  pinLifetime(turn) {
    this.#requireTurn(turn);
    if (this.#pendingLifetimePins >= MAX_HANDLES) {
      throw new RangeError("actor arena lifetime pin quota exhausted");
    }
    const pin = Object.freeze({});
    weakSet(this.#lifetimePins, pin, true);
    ++this.#pendingLifetimePins;
    return pin;
  }

  releaseLifetimePin(pin) {
    if (!weakHas(this.#lifetimePins, pin)) {
      throw new Error("foreign or unissued actor arena lifetime pin");
    }
    if (!weakGet(this.#lifetimePins, pin)) return; // idempotent release
    weakSet(this.#lifetimePins, pin, false);
    --this.#pendingLifetimePins;
    if (this.#closed && this.#pendingLifetimePins === 0) {
      this.#finishRetirement();
    }
  }

  #finishRetirement() {
    if (this.#memory === null) return;
    // This zeroes guest-visible bytes and severs the host reference. The JS
    // engine, not Oreslang, decides when physical backing pages are reclaimed.
    scrub(ownedBytes(this.#memory));
    this.#memory = null;
  }

  #alloc(turn, length, scratch) {
    this.#requireTurn(turn);
    if (!trustedIsSafeInteger(length) || length <= 0 || length > PAGE) {
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
      const index = listFindIndex(this.#freePersistent, segment => segment.length >= length);
      if (index !== -1) {
        const segment = this.#freePersistent[index];
        offset = segment.offset;
        segment.offset += length;
        segment.length -= length;
        if (segment.length === 0) listSplice(this.#freePersistent, index, 1);
      } else {
        if (length > PAGE - this.#persistentTop) throw new RangeError("actor arena quota exhausted");
        offset = this.#persistentTop;
        this.#persistentTop += length;
      }
      ++this.#persistentCount;
    }
    const handle = Object.freeze({});
    const slot = {offset, length};
    weakSet(scratch ? this.#scratch : this.#handles, handle, slot);
    scrub(this.#bytes(), offset, offset + length);
    return handle;
  }

  allocPersistent(turn, length) { return this.#alloc(turn, length, false); }
  allocScratch(turn, length) { return this.#alloc(turn, length, true); }

  dropPersistent(turn, handle) {
    this.#requireTurn(turn);
    const entry = weakGet(this.#handles, handle);
    if (!entry) throw new Error("foreign, stale or scratch arena handle");
    scrub(this.#bytes(), entry.offset, entry.offset + entry.length);
    weakDelete(this.#handles, handle);
    --this.#persistentCount;
    listPush(this.#freePersistent, {...entry});
    listSort(this.#freePersistent, (a, b) => a.offset - b.offset);
    const coalesced = [];
    // Do not invoke mutable Array.prototype[Symbol.iterator] on arena metadata.
    for (let i = 0; i < this.#freePersistent.length; ++i) {
      const segment = this.#freePersistent[i];
      const prior = coalesced[coalesced.length - 1];
      if (prior && prior.offset + prior.length === segment.offset) prior.length += segment.length;
      else listPush(coalesced, segment);
    }
    this.#freePersistent = coalesced;
  }

  #slot(turn, handle) {
    this.#requireTurn(turn);
    const entry = weakGet(this.#handles, handle) ?? weakGet(this.#scratch, handle);
    if (!entry) throw new Error("foreign or stale arena handle");
    return entry;
  }

  read(turn, handle) {
    const {offset, length} = this.#slot(turn, handle);
    return trustedApply(trustedSlice, this.#bytes(), [offset, offset + length]); // owned copy
  }

  // Recoverable bounds check for an actor-owned byte span. The exact physical
  // turn and unforgeable allocation handle are checked EVEN on a missing
  // index. A hit returns an owned copy, never a retained alias into Wasm.
  tryReadBytes(turn, handle, start, count) {
    const {offset, length} = this.#slot(turn, handle);
    const i = strictIndex(start, "slice start");
    const n = strictIndex(count, "slice length");
    if (i < 0n || n < 0n || i > trustedBigInt(length) ||
        n > trustedBigInt(length) - i) return NO_RANGE;
    const lower = offset + trustedNumber(i);
    const upper = lower + trustedNumber(n);
    const value = trustedApply(trustedSlice, this.#bytes(), [lower, upper]);
    return Object.freeze({kind: "Some", value});
  }

  write(turn, handle, data) {
    const {offset, length} = this.#slot(turn, handle);
    // Native internal slots prevent instance property overrides from changing
    // the exact-size and shared-memory admission checks.
    if (!trustedIsUint8Array(data) || trustedApply(nativeByteLength, data, []) !== length) {
      throw new TypeError("arena write requires exact-size Uint8Array");
    }
    if (trustedIsSharedArrayBuffer(trustedApply(nativeBuffer, data, []))) {
      throw new TypeError("arena write rejects shared backing memory");
    }
    // Never return live memory views; callers cannot retain a raw alias.
    trustedApply(trustedSet, this.#bytes(), [data, offset]);
  }

  retire() {
    // A previously failed scrub may be retried, but authority never reopens.
    if (this.#closed) {
      if (this.#pendingLifetimePins === 0) this.#finishRetirement();
      return;
    }
    if (this.#turn !== null) throw new Error("active actor turn blocks retirement");
    // Logical retirement fences all future guest operations before waiting
    // for external owners. Physical guest-byte scrubbing follows the last pin.
    this.#closed = true;
    this.#handles = new trustedWeakMap();
    this.#scratch = new trustedWeakMap();
    this.#persistentCount = this.#scratchCount = 0;
    this.#freePersistent = [];
    if (this.#pendingLifetimePins === 0) this.#finishRetirement();
  }
}
