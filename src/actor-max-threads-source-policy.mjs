/**
 * Capability-free source preflight for the scalar-only Wasm compiler bridge.
 * No source actors or reactor threads are currently available to a Wasm guest.
 * This lexes only enough to distinguish executable tokens from comments and
 * quoted strings; it does not substitute for a full Oreslang source parser.
 */
const decoder = new TextDecoder("utf-8", {fatal:true});
const wordStart = c => /[A-Za-z_]/.test(c);
const wordRest = c => /[A-Za-z_0-9]/.test(c);
// Read genuine typed-array internal slots, never caller-shadowed byteLength.
const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const actualByteLength = Object.getOwnPropertyDescriptor(typedArrayProto,"byteLength").get;
const actualBuffer = Object.getOwnPropertyDescriptor(typedArrayProto,"buffer").get;
const sharedLength = typeof SharedArrayBuffer === "function"
  ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype,"byteLength").get : null;

export function rejectUnsupportedActorThreadSource(snapshot) {
  if (!(snapshot instanceof Uint8Array))
    throw new TypeError("source preflight requires immutable snapshot bytes");
  // Apply the same 1 MiB byte cap as the scalar compiler frontends before
  // allocating a decoded copy or scanning long, token-free comment payloads.
  let length, backing;
  try { length = actualByteLength.call(snapshot); backing = actualBuffer.call(snapshot); }
  catch { throw new TypeError("source preflight requires genuine Uint8Array bytes"); }
  if (length > 1_048_576)
    throw Error("WASM source preflight exceeds 1 MiB byte budget");
  if (sharedLength) {
    let shared = false;
    try { sharedLength.call(backing); shared = true; } catch {}
    if (shared) throw Error("WASM source preflight refuses shared source backing");
  }
  const source = decoder.decode(snapshot);
  // NUL is not source trivia: it can truncate native bridge consumers,
  // producing a different program from the one just safety-checked.
  if (source.includes("\0"))
    throw Error("WASM source preflight contains NUL byte");
  const tokens = [];
  for (let i = 0; i < source.length;) {
    const c = source[i];
    // NEL is an AttoLang line boundary but is not matched by JavaScript /\\s/.
    if (/\s/.test(c) || c === "\u0085") {i++;continue;}
    if (source.startsWith("//", i)) {
      let next = i + 2;
      // CR-only, NEL and Unicode separators also terminate AttoLang // comments.
      while (next < source.length && !["\r", "\n", "\u0085", "\u2028", "\u2029"].includes(source[next])) next++;
      i = next;
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

  // Recognize declaration modifiers before the unsupported guest supervisor
  // boundary; plain identifiers and property references must remain valid.
  const supervisorModifiers = new Set([
    "pub", "private", "shared", "untrusted", "serial", "abstract",
    "transform", "pipe", "http", "tcp", "websocket", "stream", "unary"
  ]);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "@" && tokens[i+1] === "ActorMaxThreads")
      throw Error("WASM source actor @ActorMaxThreads unsupported: no guest actor scheduler");
    if (tokens[i] === "define") {
      // Visibility modifiers may precede the reserved actor-thread enum.
      let j = i + 1;
      // Reserved actor-thread enum identity cannot hide behind stacked modifiers.
      while (j < tokens.length && ["pub","private","shared","untrusted","serial","abstract"].includes(tokens[j])) j++;
      if (tokens[j] === "enum" && tokens[j+1] === "MaxActorThreads")
        throw Error("WASM built-in MaxActorThreads enum unsupported: no guest actor scheduler");
    }
    // A source supervisor is an independent CONTROL process, not a scalar
    // class or a guest actor that can be delegated to the LLVM compiler.
    // Recognize both visibility orders without matching text in comments
    // or string literals, and reject before any Wasm artifact is staged.
    if (tokens[i] === "define") {
      let j = i + 1;
      while (j < tokens.length && supervisorModifiers.has(tokens[j])) j++;
      if (tokens[j] === "supervisor")
        throw Error("WASM source supervisor unsupported: no typed Failure or CONTROL lowering");
    }
    const name = tokens[i+1], following = tokens[i+2];
    if (tokens[i] === "supervisor" &&
        name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
        ["as", "{", "extends", "implements", "impl", "with", "<"].includes(following))
      throw Error("WASM source supervisor unsupported: no typed Failure or CONTROL lowering");
    // Actor declarations cannot enter a scalar-only guest through modifiers.
    if (tokens[i] === "define") {
      let j = i + 1;
      while (j < tokens.length && supervisorModifiers.has(tokens[j])) j++;
      if (tokens[j] === "actor" || tokens[j] === "isoactor")
        throw Error("WASM source actor execution unsupported: no guest actor scheduler");
    }
    // The Java frontend also accepts bare "actor A1 as ... end",
    // "actor fnc ..." and "fnc actor ..." declaration families.
    // A normal variable named actor or property access actor.send() is
    // not a declaration; inspect adjacent grammar tokens, not substrings.
    const actorToken = tokens[i] === "actor" || tokens[i] === "isoactor";
    const next = tokens[i+1], afterNext = tokens[i+2];
    // An unsupported actor callable must not hide after more than six
    // repeated modifiers. The preflight token ledger is already bounded.
    let callableCursor = i + 1;
    if (actorToken)
      while (callableCursor < tokens.length &&
             supervisorModifiers.has(tokens[callableCursor])) callableCursor++;
    const actorCallable = actorToken &&
      (tokens[callableCursor] === "fnc" ||
       tokens[callableCursor] === "routine");
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
    if (tokens[i] === "define" && tokens[i+1] === "actor")
      throw Error("WASM source actor execution unsupported: no guest actor scheduler");
    // The Wasm source bridge has no authenticated ETS table handles,
    // ActorGroup pg memberships, or actor-owned mailbox admission. Reject
    // explicit module access before invoking LLVM or staging a Wasm artifact.
    // Lexical gate only; the compiler still owns full name resolution.
    if (tokens[i] === "ets" && tokens[i+1] === ".")
      throw Error("WASM ETS guest table operations unsupported: missing isolate-bound table capabilities");
    if (tokens[i] === "pg" && tokens[i+1] === ".")
      throw Error("WASM pg guest group operations unsupported: missing actor mailbox and membership lowering");
  }
}
