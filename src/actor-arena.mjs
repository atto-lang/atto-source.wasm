import {compileActorMemoryGuest} from "./actor-guest-policy.mjs";
import {runIsolatedActorGuest} from "./isolated-actor-runner.mjs";
import {consumeTrustedActorGuestPermit} from "./actor-guest-authority.mjs";

// Actor-owned memory with a restricted synchronous Wasm guest bridge.
// Not yet a source-level Oreslang actor scheduler, await or FFI bridge.
// Every SHARED/PRIVATE/UNTRUSTED actor owns a distinct WebAssembly.Memory.
// Host-only memories are reused after retirement; guest-exposed instances
// are permanently quarantined, never assigned to successor actors.
// ActorRef grants no heap access. Guest source lowering remains separate.
const PAGE = 65536;
const ARENA_PAGES = 2;
const MAX_POOL_PAGES = 4096; // 256 MiB conservatively charged capacity.
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
const NativeWasmInstance = WebAssembly.Instance;
const wasmInstanceExports =
  Object.getOwnPropertyDescriptor(NativeWasmInstance.prototype, "exports").get;
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
 * Per-actor linear-memory pool. A leased actor has an entire, independently
 * addressable WebAssembly.Memory (2 pages: persistent and scratch).
 *
 * Earlier versions sliced a process-wide WebAssembly.Memory by base offsets.
 * Such slices are NOT a security boundary when raw Wasm memory instructions
 * can address the complete module memory. This implementation pools WHOLE
 * MEMORY INSTANCES rather than sharing a linear address space, except that
 * guest-exposed instances are quarantined forever because native guest
 * aliases cannot be forcibly revoked.
 *
 * No memory instance, ArrayBuffer, typed-array view or byte offset is returned
 * through the public ActorArena API. Trusted host code may reuse an instance
 * ONLY if it was never imported into a guest; actor turns and borrowed
 * continuations must have ended, and the bytes must be scrubbed.
 *
 * Fixed capacity avoids allocation on the free-stack path and does not depend
 * on JavaScript GC for capacity reuse. It DOES NOT guarantee OS page decommit
 * or make a Worker an OS sandbox.
 */
const MAX_ARENAS = MAX_POOL_PAGES / ARENA_PAGES;
const freeArenaMemories = new Array(MAX_ARENAS); // fixed-size private stack
let freeArenaCount = 0;
let leasedArenas = 0;
let allocatedArenas = 0;
// A guest-exposed Memory may be retained by native Wasm instances/views even
// after host detach; never give that physical instance to another actor.
// Quarantine consumes a permanent bounded instance slot until runtime restart.
let quarantinedArenas = 0;

function memoryBytes(memory) {
  // Captured intrinsic getter requires a genuine WebAssembly.Memory.
  return new NativeUint8Array(memoryBuffer.call(memory));
}

function leaseArenaMemory() {
  let memory;
  if (freeArenaCount > 0) {
    memory = freeArenaMemories[--freeArenaCount];
    freeArenaMemories[freeArenaCount] = undefined; // sever stale pool alias
    if (memory === undefined) throw new Error("actor memory pool corruption");
  } else {
    if (allocatedArenas >= MAX_ARENAS)
      throw new RangeError("actor arena runtime pool exhausted");
    // Fresh linear address space; no actor can address another instance.
    // Fixed maximum also forbids memory.grow on a leased actor.
    memory = new NativeMemory({initial: ARENA_PAGES, maximum: ARENA_PAGES});
    ++allocatedArenas;
  }
  try {
    typedArrayFill.call(memoryBytes(memory), 0, 0, ARENA_PAGES * PAGE);
  } catch (error) {
    // A failed scrub must not strand capacity. This is safe only because
    // memory has not been published to any new actor or guest.
    if (freeArenaCount >= MAX_ARENAS)
      throw new Error("actor memory pool rollback overflow");
    freeArenaMemories[freeArenaCount++] = memory;
    throw error;
  }
  ++leasedArenas;
  return memory;
}

function releaseArenaMemory(memory, guestExposed = false) {
  if (memory === null || memory === undefined)
    throw new Error("actor memory release requires an owned instance");
  if (leasedArenas <= 0)
    throw new Error("actor memory pool accounting underflow");
  if (!guestExposed && freeArenaCount >= MAX_ARENAS)
    throw new Error("actor memory pool free-stack overflow");
  // Zero physical state for defense-in-depth even when quarantining.
  // Guest-exposed linear memories are NEVER reassigned. Retaining old guest
  // instance references makes reusing them fundamentally unsafe in JS/Wasm.
  // Keep allocatedArenas charged against the hard 2048-instance budget:
  // returning a quarantined instance to available quota would silently rely
  // on non-deterministic GC reclaiming its native backing allocation.
  typedArrayFill.call(memoryBytes(memory), 0, 0, ARENA_PAGES * PAGE);
  if (guestExposed) ++quarantinedArenas;
  else freeArenaMemories[freeArenaCount++] = memory;
  --leasedArenas;
}

/** Host diagnostic only; exposes counters, never memory or backing views. */
export function actorArenaPoolStats() {
  // Every allocated memory slot must be in exactly one state. In particular,
  // quarantined memory remains charged even when its JS wrapper is collected.
  if (leasedArenas < 0 || freeArenaCount < 0 || quarantinedArenas < 0 ||
      allocatedArenas !== leasedArenas + freeArenaCount + quarantinedArenas)
    throw new Error("actor memory pool accounting invariant violated");
  return nativeFreeze({
    // Conservative charged capacity, not a physical-residency measurement.
    committedPages: allocatedArenas * ARENA_PAGES,
    leasedArenas,
    freeArenas: freeArenaCount,
    quarantinedArenas
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
  #memory;
  #actor;
  #incarnation;
  #kind;
  #turn = null;
  #handles = new NativeWeakMap();
  #scratch = new NativeWeakMap();
  // Distinct, opaque actor-lifetime pins are held by the trusted scheduler
  // for continuations/FFI operations that can outlive a mailbox turn.
  // A pin does NOT grant memory access and MUST be released only after its
  // associated operation has fully quiesced.
  #lifetimePins = new NativeWeakMap();
  #guestBindings = new NativeWeakMap();
  #guestExposed = false;
  #lifetimePinCount = 0;
  #retirementRequested = false;
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
    this.#kind = kind;
    // An actor leases a WHOLE, independent linear-memory instance.
    // Retirement recycles a scrubbed host-only instance; guest-bound memory
    // permanently consumes its bounded allocation slot instead.
    this.#memory = leaseArenaMemory();
  }

  get actorId() { return this.#actor; }
  get incarnation() { return this.#incarnation; }
  get retired() { return this.#closed; }
  get retirementRequested() { return this.#retirementRequested; }

  #bytes() {
    if (this.#closed || this.#memory === null) throw new Error("actor arena retired");
    return memoryBytes(this.#memory);
  }

  #requireTurn(token) {
    this.#bytes();
    if (token === null || token !== this.#turn) {
      throw new Error("actor turn authority required");
    }
  }

  beginTurn() {
    this.#bytes();
    if (this.#retirementRequested)
      throw new Error("actor retirement requested; no new turns");
    if (this.#turn !== null) throw new Error("actor already admitted");
    const turn = nativeFreeze({});
    this.#turn = turn;
    return turn;
  }

  endTurn(turn) {
    this.#requireTurn(turn);
    typedArrayFill.call(
      this.#bytes(), 0,
      PAGE,
      PAGE + this.#scratchTop);
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

  // These are *lifetime barriers*, never direct memory/guest capabilities.
  // The control plane must hold a pin for every external user of persistent
  // actor state and retain the pin until its task, callback, FFI or guest
  // instance has completely stopped. A pin survives mailbox turn changes.
  pinLifetime(turn) {
    this.#requireTurn(turn);
    if (this.#retirementRequested)
      throw new Error("actor retirement requested; no new lifetime pins");
    if (this.#lifetimePinCount >= MAX_HANDLES)
      throw new RangeError("actor lifetime pin quota exhausted");
    const pin = nativeFreeze({});
    weakMapSet.call(this.#lifetimePins, pin, true);
    ++this.#lifetimePinCount;
    return pin;
  }

  unpinLifetime(pin) {
    this.#bytes();
    if (!weakMapGet.call(this.#lifetimePins, pin))
      throw new Error("foreign, stale or already released actor lifetime pin");
    if (this.#lifetimePinCount <= 0)
      throw new Error("actor lifetime pin accounting underflow");
    weakMapDelete.call(this.#lifetimePins, pin);
    --this.#lifetimePinCount;
  }

  // Any actor kind may invoke the disposable worker ABI, but never shares
  // its live host-side arena WebAssembly.Memory with the worker. Copying a
  // persistent handle's bytes into worker-owned memory preserves isolation.
  // The pin remains held through timeout/cancellation until Worker "exit".
  async invokeIsolatedGuest(turn, guestBytes, exportName, persistentHandle, {
    expectedSha256, args = [0], timeoutMs = 2000, signal
  } = {}) {
    this.#requireTurn(turn);
    if (this.#retirementRequested)
      throw new Error("actor retirement requested; no new guest work");
    const initialData = persistentHandle === undefined
      ? new NativeUint8Array(0) : this.read(turn, persistentHandle);
    const pin = this.pinLifetime(turn);
    try {
      return await runIsolatedActorGuest(guestBytes, {
        actorId: this.#actor, incarnation: this.#incarnation,
        expectedSha256, exportName, args, timeoutMs, signal, initialData
      });
    } finally {
      // This finally runs only after a physical Worker exit receipt.
      // If termination cannot be proven, the runner intentionally does
      // not settle, so this lifetime pin cannot be released.
      this.unpinLifetime(pin);
    }
  }

  // A guest binding has no exported memory, host callbacks or references to
  // its WebAssembly.Instance available to the guest/caller. Each binding holds
  // an actor-lifetime pin until the trusted host explicitly detaches it.
  // This profile is synchronous only: it intentionally rejects async/await,
  // host function imports, tables and module-defined secondary memories.
  attachGuest(turn, guestBytes, executionPermit) {
    this.#requireTurn(turn);
    // This ABI executes synchronous Wasm in the host JS worker with no
    // instruction fuel or preemption. An untrusted infinite loop could stall
    // the entire carrier, so untrusted guests MUST use an isolated worker
    // with a forced-termination deadline instead of this direct binding.
    if (this.#kind === "untrusted")
      throw new Error("untrusted guest requires isolated worker execution");
    if (this.#retirementRequested)
      throw new Error("actor retirement requested; no new guest bindings");
    // Actor kind is an ownership/layout label, NEVER an execution-trust
    // grant. CONTROL must issue an opaque one-shot permit for this exact
    // arena instance and pinned artifact. Consume before parsing, so a
    // rejected artifact or repeated attachment cannot reuse authority.
    const expectedSha256 = consumeTrustedActorGuestPermit(this, executionPermit);
    const module = compileActorMemoryGuest(guestBytes, {expectedSha256});
    const pin = this.pinLifetime(turn);
    try {
      // Taint BEFORE instantiation. Even a failed/native-trapping instance
      // must never cause accidental reissue of its imported memory.
      this.#guestExposed = true;
      const instance = new NativeWasmInstance(module, {env: {memory: this.#memory}});
      const handle = nativeFreeze({});
      weakMapSet.call(this.#guestBindings, handle, {instance, pin});
      return handle;
    } catch (error) {
      this.unpinLifetime(pin);
      throw error;
    }
  }

  invokeGuest(turn, handle, exportName, ...args) {
    this.#requireTurn(turn);
    const guest = weakMapGet.call(this.#guestBindings, handle);
    if (!guest) throw new Error("foreign or detached actor guest binding");
    if (typeof exportName !== "string" ||
        !/^[A-Za-z_][A-Za-z_0-9]*$/.test(exportName)) {
      throw new TypeError("invalid actor guest function name");
    }
    // Do not dispatch mutable Array.prototype.some/iterator on authority
    // input; a poisoned same-realm helper could bypass guest admission.
    for (let i = 0; i < args.length; ++i) {
      const x = args[i];
      if (typeof x !== "bigint" &&
          (typeof x !== "number" || !Number.isFinite(x))) {
        throw new TypeError("actor guest arguments must be scalar numbers");
      }
    }
    // The native exports getter itself is mutable on Instance.prototype.
    // Capture it at module initialization rather than trusting a hook.
    const fn = wasmInstanceExports.call(guest.instance)[exportName];
    if (typeof fn !== "function")
      throw new Error("actor guest function is not exported");
    const result = fn(...args);
    if (result !== undefined && typeof result !== "number" &&
        typeof result !== "bigint") {
      throw new Error("actor guest may return only scalar numeric values");
    }
    return result;
  }

  // A detached binding is permanently stale. Removing it releases the
  // lifetime pin without admitting another turn, even during shutdown.
  // The narrow profile has no async or guest callbacks, so execute/detach
  // cannot overlap on a single JS worker. No instance/export is handed out.
  detachGuest(handle) {
    this.#bytes();
    const guest = weakMapGet.call(this.#guestBindings, handle);
    if (!guest) throw new Error("foreign or already detached actor guest binding");
    this.unpinLifetime(guest.pin);
    weakMapDelete.call(this.#guestBindings, handle);
  }

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
    // Do not use Array iteration protocols here: Array.prototype[Symbol.iterator]
    // is mutable userland code and must never observe private free-list metadata.
    for (let i = 0; i < this.#freePersistent.length; ++i) {
      const segment = this.#freePersistent[i];
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

  // CONTROL may close admission while the last turn is still running.
  // Its completion and outstanding lifetime releases must remain possible.
  requestRetirement() {
    this.#bytes();
    this.#retirementRequested = true;
  }

  retire() {
    if (this.#closed) return;
    if (this.#turn !== null) throw new Error("active actor turn blocks retirement");
    if (this.#lifetimePinCount !== 0)
      throw new Error("outstanding actor lifetime pins block retirement");
    // Only after an inactive actor has quiesced may its memory instance be
    // scrubbed and reissued. Failed retirement preserves ownership to retry.
    this.#retirementRequested = true;
    releaseArenaMemory(this.#memory, this.#guestExposed);
    this.#closed = true;
    this.#memory = null;
    this.#handles = new NativeWeakMap();
    this.#scratch = new NativeWeakMap();
    this.#lifetimePins = new NativeWeakMap();
    this.#guestBindings = new NativeWeakMap();
    this.#lifetimePinCount = 0;
    this.#persistentCount = this.#scratchCount = 0;
    this.#persistentTop = this.#scratchTop = 0;
    this.#freePersistent = [];
  }
}
