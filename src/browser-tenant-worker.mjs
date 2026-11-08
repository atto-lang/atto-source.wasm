/** Experimental trusted browser tenant: ONE Web Worker, MANY private instances.
 * Not a production sandbox, a preemptive scheduler, or source actor lowering.
 * Parent MUST terminate this Worker on a deadline or fatal condition. */
import {admitBrowserActor} from './browser-tenant-admission.mjs';
const actors = new Map();
const MAX_ACTORS = 16;
let poisoned = false;
const MIN = -(1n<<63n), MAX = (1n<<63n)-1n;
const asId = id => Number.isSafeInteger(id) && id>0 && id<=0x7fffffff;

async function handle(data) {
  const ticket = data?.ticket;
  if (poisoned) return; // Parent must terminate this carrier.
  try {
    if (!Number.isSafeInteger(ticket) || ticket<=0 ||
        !asId(data?.id) || !['spawn','send','stop'].includes(data?.kind))
      throw Error('invalid tenant operation');
    const {kind,id} = data;
    if (kind==='spawn') {
      if (actors.has(id)) throw Error('duplicate actor ID');
      if (actors.size>=MAX_ACTORS) throw Error('tenant actor capacity exceeded');
      // This is a reference host for reviewed/trusted artifacts only. A hash
      // supplied by the guest itself does not authenticate source provenance.
      if (data.trusted!==true) throw Error('untrusted browser actor pooling is unsupported');
      const module = await admitBrowserActor(data.bytes, data.approvedSha256);
      const instance = await WebAssembly.instantiate(module, {});
      if (instance.exports.oreslang_wasm_actor_init()!==undefined) throw Error('actor init ABI mismatch');
      const memory = instance.exports.memory;
      if (!(memory instanceof WebAssembly.Memory) ||
          (typeof SharedArrayBuffer !== 'undefined' && memory.buffer instanceof SharedArrayBuffer) ||
          memory.buffer.byteLength!==131072)
        throw Error('actor memory boundary mismatch');
      actors.set(id,{instance,memory});
      self.postMessage({ticket,id,kind:'ack',result:null});
      return;
    }
    const actor = actors.get(id);
    if (!actor) throw Error('unknown or retired actor ID');
    if (kind==='send') {
      if (typeof data.value!=='bigint' || data.value<MIN || data.value>MAX)
        throw Error('actor message must be signed i64');
      let value;
      try {value=actor.instance.exports.oreslang_wasm_actor_on_message(data.value);}
      catch (e) {
        // Only exact synchronous unreachable is locally retired. Any other
        // trap, including engine stack exhaustion, poisons the WHOLE tenant.
        if (!(e instanceof WebAssembly.RuntimeError) || e.message!=='unreachable') throw e;
        actors.delete(id);
        new Uint8Array(actor.memory.buffer).fill(0);
        self.postMessage({ticket,id,kind:'actor_fault',code:'WASM_UNREACHABLE_V1'});
        return;
      }
      if (typeof value!=='bigint' || value<MIN || value>MAX) throw Error('actor reply ABI mismatch');
      self.postMessage({ticket,id,kind:'ack',result:value});
      return;
    }
    actors.delete(id); // Never re-enter a partially torn down actor.
    if (actor.instance.exports.oreslang_wasm_actor_teardown()!==undefined)
      throw Error('actor teardown ABI mismatch');
    new Uint8Array(actor.memory.buffer).fill(0);
    self.postMessage({ticket,id,kind:'ack',result:null});
  } catch (e) {
    poisoned=true;
    self.postMessage({ticket,id:data?.id,kind:'fatal',reason:String(e?.message||e).slice(0,160)});
    // Never claim retirement or recovery from a fatal trap. The supervising
    // parent must terminate the Worker and wait for its termination receipt.
  }
}

// Crypto digest and WebAssembly compilation suspend the JavaScript handler.
// Serialize *all* Worker messages across those awaits; otherwise simultaneous
// SPAWN requests can race capacity/identity checks before either registers.
let lane = Promise.resolve();
let pending = 0;
self.onmessage = ({data}) => {
  if (poisoned) return;
  if (++pending > 64) {
    poisoned = true;
    self.postMessage({ticket:data?.ticket,id:data?.id,kind:'fatal',
      reason:'tenant mailbox admission exhausted'});
    return;
  }
  lane = lane.then(() => handle(data)).catch(error => {
    poisoned = true;
    self.postMessage({ticket:data?.ticket,id:data?.id,kind:'fatal',
      reason:String(error?.message || error).slice(0,160)});
  }).finally(() => {pending--;});
};
