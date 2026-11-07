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
  // Actor-owned, bounded managed frame stacks. A distinct, non-shared
  // WebAssembly.Memory belongs to each logical execution. Never expose it.
  // This does not replace the engine's native WebAssembly call stack.
  #stackExecutions = new Map();
  #stackFrames = new WeakMap();
  #stackResumeTickets = new WeakMap();
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
    this.#memory = new WebAssembly.Memory({initial: 2, maximum: 2});
  }

  get actorId() { return this.#actor; }
  get incarnation() { return this.#incarnation; }
  get retired() { return this.#closed; }
  get pendingLifetimePins() { return this.#pendingLifetimePins; }
  get stackExecutionCount() { return this.#stackExecutions.size; }
  get stackBytesInUse() {
    let bytes = 0;
    for (const stack of this.#stackExecutions.values()) bytes += stack.top;
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
    // Last external owner has quiesced. Physical reclamation is JS-engine
    // controlled; explicit zeroization, NOT deterministic native stack free.
    if (this.#memory !== null) {
      scrub(ownedBytes(this.#memory));
      this.#memory = null;
    }
    for (const stack of this.#stackExecutions.values()) {
      if (stack.memory !== null) {
        scrub(ownedBytes(stack.memory));
        stack.memory = null;
      }
    }
    this.#stackExecutions.clear();
    this.#stackFrames = new WeakMap();
    this.#stackResumeTickets = new WeakMap();
    this.#activeStack = null;
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


  // Host compiler/scheduler primitive. One private 64-KiB frame backing
  // per live logical execution (max eight per actor). Compiler lowering must
  // explicitly materialize locals/roots here; Wasm engine frames are separate.
  startStack(turn) {
    this.#requireTurn(turn);
    if (this.#activeStack !== null) throw new Error("actor stack already active");
    if (this.#stackExecutions.size >= MAX_STACK_EXECUTIONS) {
      throw new RangeError("actor stack execution quota exhausted");
    }
    const memory = new WebAssembly.Memory({initial: 1, maximum: 1});
    const execution = Object.freeze({});
    this.#stackExecutions.set(execution, {
      memory, top: 0, frames: [], suspension: null
    });
    this.#activeStack = execution;
    return execution;
  }

  #requireStack(turn, execution) {
    this.#requireTurn(turn);
    const stack = this.#stackExecutions.get(execution);
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
    const frame = Object.freeze({});
    const offset = stack.top;
    scrub(ownedBytes(stack.memory), offset, offset + length);
    this.#stackFrames.set(frame, {execution, offset, length});
    stack.frames.push(frame);
    stack.top += length;
    return frame;
  }

  #topStackFrame(turn, execution, frame) {
    const stack = this.#requireStack(turn, execution);
    const slot = this.#stackFrames.get(frame);
    if (!slot || slot.execution !== execution ||
        stack.frames[stack.frames.length - 1] !== frame) {
      throw new Error("foreign, stale or non-top actor stack frame");
    }
    return {stack, slot};
  }

  readStackFrame(turn, execution, frame) {
    const {stack, slot} = this.#topStackFrame(turn, execution, frame);
    return trustedApply(trustedSlice, ownedBytes(stack.memory),
      [slot.offset, slot.offset + slot.length]); // defensive copy
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
    stack.frames.pop();
    stack.top = slot.offset;
    this.#stackFrames.delete(frame);
  }

  suspendStack(turn, execution) {
    const stack = this.#requireStack(turn, execution);
    const ticket = Object.freeze({});
    stack.suspension = ticket;
    this.#stackResumeTickets.set(ticket, execution);
    this.#activeStack = null;
    return ticket;
  }

  resumeStack(turn, ticket) {
    this.#requireTurn(turn);
    if (this.#activeStack !== null) throw new Error("actor stack already active");
    const execution = this.#stackResumeTickets.get(ticket);
    const stack = this.#stackExecutions.get(execution);
    if (!stack || stack.suspension !== ticket) {
      throw new Error("foreign, stale or consumed actor stack resume ticket");
    }
    this.#stackResumeTickets.delete(ticket);
    stack.suspension = null;
    this.#activeStack = execution;
    return execution;
  }

  #clearStack(execution, stack) {
    scrub(ownedBytes(stack.memory));
    for (const frame of stack.frames) this.#stackFrames.delete(frame);
    if (stack.suspension !== null) this.#stackResumeTickets.delete(stack.suspension);
    stack.memory = null;
    this.#stackExecutions.delete(execution);
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
    const stack = this.#stackExecutions.get(execution);
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
    this.#handles = new WeakMap();
    this.#scratch = new WeakMap();
    this.#persistentCount = this.#scratchCount = 0;
    this.#freePersistent = [];
    if (this.#pendingLifetimePins === 0) this.#finishRetirement();
  }
}
