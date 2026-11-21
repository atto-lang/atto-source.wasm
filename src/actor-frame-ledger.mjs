import {types} from 'node:util';

// Trusted-host-only managed frame storage for the pooled Wasm actor carrier.
// This memory is distinct from both the guest-exported heap and the native
// WebAssembly call stack; it is NOT compiler-lowered AttoLang frame storage.
const PAGE = 65536, MAX_EXECUTIONS = 8, MAX_FRAMES = 64;
const NativeMemory = WebAssembly.Memory;
const NativeBytes = Uint8Array;
const NativeMap = Map, NativeWeakMap = WeakMap;
const freeze = Object.freeze, isSafeInteger = Number.isSafeInteger;
const getMemoryBuffer = Object.getOwnPropertyDescriptor(NativeMemory.prototype, 'buffer').get;
const typedProto = Object.getPrototypeOf(NativeBytes.prototype);
const getBuffer = Object.getOwnPropertyDescriptor(typedProto, 'buffer').get;
const getByteLength = Object.getOwnPropertyDescriptor(typedProto, 'byteLength').get;
const fill = NativeBytes.prototype.fill, set = NativeBytes.prototype.set;
const mapGet = Map.prototype.get, mapSet = Map.prototype.set;
const mapDelete = Map.prototype.delete, mapClear = Map.prototype.clear;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
const mapForEach = Map.prototype.forEach;
const weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set;
const weakDelete = WeakMap.prototype.delete;
const push = Array.prototype.push, pop = Array.prototype.pop;
const validBytes = types.isUint8Array, sharedBacking = types.isSharedArrayBuffer;
const apply = Reflect.apply;
const managedBytes = memory => new NativeBytes(apply(getMemoryBuffer, memory, []));
const zero = (memory, start = 0, end = PAGE) =>
  apply(fill, managedBytes(memory), [0, start, end]);
const own = (data, offset, length) => {
  const copy = new NativeBytes(length);
  apply(set, copy, [new NativeBytes(apply(getBuffer, data, []), offset, length)]);
  return copy;
};

export class ActorFrameLedger {
  #actorId;
  #incarnation;
  #turn = null;
  #activeExecution = null;
  #closed = false;
  #executions = new NativeMap();
  #frames = new NativeWeakMap();
  #tickets = new NativeWeakMap();
  // Recycled only within this actor incarnation. No native guest or callback
  // ever receives these private backing objects.
  #freeBacking = [];

  constructor({actorId, incarnation} = {}) {
    if (!isSafeInteger(actorId) || actorId <= 0 ||
        typeof incarnation !== 'string' || !/^[a-f0-9]{32}$/.test(incarnation))
      throw new TypeError('invalid actor frame ledger owner');
    this.#actorId = actorId;
    this.#incarnation = incarnation;
  }
  get actorId() { return this.#actorId; }
  get incarnation() { return this.#incarnation; }
  get retired() { return this.#closed; }
  get liveExecutionCount() { return apply(mapSize, this.#executions, []); }
  get frameBytesInUse() {
    let used = 0;
    apply(mapForEach, this.#executions, [s => { used += s.top; }]);
    return used;
  }

  #requireTurn(turn) {
    if (this.#closed) throw Error('actor frame ledger retired');
    if (turn === null || turn !== this.#turn) throw Error('actor frame turn authority required');
  }
  beginTurn() {
    if (this.#closed) throw Error('actor frame ledger retired');
    if (this.#turn !== null) throw Error('actor frame turn already active');
    this.#turn = freeze({});
    return this.#turn;
  }
  endTurn(turn) {
    this.#requireTurn(turn);
    if (this.#activeExecution !== null)
      throw Error('actor frame execution must suspend or finish before endTurn');
    this.#turn = null;
  }

  startExecution(turn) {
    this.#requireTurn(turn);
    if (this.#activeExecution !== null) throw Error('actor frame execution already active');
    if (this.liveExecutionCount >= MAX_EXECUTIONS)
      throw new RangeError('actor frame execution quota exhausted');
    // Allocation and capability minting precede the registry commit.
    const backing = this.#freeBacking.length
      ? apply(pop, this.#freeBacking, [])
      : new NativeMemory({initial: 1, maximum: 1});
    const execution = freeze({});
    const state = {backing, top: 0, frames: [], suspension: null};
    apply(mapSet, this.#executions, [execution, state]);
    this.#activeExecution = execution;
    return execution;
  }
  #requireExecution(turn, execution) {
    this.#requireTurn(turn);
    const state = apply(mapGet, this.#executions, [execution]);
    if (!state || this.#activeExecution !== execution)
      throw Error('actor frame execution authority required');
    return state;
  }
  pushFrame(turn, execution, length) {
    const state = this.#requireExecution(turn, execution);
    if (!isSafeInteger(length) || length <= 0 || length > PAGE)
      throw new RangeError('invalid actor frame length');
    if (state.frames.length >= MAX_FRAMES)
      throw new RangeError('actor frame depth quota exhausted');
    if (length > PAGE - state.top)
      throw new RangeError('actor frame byte quota exhausted');
    const frame = freeze({});
    const offset = state.top;
    zero(state.backing, offset, offset + length);
    apply(weakSet, this.#frames, [frame, {execution, offset, length}]);
    apply(push, state.frames, [frame]);
    state.top += length;
    return frame;
  }
  #top(turn, execution, frame) {
    const state = this.#requireExecution(turn, execution);
    const slot = apply(weakGet, this.#frames, [frame]);
    if (!slot || slot.execution !== execution ||
        state.frames.length === 0 || state.frames[state.frames.length - 1] !== frame)
      throw Error('foreign, stale or non-top actor frame');
    return {state, slot};
  }
  readFrame(turn, execution, frame) {
    const {state, slot} = this.#top(turn, execution, frame);
    return own(managedBytes(state.backing), slot.offset, slot.length);
  }
  writeFrame(turn, execution, frame, data) {
    const {state, slot} = this.#top(turn, execution, frame);
    if (!validBytes(data) || apply(getByteLength, data, []) !== slot.length)
      throw TypeError('actor frame write requires exact-size Uint8Array');
    if (sharedBacking(apply(getBuffer, data, [])))
      throw TypeError('actor frame write denies shared memory');
    apply(set, managedBytes(state.backing), [data, slot.offset]);
  }
  popFrame(turn, execution, frame) {
    const {state, slot} = this.#top(turn, execution, frame);
    zero(state.backing, slot.offset, slot.offset + slot.length);
    apply(pop, state.frames, []);
    state.top = slot.offset;
    apply(weakDelete, this.#frames, [frame]);
  }
  suspend(turn, execution) {
    const state = this.#requireExecution(turn, execution);
    const ticket = freeze({});
    apply(weakSet, this.#tickets, [ticket, execution]);
    state.suspension = ticket;
    this.#activeExecution = null;
    return ticket;
  }
  resume(turn, ticket) {
    this.#requireTurn(turn);
    if (this.#activeExecution !== null) throw Error('actor frame execution already active');
    const execution = apply(weakGet, this.#tickets, [ticket]);
    const state = apply(mapGet, this.#executions, [execution]);
    if (!state || state.suspension !== ticket)
      throw Error('foreign, stale or consumed actor frame ticket');
    apply(weakDelete, this.#tickets, [ticket]);
    state.suspension = null;
    this.#activeExecution = execution;
    return execution;
  }
  #clearExecution(execution, state) {
    zero(state.backing);
    for (let i = 0; i < state.frames.length; i++)
      apply(weakDelete, this.#frames, [state.frames[i]]);
    if (state.suspension !== null)
      apply(weakDelete, this.#tickets, [state.suspension]);
    apply(mapDelete, this.#executions, [execution]);
    if (this.#activeExecution === execution) this.#activeExecution = null;
    // No external holder ever receives a backing object or live memory view.
    apply(push, this.#freeBacking, [state.backing]);
    state.backing = null;
  }
  finishExecution(turn, execution) {
    const state = this.#requireExecution(turn, execution);
    if (state.frames.length !== 0) throw Error('actor frame stack not empty');
    this.#clearExecution(execution, state);
  }
  cancelExecution(turn, execution) {
    this.#requireTurn(turn);
    const state = apply(mapGet, this.#executions, [execution]);
    if (!state) throw Error('foreign or stale actor frame execution');
    if (this.#activeExecution !== null && this.#activeExecution !== execution)
      throw Error('another actor frame execution is active');
    this.#clearExecution(execution, state);
  }
  retire() {
    if (this.#closed) return;
    if (this.#turn !== null) throw Error('active actor frame turn blocks retirement');
    this.#closed = true; // revoke before scrubbing any backing
    apply(mapForEach, this.#executions, [state => {zero(state.backing); }]);
    for (let i = 0; i < this.#freeBacking.length; i++) zero(this.#freeBacking[i]);
    apply(mapClear, this.#executions, []);
    this.#freeBacking = [];
    this.#frames = new NativeWeakMap();
    this.#tickets = new NativeWeakMap();
  }
}
