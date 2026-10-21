// Private mixed-width layout geometry. A scalar ref32 is an encoded word only,
 // not a dereference capability. No WebAssembly or JS guest compilation claimed.
const NativeMap = Map;
const NativeSet = Set;
const mapHas = Map.prototype.has;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const arrayMap = Array.prototype.map;
const arrayForEach = Array.prototype.forEach;
const arrayIncludes = Array.prototype.includes;
const isArray = Array.isArray;
const safeInteger = Number.isSafeInteger;
const hasOwn = Object.hasOwn;
const TYPES = Object.freeze({u32:Object.freeze({bytes:4,alignment:4}),f64:Object.freeze({bytes:8,alignment:8}),bool:Object.freeze({bytes:1,alignment:1}),ref32:Object.freeze({bytes:4,alignment:4})});
const align = (v,a)=>(v+a-1n)/a*a;
class MixedLayoutGeometry {
  #fields; #byName; #segments; #locators; #rows; #layout; #tileWidth; #allocationBytes; #totalBytes;
  constructor({fields,rows,layout,tileWidth,groups,maxBytes=16*1024*1024}={}) {
    if (!isArray(fields)||fields.length===0||fields.length>1024) throw new TypeError("1..1024 field declarations required");
    if (!safeInteger(rows)||rows<0) throw new RangeError("invalid logical row count");
    if (!safeInteger(maxBytes)||maxBytes<0||maxBytes>256*1024*1024) throw new RangeError("invalid physical byte cap");
    if (!arrayIncludes.call(["aos","soa","aosoa","soaos"],layout)) throw new RangeError("unsupported mixed layout");
    if (layout==="aosoa") {
      if (!safeInteger(tileWidth)||tileWidth<1||tileWidth>1024||(tileWidth&(tileWidth-1))!==0) throw new RangeError("AoSoA tileWidth must be a power of two");
    } else if (tileWidth!==undefined) throw new TypeError("tileWidth belongs only to AoSoA");
    if (layout!=="soaos" && groups!==undefined) throw new TypeError("groups belong only to SoAoS");
    const declarations=[]; const map=new NativeMap();
    for(const field of fields) {
      if (!field||typeof field.name!=="string"||!/^[$A-Za-z_][$\w]*$/.test(field.name)||
          mapHas.call(map,field.name)||typeof field.type!=="string"||!hasOwn(TYPES,field.type)) {
        throw new TypeError("invalid or repeated mixed field");
      }
      const desc=Object.freeze({name:field.name,type:field.type,bytes:TYPES[field.type].bytes,alignment:TYPES[field.type].alignment});
      mapSet.call(map,desc.name,declarations.length);declarations.push(desc);
    }
    const locators=new Array(declarations.length),segments=[];
    const shape=(members)=>{
      let cursor=0n,maxAlign=1n; const offsets=[];
      for(const index of members){const field=declarations[index];const a=BigInt(field.alignment);
        cursor=align(cursor,a);offsets.push(cursor);cursor+=BigInt(field.bytes);if(a>maxAlign)maxAlign=a;
      }
      return {stride:align(cursor,maxAlign),alignment:maxAlign,offsets};
    };
    const count=BigInt(rows),idx=arrayMap.call(declarations,(_,i)=>i);
    if(layout==="aos"){
      const sh=shape(idx);segments.push({bytes:sh.stride*count,alignment:sh.alignment,stride:sh.stride});
      arrayForEach.call(idx,(i)=>locators[i]={segment:0,offset:sh.offsets[i],stride:sh.stride});
    } else if(layout==="soa"){
      arrayForEach.call(idx,(i)=>{const f=declarations[i]; const seg=segments.length;
        segments.push({bytes:BigInt(f.bytes)*count,alignment:BigInt(f.alignment),stride:BigInt(f.bytes)});
        locators[i]={segment:seg,offset:0n,stride:BigInt(f.bytes)};
      });
    } else if(layout==="aosoa"){
      const tile=BigInt(tileWidth);let cursor=0n,maxAlign=1n;
      arrayForEach.call(idx,i=>{const f=declarations[i],a=BigInt(f.alignment);
        cursor=align(cursor,a);locators[i]={segment:0,offset:cursor,stride:BigInt(f.bytes)};
        cursor+=BigInt(f.bytes)*tile;if(a>maxAlign)maxAlign=a;
      });
      const stride=align(cursor,maxAlign);
      segments.push({bytes:stride*((count+tile-1n)/tile),alignment:maxAlign,stride});
    } else {
      if(!isArray(groups)||groups.length===0||groups.length>fields.length) throw new TypeError("SoAoS requires explicit groups");
      const used=new NativeSet();
      for(const group of groups) {
        if(!isArray(group)||group.length===0) throw new TypeError("SoAoS empty group");
        const members=[];
        for(const name of group){if(typeof name!=="string"||!mapHas.call(map,name)||setHas.call(used,name))throw new TypeError("SoAoS groups must partition fields");
          setAdd.call(used,name); members.push(mapGet.call(map,name));
        }
        const sh=shape(members),seg=segments.length;
        segments.push({bytes:sh.stride*count,alignment:sh.alignment,stride:sh.stride});
        members.forEach((index,i)=>locators[index]={segment:seg,offset:sh.offsets[i],stride:sh.stride});
      }
      if(used.size!==fields.length)throw new TypeError("SoAoS groups must partition fields");
    }
    let physical=0n,total=0n;
    for(const seg of segments) {
      physical=align(physical,seg.alignment);
      seg.base=physical;physical+=seg.bytes;total+=seg.bytes;
    }
    if(physical>BigInt(maxBytes))throw new RangeError("mixed layout exceeds actor physical byte cap");
    this.#fields=Object.freeze(declarations);this.#byName=map;
    this.#segments=Object.freeze(arrayMap.call(segments,seg=>Object.freeze({bytes:Number(seg.bytes),alignment:Number(seg.alignment),stride:Number(seg.stride),base:Number(seg.base)})));
    this.#locators=Object.freeze(arrayMap.call(locators,Object.freeze));
    this.#rows=rows;this.#layout=layout;this.#tileWidth=tileWidth??1;this.#allocationBytes=Number(physical);this.#totalBytes=Number(total);
  }
  get rows(){return this.#rows;} get layout(){return this.#layout;}
  get fields(){return this.#fields;} get segments(){return this.#segments;}
  get byteLength(){return this.#allocationBytes;} get payloadBytes(){return this.#totalBytes;}
  typeOf(name){
    if(typeof name!=="string" || !mapHas.call(this.#byName,name))
      throw new RangeError("unknown mixed field");
    return this.#fields[mapGet.call(this.#byName,name)].type;
  }
  address(row,field){
    if(!safeInteger(row)||row<0||row>=this.#rows||typeof field!=="string"||!mapHas.call(this.#byName,field))throw new RangeError("mixed row/field out of bounds");
    const at=mapGet.call(this.#byName,field),loc=this.#locators[at],seg=this.#segments[loc.segment];
    const byteOffset=this.#layout==="aosoa" ?
      Number(BigInt(Math.floor(row/this.#tileWidth))*BigInt(seg.stride)+loc.offset+BigInt(row%this.#tileWidth)*loc.stride):
      Number(BigInt(row)*loc.stride+loc.offset);
    const width=this.#fields[at].bytes;
    if(byteOffset<0||byteOffset+width>seg.bytes)throw new RangeError("mixed cell outside segment");
    return Object.freeze({segment:loc.segment,byteOffset,absoluteByteOffset:seg.base+byteOffset,type:this.#fields[at].type});
  }
}
export {MixedLayoutGeometry};
