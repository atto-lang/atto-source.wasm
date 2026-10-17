// Host-only experimental actor-owned region. NOT attached to a guest module.
// Every SHARED actor retains a private arena; ActorRef never grants heap access.
// Guest source arena lowering and shared-domain regions are separate gates.
const PAGE = 65536;
const ARENA_PAGES = 2;
const MAX_POOL_PAGES = 4096; // 256 MiB retained capacity, recycled explicitly.
const MAX_HANDLES = 4096;
const MAX_EXTERNAL_LEASES = 4096;
const kinds = new Set(["shared", "private", "untrusted"]);
// Identity/admission checks must not trust mutable standard-library hooks.
const safeInteger = Number.isSafeInteger;
const nativeFreeze = Object.freeze;
const reflectApply = Reflect.apply;
const setHas = Set.prototype.has;
// Use the intrinsic brand check, not instanceof: a cross-realm SAB can back
// a local Uint8Array while failing instanceof SharedArrayBuffer.
// Own properties on a Uint8Array can shadow .buffer and .byteLength. Read
// the real typed-array internal slots instead of trusting spoofable properties.
// Bind allocator/copy/zero primitives before user code can monkeypatch them.
// Never dispatch a mutable Uint8Array prototype method on private region bytes.
const NativeUint8Array = Uint8Array;
const NativeUint32Array = Uint32Array;
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
const memoryGrow = NativeMemory.prototype.grow;
const arrayBufferByteLength =
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
const typedArrayPrototype = Object.getPrototypeOf(NativeUint8Array.prototype);
const typedArraySet = typedArrayPrototype.set;
const typedArrayFill = typedArrayPrototype.fill;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer").get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength").get;
// instanceof Uint8Array trusts mutable Symbol.hasInstance. An attacker could
// admit an Int16Array of matching byteLength, then TypedArray#set would
// coerce/copy elements rather than exact bytes into actor-private storage.
const typedArrayTag = Object.getOwnPropertyDescriptor(
  typedArrayPrototype, Symbol.toStringTag).get;
const sharedByteLength = typeof SharedArrayBuffer === "function"
  ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength").get
  : null;

/*
 * Runtime-owned backing pool.
 *
 * WebAssembly.Memory cannot shrink, so dropping a per-actor Memory object makes
 * physical reclamation depend on the JavaScript host GC. Instead, actors lease
 * two pages from one bounded runtime Memory. Retirement zeroes and returns the
 * pages immediately for deterministic reuse. Committed pages may stay mapped
 * by the Wasm engine, but no actor capacity depends on GC to become reusable.
 */
const poolMemory = new NativeMemory({initial: 0, maximum: MAX_POOL_PAGES});
// Fixed-capacity free stack: page reuse itself must not depend on growing a
// JavaScript Array or triggering host GC. Byte offsets fit in uint32 because
// MAX_POOL_PAGES * PAGE is 256 MiB.
const freeArenaBases = new NativeUint32Array(MAX_POOL_PAGES / ARENA_PAGES);
let freeArenaCount = 0;
let leasedArenas = 0;

function poolBytes() {
  return new NativeUint8Array(memoryBuffer.call(poolMemory));
}

function leaseArenaBase() {
  let base;
  let reused = false;
  if (freeArenaCount !== 0) {
    base = freeArenaBases[--freeArenaCount];
    freeArenaBases[freeArenaCount] = 0;
    reused = true;
  } else {
    let oldPages;
    try {
      oldPages = memoryGrow.call(poolMemory, ARENA_PAGES);
    } catch (error) {
      throw new RangeError("actor arena runtime pool exhausted");
    }
    base = oldPages * PAGE;
  }
  try {
    // Belt-and-suspenders zero on admission as well as retirement.
    typedArrayFill.call(poolBytes(), 0, base, base + ARENA_PAGES * PAGE);
  } catch (error) {
    // A failed admission must not strand reusable capacity. Newly grown pages
    // are safe to publish too: no actor has observed them yet.
    if (freeArenaCount >= freeArenaBases.length) {
      throw new Error("actor arena pool free-stack overflow during lease rollback");
    }
    freeArenaBases[freeArenaCount++] = base;
    throw error;
  }
  ++leasedArenas;
  return base;
}

function releaseArenaBase(base) {
  if (!safeInteger(base) || base < 0 || base % (ARENA_PAGES * PAGE) !== 0) {
    throw new Error("actor arena pool lease invariant violated");
  }
  if (leasedArenas <= 0) throw new Error("actor arena pool accounting underflow");
  typedArrayFill.call(poolBytes(), 0, base, base + ARENA_PAGES * PAGE);
  if (freeArenaCount >= freeArenaBases.length) {
    throw new Error("actor arena pool free-stack overflow");
  }
  freeArenaBases[freeArenaCount++] = base;
  --leasedArenas;
}

/** Host diagnostic only; exposes counts, never a backing buffer or offset. */
export function actorArenaPoolStats() {
  return nativeFreeze({
    committedPages: arrayBufferByteLength.call(memoryBuffer.call(poolMemory)) / PAGE,
    leasedArenas,
    freeArenas: freeArenaCount
  });
}
function isSharedBacking(buffer) {
  if (sharedByteLength === null) return false;
  try {
    sharedByteLength.call(buffer); // Native internal-slot check, including cross-realm SAB.
    return true;
  } catch (error) {
    // SharedArrayBuffer.prototype.byteLength has exactly one expected failure
    // here: a non-SAB receiver. Do not consult mutable TypeError instanceof
    // hooks merely to classify ordinary ArrayBuffer input.
    return false;
  }
}

export class ActorArena {
  #base;
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
  #externalLeases = 0;
  #closed = false;

  constructor({actorId, incarnation, kind = "shared"} = {}) {
    if (!safeInteger(actorId) || actorId <= 0 ||
        !safeInteger(incarnation) || incarnation <= 0 ||
        !setHas.call(kinds, kind)) throw new TypeError("invalid actor arena owner");
    this.#actor = actorId;
    this.#incarnation = incarnation;
    // One persistent and one scratch page leased from the runtime-owned pool.
    // Retirement returns both pages synchronously; no JS GC is required for
    // arena capacity to become reusable by another actor.
    this.#base = leaseArenaBase();
  }

  get actorId() { return this.#actor; }
  get incarnation() { return this.#incarnation; }
  get retired() { return this.#closed; }
  get physicallyReclaimed() { return this.#base === null; }
  get outstandingExternalLeases() { return this.#externalLeases; }

  #bytes() {
    if (this.#closed || this.#base === null) throw new Error("actor arena retired");
    return poolBytes();
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
    typedArrayFill.call(
      this.#bytes(), 0,
      this.#base + PAGE,
      this.#base + PAGE + this.#scratchTop);
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
      offset = this.#base + PAGE + this.#scratchTop;
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
        offset = this.#base + this.#persistentTop;
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

  // Lifetime-only authority for a continuation/FFI/I/O callback. The lease
  // intentionally grants no memory access. It may outlive the actor turn and
  // pins the arena's fixed pool capacity until its idempotent close succeeds.
  acquireExternalLease(turn) {
    this.#requireTurn(turn);
    if (this.#externalLeases >= MAX_EXTERNAL_LEASES) {
      throw new RangeError("actor arena external lease quota exhausted");
    }
    ++this.#externalLeases;
    let live = true;
    const arena = this;
    return nativeFreeze({
      close() {
        if (!live) return;
        arena.#releaseExternalLease();
        live = false;
      }
    });
  }

  // Register an external continuation/FFI/I/O callback while the actor
  // turn is admitted. The returned object carries lifetime authority only.
  // JavaScript has no deterministic finalizer contract, so an abandoned
  // callback MUST be explicitly close()d; fire() closes in a finally block.
  trackExternalCallback(turn, callback) {
    if (typeof callback !== "function") {
      throw new TypeError("external callback must be callable");
    }
    const lease = this.acquireExternalLease(turn);
    let fired = false;
    let disabled = false;
    return nativeFreeze({
      fire(...args) {
        if (disabled || fired) {
          throw new Error("actor external completion already fired or closed");
        }
        fired = true;
        try {
          return reflectApply(callback, undefined, args);
        } finally {
          // Logical callback ownership is terminal even if physical reclaim
          // fails. close() remains callable to retry the lease release.
          disabled = true;
          lease.close();
        }
      },
      close() {
        // Cancellation/abandonment revokes callback execution immediately.
        // Always retry the underlying close: its own live bit is cleared only
        // after release/reclaim succeeds.
        disabled = true;
        lease.close();
      }
    });
  }

  #releaseExternalLease() {
    if (this.#externalLeases <= 0) {
      throw new Error("actor arena external lease accounting underflow");
    }
    --this.#externalLeases;
    try {
      if (this.#closed && this.#externalLeases === 0) this.#reclaim();
    } catch (error) {
      ++this.#externalLeases; // preserve retryable ownership on reclaim failure
      throw error;
    }
  }

  dropPersistent(turn, handle) {
    this.#requireTurn(turn);
    const entry = weakMapGet.call(this.#handles, handle);
    if (!entry) throw new Error("foreign, stale or scratch arena handle");
    // Build and coalesce replacement free-list metadata BEFORE consuming the
    // live handle. An allocation/sort failure must not retire a slot while
    // leaving its capacity permanently missing from the free list.
    const prepared = [];
    for (let i = 0; i < this.#freePersistent.length; ++i) {
      const segment = this.#freePersistent[i];
      arrayPush.call(prepared, {offset: segment.offset, length: segment.length});
    }
    arrayPush.call(prepared, {offset: entry.offset, length: entry.length});
    arraySort.call(prepared, (a, b) => a.offset - b.offset);
    const coalesced = [];
    // Use intrinsic array operations and never leak authority via iterators.
    for (let i = 0; i < prepared.length; ++i) {
      const segment = prepared[i];
      const prior = coalesced[coalesced.length - 1];
      if (prior && prior.offset + prior.length === segment.offset) prior.length += segment.length;
      else arrayPush.call(coalesced, segment);
    }
    typedArrayFill.call(this.#bytes(), 0, entry.offset, entry.offset + entry.length);
    weakMapDelete.call(this.#handles, handle);
    --this.#persistentCount;
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
    if (typedArrayTag.call(data) !== "Uint8Array" ||
        typedArrayByteLength.call(data) !== length) {
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

  #reclaim() {
    if (this.#base === null) return;
    const base = this.#base;
    // releaseArenaBase scrubs before publishing pages onto the fixed-capacity
    // free stack. On failure, retain the base for an exact retry.
    releaseArenaBase(base);
    this.#base = null;
    this.#persistentCount = this.#scratchCount = 0;
    this.#persistentTop = this.#scratchTop = 0;
    this.#freePersistent = [];
  }

  retire() {
    if (this.#turn !== null) throw new Error("active actor turn blocks retirement");
    if (!this.#closed) {
      // Logical retirement is monotonic and revokes every arena handle now,
      // even when an external continuation/FFI/I/O lifetime pin still exists.
      this.#closed = true;
      this.#handles = new NativeWeakMap();
      this.#scratch = new NativeWeakMap();
    }
    if (this.#externalLeases === 0) this.#reclaim();
  }
}
