/**
 * Capability-free source preflight for the scalar-only Wasm compiler bridge.
 * No source actors or reactor threads are currently available to a Wasm guest.
 * This lexes only enough to distinguish executable tokens from comments and
 * quoted strings; it does not substitute for a full Oreslang source parser.
 */
import {lexSourceAdmission} from "./source-admission-lexer.mjs";
const declarationModifiers = new Set(["pub", "serial", "http", "tcp", "ws"]);

export function rejectUnsupportedActorThreadSource(snapshot) {
  const tokens = lexSourceAdmission(snapshot).map(token => token.text);

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "@" && tokens[i+1] === "ActorMaxThreads")
      throw Error("WASM source actor @ActorMaxThreads unsupported: no guest actor scheduler");
    // The Wasm bridge has no checked annotation expansion/effect/ABI pass.
    // Reject any other source annotation before invoking LLVM or publishing
    // an artifact. Comments, quoted strings and templates were skipped above.
    if (tokens[i] === "@")
      throw Error("WASM source annotation unsupported: no validated guest annotation lowering");
    if (tokens[i] === "define") {
      // Actor variants desugar to actors, including public, serial and
      // transport-specific shorthands. A scanner checking only `define actor`
      // would silently skip the other spellings before native compilation.
      let declaration = i + 1;
      for (let seen = 0; seen < 5 && declarationModifiers.has(tokens[declaration]); seen++)
        declaration++;
      if (tokens[declaration] === "actor")
        throw Error("WASM source actor execution unsupported: no guest actor scheduler");
      if (tokens[declaration] === "enum"
          && tokens[declaration + 1] === "MaxActorThreads")
        throw Error("WASM built-in MaxActorThreads enum unsupported: no guest actor scheduler");
    }
  }
}
