import {ActorIoEnvelope} from './actor-io.mjs';

/**
 * Demand-aware, host-side adapter over a REAL Wasm actor I/O output envelope.
 *
 * Acquires a real exclusive output lease from ActorIoEnvelope: other holders
 * of the actor's generation authority cannot bypass this adapter's output
 * accounting until its terminal, physically quiescent dispose().
 * Guest Flow<T>, worker postMessage admission and source moves remain pending.
 */
export class ActorDemandOutputPort {
  #io;
  #authority;
  #outputLease;
  #capacity;
  #maxBytes;
  #maxDemand;
  #maxInFlight;
  #byteSizes;
  #head = 0;
  #tail = 0;
  #queued = 0;
  #retained = 0;
  #credits = 0;
  #lease = null;
  #nextTicket = 1;
  #tickets;
  #loanBytes;
  #completed = false;
  #cancelled = false;

  constructor({io, authority, capacity = 16, maxInFlight = 4,
               maxBytes = 65536, maxDemand = 1024} = {}) {
    if (!(io instanceof ActorIoEnvelope)) throw new TypeError('ActorIoEnvelope required');
    io.metadata(authority); // reject foreign/stale authority before setup
    for (const [key,value,bound] of [
      ['capacity',capacity,1024], ['maxInFlight',maxInFlight,4096],
      ['maxBytes',maxBytes,4*1024*1024], ['maxDemand',maxDemand,1_000_000]
    ]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > bound)
        throw new RangeError(key+' must have a finite positive budget');
    }
    this.#io=io;this.#authority=authority;
    this.#outputLease=io.acquireOutputLease(authority);
    this.#capacity=capacity;this.#maxBytes=maxBytes;
    this.#maxDemand=maxDemand;this.#maxInFlight=maxInFlight;
    this.#byteSizes=new Array(capacity).fill(0);
    this.#tickets=new Array(maxInFlight).fill(0);
    this.#loanBytes=new Array(maxInFlight).fill(0);
  }

  #valid() {
    this.#io.metadata(this.#authority);
    if (this.#outputLease === null) throw new Error('demand output lease disposed');
  }
  #check(lease) {
    this.#valid();
    if (this.#lease === null || lease !== this.#lease)
      throw new Error('exclusive output reader lease unavailable');
  }
  subscribe() {
    this.#valid();
    if (this.#lease !== null || this.#completed || this.#cancelled)
      throw new Error('exclusive output reader lease unavailable');
    this.#lease=Object.freeze(Object.create(null));
    return this.#lease;
  }
  request(lease,n) {
    this.#check(lease);
    if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError('invalid credit request');
    if (this.#completed || this.#cancelled) throw new Error('terminal output');
    if (n > this.#maxDemand - this.#credits) throw new RangeError('credit overflow');
    this.#credits += n;
  }
  tryOffer(bytes) {
    this.#valid();
    if (!(bytes instanceof Uint8Array)) throw new TypeError('Uint8Array required');
    if (this.#completed || this.#cancelled) return 'closed';
    if (this.#lease === null) return 'no-subscriber';
    if (this.#credits === 0) return 'no-demand';
    if (this.#queued >= this.#capacity) return 'full';
    if (bytes.byteLength > this.#maxBytes - this.#retained) return 'byte-budget';
    // Underlying ActorIoEnvelope clones accepted messages before publishing.
    if (!this.#io.tryWriteOutputWithLease(this.#authority,this.#outputLease,bytes)) return 'host-backpressure';
    this.#byteSizes[this.#tail]=bytes.byteLength;
    this.#tail=(this.#tail+1)%this.#capacity;
    this.#queued++;
    this.#retained+=bytes.byteLength;
    this.#credits--;
    return 'accepted';
  }
  tryNext(lease) {
    this.#check(lease);
    if (this.#cancelled) return {kind:'cancelled'};
    const free=this.#tickets.indexOf(0);
    if (free===-1) return {kind:'not-ready'};
    if (this.#queued===0) return {kind:this.#completed?'complete':'not-ready'};
    if (this.#nextTicket >= Number.MAX_SAFE_INTEGER)
      throw new RangeError('ticket exhausted');
    const bytes=this.#io.readOutputWithLease(this.#authority,this.#outputLease);
    if (!(bytes instanceof Uint8Array))
      throw new Error('output queue changed outside demand port');
    const size=this.#byteSizes[this.#head];
    if (bytes.byteLength!==size)
      throw new Error('output queue changed outside demand port');
    this.#head=(this.#head+1)%this.#capacity;
    this.#queued--;
    const ticket=this.#nextTicket++;
    this.#tickets[free]=ticket;
    this.#loanBytes[free]=size;
    return {kind:'item',value:bytes,ticket};
  }
  ack(lease,ticket) {
    this.#check(lease);
    if (!Number.isSafeInteger(ticket)||ticket<1) return false;
    const i=this.#tickets.indexOf(ticket);
    if (i<0) return false;
    this.#tickets[i]=0;
    this.#retained-=this.#loanBytes[i];
    this.#loanBytes[i]=0;
    return true;
  }
  complete() {
    this.#valid();
    if (this.#completed||this.#cancelled) return false;
    this.#completed=true;this.#credits=0;
    return true; // No actor-envelope shutdown; only this reader terminates.
  }
  cancel() {
    this.#valid();
    if (this.#completed||this.#cancelled) return false;
    this.#completed=true;this.#cancelled=true;this.#credits=0;
    while(this.#queued>0) {
      const bytes=this.#io.readOutputWithLease(this.#authority,this.#outputLease);
      if (!(bytes instanceof Uint8Array) ||
          bytes.byteLength!==this.#byteSizes[this.#head])
        throw new Error('output queue changed outside demand port');
      this.#retained-=this.#byteSizes[this.#head];
      this.#byteSizes[this.#head]=0;
      this.#head=(this.#head+1)%this.#capacity;
      this.#queued--;
    }
    return true;
  }
  /** Release underlying actor authority only after terminal AND physical ACK. */
  dispose(lease) {
    this.#check(lease);
    if (!this.#completed || this.#queued !== 0 ||
        this.#tickets.some(ticket => ticket !== 0))
      throw new Error('cannot retire demand output before terminal quiescence');
    this.#io.releaseOutputLease(this.#authority,this.#outputLease);
    this.#outputLease=null;
    return true;
  }
  get queued() {return this.#queued;}
  get retainedBytes() {return this.#retained;}
  get outstandingDemand() {return this.#credits;}
  get inFlight() {return this.#tickets.filter(x=>x!==0).length;}
}
