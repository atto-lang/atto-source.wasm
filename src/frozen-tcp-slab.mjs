// Trusted-host immutable TCP slab. This is NOT a guest Wasm memory import,
// socket connector, network capability, or unsafe shared-memory pointer.
const MAX_BYTES = 1024 * 1024;
export class FrozenTcpSlab {
  #bytes;
  #pins = new WeakSet();
  #pinCount = 0;
  #retiring = false;
  constructor(source) {
    if (source == null || typeof source[Symbol.iterator] !== 'function')
      throw new TypeError('invalid TCP byte source');
    if (typeof SharedArrayBuffer !== 'undefined' &&
        ArrayBuffer.isView(source) && source.buffer instanceof SharedArrayBuffer)
      throw new TypeError('mutable shared backing memory is forbidden');
    const copy = [];
    for (const byte of source) {
      if (copy.length === MAX_BYTES) throw new RangeError('TCP slab exceeds one MiB');
      if (!Number.isInteger(byte) || byte < 0 || byte > 255)
        throw new TypeError('TCP slab requires unsigned byte values');
      copy.push(byte);
    }
    this.#bytes = Object.freeze(copy);
  }
  get size() { return this.#bytes.length; }
  get freed() { return this.#retiring && this.#pinCount === 0; }
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
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#bytes.length)
      throw new RangeError('TCP slab byte index');
    return this.#bytes[index];
  }
  releasePin(pin) {
    if (!this.#pins.has(pin)) return false;
    this.#pins.delete(pin);
    this.#pinCount--;
    return true;
  }
  retire() { this.#retiring = true; }
}
