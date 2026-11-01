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

  // Modifiers are part of the actor declaration, not an alternate way
  // around the missing Wasm guest scheduler. Reject all declaration prefixes
  // while leaving identifier uses, comments and quoted examples untouched.
  const actorModifiers = new Set([
    "pub", "private", "shared", "untrusted", "serial", "http", "tcp",
    "websocket", "unary", "stream", "abstract", "transform", "pipe"
  ]);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "define") {
      let j = i + 1;
      while (j < tokens.length && j < i + 12 && actorModifiers.has(tokens[j])) j++;
      if (tokens[j] === "actor" || tokens[j] === "isoactor")
        throw Error("WASM source actor execution unsupported: no guest actor scheduler");
    }
    // The Java frontend also accepts bare "actor A1 as ... end",
    // "actor fnc ..." and "fnc actor ..." declaration families.
    // A normal variable named actor or property access actor.send() is
    // not a declaration; inspect adjacent grammar tokens, not substrings.
    const actorToken = tokens[i] === "actor" || tokens[i] === "isoactor";
    const next = tokens[i+1], afterNext = tokens[i+2];
    const actorCallable = actorToken &&
      (next === "fnc" || next === "routine" ||
       (actorModifiers.has(next) &&
        (tokens.slice(i+2,i+8).includes("fnc") ||
         tokens.slice(i+2,i+8).includes("routine"))));
    const bareActor = actorToken && (
      tokens[i] === "isoactor" ||
      (tokens[i-1] === "shared" || tokens[i-1] === "untrusted") ||
      (next && /^[A-Za-z_][A-Za-z0-9_]*$/.test(next) &&
       (["as","{","extends","implements","impl","<"].includes(afterNext))) ||
      actorCallable);
    if (bareActor ||
        (actorToken && (tokens[i-1] === "fnc" || tokens[i-1] === "routine") &&
         tokens[i+1] && /^[A-Za-z_]/.test(tokens[i+1])))
      throw Error("WASM source actor execution unsupported: no guest actor scheduler");
    if (tokens[i] === "@" && tokens[i+1] === "ActorMaxThreads")
      throw Error("WASM source actor @ActorMaxThreads unsupported: no guest actor scheduler");
    if (tokens[i] === "define" && tokens[i+1] === "enum"
        && tokens[i+2] === "MaxActorThreads")
      throw Error("WASM built-in MaxActorThreads enum unsupported: no guest actor scheduler");
    if (tokens[i] === "define" && tokens[i+1] === "actor")
      throw Error("WASM source actor execution unsupported: no guest actor scheduler");
  }
}
