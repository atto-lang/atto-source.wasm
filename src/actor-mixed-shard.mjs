import {ActorArena} from "./actor-arena.mjs";
import {MixedLayoutGeometry} from "./mixed-layout-geometry.mjs";

// One actor-owned allocation inside WebAssembly.Memory (not a source-compiled
// guest actor or an unforgeable guest reference). No live buffer view escapes.
const nativeInteger = Number.isInteger;
const nativeFinite = Number.isFinite;
const alloc=ActorArena.prototype.allocPersistent;
const drop=ActorArena.prototype.dropPersistent;
const readBytes=ActorArena.prototype.readRangeInto;
const writeBytes=ActorArena.prototype.writeRange;
const fill=Uint8Array.prototype.fill;
const readU32=DataView.prototype.getUint32;
const writeU32=DataView.prototype.setUint32;
const readF64=DataView.prototype.getFloat64;
const writeF64=DataView.prototype.setFloat64;
const readU8=DataView.prototype.getUint8;
const writeU8=DataView.prototype.setUint8;

export class ActorMixedShard {
  #arena; #handle; #geometry; #staging=new Uint8Array(8);
  #one=new Uint8Array(this.#staging.buffer,0,1);
  #four=new Uint8Array(this.#staging.buffer,0,4);
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
    this.#live();
    const offset=this.#geometry.offsetAt(row,field);
    const type=this.#geometry.typeOf(field);
    const cell=type==="f64"?this.#staging:type==="bool"?this.#one:this.#four;
    readBytes.call(this.#arena,turn,this.#handle,offset,cell);
    switch(type){
      case "u32":case "ref32":return readU32.call(this.#view,0,true);
      case "f64":return readF64.call(this.#view,0,true);
      case "bool": {
        const encoded=readU8.call(this.#view,0);
        if (encoded > 1) throw new RangeError("noncanonical bool byte in actor storage");
        return encoded === 1;
      }
      default:throw new Error("unsupported mixed scalar");
    }
  }
  write(turn,row,field,value){
    this.#live();
    const offset=this.#geometry.offsetAt(row,field);
    const type=this.#geometry.typeOf(field);
    let cell;
    switch(type){
      case "u32":case "ref32":
        if(!nativeInteger(value)||value<0||value>0xffffffff)
          throw new RangeError("u32/ref32 must be an unsigned 32-bit word");
        writeU32.call(this.#view,0,value,true);cell=this.#four;break;
      case "f64":
        if(typeof value!=="number")throw new TypeError("f64 required");
        writeF64.call(this.#view,0,value,true);cell=this.#staging;break;
      case "bool":
        if(typeof value!=="boolean")throw new TypeError("bool required");
        writeU8.call(this.#view,0,value?1:0);cell=this.#one;break;
      default:throw new Error("unsupported mixed scalar");
    }
    writeBytes.call(this.#arena,turn,this.#handle,offset,cell);
  }
  integrate(turn,positionField,velocityField,dt){
    this.#live();
    if(positionField===velocityField||!nativeFinite(dt)||
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
