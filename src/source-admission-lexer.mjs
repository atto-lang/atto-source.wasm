/**
 * Shared, bounded source-token view for the experimental WASM admission gates.
 * This is NOT a parser: all unsupported effects/ABI constructs must still
 * be validated by the real Oreslang compiler before artifact publication.
 */
const utf8 = new TextDecoder("utf-8", {fatal: true});
const idStart = c => c !== undefined && /[A-Za-z_]/.test(c);
const idPart = c => c !== undefined && /[A-Za-z0-9_]/.test(c);
const lineBoundary = c => c === "\r" || c === "\n" || c === "\u0085"
                            || c === "\u2028" || c === "\u2029";

/** Token {text,offset,id}; offsets are UTF-16 code-unit indices. */
export function lexSourceAdmission(snapshot) {
  if (!(snapshot instanceof Uint8Array))
    throw new TypeError("source preflight requires immutable snapshot bytes");

  const source = utf8.decode(snapshot);
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "\u0085" || /\s/.test(c)) { i++; continue; }

    if (source.startsWith("//", i)) {
      i += 2;
      while (i < source.length && !lineBoundary(source[i])) i++;
      continue;
    }

    if (source.startsWith("/*", i)) {
      i += 2;
      let depth = 1;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) { depth++; i += 2; }
        else if (source.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
        if (depth > 128) throw Error("source comment nesting exceeded");
      }
      if (depth) throw Error("unterminated source comment");
      continue;
    }

    if (c === '"' || c === "'" || c === "\x60") {
      const quote = c;
      i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        // Backtick interpolation is executable, not an inert quoted string.
        if (quote === "\x60" && source.startsWith("$" + "{", i))
          throw Error("WASM source template interpolation unsupported until checked annotation and expression lowering");
        if (source[i++] === quote) { closed = true; break; }
      }
      if (!closed) throw Error("unterminated source string");
      continue;
    }

    const start = i;
    let id = false;
    if (idStart(c)) {
      id = true;
      i++;
      while (i < source.length && idPart(source[i])) i++;
    } else i++;

    tokens.push({text: source.slice(start, i), offset: start, id});
    if (tokens.length > 100_000) throw Error("source token budget exceeded");
  }
  return tokens;
}
