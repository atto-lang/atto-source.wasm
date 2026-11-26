import {types} from 'node:util';
import {ActorIoEnvelope} from './actor-io.mjs';

// All accounting is by intrinsic, fixed backing-store slots. A Uint8Array
// subclass may lie about .byteLength and @@iterator; a proxy is not an
// admissible byte view. Never trust either for quotas or retained bytes.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicSize = Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get);
const intrinsicBuffer = Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get);
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const scrubBytes = Function.prototype.call.bind(Uint8Array.prototype.fill);
const CountSlots = Uint32Array;
const TicketSlots = Float64Array;
const slotIndex = Function.prototype.call.bind(typedArrayPrototype.indexOf);
const slotLength = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(typedArrayPrototype,'length').get);

function ownedSize(bytes) {
  if (!types.isUint8Array(bytes)) throw new TypeError('genuine Uint8Array required');
  const buffer = intrinsicBuffer(bytes);
  if (types.isSharedArrayBuffer(buffer)) throw new TypeError('SharedArrayBuffer forbidden');
  if (resizable && resizable.call(buffer)) throw new TypeError('resizable backing forbidden');
  return intrinsicSize(bytes);
}

/**
 * Host-side bounded demand/ACK on an exclusive ActorIoEnvelope output lease.
 * This is not guest Flow<T> implementation or compiled .atto proof.
 * Output copies stay inside the actor queue until tryNext transfers ownership;
 * bytes stay charged until ACK even after a cancelled stream.
 */
export class ActorDemandOutputPort {
  #io;
  #authority;
  #outputLease;
  #capacity;
  #maxBytes;
  #maxDemand;
  #byteSizes;
  #head = 0;
  #tail = 0;
  #queued = 0;
  #retained = 0;
  #credits = 0;
  #reader = null;
  #nextTicket = 1;
  #tickets;
  #loanBytes;
  #completed = false;
  #cancelled = false;

  constructor({io, authority, capacity = 16, maxInFlight = 4,
               maxBytes = 65536, maxDemand = 1024} = {}) {
    if (!(io instanceof ActorIoEnvelope)) throw new TypeError('ActorIoEnvelope required');
    io.metadata(authority); // reject stale/foreign capability before allocating
    for (const [name,value,max] of [
      ['capacity',capacity,1024], ['maxInFlight',maxInFlight,4096],
      ['maxBytes',maxBytes,4*1024*1024], ['maxDemand',maxDemand,1_000_000]
    ]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > max)
        throw new RangeError(`${name} must have a finite positive budget`);
    }
    this.#io = io;
    this.#authority = authority;
    this.#capacity = capacity;
    this.#maxBytes = maxBytes;
    this.#maxDemand = maxDemand;
    this.#byteSizes = new CountSlots(capacity);
    this.#tickets = new TicketSlots(maxInFlight);
    this.#loanBytes = new CountSlots(maxInFlight);
    // Acquire the exclusive host lease only after all local allocations.
    this.#outputLease = io.acquireOutputLease(authority);
  }
  #valid() {
    this.#io.metadata(this.#authority);
    if (this.#outputLease === null) throw new Error('demand output lease disposed');
  }
  #check(reader) {
    this.#valid();
    if (this.#reader === null || reader !== this.#reader)
      throw new Error('exclusive output reader lease unavailable');
  }
  subscribe() {
    this.#valid();
    if (this.#reader !== null || this.#completed || this.#cancelled)
      throw new Error('exclusive output reader lease unavailable');
    this.#reader = Object.freeze(Object.create(null));
    return this.#reader;
  }
  request(reader, n) {
    this.#check(reader);
    if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError('invalid credit request');
    if (this.#completed || this.#cancelled) throw new Error('terminal output');
    if (n > this.#maxDemand - this.#credits) throw new RangeError('credit overflow');
    this.#credits += n;
  }
  tryOffer(bytes) {
    this.#valid();
    // Check true byte view even if demand or stream state denies the offer.
    if (!types.isUint8Array(bytes)) throw new TypeError('genuine Uint8Array required');
    if (this.#completed || this.#cancelled) return 'closed';
    if (this.#reader === null) return 'no-subscriber';
    if (this.#credits === 0) return 'no-demand';
    if (this.#queued >= this.#capacity) return 'full';
    const n = ownedSize(bytes);
    if (n > this.#maxBytes - this.#retained) return 'byte-budget';
    // The actor I/O queue takes its own byte snapshot, and rejects detached
    // or resizable backing without touching credits or retained-size state.
    if (!this.#io.tryWriteOutputWithLease(this.#authority, this.#outputLease, bytes))
      return 'host-backpressure';
    this.#byteSizes[this.#tail] = n;
    this.#tail = (this.#tail + 1) % this.#capacity;
    this.#queued++;
    this.#retained += n;
    this.#credits--;
    return 'accepted';
  }
  tryNext(reader) {
    this.#check(reader);
    if (this.#cancelled) return {kind:'cancelled'};
    const free = slotIndex(this.#tickets,0);
    if (free === -1) return {kind:'not-ready'};
    if (this.#queued === 0) return {kind:this.#completed?'complete':'not-ready'};
    if (this.#nextTicket >= Number.MAX_SAFE_INTEGER)
      throw new RangeError('ticket exhausted');
    const bytes = this.#io.readOutputWithLease(this.#authority,this.#outputLease);
    const size = this.#byteSizes[this.#head];
    if (!types.isUint8Array(bytes) || ownedSize(bytes) !== size)
      throw new Error('output queue changed outside demand port');
    this.#byteSizes[this.#head] = 0;
    this.#head = (this.#head + 1) % this.#capacity;
    this.#queued--;
    const ticket = this.#nextTicket++;
    this.#tickets[free] = ticket;
    this.#loanBytes[free] = size;
    return {kind:'item',value:bytes,ticket};
  }
  ack(reader, ticket) {
    this.#check(reader);
    if (!Number.isSafeInteger(ticket) || ticket < 1) return false;
    const i = slotIndex(this.#tickets,ticket);
    if (i < 0) return false;
    this.#tickets[i] = 0;
    this.#retained -= this.#loanBytes[i];
    this.#loanBytes[i] = 0;
    return true;
  }
  complete() {
    this.#valid();
    if (this.#completed || this.#cancelled) return false;
    this.#io.closeOutputWithLease(this.#authority,this.#outputLease);
    this.#completed = true;
    this.#credits = 0;
    return true;
  }
  cancel() {
    this.#valid();
    if (this.#completed || this.#cancelled) return false;
    this.#io.closeOutputWithLease(this.#authority,this.#outputLease);
    this.#completed = true;
    this.#cancelled = true;
    this.#credits = 0;
    while(this.#queued > 0) {
      const bytes = this.#io.readOutputWithLease(this.#authority,this.#outputLease);
      const size = this.#byteSizes[this.#head];
      if (!types.isUint8Array(bytes) || ownedSize(bytes) !== size)
        throw new Error('output queue changed outside demand port');
      scrubBytes(bytes, 0);
      this.#retained -= size;
      this.#byteSizes[this.#head] = 0;
      this.#head = (this.#head + 1) % this.#capacity;
      this.#queued--;
    }
    return true;
  }
  dispose(reader) {
    this.#check(reader);
    if (!this.#completed || this.#queued !== 0 || this.inFlight!==0)
      throw new Error('cannot retire demand output before terminal quiescence');
    this.#io.releaseOutputLease(this.#authority,this.#outputLease);
    this.#outputLease = null;
    return true;
  }
  get queued() {return this.#queued;}
  get retainedBytes() {return this.#retained;}
  get outstandingDemand() {return this.#credits;}
  get inFlight() {
    let count=0;
    for(let i=0;i<slotLength(this.#tickets);i++) if(this.#tickets[i]!==0) count++;
    return count;
  }
}
