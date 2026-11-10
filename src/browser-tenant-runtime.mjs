/** Run compiler-emitted ESM inside a disposable tenant Worker.
 * One instance/private wasm32 memory per actor. The owning page MUST terminate
 * the Worker on cancellation/deadline; synchronous guest loops cannot yield.
 * Only use modules emitted by the pinned canonical compiler, never arbitrary JS.
 */
export function runCanonicalGuest(guest) {
  if(typeof guest?.instantiate!=='function'||!Array.isArray(guest.actorNames))
    throw Error('E_ABI: canonical ESM module required');
  const actors=[],memories=new Set();
  let stdout='',truncated=false;
  function write(text){
    if(truncated)return;
    const room=65536-stdout.length;
    if(text.length<=room){stdout+=text;return;}
    let cut=room;
    if(cut>0&&/[\uD800-\uDBFF]/.test(text[cut-1]))cut--;
    stdout+=text.slice(0,cut);truncated=true;
  }
  function instance(inActor){
    let e;
    const atto={
      print_i64:n=>write(String(n)),print_bool:n=>write(n?'true':'false'),
      print_newline:()=>write('\n'),
      print_str:(ptr,len)=>{
        if(!e.memory||!Number.isInteger(ptr)||!Number.isInteger(len)||ptr<0||len<0||ptr+len>e.memory.buffer.byteLength)
          throw Error('E_MEMORY: invalid print span');
        write(new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(e.memory.buffer,ptr,len)));
      },
      actor_spawn:type=>{
        if(inActor)throw Error('E_ACTOR: nested spawn unsupported');
        if(!Number.isInteger(type)||type<0||type>=guest.actorNames.length)throw Error('E_ACTOR: unknown actor type');
        if(actors.length>=16)throw Error('E_ACTOR_LIMIT: at most 16 actors per tenant run');
        const actor={type,e:instance(true),mail:[]};
        actor.e.actor_init(type);actors.push(actor);return actors.length-1;
      },
      actor_send:(ref,value)=>{
        if(inActor)throw Error('E_ACTOR: nested send unsupported');
        const a=Number.isInteger(ref)?actors[ref]:null;
        if(!a||typeof value!=='bigint'||value<-(1n<<63n)||value>(1n<<63n)-1n)throw Error('E_ACTOR: invalid reference/mail');
        if(a.mail.length>=10000)throw Error('E_MAILBOX_FULL: at most 10000 messages per actor run');
        a.mail.push(value);
      }
    };
    e=guest.instantiate(Object.freeze(atto)).exports;
    if(e.memory){
      if(!(e.memory instanceof WebAssembly.Memory)||(typeof SharedArrayBuffer==='function'&&e.memory.buffer instanceof SharedArrayBuffer)||memories.has(e.memory.buffer))
        throw Error('E_MEMORY: expected private per-instance wasm32 memory');
      memories.add(e.memory.buffer);
    }
    return e;
  }
  let active;
  try{
    active=instance(false);
    const value=active.main();
    if(typeof value!=='bigint')throw Error('E_ABI: main must return signed i64');
    for(const a of actors){active=a.e;for(let i=0;i<a.mail.length;i++)a.e.actor_receive(a.type,a.mail[i],BigInt(i));}
    return {ok:true,value:value.toString(),stdout,truncated,actors:actors.length,privateMemories:memories.size};
  }catch(error){
    const code=active?.panic_code?.value;
    return {ok:false,message:code===1?'E_PANIC: integer overflow':code===3?'E_PANIC: object heap exhausted':String(error.message),stdout,truncated,actors:actors.length};
  }
}
