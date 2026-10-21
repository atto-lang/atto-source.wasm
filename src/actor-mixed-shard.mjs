import {ActorArena} from "./actor-arena.mjs";
import {MixedLayoutGeometry} from "./mixed-layout-geometry.mjs";

// One actor-owned allocation inside WebAssembly.Memory (not a source-compiled
// guest actor or an unforgeable guest reference). No live buffer view escapes.
const alloc=ActorArena.prototype.allocPersistent;
const drop=ActorArena.prototype.dropPersistent;
const readBytes=ActorArena.prototype.readRangeInto;
const writeBytes=ActorArena.prototype.writeRange;
const subarray=Uint8Array.prototype.subarray;
const fill=Uint8Array.prototype.fill;
const readU32=DataView.prototype.getUint32;
const writeU32=DataView.prototype.setUint32;
const readF64=DataView.prototype.getFloat64;
const writeF64=DataView.prototype.setFloat64;
const readU8=DataView.prototype.getUint8;
const writeU8=DataView.prototype.setUint8;

export class ActorMixedShard {
  #arena; #handle; #geometry; #staging=new Uint8Array(8);
  #view=new DataView(this.#staging.buffer); #released=false;
  constructor(arena,turn,options) {
    if(!options || typeof options!=="object")throw new TypeError("mixed shard options required");
    this.#geometry=new MixedLayoutGeometry({...options,maxBytes:65536});
    if(this.#geometry.rows===0 || this.#geometry.byteLength===0)
      throw new RangeError("actor shard requires nonzero persistent storage");
    this.#arena=arena;
    this.#handle=alloc.call(arena,turn,this.#geometry.byteLength);
  }
  get rows(){return this.#geometry.rows;}
  get fields(){return this.#geometry.fields;}
  get layout(){return this.#geometry.layout;}
  get byteLength(){return this.#geometry.byteLength;}
  get payloadBytes(){return this.#geometry.payloadBytes;}
  #live(){if(this.#released)throw new Error("mixed actor shard released");}
  address(row,field){this.#live();return this.#geometry.address(row,field);}
  read(turn,row,field){
    const addr=this.address(row,field),width=addr.type==="f64"?8:addr.type==="bool"?1:4;
    readBytes.call(this.#arena,turn,this.#handle,addr.absoluteByteOffset,
      subarray.call(this.#staging,0,width));
    switch(addr.type){
      case "u32":case "ref32":return readU32.call(this.#view,0,true);
      case "f64":return readF64.call(this.#view,0,true);
      case "bool":return readU8.call(this.#view,0)!==0;
      default:throw new Error("unsupported mixed scalar");
    }
  }
  write(turn,row,field,value){
    const addr=this.address(row,field);
    let width;
    switch(addr.type){
      case "u32":case "ref32":
        if(!Number.isInteger(value)||value<0||value>0xffffffff)
          throw new RangeError("u32/ref32 must be an unsigned 32-bit word");
        writeU32.call(this.#view,0,value,true);width=4;break;
      case "f64":
        if(typeof value!=="number")throw new TypeError("f64 required");
        writeF64.call(this.#view,0,value,true);width=8;break;
      case "bool":
        if(typeof value!=="boolean")throw new TypeError("bool required");
        writeU8.call(this.#view,0,value?1:0);width=1;break;
      default:throw new Error("unsupported mixed scalar");
    }
    writeBytes.call(this.#arena,turn,this.#handle,addr.absoluteByteOffset,
      subarray.call(this.#staging,0,width));
  }
  integrate(turn,positionField,velocityField,dt){
    this.#live();
    if(positionField===velocityField||!Number.isFinite(dt)||
      this.#geometry.typeOf(positionField)!=="f64"||
      this.#geometry.typeOf(velocityField)!=="f64")
      throw new RangeError("integrate requires distinct f64 fields and finite dt");
    for(let r=0;r<this.rows;r++){
      this.write(turn,r,positionField,this.read(turn,r,positionField)+
        this.read(turn,r,velocityField)*dt);
    }
  }
  release(turn){
    if(this.#released)return;
    drop.call(this.#arena,turn,this.#handle);
    this.#released=true;
    fill.call(this.#staging,0);
  }
}
