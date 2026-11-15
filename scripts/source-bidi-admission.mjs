/**
 * Trojan Source guard shared by Wasm scalar and actor source admission.
 * A Unicode bidi formatting control can reorder displayed text in comments
 * and literals. Check the exact bounded source bytes before any tokenizer,
 * compiler invocation, temporary artifact or executable Wasm is created.
 */
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
export function rejectBidirectionalSourceControls(sourceBytes) {
  if (!sourceBytes || !Number.isSafeInteger(sourceBytes.byteLength))
    throw new TypeError('WASM source preflight requires bounded byte input');
  if (sourceBytes.byteLength > 1024 * 1024)
    throw new RangeError('WASM source preflight byte budget exceeded');
  const source = new TextDecoder('utf-8', {fatal: true}).decode(sourceBytes);
  if (BIDI_CONTROL.test(source))
    throw new Error('WASM source contains bidirectional Unicode control');
  return source;
}
