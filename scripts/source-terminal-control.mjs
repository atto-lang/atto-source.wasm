/**
 * Bounded, raw-source admission for both scalar and actor Wasm bridges.
 * No CLI caller or tokenizer can erase ESC/DEL/NUL hidden in comments or
 * literals. Decode strictly before control admission so malformed UTF-8
 * retains its existing fatal-decoder rejection.
 */
export function rejectRawTerminalSourceControls(sourceBytes) {
  if (!(sourceBytes instanceof Uint8Array))
    throw new TypeError("WASM source preflight requires byte input");
  if (sourceBytes.byteLength > 1024 * 1024)
    throw new RangeError("WASM source preflight byte budget exceeded");
  const text = new TextDecoder("utf-8", {fatal: true}).decode(sourceBytes);
  // Every scalar is encoded as UTF-8, but ESC/DEL/NUL are ASCII single bytes.
  // Scanning original bytes preserves true UTF-8 offsets after astral text.
  for (let at = 0; at < sourceBytes.byteLength; at++) {
    const byte = sourceBytes[at];
    if (byte === 0)
      throw Error("WASM source preflight contains NUL byte at byte offset " + at);
    if (byte === 0x1b || byte === 0x7f)
      throw Error("WASM source preflight contains terminal control at byte offset " + at);
  }
  return text;
}
