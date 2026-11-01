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
    // The scalar-only source bridge has no type-directed actor activation,
    // state-region loans, typed model graph, or supervisor CONTROL semantics.
    // Recognize declaration tokens, not text in comments/strings. Source
    // modifiers are contextual and must not bypass capability admission.
    if (tokens[i] === "define") {
      let first=i+1;
      const modifiers=new Set([
        "pub","private","abstract","shared","untrusted",
        "serial","http","tcp","ws","websocket","unary","stream"
      ]);
      for(let n=0;n<16 && modifiers.has(tokens[first]);n++)first++;
      const kind=tokens[first];
      if(kind==="actor" || kind==="isoactor")
        throw Error("WASM source actor execution unsupported: no guest actor scheduler");
      if(kind==="enum") {
        if(tokens[first+1]==="MaxActorThreads")
          throw Error("WASM built-in MaxActorThreads enum unsupported: no guest actor scheduler");
        throw Error("WASM DECL_KIND_UNSUPPORTED: enum requires nominal tagged-case ABI lowering");
      }
      const pair = kind === "state" && tokens[first+1] === "container"
        ? "state container" : kind === "proxy" && tokens[first+1] === "actor"
        ? "proxy actor" : null;
      const unsupported = pair ?? ([
        "grain", "supervisor", "scheduler", "mailman",
        "model", "protocol", "service"
      ].includes(kind) ? kind : null);
      if (unsupported)
        throw Error("WASM DECL_KIND_UNSUPPORTED: " + unsupported
          + " requires verified nominal identity/ownership lowering");
    }
  }
}
