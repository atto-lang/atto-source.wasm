// Trusted-host immutable TCP slab. This is NOT a guest Wasm memory import,
// socket connector, network capability, or unsafe shared-memory pointer.
const MAX_BYTES = 1024 * 1024;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get;
export class FrozenTcpSlab {
  #bytes;
  #size;
  #pins = new WeakSet();
  #pinCount = 0;
  #retiring = false;
  constructor(source) {
    if (source == null || typeof source[Symbol.iterator] !== 'function')
      throw new TypeError('invalid TCP byte source');
    if (ArrayBuffer.isView(source)) {
      // Use native internal slots, not realm-bound instanceof or a caller's
      // overridable .buffer property. Cross-realm shared views must fail.
      let backing;
      try {
        backing = (source instanceof DataView ? dataViewBuffer : typedArrayBuffer).call(source);
        arrayBufferByteLength.call(backing);
      } catch {
        throw new TypeError('mutable shared backing memory is forbidden');
      }
    }
    const copy = [];
    for (const byte of source) {
      if (copy.length === MAX_BYTES) throw new RangeError('TCP slab exceeds one MiB');
      if (!Number.isInteger(byte) || byte < 0 || byte > 255)
        throw new TypeError('TCP slab requires unsigned byte values');
      copy.push(byte);
    }
    this.#size = copy.length;
    this.#bytes = Object.freeze(copy);
  }
  get size() { return this.#size; }
  get freed() { return this.#bytes === null; }
  get pinCount() { return this.#pinCount; }
  pin() {
    if (this.#retiring) throw new Error('slab retired');
    if (this.#pinCount >= Number.MAX_SAFE_INTEGER) throw new Error('pin count exhausted');
    const pin = Object.freeze({});
    this.#pins.add(pin);
    this.#pinCount++;
    return pin;
  }
  readByte(pin, index) {
    if (!this.#pins.has(pin)) throw new Error('invalid TCP slab pin');
    if (this.#bytes === null) throw new Error('TCP slab storage retired');
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#bytes.length)
      throw new RangeError('TCP slab byte index');
    return this.#bytes[index];
  }
  releasePin(pin) {
    if (!this.#pins.has(pin)) return false;
    this.#pins.delete(pin);
    this.#pinCount--;
    this.#finalize();
    return true;
  }
  retire() { this.#retiring = true; this.#finalize(); }
  #finalize() {
    // Drop the private backing region after the final physical I/O/reader pin.
    // This releases ownership for JS GC; it is NOT secure memory zeroization.
    // The trusted transport owner must call retire only after kernel IO quiesces.
    if (this.#retiring && this.#pinCount === 0) this.#bytes = null;
  }
}
