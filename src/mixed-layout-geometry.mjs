// Private mixed-width layout geometry. A scalar ref32 is an encoded word only,
 // not a dereference capability. No WebAssembly or JS guest compilation claimed.
const NativeArray = Array;
const NativeNumber = Number;
const NativeBigInt = BigInt;
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
const arrayPush = Array.prototype.push;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const nativeFreeze = Object.freeze;
const nativeFloor = Math.floor;
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
    for(let i=0;i<fields.length;i++){
      const slot=ownDescriptor(fields,String(i));
      if(!slot || !hasOwn(slot,"value") || !slot.value)
        throw new TypeError("mixed field array must contain own data entries");
      const field=slot.value;
      const nameSlot=ownDescriptor(field,"name");
      const typeSlot=ownDescriptor(field,"type");
      if(!nameSlot || !typeSlot || !hasOwn(nameSlot,"value") || !hasOwn(typeSlot,"value"))
        throw new TypeError("mixed field name/type must be own data values");
      const name=nameSlot.value,type=typeSlot.value;
      if(typeof name!=="string" || !/^[$A-Za-z_][$\w]*$/.test(name) ||
         mapHas.call(map,name) || typeof type!=="string" || !hasOwn(TYPES,type))
        throw new TypeError("invalid or repeated mixed field");
      const desc=nativeFreeze({name,type,bytes:TYPES[type].bytes,alignment:TYPES[type].alignment});
      mapSet.call(map,name,declarations.length);
      arrayPush.call(declarations,desc);
    }
    const locators=new NativeArray(declarations.length),segments=[];
    const shape=(members)=>{
      let cursor=0n,maxAlign=1n; const offsets=[];
      for(let k=0;k<members.length;k++){
        const field=declarations[members[k]],a=NativeBigInt(field.alignment);
        cursor=align(cursor,a);arrayPush.call(offsets,cursor);
        cursor+=NativeBigInt(field.bytes);if(a>maxAlign)maxAlign=a;
      }
      return {stride:align(cursor,maxAlign),alignment:maxAlign,offsets};
    };
    const count=NativeBigInt(rows),idx=arrayMap.call(declarations,(_,i)=>i);
    if(layout==="aos"){
      const sh=shape(idx);arrayPush.call(segments,{bytes:sh.stride*count,alignment:sh.alignment,stride:sh.stride});
      arrayForEach.call(idx,(i)=>locators[i]={segment:0,offset:sh.offsets[i],stride:sh.stride});
    } else if(layout==="soa"){
      arrayForEach.call(idx,(i)=>{const f=declarations[i]; const seg=segments.length;
        arrayPush.call(segments,{bytes:NativeBigInt(f.bytes)*count,alignment:NativeBigInt(f.alignment),stride:NativeBigInt(f.bytes)});
        locators[i]={segment:seg,offset:0n,stride:NativeBigInt(f.bytes)};
      });
    } else if(layout==="aosoa"){
      const tile=NativeBigInt(tileWidth);let cursor=0n,maxAlign=1n;
      arrayForEach.call(idx,i=>{const f=declarations[i],a=NativeBigInt(f.alignment);
        cursor=align(cursor,a);locators[i]={segment:0,offset:cursor,stride:NativeBigInt(f.bytes)};
        cursor+=NativeBigInt(f.bytes)*tile;if(a>maxAlign)maxAlign=a;
      });
      const stride=align(cursor,maxAlign);
      arrayPush.call(segments,{bytes:stride*((count+tile-1n)/tile),alignment:maxAlign,stride});
    } else {
      if(!isArray(groups)||groups.length===0||groups.length>fields.length) throw new TypeError("SoAoS requires explicit groups");
      const used=new NativeSet();
      for(let gi=0;gi<groups.length;gi++) {
        const groupEntry=ownDescriptor(groups,String(gi));
        if(!groupEntry || !hasOwn(groupEntry,"value") || !isArray(groupEntry.value))
          throw new TypeError("SoAoS requires own data group entries");
        const group=groupEntry.value;
        if(group.length===0)throw new TypeError("SoAoS empty group");
        const members=[];
        for(let j=0;j<group.length;j++){
          const nameEntry=ownDescriptor(group,String(j));
          if(!nameEntry || !hasOwn(nameEntry,"value"))
            throw new TypeError("SoAoS field names must be own data entries");
          const name=nameEntry.value;
          if(typeof name!=="string"||!mapHas.call(map,name)||setHas.call(used,name))
            throw new TypeError("SoAoS groups must partition fields");
          setAdd.call(used,name);
          arrayPush.call(members,mapGet.call(map,name));
        }
        const sh=shape(members),seg=segments.length;
        arrayPush.call(segments,{bytes:sh.stride*count,alignment:sh.alignment,stride:sh.stride});
        arrayForEach.call(members,(index,i)=>locators[index]={segment:seg,offset:sh.offsets[i],stride:sh.stride});
      }
      if(used.size!==fields.length)throw new TypeError("SoAoS groups must partition fields");
    }
    let physical=0n,total=0n;
    for(let si=0;si<segments.length;si++) {
      const seg=segments[si];
      physical=align(physical,seg.alignment);
      seg.base=physical;physical+=seg.bytes;total+=seg.bytes;
    }
    if(physical>NativeBigInt(maxBytes))throw new RangeError("mixed layout exceeds actor physical byte cap");
    this.#fields=nativeFreeze(declarations);this.#byName=map;
    this.#segments=nativeFreeze(arrayMap.call(segments,seg=>nativeFreeze({bytes:NativeNumber(seg.bytes),alignment:NativeNumber(seg.alignment),stride:NativeNumber(seg.stride),base:NativeNumber(seg.base)})));
    this.#locators=nativeFreeze(arrayMap.call(locators,nativeFreeze));
    this.#rows=rows;this.#layout=layout;this.#tileWidth=tileWidth??1;this.#allocationBytes=NativeNumber(physical);this.#totalBytes=NativeNumber(total);
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
      NativeNumber(NativeBigInt(nativeFloor(row/this.#tileWidth))*NativeBigInt(seg.stride)+loc.offset+NativeBigInt(row%this.#tileWidth)*loc.stride):
      NativeNumber(NativeBigInt(row)*loc.stride+loc.offset);
    const width=this.#fields[at].bytes;
    if(byteOffset<0||byteOffset+width>seg.bytes)throw new RangeError("mixed cell outside segment");
    return nativeFreeze({segment:loc.segment,byteOffset,absoluteByteOffset:seg.base+byteOffset,type:this.#fields[at].type});
  }
}
export {MixedLayoutGeometry};
