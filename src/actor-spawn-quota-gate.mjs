// Trusted single-Worker host bookkeeping only; not Wasm guest lowering or
// physical engine memory release. Guest code must never receive these tokens.
const MAX = (1n << 64n) - 1n;
const dims = 4;
const valid = c => Array.isArray(c) && c.length === dims &&
  c.every(x => typeof x === "bigint" && x > 0n && x <= MAX);
const deny = code => { throw new Error(code); };
export class ActorSpawnQuotaGate {
  #limit; #used = [0n,0n,0n,0n]; #entries; #receives; #generation = 0n;
  constructor(limit, slots, receives) {
    if (!valid(limit) || !Number.isSafeInteger(slots) || slots < 1 ||
        !Number.isSafeInteger(receives) || receives < 1 || slots * receives > 65536)
      deny("E_SPAWN_POLICY");
    this.#limit = [...limit];
    this.#entries = Array(slots).fill(null);
    this.#receives = receives;
  }
  get usage() { return [...this.#used]; }
  reserve(charge) {
    if (!valid(charge) || charge.some((x,i) => x > this.#limit[i]-this.#used[i]))
      deny("E_SPAWN_QUOTA");
    const slot = this.#entries.indexOf(null);
    if (slot < 0) deny("E_SPAWN_FULL");
    if (this.#generation === MAX) deny("E_SPAWN_GENERATION");
    const p = Object.freeze({generation: this.#generation+1n});
    const entry = {p, charge: [...charge], phase: "init", initStarted: false,
      init: null, receives: Array(this.#receives).fill(null)};
    this.#entries[slot] = entry;
    for (let i=0;i<dims;i++) this.#used[i]+=entry.charge[i];
    this.#generation=p.generation;
    return p;
  }
  #entry(p) {
    const e=this.#entries.find(e=>e!==null && e.p===p);
    if (!e) deny("E_SPAWN_STALE_PERMIT");
    return e;
  }
  beginInit(p) {
    const e=this.#entry(p);
    if(e.phase!=="init" || e.initStarted) deny("E_SPAWN_INIT_AUTHORITY");
    const lease=Object.freeze({p});
    e.initStarted=true; e.init=lease;
    return lease;
  }
  completeInit(lease, success) {
    const e=this.#entry(lease?.p);
    if(e.init!==lease || e.init===null || typeof success!=="boolean")
      deny("E_SPAWN_INIT_AUTHORITY");
    e.init=null;
    if(!success || e.phase==="retiring") {e.phase="retiring"; return false;}
    e.phase="ready"; return true;
  }
  tryEnterReceive(p) {
    const e=this.#entry(p);
    if(e.phase!=="ready") return null;
    const i=e.receives.indexOf(null);
    if(i<0) deny("E_SPAWN_FULL");
    const lease=Object.freeze({p});
    e.receives[i]=lease; return lease;
  }
  finishReceive(lease) {
    const e=this.#entry(lease?.p);
    const i=e.receives.indexOf(lease);
    if(i<0 || lease===null) deny("E_SPAWN_STALE_PERMIT");
    e.receives[i]=null;
  }
  retire(p) { this.#entry(p).phase="retiring"; }
  // Trusted scheduler only, AFTER arena scrubbing, task and external pin
  // retirement. This ledger cannot certify those physical prerequisites.
  releaseAfterQuiescence(p) {
    const e=this.#entry(p);
    if(e.phase!=="retiring") deny("E_SPAWN_NOT_RETIRED");
    if(e.init!==null || e.receives.some(x=>x!==null)) deny("E_SPAWN_IN_FLIGHT");
    for(let i=0;i<dims;i++) this.#used[i]-=e.charge[i];
    this.#entries[this.#entries.indexOf(e)]=null;
  }
}
