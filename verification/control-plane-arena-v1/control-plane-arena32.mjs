// Bounded control-plane host reference; not a compiled guest allocator.
// The payload and slot table live in explicit fixed linear storage.
// JS BigInt values, views, errors and wrapper objects may allocate on the host.
let nextIssuer=0;
const MASK=0xfffff, MAX_GENERATION=4095, RECORD=32, META=12;
export class ControlPlaneArena32 {
  static ABI="control_generation12_slot20_v1";
  #capacity; #issuer; #view; #backing; #head=1; #tail; #closed=false;
  constructor(capacity,mode){
    if(!Number.isInteger(capacity)||capacity<1||capacity>MASK)throw RangeError("capacity");
    if(mode!=="array-buffer"&&mode!=="wasm-linear")throw RangeError("backing mode");
    if(nextIssuer>=0xffffffff)throw Error("issuer exhausted");
    this.#issuer=++nextIssuer;this.#capacity=capacity;this.#tail=capacity;
    const bytes=capacity*(RECORD+META);
    if(mode==="wasm-linear"){
      const pages=Math.ceil(bytes/65536);
      this.#backing=new WebAssembly.Memory({initial:pages,maximum:pages});
      this.#view=new DataView(this.#backing.buffer,0,bytes);
    }else{
      this.#backing=new ArrayBuffer(bytes);
      this.#view=new DataView(this.#backing);
    }
    for(let i=0;i<capacity;i++){this.#set(i,0,1);this.#set(i,8,i+1<capacity?i+2:0);}
  }
  #offset(slot,field){return this.#capacity*RECORD+slot*META+field;}
  #get(slot,field){return this.#view.getUint32(this.#offset(slot,field),true);}
  #set(slot,field,value){this.#view.setUint32(this.#offset(slot,field),value,true);}
  #witness(word){return (BigInt(this.#issuer)<<32n)|BigInt(word>>>0);}
  #validate(handle){
    if(this.#closed||typeof handle!=="bigint"||handle<=0n||(handle>>32n)!==BigInt(this.#issuer))throw Error("closed or foreign handle");
    const word=Number(handle&0xffffffffn),low=word&MASK,generation=word>>>20;
    if(low===0||low>this.#capacity||generation===0)throw Error("invalid handle");
    const slot=low-1;
    if(this.#get(slot,4)!==1||this.#get(slot,0)!==generation)throw Error("stale handle");
    return slot;
  }
  tryAllocate(){
    if(this.#closed||this.#head===0)return 0n;
    const slot=this.#head-1,generation=this.#get(slot,0);
    if(generation===0||this.#get(slot,4)!==0)throw Error("invalid free slot");
    this.#head=this.#get(slot,8);if(this.#head===0)this.#tail=0;
    this.#set(slot,4,1);this.#set(slot,8,0);
    return this.#witness((generation<<20)|(slot+1));
  }
  drop(handle){
    const slot=this.#validate(handle),base=slot*RECORD;
    for(let i=0;i<RECORD;i+=4)this.#view.setUint32(base+i,0,true);
    this.#set(slot,4,0);
    const generation=this.#get(slot,0);
    if(generation===MAX_GENERATION)this.#set(slot,0,0);
    else{
      this.#set(slot,0,generation+1);this.#set(slot,8,0);
      if(this.#tail===0)this.#head=slot+1;else this.#set(this.#tail-1,8,slot+1);
      this.#tail=slot+1;
    }
  }
  #scalarOffset(handle,field){
    const slot=this.#validate(handle);
    if(field!==0&&field!==8)throw RangeError("scalar field");
    return slot*RECORD+field;
  }
  writeI64(handle,field,value){
    const offset=this.#scalarOffset(handle,field);
    if(typeof value!=="bigint"||value<-(1n<<63n)||value>(1n<<63n)-1n)throw RangeError("i64");
    this.#view.setBigInt64(offset,value,true);
  }
  readI64(handle,field){return this.#view.getBigInt64(this.#scalarOffset(handle,field),true);}
  writeRef32(parent,child){
    const slot=this.#validate(parent);
    if(child!==0n)this.#validate(child);
    this.#view.setUint32(slot*RECORD+16,Number(child&0xffffffffn),true);
  }
  readRef32(parent){
    const slot=this.#validate(parent),word=this.#view.getUint32(slot*RECORD+16,true);
    if(word===0)return 0n;
    const child=this.#witness(word);this.#validate(child);return child;
  }
  close(){
    if(this.#closed)return;
    // Explicit logical invalidation and zeroing, not proof of physical release:
    // ArrayBuffer/WebAssembly.Memory backing reclamation is host-owned.
    new Uint8Array(this.#view.buffer).fill(0);
    this.#closed=true;this.#view=null;this.#backing=null;
  }
}
