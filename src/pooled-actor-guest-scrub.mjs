// Capture native byte operations before any guest-facing code runs.
// No guest or module is allowed to replace the physical zeroization primitive.
import {types} from 'node:util';
const NativeBytes = Uint8Array;
const nativeFill = Uint8Array.prototype.fill;
const nativeApply = Reflect.apply;
const nativeBuffer = Object.getOwnPropertyDescriptor(
  WebAssembly.Memory.prototype, 'buffer').get;
const nativeByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const MAX = 2 * 65536;

// Guest code runs in an import-free, private fixed-two-page instance.
// Destroying its bytes must be independently observable before STOP ACK.
export function scrubFixedGuestMemory(memory) {
  if (!(memory instanceof WebAssembly.Memory))
    throw TypeError('private guest Wasm memory required');
  const buffer = nativeApply(nativeBuffer, memory, []);
  if (types.isSharedArrayBuffer(buffer))
    throw Error('guest memory cannot have shared backing');
  const view = new NativeBytes(buffer);
  if (nativeApply(nativeByteLength, view, []) !== MAX)
    throw Error('guest memory scrub requires exactly two fixed pages');
  nativeApply(nativeFill, view, [0]);
  // Fail closed if a future engine, memory alias or hostile JS call prevents
  // complete physical byte clearance. Never acknowledge STOP without this.
  for (let i = 0; i < MAX; ++i)
    if (view[i] !== 0) throw Error('actor guest memory zeroization failed');
  return true;
}
