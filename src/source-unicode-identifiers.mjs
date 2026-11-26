// Conservative source preflight: a full Unicode identifier remains one token.
// The pinned compiler, not this scanner, decides the accepted identifier set.
const start = /^(?:[_\p{Alphabetic}]|〇)$/u;
const part = /^(?:[_\p{Alphabetic}\p{Number}]|〇)$/u;
export const scalarAt = (text, offset) => {
  const cp = text.codePointAt(offset);
  return cp === undefined ? '' : String.fromCodePoint(cp);
};
export const isSourceNameStart = scalar => start.test(scalar);
export const isSourceNamePart = scalar => part.test(scalar);
export function sourceNameEnd(text, offset) {
  while (offset < text.length) {
    const c = scalarAt(text, offset);
    if (!isSourceNamePart(c)) break;
    offset += c.length;
  }
  return offset;
}
export function invalidSourceUtf16Offset(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return i;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return i;
  }
  return -1;
}
