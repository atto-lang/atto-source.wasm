// Trusted worker host adapter. No guest imports, no cross-worker shared heap,
// no callback dispatch into Wasm. The owner must authenticate execution IDs
// against its live scheduler registry before calling these methods.
import {BufferedStdioHost} from '../buffered-stdio-host.mjs';
const STALE=Object.freeze({ok:false,code:'STALE'});
const QUOTA=Object.freeze({ok:false,code:'WAITER_QUOTA'});
const PENDING=Object.freeze({pending:true});
const valid=n=>Number.isSafeInteger(n)&&n>0;
export class TenantStdioAdmission {
  #channel; #limit; #entries=new Map(); #sealed=false;
  constructor(sink,maxRecords=1024,maxBytes=4194304,maxWaiters=64,maxPendingBytes=1048576) {
    this.#channel=new BufferedStdioHost(sink,maxRecords,maxBytes,maxWaiters,maxPendingBytes);
    this.#limit=maxWaiters;
  }
  // All retained tickets (including completed but unconsumed) share the
  // bound. The token's object identity prevents cross-descriptor replay.
  admit(execution,generation,text) {
    if(!valid(execution)||!valid(generation))return STALE;
    if(this.#sealed)return Object.freeze({ok:false,code:'CLOSED'});
    if(this.#entries.size>=this.#limit)return QUOTA;
    const ticket=Object.freeze(Object.create(null));
    const handle=this.#channel.admit(text);
    const entry={execution,generation,handle,result:PENDING};
    this.#entries.set(ticket,entry);
    // Promise notification stores readiness only, never executes a guest.
    void handle.admitted.then(result=>{
      if(this.#entries.get(ticket)===entry)entry.result=result;
    });
    return Object.freeze({ticket});
  }
  #match(execution,generation,ticket) {
    const e=this.#entries.get(ticket);
    return e&&e.execution===execution&&e.generation===generation?e:null;
  }
  takeReady(execution,generation,ticket) {
    const e=this.#match(execution,generation,ticket);
    if(!e)return STALE;
    if(e.result===PENDING)return PENDING;
    this.#entries.delete(ticket);
    return e.result;
  }
  cancel(execution,generation,ticket) {
    const e=this.#match(execution,generation,ticket);
    if(!e||!e.handle.cancel())return false;
    this.#entries.delete(ticket);
    return true;
  }
  retire(execution,generation) {
    for(const [ticket,e] of this.#entries) {
      if(e.execution!==execution||e.generation!==generation)continue;
      this.#entries.delete(ticket);e.handle.cancel();
    }
  }
  get retainedReceipts(){return this.#entries.size;}
  get accounting(){return this.#channel.accounting;}
  get quiescence(){return this.#channel.quiescence;}
  seal(){this.#sealed=true;return this.#channel.seal();}
  abort(){this.#sealed=true;return this.#channel.abort();}
}
