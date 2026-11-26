/**
 * Trojan Source guard shared by Wasm scalar and actor source admission.
 * A Unicode bidi formatting control can reorder displayed text in comments
 * and literals. Check the exact bounded source bytes before any tokenizer,
 * compiler invocation, temporary artifact or executable Wasm is created.
 */
import {snapshotGuestBytes} from '../src/snapshot-guest-bytes.mjs';
const BIDI_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
export function rejectBidirectionalSourceControls(sourceBytes) {
  const bytes = snapshotGuestBytes(sourceBytes, 1024 * 1024);
  const source = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  if (BIDI_CONTROL.test(source))
    throw new Error('WASM source contains bidirectional Unicode control');
  return source;
}
