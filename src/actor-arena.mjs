import {types} from "node:util";
import {copyPrivateBytes, copyPrivateBytesInto, refreshPrivateMemoryView} from "./actor-frame-bytes.mjs";

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
const trustedWeakMapSet = WeakMap.prototype.set;
const trustedWeakMapDelete = WeakMap.prototype.delete;
const trustedIsUint8Array = types.isUint8Array;
const trustedIsSharedArrayBuffer = types.isSharedArrayBuffer;
const trustedMemoryBuffer = Object.getOwnPropertyDescriptor(
  WebAssembly.Memory.prototype, "buffer").get;
const ownedBytes = memory => new trustedBytes(trustedApply(trustedMemoryBuffer, memory, []));
const scrub = (bytes, start = 0, end = trustedApply(nativeByteLength, bytes, [])) =>
  trustedApply(trustedFill, bytes, [0, start, end]);

// Host-only Option shape; not a guest Option<T> object or a borrowed view.
const NO_RANGE = Object.freeze({kind: "None"});
function strictIndex(value, label) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) &&
      !Object.is(value, -0)) return BigInt(value);
  throw new TypeError(label + " requires an exact integer");
}

export class ActorArena {
  #memory;
  #byteView = null;
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
    // One wrapper for the normal fixed-size fast path. Even memory.grow(0)
    // can detach the old ArrayBuffer, so every access must verify its backing.
    this.#byteView = ownedBytes(this.#memory);
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

  #refreshBacking() {
    // WebAssembly.Memory.grow(0) may detach the *existing* ArrayBuffer even
    // when initial === maximum. A stale cached view silently has byteLength
    // zero and can skip security scrubbing. The native descriptor cannot be
    // replaced by later host monkeypatches. The common no-grow path creates
    // no fresh typed-array wrapper.
    const actual = trustedApply(trustedMemoryBuffer, this.#memory, []);
    if (trustedApply(nativeBuffer, this.#byteView, []) !== actual) {
      this.#byteView = new trustedBytes(actual);
    }
    return this.#byteView;
  }

  #bytes() {
    if (this.#closed) throw new Error("actor arena retired");
    return this.#refreshBacking();
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
    // Scrub the live backing, even if grow(0) detached a cached view.
    if (this.#memory !== null) {
      scrub(this.#refreshBacking());
      this.#byteView = null;
      this.#memory = null;
    }
    trustedApply(trustedMapForEach, this.#stackExecutions, [stack => {
      if (stack.memory !== null) {
        scrub(this.#stackBytes(stack));
        stack.memory = null;
        stack.byteView = null;
      }
    }]);
    trustedApply(trustedMapClear, this.#stackExecutions, []);
    this.#stackFrames = new trustedWeakMap();
    this.#stackResumeTickets = new trustedWeakMap();
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

  // A caller-owned destination avoids allocating a JS copy for each read.
  // The arena never publishes its live backing view.
  readInto(turn, handle, destination) {
    const {offset, length} = this.#slot(turn, handle);
    this.#requireExternalBytes(destination, length);
    const src = this.#bytes();
    // Copy directly, avoiding the temporary subarray wrapper of .set().
    for (let i = 0; i < length; ++i) destination[i] = src[offset + i];
  }

  read(turn, handle) {
    const {offset, length} = this.#slot(turn, handle);
    return copyPrivateBytes(this.#bytes(), offset, length);
  }

  #requireExternalBytes(data, length) {
    // Native internal slots prevent instance property overrides from
    // changing precise length and shared-memory admission checks.
    if (!trustedIsUint8Array(data) || trustedApply(nativeByteLength, data, []) !== length) {
      throw new TypeError("arena copy requires exact-size Uint8Array");
    }
    const backing = trustedApply(nativeBuffer, data, []);
    if (trustedIsSharedArrayBuffer(backing)) {
      throw new TypeError("arena copy rejects shared backing memory");
    }
    // A trusted host must not smuggle another view of this arena's backing
    // into the copy API. This is not protection against arbitrary JS host
    // code, but fences accidental self-alias and authority confusion.
    if (backing === trustedApply(nativeBuffer, this.#bytes(), [])) {
      throw new TypeError("arena copy rejects private backing alias");
    }
  }

  // Recoverable bounds check for an actor-owned byte span. The exact physical
  // turn and unforgeable allocation handle are checked EVEN on a missing
  // index. A hit returns an owned copy, never a retained alias into Wasm.
  tryReadBytes(turn, handle, start, count) {
    const {offset, length} = this.#slot(turn, handle);
    const i = strictIndex(start, "slice start");
    const n = strictIndex(count, "slice length");
    if (i < 0n || n < 0n || i > BigInt(length) ||
        n > BigInt(length) - i) return NO_RANGE;
    const lower = offset + Number(i);
    const upper = lower + Number(n);
    const value = trustedApply(trustedSlice, this.#bytes(), [lower, upper]);
    return Object.freeze({kind: "Some", value});
  }

  write(turn, handle, data) {
    const {offset, length} = this.#slot(turn, handle);
    this.#requireExternalBytes(data, length);
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
      memory, byteView: refreshPrivateMemoryView(memory),
      top: 0, frames: [], suspension: null, suspendedTurn: null
    }]);
    this.#activeStack = execution;
    return execution;
  }

  #stackBytes(stack) {
    stack.byteView = refreshPrivateMemoryView(stack.memory, stack.byteView);
    return stack.byteView;
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
    scrub(this.#stackBytes(stack), offset, offset + length);
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
    return copyPrivateBytes(this.#stackBytes(stack), slot.offset, slot.length);
  }

  // Caller-owned destination: no per-read allocation of a result buffer.
  readStackFrameInto(turn, execution, frame, destination) {
    const {stack, slot} = this.#topStackFrame(turn, execution, frame);
    copyPrivateBytesInto(this.#stackBytes(stack), slot.offset, slot.length, destination);
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
    trustedApply(trustedSet, this.#stackBytes(stack), [data, slot.offset]);
  }

  popStackFrame(turn, execution, frame) {
    const {stack, slot} = this.#topStackFrame(turn, execution, frame);
    scrub(this.#stackBytes(stack), slot.offset, slot.offset + slot.length);
    trustedApply(trustedArrayPop, stack.frames, []);
    stack.top = slot.offset;
    trustedApply(trustedWeakMapDelete, this.#stackFrames, [frame]);
  }

  suspendStack(turn, execution) {
    const stack = this.#requireStack(turn, execution);
    const ticket = trustedFreeze({});
    stack.suspension = ticket;
    stack.suspendedTurn = turn;
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
    // A receipt must cross an actual physical carrier release. Refusal
    // does not consume the receipt; a later admitted turn may resume it.
    if (stack.suspendedTurn === turn) {
      throw new Error("actor stack resume requires a new physical turn");
    }
    trustedApply(trustedWeakMapDelete, this.#stackResumeTickets, [ticket]);
    stack.suspension = null;
    stack.suspendedTurn = null;
    this.#activeStack = execution;
    return execution;
  }

  #clearStack(execution, stack) {
    scrub(this.#stackBytes(stack));
    for (let i = 0; i < stack.frames.length; ++i) {
      trustedApply(trustedWeakMapDelete, this.#stackFrames, [stack.frames[i]]);
    }
    if (stack.suspension !== null) trustedApply(trustedWeakMapDelete, this.#stackResumeTickets, [stack.suspension]);
    stack.memory = null;
    stack.byteView = null;
    stack.suspension = null;
    stack.suspendedTurn = null;
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
    // A suspended sibling owns independent backing and may be canceled
    // during another invocation's turn. Never clear that active invocation.
    if (this.#activeStack !== execution && stack.suspension === null) {
      throw new Error("actor stack cancellation requires active or suspended execution");
    }
    // Revoke only this execution's resume ticket and frame leases.
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
