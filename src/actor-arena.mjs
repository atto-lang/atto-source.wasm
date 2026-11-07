import {types} from "node:util";

// Host-only experimental actor-owned region. NOT attached to a guest module.
// Every SHARED actor retains a private arena; ActorRef never grants heap access.
// Guest source arena lowering and shared-domain regions are separate gates.
const PAGE = 65536;
const MAX_HANDLES = 4096;
// Provisional host-runtime quotas, NOT a compiled guest stack ABI.
const MAX_STACK_EXECUTIONS = 8;
const MAX_STACK_FRAMES = 64;
const kinds = new Set(["shared", "private", "untrusted"]);
const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const nativeBuffer = Object.getOwnPropertyDescriptor(typedArrayProto, "buffer").get;
const nativeByteLength = Object.getOwnPropertyDescriptor(typedArrayProto, "byteLength").get;
// Capture byte operations before untrusted or plugin code can mutate globals.
// A no-op monkeypatch of .fill must never bypass actor-memory zeroization.
const trustedBytes = Uint8Array;
const trustedApply = Reflect.apply;
const trustedFill = Uint8Array.prototype.fill;
// Avoid mutable TypedArray @@species even when the method is captured.
const trustedFindIndex = Array.prototype.findIndex;
const trustedArraySplice = Array.prototype.splice;
const trustedArraySort = Array.prototype.sort;
const trustedSet = Uint8Array.prototype.set;
const trustedArrayPush = Array.prototype.push;
const trustedArrayPop = Array.prototype.pop;
const trustedWasmMemory = WebAssembly.Memory;
const trustedFreeze = Object.freeze;
const trustedMap = Map;
const trustedWeakMap = WeakMap;
const trustedMapGet = Map.prototype.get;
const trustedMapSet = Map.prototype.set;
const trustedMapDelete = Map.prototype.delete;
const trustedMapClear = Map.prototype.clear;
const trustedMapForEach = Map.prototype.forEach;
const trustedMapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size").get;
const trustedWeakMapGet = WeakMap.prototype.get;
const trustedWeakMapHas = WeakMap.prototype.has;
const trustedWeakMapSet = WeakMap.prototype.set;
const trustedWeakMapDelete = WeakMap.prototype.delete;
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
  #handles = new trustedWeakMap();
  #scratch = new trustedWeakMap();
  // Issued lifetime-only leases keep the backing memory reachable until the
  // last async/FFI/IO owner acknowledges retirement. They grant no byte access.
  #lifetimePins = new trustedWeakMap();
  // Actor-owned, bounded managed frame stacks. A distinct, non-shared
  // WebAssembly.Memory belongs to each logical execution. Never expose it.
  // This does not replace the engine's native WebAssembly call stack.
  #stackExecutions = new trustedMap();
  #stackFrames = new trustedWeakMap();
  #stackResumeTickets = new trustedWeakMap();
  #activeStack = null;
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
    this.#memory = new trustedWasmMemory({initial: 2, maximum: 2});
  }

  get actorId() { return this.#actor; }
  get incarnation() { return this.#incarnation; }
  get retired() { return this.#closed; }
  get pendingLifetimePins() { return this.#pendingLifetimePins; }
  get stackExecutionCount() { return trustedApply(trustedMapSize, this.#stackExecutions, []); }
  get stackBytesInUse() {
    let bytes = 0;
    trustedApply(trustedMapForEach, this.#stackExecutions, [stack => { bytes += stack.top; }]);
    return bytes;
  }

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
    // A logical call chain must explicitly suspend or finish before its
    // physical carrier turn can be reissued to another actor.
    if (this.#activeStack !== null) {
      throw new Error("actor stack execution must suspend or finish before endTurn");
    }
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
    trustedApply(trustedWeakMapSet, this.#lifetimePins, [pin, true]);
    ++this.#pendingLifetimePins;
    return pin;
  }

  releaseLifetimePin(pin) {
    if (!trustedApply(trustedWeakMapHas, this.#lifetimePins, [pin])) {
      throw new Error("foreign or unissued actor arena lifetime pin");
    }
    if (!trustedApply(trustedWeakMapGet, this.#lifetimePins, [pin])) return; // idempotent release
    trustedApply(trustedWeakMapSet, this.#lifetimePins, [pin, false]);
    --this.#pendingLifetimePins;
    if (this.#closed && this.#pendingLifetimePins === 0) {
      this.#finishRetirement();
    }
  }

  #finishRetirement() {
    // Last external owner has quiesced. Physical reclamation is JS-engine
    // controlled; explicit zeroization, NOT deterministic native stack free.
    if (this.#memory !== null) {
      scrub(ownedBytes(this.#memory));
      this.#memory = null;
    }
    trustedApply(trustedMapForEach, this.#stackExecutions, [stack => {
      if (stack.memory !== null) {
        scrub(ownedBytes(stack.memory));
        stack.memory = null;
      }
    }]);
    trustedApply(trustedMapClear, this.#stackExecutions, []);
    this.#stackFrames = new trustedWeakMap();
    this.#stackResumeTickets = new trustedWeakMap();
    this.#activeStack = null;
  }

  #alloc(turn, length, scratch) {
    this.#requireTurn(turn);
    if (!Number.isSafeInteger(length) || length <= 0 || length > PAGE)
      throw new RangeError("invalid arena allocation length");
    if ((scratch ? this.#scratchCount : this.#persistentCount) >= MAX_HANDLES)
      throw new RangeError("actor arena handle quota exhausted");
    let offset, freeIndex = -1;
    if (scratch) {
      if (length > PAGE - this.#scratchTop)
        throw new RangeError("actor arena quota exhausted");
      offset = PAGE + this.#scratchTop;
    } else {
      freeIndex = trustedApply(trustedFindIndex, this.#freePersistent,
        [segment => segment.length >= length]);
      if (freeIndex !== -1) offset = this.#freePersistent[freeIndex].offset;
      else {
        if (length > PAGE - this.#persistentTop)
          throw new RangeError("actor arena quota exhausted");
        offset = this.#persistentTop;
      }
    }
    // Token registration and memory scrub must succeed before any quota
    // or free-list offset becomes visible to another operation.
    const handle = trustedFreeze({});
    const slot = {offset, length};
    scrub(this.#bytes(), offset, offset + length);
    trustedApply(trustedWeakMapSet,
      scratch ? this.#scratch : this.#handles, [handle, slot]);
    if (scratch) {
      this.#scratchTop += length;
      ++this.#scratchCount;
    } else {
      if (freeIndex !== -1) {
        const segment = this.#freePersistent[freeIndex];
        segment.offset += length;
        segment.length -= length;
        if (segment.length === 0)
          trustedApply(trustedArraySplice, this.#freePersistent, [freeIndex, 1]);
      } else this.#persistentTop += length;
      ++this.#persistentCount;
    }
    return handle;
  }

  allocPersistent(turn, length) { return this.#alloc(turn, length, false); }
  allocScratch(turn, length) { return this.#alloc(turn, length, true); }

  dropPersistent(turn, handle) {
    this.#requireTurn(turn);
    const entry = trustedApply(trustedWeakMapGet, this.#handles, [handle]);
    if (!entry) throw new Error("foreign, stale or scratch arena handle");
    // Plan a complete replacement free list before scrubbing the live slot.
    const planned = [];
    for (let i = 0; i < this.#freePersistent.length; ++i) {
      const seg = this.#freePersistent[i];
      trustedApply(trustedArrayPush, planned, [{offset: seg.offset, length: seg.length}]);
    }
    trustedApply(trustedArrayPush, planned, [{offset: entry.offset, length: entry.length}]);
    trustedApply(trustedArraySort, planned, [(a, b) => a.offset - b.offset]);
    const coalesced = [];
    for (let i = 0; i < planned.length; ++i) {
      const seg = planned[i];
      const prior = coalesced.length === 0 ? null : coalesced[coalesced.length - 1];
      if (prior && prior.offset + prior.length === seg.offset)
        prior.length += seg.length;
      else trustedApply(trustedArrayPush, coalesced, [seg]);
    }
    scrub(this.#bytes(), entry.offset, entry.offset + entry.length);
    trustedApply(trustedWeakMapDelete, this.#handles, [handle]);
    --this.#persistentCount;
    this.#freePersistent = coalesced;
  }

  #slot(turn, handle) {
    this.#requireTurn(turn);
    const entry = trustedApply(trustedWeakMapGet, this.#handles, [handle]) ??
      trustedApply(trustedWeakMapGet, this.#scratch, [handle]);
    if (!entry) throw new Error("foreign or stale arena handle");
    return entry;
  }

  read(turn, handle) {
    const {offset, length} = this.#slot(turn, handle);
    const bytes = this.#bytes();
    const copy = new trustedBytes(length);
    trustedApply(trustedSet, copy, [
      new trustedBytes(trustedApply(nativeBuffer, bytes, []), offset, length)
    ]);
    return copy; // owned, species-independent result
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


  // Host compiler/scheduler primitive. One private 64-KiB frame backing
  // per live logical execution (max eight per actor). Compiler lowering must
  // explicitly materialize locals/roots here; Wasm engine frames are separate.
  startStack(turn) {
    this.#requireTurn(turn);
    if (this.#activeStack !== null) throw new Error("actor stack already active");
    if (trustedApply(trustedMapSize, this.#stackExecutions, []) >= MAX_STACK_EXECUTIONS) {
      throw new RangeError("actor stack execution quota exhausted");
    }
    const memory = new trustedWasmMemory({initial: 1, maximum: 1});
    const execution = trustedFreeze({});
    trustedApply(trustedMapSet, this.#stackExecutions, [execution, {
      memory, top: 0, frames: [], suspension: null
    }]);
    this.#activeStack = execution;
    return execution;
  }

  #requireStack(turn, execution) {
    this.#requireTurn(turn);
    const stack = trustedApply(trustedMapGet, this.#stackExecutions, [execution]);
    if (!stack || this.#activeStack !== execution) {
      throw new Error("active actor stack execution authority required");
    }
    return stack;
  }

  pushStackFrame(turn, execution, length) {
    const stack = this.#requireStack(turn, execution);
    if (!Number.isSafeInteger(length) || length <= 0 || length > PAGE) {
      throw new RangeError("invalid actor stack frame length");
    }
    if (stack.frames.length >= MAX_STACK_FRAMES) {
      throw new RangeError("actor stack frame quota exhausted");
    }
    if (length > PAGE - stack.top) {
      throw new RangeError("actor stack byte quota exhausted");
    }
    const frame = trustedFreeze({});
    const offset = stack.top;
    scrub(ownedBytes(stack.memory), offset, offset + length);
    trustedApply(trustedWeakMapSet, this.#stackFrames, [frame, {execution, offset, length}]);
    trustedApply(trustedArrayPush, stack.frames, [frame]);
    stack.top += length;
    return frame;
  }

  #topStackFrame(turn, execution, frame) {
    const stack = this.#requireStack(turn, execution);
    const slot = trustedApply(trustedWeakMapGet, this.#stackFrames, [frame]);
    if (!slot || slot.execution !== execution ||
        (stack.frames.length === 0 ||
         stack.frames[stack.frames.length - 1] !== frame)) {
      throw new Error("foreign, stale or non-top actor stack frame");
    }
    return {stack, slot};
  }

  readStackFrame(turn, execution, frame) {
    const {stack, slot} = this.#topStackFrame(turn, execution, frame);
    const bytes = ownedBytes(stack.memory);
    const copy = new trustedBytes(slot.length);
    trustedApply(trustedSet, copy, [
      new trustedBytes(trustedApply(nativeBuffer, bytes, []),
        slot.offset, slot.length)
    ]);
    return copy; // no mutable @@species
  }

  writeStackFrame(turn, execution, frame, data) {
    const {stack, slot} = this.#topStackFrame(turn, execution, frame);
    if (!trustedIsUint8Array(data) ||
        trustedApply(nativeByteLength, data, []) !== slot.length) {
      throw new TypeError("actor stack write requires exact-size Uint8Array");
    }
    if (trustedIsSharedArrayBuffer(trustedApply(nativeBuffer, data, []))) {
      throw new TypeError("actor stack write rejects shared backing memory");
    }
    trustedApply(trustedSet, ownedBytes(stack.memory), [data, slot.offset]);
  }

  popStackFrame(turn, execution, frame) {
    const {stack, slot} = this.#topStackFrame(turn, execution, frame);
    scrub(ownedBytes(stack.memory), slot.offset, slot.offset + slot.length);
    trustedApply(trustedArrayPop, stack.frames, []);
    stack.top = slot.offset;
    trustedApply(trustedWeakMapDelete, this.#stackFrames, [frame]);
  }

  suspendStack(turn, execution) {
    const stack = this.#requireStack(turn, execution);
    const ticket = trustedFreeze({});
    stack.suspension = ticket;
    trustedApply(trustedWeakMapSet, this.#stackResumeTickets, [ticket, execution]);
    this.#activeStack = null;
    return ticket;
  }

  resumeStack(turn, ticket) {
    this.#requireTurn(turn);
    if (this.#activeStack !== null) throw new Error("actor stack already active");
    const execution = trustedApply(trustedWeakMapGet, this.#stackResumeTickets, [ticket]);
    const stack = trustedApply(trustedMapGet, this.#stackExecutions, [execution]);
    if (!stack || stack.suspension !== ticket) {
      throw new Error("foreign, stale or consumed actor stack resume ticket");
    }
    trustedApply(trustedWeakMapDelete, this.#stackResumeTickets, [ticket]);
    stack.suspension = null;
    this.#activeStack = execution;
    return execution;
  }

  #clearStack(execution, stack) {
    scrub(ownedBytes(stack.memory));
    for (let i = 0; i < stack.frames.length; ++i) {
      trustedApply(trustedWeakMapDelete, this.#stackFrames, [stack.frames[i]]);
    }
    if (stack.suspension !== null) trustedApply(trustedWeakMapDelete, this.#stackResumeTickets, [stack.suspension]);
    stack.memory = null;
    trustedApply(trustedMapDelete, this.#stackExecutions, [execution]);
    if (this.#activeStack === execution) this.#activeStack = null;
  }

  finishStack(turn, execution) {
    const stack = this.#requireStack(turn, execution);
    if (stack.frames.length !== 0) {
      throw new Error("actor stack must unwind all frames before finish");
    }
    this.#clearStack(execution, stack);
  }

  cancelStack(turn, execution) {
    this.#requireTurn(turn);
    const stack = trustedApply(trustedMapGet, this.#stackExecutions, [execution]);
    if (!stack) throw new Error("foreign or stale actor stack execution");
    if (this.#activeStack !== null && this.#activeStack !== execution) {
      throw new Error("another actor stack execution is active");
    }
    // Cancellation may clean a suspended task. Its old resume ticket and
    // every frame lease are revoked, even if the same offsets are reused.
    this.#clearStack(execution, stack);
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
