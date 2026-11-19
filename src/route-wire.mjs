// atto.browser.route.v1 — external host transport ABI, NOT a guest import.
// This matches actor_receive(i32 actor_type,i64 payload,i64 sequence) emitted
// by the Rust compiler; the browser host owns actor ID and sequence values.
const MIN_I64=-(1n<<63n), MAX_I64=(1n<<63n)-1n;
const arrayBufferByteLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
export const ROUTE_WIRE='atto.browser.route.v1';
export const I64_ROUTE_BYTES=8;
export function encode_i64_route(value) {
  if(typeof value!=='bigint')throw new TypeError('E_ROUTE_I64_TYPE');
  if(value<MIN_I64 || value>MAX_I64)throw new RangeError('E_ROUTE_I64_RANGE');
  const buffer=new ArrayBuffer(I64_ROUTE_BYTES);
  new DataView(buffer).setBigInt64(0,value,true);
  return buffer;
}
export function decode_i64_route(buffer) {
  // Native internal-slot getter accepts genuine cross-realm ArrayBuffers but
  // rejects forged/proxy objects, SharedArrayBuffer, and detached buffers.
  let length;
  try { length=arrayBufferByteLength.call(buffer); }
  catch { throw new TypeError('E_ROUTE_BUFFER'); }
  if(length!==I64_ROUTE_BYTES)throw new Error('E_ROUTE_WIRE');
  return new DataView(buffer).getBigInt64(0,true);
}
