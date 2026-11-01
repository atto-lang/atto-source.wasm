/**
 * Capability-free source preflight for the scalar-only Wasm compiler bridge.
 * No source actors or reactor threads are currently available to a Wasm guest.
 * This lexes only enough to distinguish executable tokens from comments and
 * quoted strings; it does not substitute for a full Oreslang source parser.
 */
const decoder = new TextDecoder("utf-8", {fatal:true});
const wordStart = c => /[A-Za-z_]/.test(c);
const wordRest = c => /[A-Za-z_0-9]/.test(c);

export function rejectUnsupportedActorThreadSource(snapshot) {
  if (!(snapshot instanceof Uint8Array))
    throw new TypeError("source preflight requires immutable snapshot bytes");
  const source = decoder.decode(snapshot);
  const tokens = [];
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (/\s/.test(c)) {i++;continue;}
    if (source.startsWith("//", i)) {
      const next = source.indexOf("\n", i + 2);
      i = next < 0 ? source.length : next + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source.startsWith("/*", i)) {depth++;i+=2;}
        else if (source.startsWith("*/", i)) {depth--;i+=2;}
        else i++;
        if (depth > 128) throw Error("source comment nesting exceeded");
      }
      if (depth) throw Error("unterminated source comment");
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\\") {i += 2;continue;}
        if (source[i++] === quote) {closed=true;break;}
      }
      if (!closed) throw Error("unterminated source string");
      continue;
    }
    if (wordStart(c)) {
      const start = i++;
      while (i < source.length && wordRest(source[i])) i++;
      tokens.push(source.slice(start, i));
    } else {
      // Punctuation is emitted as its own token. The real compiler still
      // validates all non-policy tokens and source grammar.
      tokens.push(c);
      i++;
    }
    if (tokens.length > 100_000) throw Error("source token budget exceeded");
  }

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "@" && tokens[i+1] === "ActorMaxThreads")
      throw Error("WASM source actor @ActorMaxThreads unsupported: no guest actor scheduler");
    if (tokens[i] === "define" && tokens[i+1] === "enum"
        && tokens[i+2] === "MaxActorThreads")
      throw Error("WASM built-in MaxActorThreads enum unsupported: no guest actor scheduler");
    // All declared actor spellings normalize to an actor execution domain.
    // In particular, a source preflight limited to "define actor" would let
    // shared/iso/untrusted forms and the class-extends-Actor alias bypass the
    // early scheduler capability denial. The real compiler still owns syntax.
    if (tokens[i] === "define") {
      let j = i + 1;
      if (tokens[j] === "pub" || tokens[j] === "private") j++;
      if (tokens[j] === "shared" || tokens[j] === "untrusted") j++;
      if (tokens[j] === "actor" || tokens[j] === "isoactor" ||
          tokens[j] === "supervisor") {
        throw Error("WASM source actor execution unsupported: no guest actor scheduler");
      }
      // A model declaration requires graph, tensor and differentiation
      // lowering. Do not mistake scalar arithmetic on a layer's weights
      // for executable define-model support on a Wasm worker.
      if (tokens[j] === "model") {
        throw Error("WASM source model execution unsupported: no guest model/tensor runtime");
      }
      if (tokens[j] === "class") {
        // Detect the intrinsic actor root without treating ordinary classes,
        // comments or string contents as capability-bearing actor syntax.
        const declaredName = tokens[j+1];
        let cursor = j + 2;
        // Class generics precede the extends clause. Skip them with a
        // bounded balanced delimiter walk so A<T> extends Actor is not
        // mistaken for an ordinary class by this early source gate.
        if (tokens[cursor] === "<") {
          let depth = 1;
          cursor++;
          while (cursor < tokens.length && depth > 0) {
            if (tokens[cursor] === "<") depth++;
            else if (tokens[cursor] === ">") depth--;
            cursor++;
            if (depth > 128) throw Error("source class generic nesting exceeded");
          }
          if (depth) throw Error("unterminated class generic parameters");
        }
        if (declaredName && tokens[cursor] === "extends" &&
            ["Actor","IsoActor","UntrustedActor"].includes(tokens[cursor+1])) {
          throw Error("WASM source actor execution unsupported: no guest actor scheduler");
        }
      }
    }
    if (tokens[i] === "actor" && (tokens[i+1] === "fnc" || tokens[i+1] === "routine"))
      throw Error("WASM source actor execution unsupported: no guest actor scheduler");
    if (tokens[i] === "spawn")
      throw Error("WASM source actor execution unsupported: no guest actor scheduler");
  }
}
