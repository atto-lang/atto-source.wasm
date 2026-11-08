/**
 * Browser tenant host for Rust atto-source.rs integrated source-actor guest.
 *
 * Distinct from import-free scalar browser-tenant-worker.mjs. This host
 * instantiates an identical approved, compiler-produced guest separately for
 * each actor; it NEVER executes main(), and NEVER grants nested actor/stdio
 * imports to actor receives. That permits one Worker per tenant with separate
 * mutable Wasm state for all same-tenant actors, but no preemptive scheduling.
 */
import {admitAttoBrowserActor,ATTO_ACTOR_ABI,ATTO_MAX_MEMORY_PAGES} from './browser-atto-actor-admission.mjs';
const actors=new Map();
const MAX_ACTORS=16, MAX_PENDING=64;
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
let poisoned=false,lastTicket=0,pending=0,lane=Promise.resolve();
const validId=id=>Number.isSafeInteger(id)&&id>0&&id<=0x7fffffff;
const validGen=x=>typeof x==='string'&&/^[0-9a-f]{32}$/.test(x);
class Rejected extends Error {}
const deny=()=>{throw Error('ATTO_ACTOR_NESTED_OR_STDIO_CAPABILITY_DENIED');};
const atto=Object.freeze({
  actor_spawn:deny,actor_send:deny,actor_join:deny,
  print_i64:deny,print_bool:deny,print_str:deny,print_newline:deny
});
function scrub(actor) {
  if(actor.memory) {
    const buffer=actor.memory.buffer;
    if(typeof SharedArrayBuffer!=='undefined' && buffer instanceof SharedArrayBuffer)
      throw Error('shared actor memory cannot be retired');
    new Uint8Array(buffer).fill(0);
  }
}
async function handle(data) {
  if(poisoned)return;
  const ticket=data?.ticket;
  try {
    if(!Number.isSafeInteger(ticket)||ticket<=lastTicket||
       !validId(data?.id)||!validGen(data?.incarnation)||
       !['spawn','send','stop'].includes(data?.kind))
      throw new Rejected('invalid or replayed tenant request');
    lastTicket=ticket;
    const {id,incarnation,kind}=data;
    if(kind==='spawn'){
      if(actors.has(id))throw new Rejected('duplicate actor ID');
      if(actors.size>=MAX_ACTORS)throw new Rejected('tenant actor capacity exceeded');
      if(data.trusted!==true||data.profile!==ATTO_ACTOR_ABI||
         !Number.isInteger(data.actorId)||data.actorId<0||data.actorId>1024)
        throw new Rejected('integrated Atto actor requires approved profile and handler');
      let admitted;
      try{admitted=await admitAttoBrowserActor(data.bytes,data.approvedSha256,data.actorId);}
      catch{throw new Rejected('Atto guest artifact admission denied');}
      // All imports in this actor-only instance deny nested spawn/send/stdio.
      // Only trusted, verified pure numeric receive handlers may execute.
      const instance=await WebAssembly.instantiate(admitted.module,{atto});
      const receiver=instance.exports['atto_actor_receive_'+data.actorId];
      const panic=instance.exports.panic_code;
      const memory=instance.exports.memory ?? null;
      if(typeof receiver!=='function'||
         !(panic instanceof WebAssembly.Global)||typeof panic.value!=='number')
        throw Error('integrated actor runtime ABI mismatch');
      if((!!memory)!==admitted.abi.hasMemory||
         (memory&&(!(memory instanceof WebAssembly.Memory)||
          (typeof SharedArrayBuffer!=='undefined'&&memory.buffer instanceof SharedArrayBuffer)||
          memory.buffer.byteLength>ATTO_MAX_MEMORY_PAGES*65536)))
        throw Error('integrated actor private memory mismatch');
      actors.set(id,{instance,receiver,memory,incarnation,actorId:data.actorId});
      self.postMessage({kind:'ack',ticket,id,incarnation,result:null});
      return;
    }
    const actor=actors.get(id);
    if(!actor||actor.incarnation!==incarnation)
      throw new Rejected('missing or stale actor generation');
    if(kind==='send'){
      if(typeof data.value!=='bigint'||data.value<MIN||data.value>MAX)
        throw new Rejected('integrated actor messages require signed i64');
      let result;
      try{result=actor.receiver(data.value);}
      catch(error){
        if(!(error instanceof WebAssembly.RuntimeError)||error.message!=='unreachable')
          throw error;
        actors.delete(id);
        scrub(actor); // Cleanup must succeed before sending actor-local proof.
        self.postMessage({kind:'actor_fault',code:'WASM_UNREACHABLE_V1',
          ticket,id,incarnation});
        return;
      }
      if(typeof result!=='bigint'||result<MIN||result>MAX)
        throw Error('integrated actor receive signature/runtime mismatch');
      self.postMessage({kind:'ack',ticket,id,incarnation,result});
      return;
    }
    // Rust guest has no teardown export; revoke then scrub private memory.
    actors.delete(id);
    scrub(actor);
    self.postMessage({kind:'ack',ticket,id,incarnation,result:null});
  }catch(error){
    if(error instanceof Rejected){
      self.postMessage({kind:'rejected',ticket,id:data?.id,
        incarnation:data?.incarnation,reason:error.message.slice(0,160)});
      return;
    }
    poisoned=true;
    self.postMessage({kind:'fatal',ticket,id:data?.id,incarnation:data?.incarnation,
      reason:String(error?.message||error).slice(0,160)});
    // Parent MUST terminate poisoned Worker; arbitrary engine stack exhaustion,
    // unexpected guest traps or failed memory cleanup cannot be actor-local.
  }
}
self.onmessage=({data})=>{
  if(poisoned)return;
  if(++pending>MAX_PENDING){
    poisoned=true;
    self.postMessage({kind:'fatal',ticket:data?.ticket,id:data?.id,
      incarnation:data?.incarnation,reason:'integrated tenant mailbox exhausted'});
    return;
  }
  lane=lane.then(()=>handle(data)).catch(error=>{
    poisoned=true;
    self.postMessage({kind:'fatal',ticket:data?.ticket,id:data?.id,
      incarnation:data?.incarnation,reason:String(error?.message||error).slice(0,160)});
  }).finally(()=>{pending--;});
};
