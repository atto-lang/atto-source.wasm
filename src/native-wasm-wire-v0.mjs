// Trusted host-only i64 tuple codec, byte-identical to LLVM MessagePackWireV2.
// This is DATA validation, not an ActorRef, capability, supervisor CONTROL or
// authenticated network protocol. Never accept remote arbitrary schema IDs.
import {createHash, timingSafeEqual} from 'node:crypto';
import {types} from 'node:util';
import {snapshotGuestBytes} from './snapshot-guest-bytes.mjs';

export const REQUEST_SCHEMA = 'oreslang.native_wasm.data.request.v0';
export const RESPONSE_SCHEMA = 'oreslang.native_wasm.data.response.v0';
export const ACK_SCHEMA = 'oreslang.native_wasm.data.ack.v0';
export const MAX_FRAME_BYTES = 4096;
const MIN = -(1n << 63n), MAX = (1n << 63n) - 1n;
const SCHEMAS = new Set([REQUEST_SCHEMA, RESPONSE_SCHEMA, ACK_SCHEMA]);
const DIGEST = createHash('sha256').update('oreslang.actor.shape.v2/T[I,I]').digest();
// Reject Proxy-wrapped typed arrays before any trap-controlled property read.
// Snapshot using native ArrayBuffer/View slots; never retain shared or mutable
// producer storage as an authoritative DATA frame. This is host admission, not
// compiled guest proof, and it does not authenticate an external pipe peer.
const isNativeUint8Array = types.isUint8Array;
function ownWireBytes(bytes, maxBytes) {
  if (!isNativeUint8Array(bytes))
    throw new TypeError('binary native/WASM frame requires a genuine Uint8Array');
  return snapshotGuestBytes(bytes, maxBytes);
}

function requireI64(n) {
  if (typeof n !== 'bigint' || n < MIN || n > MAX) throw TypeError('expected signed i64');
  return n;
}
function requireSchema(schema) {
  if (!SCHEMAS.has(schema)) throw Error('unregistered native/WASM DATA schema');
}
function appendUint(out, n, width) {
  for (let i = width - 1; i >= 0; i--)
    out.push(Number((BigInt(n) >> BigInt(i * 8)) & 255n));
}
function appendInt(out, n) {
  n = requireI64(n);
  if (n >= 0n && n < 128n) out.push(Number(n));
  else if (n < 0n && n >= -32n) out.push(Number(n & 255n));
  else if (n >= 0n && n <= 255n) {out.push(0xcc); appendUint(out,n,1);}
  else if (n >= 0n && n <= 65535n) {out.push(0xcd); appendUint(out,n,2);}
  else if (n >= 0n && n <= 4294967295n) {out.push(0xce); appendUint(out,n,4);}
  else if (n >= 0n) {out.push(0xcf); appendUint(out,n,8);}
  else if (n >= -128n) {out.push(0xd0); appendUint(out,n,1);}
  else if (n >= -32768n) {out.push(0xd1); appendUint(out,n,2);}
  else if (n >= -2147483648n) {out.push(0xd2); appendUint(out,n,4);}
  else {out.push(0xd3); appendUint(out,n,8);}
}
function readInt(r) {
  const b = r.byte();
  if (b <= 0x7f) return BigInt(b);
  if (b >= 0xe0) return BigInt(b - 256);
  const read = width => r.uint(width);
  const signed = (value,bits) =>
    value >= (1n << BigInt(bits - 1)) ? value - (1n << BigInt(bits)) : value;
  let n;
  switch (b) {
    case 0xcc: n=read(1); if(n<=127n) throw Error('noncanonical uint8'); return n;
    case 0xcd: n=read(2); if(n<=255n) throw Error('noncanonical uint16'); return n;
    case 0xce: n=read(4); if(n<=65535n) throw Error('noncanonical uint32'); return n;
    case 0xcf:
      n=read(8);
      if (n <= 4294967295n || n > MAX) throw Error('noncanonical/out-of-range uint64');
      return n;
    case 0xd0: n=signed(read(1),8); if(n >= -32n) throw Error('noncanonical int8'); return n;
    case 0xd1: n=signed(read(2),16); if(n >= -128n) throw Error('noncanonical int16'); return n;
    case 0xd2: n=signed(read(4),32); if(n >= -32768n) throw Error('noncanonical int32'); return n;
    case 0xd3: n=signed(read(8),64); if(n >= -2147483648n) throw Error('noncanonical int64'); return n;
    default: throw Error('expected canonical MessagePack integer');
  }
}
class Reader {
  constructor(bytes) {this.bytes=bytes; this.at=0;}
  read(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.bytes.length-this.at)
      throw Error('truncated native/WASM frame');
    const bytes=this.bytes.subarray(this.at,this.at+n); this.at+=n; return bytes;
  }
  byte() {return this.read(1)[0];}
  uint(n) {
    let result=0n;
    for(const b of this.read(n))result=(result<<8n)|BigInt(b);
    return result;
  }
}
function putStr(out, text) {
  const raw=Buffer.from(text,'utf8');
  if (raw.length<=31) out.push(0xa0|raw.length);
  else if (raw.length<=255) out.push(0xd9,raw.length);
  else throw Error('schema ID too long');
  out.push(...raw);
}
function readStr(r) {
  const b=r.byte();
  let n;
  if ((b&0xe0)===0xa0) n=b&31;
  else if (b===0xd9) {
    n=r.byte();
    if (n<=31) throw Error('noncanonical schema string');
  } else throw Error('unsupported schema string header');
  return Buffer.from(r.read(n)).toString('utf8');
}
export function encodeNativeWasmPair(schema, ticket, value) {
  requireSchema(schema); requireI64(ticket); requireI64(value);
  if (ticket <= 0n) throw RangeError('ticket must be positive');
  const out=[0x94,0x02];
  putStr(out,schema);
  out.push(0xc4,32,...DIGEST,0x92);
  appendInt(out,ticket); appendInt(out,value);
  if(out.length>MAX_FRAME_BYTES)throw Error('native/WASM frame budget exceeded');
  return Buffer.from(out);
}
export function decodeNativeWasmPair(schema, bytes) {
  requireSchema(schema);
  const owned=ownWireBytes(bytes,MAX_FRAME_BYTES);
  if(owned.length===0)throw Error('invalid native/WASM frame budget');
  const r=new Reader(owned);
  if(r.byte()!==0x94 || readInt(r)!==2n)throw Error('wrong native/WASM MessagePack v2 envelope');
  if(readStr(r)!==schema)throw Error('wrong native/WASM DATA schema');
  if(r.byte()!==0xc4 || r.byte()!==32)throw Error('wrong native/WASM digest header');
  if(!timingSafeEqual(Buffer.from(r.read(32)), DIGEST))throw Error('wrong native/WASM shape digest');
  if(r.byte()!==0x92)throw Error('wrong native/WASM tuple arity');
  const ticket=readInt(r), value=readInt(r);
  if(ticket<=0n)throw Error('invalid native/WASM ticket');
  if(r.at!==owned.length)throw Error('trailing native/WASM payload');
  return Object.freeze({ticket,value});
}
export function frameNativeWasm(bytes) {
  const owned=ownWireBytes(bytes,MAX_FRAME_BYTES);
  if(!owned.length)throw Error('native/WASM frame length rejected');
  const out=Buffer.allocUnsafe(owned.length+4);
  out.writeUInt32BE(owned.length,0); out.set(owned,4); return out;
}
export class NativeWasmFrameReader {
  #buffer=Buffer.alloc(0);
  push(chunk) {
    const owned=ownWireBytes(chunk,MAX_FRAME_BYTES*16);
    // No unbounded accumulation for a malicious native child process.
    if (this.#buffer.length > MAX_FRAME_BYTES*16 - owned.length)
      throw Error('native/WASM pipe admission budget exceeded');
    this.#buffer=Buffer.concat([this.#buffer,owned]);
    const frames=[];
    while(this.#buffer.length>=4) {
      const n=this.#buffer.readUInt32BE(0);
      if(!n||n>MAX_FRAME_BYTES)throw Error('native/WASM pipe frame size rejected');
      if(this.#buffer.length<4+n)break;
      frames.push(Buffer.from(this.#buffer.subarray(4,4+n)));
      this.#buffer=this.#buffer.subarray(4+n);
    }
    return frames;
  }
  end() {if(this.#buffer.length)throw Error('truncated native/WASM pipe response');}
}
