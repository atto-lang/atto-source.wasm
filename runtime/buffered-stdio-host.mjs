// Host-only per-descriptor admission substrate. Not a guest intrinsic.
// The owner must be a trusted tenant runtime and must fence guest continuations.
const OK = Object.freeze({ok:true});
const failed = code => Object.freeze({ok:false,code});
const encoder = new TextEncoder();
const bounded = (n,max) => {
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new RangeError('invalid stdio quota');
  return n;
};
function receipt() {
  let resolve;
  const promise = new Promise(r=>{resolve=r;});
  return {promise,resolve};
}
export class BufferedStdioHost {
  #sink; #maxRecords; #maxBytes; #maxWaiters; #maxPendingBytes;
  #queue=[]; #waiting=[]; #active=null; #bytes=0; #pendingBytes=0;
  #physicallyDrained=receipt();
  #scheduled=false; #running=false; #sealed=false; #failure=null; #closed=receipt();
  constructor(sink, maxRecords=1024, maxBytes=4194304, maxWaiters=64, maxPendingBytes=1048576) {
    if (typeof sink !== 'function') throw new TypeError('trusted sink function required');
    this.#sink=sink;
    this.#maxRecords=bounded(maxRecords,1024);
    this.#maxBytes=bounded(maxBytes,4194304);
    this.#maxWaiters=bounded(maxWaiters,64);
    this.#maxPendingBytes=bounded(maxPendingBytes,1048576);
  }
  get accounting() {
    return Object.freeze({acceptedRecords:this.#queue.length+Number(this.#active!==null),
      acceptedBytes:this.#bytes, pendingRecords:this.#waiting.length,pendingBytes:this.#pendingBytes});
  }
  #fits(e) {
    return this.#queue.length+Number(this.#active!==null)<this.#maxRecords &&
      e.bytes<=this.#maxBytes-this.#bytes;
  }
  #commit(e) {
    e.state='accepted'; this.#bytes+=e.bytes; this.#queue.push(e);
    e.admission.resolve(OK);
  }
  #finish(e,outcome) {
    e.state='terminal'; e.text=null; e.delivery.resolve(outcome);
  }
  #reject(e,outcome) {
    e.admission.resolve(outcome); this.#finish(e,outcome);
  }
  #promote() {
    if (this.#sealed || this.#failure) return;
    while (this.#waiting.length && this.#fits(this.#waiting[0])) {
      const e=this.#waiting.shift(); this.#pendingBytes-=e.bytes; this.#commit(e);
    }
  }
  // Outcomes are resolved rather than rejected: an unobserved delivery receipt
  // cannot generate an unhandled rejection. Cancellation wins only precommit.
  admit(text) {
    const a=receipt(), d=receipt();
    const e={text:null,bytes:0,state:'new',admission:a,delivery:d};
    const handle=Object.freeze({admitted:a.promise,delivered:d.promise,cancel:()=>{
      if(e.state!=='waiting') return false;
      const i=this.#waiting.indexOf(e);
      if(i<0) return false;
      this.#waiting.splice(i,1); this.#pendingBytes-=e.bytes;
      this.#reject(e,failed('CANCELLED')); this.#promote(); this.#schedule(); return true;
    }});
    if(this.#failure || this.#sealed) {this.#reject(e,this.#failure??failed('CLOSED'));return handle;}
    if(typeof text!=='string'||text.length>65536||!text.isWellFormed()) {
      this.#reject(e,failed('INVALID_RECORD'));return handle;
    }
    const bytes=encoder.encode(text).length;
    if(bytes>65536||bytes>this.#maxBytes) {this.#reject(e,failed('OVERSIZE'));return handle;}
    e.text=text;e.bytes=bytes;
    if(!this.#waiting.length&&this.#fits(e)) this.#commit(e);
    else if(this.#waiting.length>=this.#maxWaiters||bytes>this.#maxPendingBytes-this.#pendingBytes)
      this.#reject(e,failed('WAITER_QUOTA'));
    else {e.state='waiting';this.#waiting.push(e);this.#pendingBytes+=bytes;}
    this.#schedule();return handle;
  }
  #schedule() {
    if(this.#scheduled||this.#running||this.#failure||!this.#queue.length)return;
    this.#scheduled=true;
    // Yield to other event-loop work after at most 32 sink records.
    setTimeout(()=>{this.#scheduled=false;void this.#drain();},0);
  }
  async #drain() {
    if(this.#running||this.#failure)return;
    this.#running=true;
    try {
      for(let i=0;i<32&&this.#queue.length&&!this.#failure;i++) {
        const e=this.#queue.shift();this.#active=e;
        let sinkFailed=false;
        try {await this.#sink(e.text);}
        catch {sinkFailed=true;this.abort('SINK_FAILURE');}
        // The active record stays charged until its physical sink call exits,
        // even after abort has revoked the delivery receipt.
        this.#active=null;this.#bytes-=e.bytes;
        if(this.#failure||sinkFailed)return;
        this.#finish(e,OK);this.#promote();
      }
    } finally {this.#running=false;this.#finishClose();this.#schedule();}
  }
  #finishClose() {
    if(this.#sealed&&!this.#active&&!this.#queue.length) {
      this.#closed.resolve(this.#failure??OK);
      this.#physicallyDrained.resolve(this.#failure??OK);
    }
  }
  // Terminal receipt and actual sink quiescence are different witnesses.
  get physicallyDrained() { return this.#physicallyDrained.promise; }
  seal() {
    if(!this.#sealed) {
      this.#sealed=true;
      for(const e of this.#waiting)this.#reject(e,failed('CLOSED'));
      this.#waiting=[];this.#pendingBytes=0;
    }
    this.#finishClose();this.#schedule();return this.#closed.promise;
  }
  // Trusted owner calls on shutdown deadline, sink failure or revocation.
  // An already started host write cannot be retracted; no false delivery receipt.
  abort(code='ABORTED') {
    if(this.#failure||this.#sealed&&!this.#active&&!this.#queue.length)return false;
    this.#failure=failed(code);this.#sealed=true;
    for(const e of this.#waiting)this.#reject(e,this.#failure);
    for(const e of this.#queue)this.#finish(e,this.#failure);
    if(this.#active)this.#finish(this.#active,this.#failure);
    this.#waiting=[];this.#queue=[];
    this.#pendingBytes=0;this.#bytes=this.#active?.bytes??0;
    this.#closed.resolve(this.#failure);this.#finishClose();return true;
  }
}

// Worker-local wrapper: trusted runtime supplies an opaque object for each live
// logical execution generation. Never export raw handles to guest Wasm.
// The caller must validate tenant/actor authority before issuing an owner.
export class GenerationStdioHost {
  #buffer; #owners=new Map(); #limit;
  constructor(buffer, maxOwners=1024) {
    if(!(buffer instanceof BufferedStdioHost))throw new TypeError('trusted buffer required');
    this.#buffer=buffer;this.#limit=bounded(maxOwners,1024);
  }
  openOwner() {
    if(this.#owners.size>=this.#limit)throw new RangeError('stdio owner quota');
    const owner=Object.freeze(Object.create(null));
    this.#owners.set(owner,new Set());return owner;
  }
  admit(owner,text) {
    const pending=this.#owners.get(owner);
    if(!pending)return Object.freeze({admitted:Promise.resolve(failed('STALE_OWNER')),cancel:()=>false});
    // One unresolved admission per logical producer.
    if(pending.size)return Object.freeze({admitted:Promise.resolve(failed('OWNER_BUSY')),cancel:()=>false});
    const raw=this.#buffer.admit(text);
    const token={raw,revoked:false,receipt:receipt()};
    pending.add(token);
    raw.admitted.then(outcome=>{
      pending.delete(token);
      token.receipt.resolve(token.revoked?failed('STALE_OWNER'):outcome);
    });
    return Object.freeze({admitted:token.receipt.promise,cancel:()=>raw.cancel()});
  }
  retire(owner) {
    const pending=this.#owners.get(owner);
    if(!pending)return false;
    this.#owners.delete(owner);
    for(const token of pending) {
      token.revoked=true;token.raw.cancel();token.receipt.resolve(failed('STALE_OWNER'));
    }
    pending.clear();return true;
  }
}
