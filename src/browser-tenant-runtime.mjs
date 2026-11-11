import {createTurnQueue} from './tenant-turn-queue.mjs';
export const MAX_TENANT_ACTORS=16;
export const MAX_ACTOR_MAIL=10000;
export const MAX_TENANT_MAIL=20000;
export const MAX_TENANT_MEMORY=16*1024*1024;

/** One execution of compiler-emitted code; instances own separate wasm32 heaps.
 * The parent owns the Worker deadline. Individual guest turns remain synchronous.
 * This is not an arbitrary-JavaScript sandbox or source-level task lowering.
 */
function execution(guest){
  if(typeof guest?.instantiate!=='function'||!Array.isArray(guest.actorNames)||guest.actorNames.length>256)
    throw Error('E_ABI: canonical guest factory required');
  const actors=[],memories=new Set();
  let phase='initializing',active=null,activeActor=null,stdout='',truncated=false;
  let memoryBytes=0,instanceBytes=0,pending=0,cursor=0,turns=0,value;
  const open=()=>{if(phase==='closed')throw Error('E_TENANT_CLOSED: execution finished');};
  function write(text){
    open();if(truncated)return;
    const room=65536-stdout.length;
    if(text.length<=room){stdout+=text;return;}
    let cut=room;if(cut>0&&/[\uD800-\uDBFF]/.test(text[cut-1]))cut--;
    stdout+=text.slice(0,cut);truncated=true;
  }
  function instance(inActor){
    if(inActor&&memoryBytes+instanceBytes>MAX_TENANT_MEMORY)
      throw Error('E_TENANT_MEMORY: aggregate guest memory limit');
    let e;
    const atto=Object.freeze({
      print_i64:n=>write(String(n)),print_bool:n=>write(n?'true':'false'),
      print_newline:()=>write('\n'),
      print_str:(ptr,len)=>{
        if(!e.memory||!Number.isInteger(ptr)||!Number.isInteger(len)||ptr<0||len<0||ptr+len>e.memory.buffer.byteLength)
          throw Error('E_MEMORY: invalid print span');
        write(new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(e.memory.buffer,ptr,len)));
      },
      actor_spawn:type=>{
        open();if(inActor||phase!=='main')throw Error('E_ACTOR: spawn unavailable in this turn');
        if(!Number.isInteger(type)||type<0||type>=guest.actorNames.length)throw Error('E_ACTOR: unknown actor type');
        if(actors.length>=MAX_TENANT_ACTORS)throw Error('E_ACTOR_LIMIT: at most 16 actors per tenant run');
        const actor={ref:actors.length,type,e:instance(true),mail:[],next:0};
        activeActor=actor;active=actor.e;
        actor.e.actor_init(type);
        activeActor=null;active=e;
        actors.push(actor);return actor.ref;
      },
      actor_send:(ref,n)=>{
        open();if(inActor||phase!=='main')throw Error('E_ACTOR: send unavailable in this turn');
        const a=Number.isInteger(ref)?actors[ref]:null;
        if(!a||typeof n!=='bigint'||n<-(1n<<63n)||n>(1n<<63n)-1n)throw Error('E_ACTOR: invalid reference/mail');
        if(a.mail.length>=MAX_ACTOR_MAIL)throw Error('E_MAILBOX_FULL: at most 10000 messages per actor run');
        if(pending>=MAX_TENANT_MAIL)throw Error('E_TENANT_MAIL: aggregate mailbox limit');
        a.mail.push(n);pending++;
      }
    });
    e=guest.instantiate(atto).exports;
    if(!e||typeof e.main!=='function')throw Error('E_ABI: main export required');
    if(guest.actorNames.length&&(!e.memory||typeof e.actor_init!=='function'||typeof e.actor_receive!=='function'))
      throw Error('E_ABI: actor exports/private memory required');
    if(e.memory){
      const memory=e.memory,buffer=memory.buffer;
      if(!(memory instanceof WebAssembly.Memory)||(typeof SharedArrayBuffer==='function'&&buffer instanceof SharedArrayBuffer)||memories.has(buffer))
        throw Error('E_MEMORY: expected private per-instance wasm32 memory');
      const bytes=buffer.byteLength;
      if(bytes>1024*1024||(inActor&&bytes!==instanceBytes)||memoryBytes+bytes>MAX_TENANT_MEMORY)
        throw Error('E_TENANT_MEMORY: invalid or excessive guest memory');
      memories.add(buffer);memoryBytes+=bytes;
      if(!inActor)instanceBytes=bytes;
    }
    return e;
  }
  return {
    start(){active=instance(false);phase='main';value=active.main();
      if(typeof value!=='bigint'||value<-(1n<<63n)||value>(1n<<63n)-1n)throw Error('E_ABI: main must return signed i64');
      phase='drain';},
    hasTurn(){return pending>0;},
    step(){
      if(phase!=='drain')throw Error('E_SCHEDULER: actor turn outside drain');
      for(let i=0;i<actors.length;i++){
        const a=actors[cursor];cursor=(cursor+1)%actors.length;
        if(a.next===a.mail.length)continue;
        activeActor=a;active=a.e;
        const sequence=a.next;a.e.actor_receive(a.type,a.mail[sequence],BigInt(sequence));
        a.mail[sequence]=null;a.next++;pending--;turns++;return;
      }
      if(pending)throw Error('E_SCHEDULER: inconsistent mailbox accounting');
    },
    result(error=null){
      const base={stdout,truncated,actors:actors.length,privateMemories:memories.size,tenantMemoryBytes:memoryBytes,turns};
      if(!error)return {ok:true,value:value.toString(),...base};
      const code=active?.panic_code?.value;
      let message=code===1?'E_PANIC: integer overflow':code===3?'E_PANIC: object heap exhausted':
        error instanceof RangeError?'E_PANIC: stack exhausted (recursion too deep)':String(error?.message||error);
      if(activeActor)message+=' in actor '+guest.actorNames[activeActor.type]+'#'+activeActor.ref;
      return {ok:false,message,...base};
    },
    close(){phase='closed';for(const a of actors)a.mail.length=0;actors.length=0;memories.clear();active=null;activeActor=null;}
  };
}
/** Synchronous compatibility harness; real tenant Workers use runTenantGuest. */
export function runCanonicalGuest(guest){
  const e=execution(guest);
  try{e.start();while(e.hasTurn())e.step();return e.result();}
  catch(error){return e.result(error);}finally{e.close();}
}
/** Round-robin actor turns; yield a MessageChannel task between turns. */
export async function runTenantGuest(guest){
  const e=execution(guest),queue=createTurnQueue();
  try{
    await queue.yieldTurn();e.start();
    while(e.hasTurn()){await queue.yieldTurn();e.step();}
    return e.result();
  }catch(error){return e.result(error);}finally{e.close();queue.close();}
}
