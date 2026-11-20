import {types} from "node:util";

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
const trustedBytes = Uint8Array;
const trustedApply = Reflect.apply;
const trustedFill = Uint8Array.prototype.fill;
const trustedSlice = Uint8Array.prototype.slice;
const trustedSet = Uint8Array.prototype.set;
const trustedIsUint8Array = types.isUint8Array;
const trustedIsSharedArrayBuffer = types.isSharedArrayBuffer;
const trustedMemoryBuffer = Object.getOwnPropertyDescriptor(
  WebAssembly.Memory.prototype, "buffer").get;
const ownedBytes = memory => new trustedBytes(trustedApply(trustedMemoryBuffer, memory, []));
const scrub = (bytes, start = 0, end = trustedApply(nativeByteLength, bytes, [])) =>
  trustedApply(trustedFill, bytes, [0, start, end]);

export class ActorArena {
  #memory;
  #actor;
  #incarnation;
  #turn = null;
  #handles = new WeakMap();
  #scratch = new WeakMap();
  // Issued lifetime-only leases keep the backing memory reachable until the
  // last async/FFI/IO owner acknowledges retirement. They grant no byte access.
  #lifetimePins = new WeakMap();
  #pendingLifetimePins = 0;
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
    this.#scratch = new WeakMap();
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
    this.#lifetimePins.set(pin, true);
    ++this.#pendingLifetimePins;
    return pin;
  }

  releaseLifetimePin(pin) {
    if (!this.#lifetimePins.has(pin)) {
      throw new Error("foreign or unissued actor arena lifetime pin");
    }
    if (!this.#lifetimePins.get(pin)) return; // idempotent release
    this.#lifetimePins.set(pin, false);
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
    if (!Number.isSafeInteger(length) || length <= 0 || length > PAGE) {
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
      const index = this.#freePersistent.findIndex(segment => segment.length >= length);
      if (index !== -1) {
        const segment = this.#freePersistent[index];
        offset = segment.offset;
        segment.offset += length;
        segment.length -= length;
        if (segment.length === 0) this.#freePersistent.splice(index, 1);
      } else {
        if (length > PAGE - this.#persistentTop) throw new RangeError("actor arena quota exhausted");
        offset = this.#persistentTop;
        this.#persistentTop += length;
      }
      ++this.#persistentCount;
    }
    const handle = Object.freeze({});
    const slot = {offset, length};
    (scratch ? this.#scratch : this.#handles).set(handle, slot);
    scrub(this.#bytes(), offset, offset + length);
    return handle;
  }

  allocPersistent(turn, length) { return this.#alloc(turn, length, false); }
  allocScratch(turn, length) { return this.#alloc(turn, length, true); }

  dropPersistent(turn, handle) {
    this.#requireTurn(turn);
    const entry = this.#handles.get(handle);
    if (!entry) throw new Error("foreign, stale or scratch arena handle");
    scrub(this.#bytes(), entry.offset, entry.offset + entry.length);
    this.#handles.delete(handle);
    --this.#persistentCount;
    this.#freePersistent.push({...entry});
    this.#freePersistent.sort((a, b) => a.offset - b.offset);
    const coalesced = [];
    for (const segment of this.#freePersistent) {
      const prior = coalesced[coalesced.length - 1];
      if (prior && prior.offset + prior.length === segment.offset) prior.length += segment.length;
      else coalesced.push(segment);
    }
    this.#freePersistent = coalesced;
  }

  #slot(turn, handle) {
    this.#requireTurn(turn);
    const entry = this.#handles.get(handle) ?? this.#scratch.get(handle);
    if (!entry) throw new Error("foreign or stale arena handle");
    return entry;
  }

  read(turn, handle) {
    const {offset, length} = this.#slot(turn, handle);
    return trustedApply(trustedSlice, this.#bytes(), [offset, offset + length]); // owned copy
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

  // Host-only primitive for prospective std.buffer OwnedBytes lowering.
  // Calls are scoped to the current actor turn and issued private handles.
  // No byte view or host pointer escapes; this is NOT .atto guest compilation.
  readUnsigned(turn, handle, relativeOffset, width, endian) {
    const slot = this.#slot(turn, handle);
    if (width !== 1 && width !== 2 && width !== 4)
      throw new RangeError("invalid unsigned byte width");
    if (endian !== "le" && endian !== "be")
      throw new TypeError("explicit byte order required");
    if (!Number.isSafeInteger(relativeOffset) || relativeOffset < 0 ||
        width > slot.length || relativeOffset > slot.length - width)
      throw new RangeError("byte range out of bounds");
    const bytes = this.#bytes();
    let result = 0;
    for (let i = 0; i < width; i++) {
      const shift = 8 * (endian === "le" ? i : width - 1 - i);
      result += bytes[slot.offset + relativeOffset + i] * 2 ** shift;
    }
    return result; // always integer <= 4294967295; no JS signed32 coercion
  }

  writeUnsigned(turn, handle, relativeOffset, width, value, endian) {
    const slot = this.#slot(turn, handle);
    if (width !== 1 && width !== 2 && width !== 4)
      throw new RangeError("invalid unsigned byte width");
    if (endian !== "le" && endian !== "be")
      throw new TypeError("explicit byte order required");
    if (!Number.isSafeInteger(relativeOffset) || relativeOffset < 0 ||
        width > slot.length || relativeOffset > slot.length - width)
      throw new RangeError("byte range out of bounds");
    const max = 2 ** (8 * width) - 1;
    if (!Number.isSafeInteger(value) || value < 0 || value > max)
      throw new RangeError("unsigned byte value out of range");
    // All validation is before the first byte store. No borrowing, I/O, or
    // suspension; this owns the physical WebAssembly.Memory region.
    const bytes = this.#bytes();
    for (let i = 0; i < width; i++) {
      const shift = 8 * (endian === "le" ? i : width - 1 - i);
      bytes[slot.offset + relativeOffset + i] =
        Math.floor(value / (2 ** shift)) % 256;
    }
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
    this.#handles = new WeakMap();
    this.#scratch = new WeakMap();
    this.#persistentCount = this.#scratchCount = 0;
    this.#freePersistent = [];
    if (this.#pendingLifetimePins === 0) this.#finishRetirement();
  }
}
