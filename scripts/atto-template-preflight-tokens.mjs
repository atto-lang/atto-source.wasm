/** Quote-aware tokens for Wasm host admission; LLVM owns expression typing and codegen.
 * Template text is opaque but interpolation expressions are lexed as code.
 * No shadow interpreter or implicit scalar string lowering is introduced.
 */
export function lexicalTokensForPreflight(text) {
 const tokens = [];
 const MAX_TOKENS = 100_000, MAX_TEMPLATE_DEPTH = 32;
 const MAX_BRACES = 256, MAX_SUBSTITUTIONS = 1024;
 let pos = 0, substitutions = 0;
 const fail = (message, at) => { throw Error(message + " at offset " + at); };
 const push = (value, at, id = false) => {
  if (tokens.length >= MAX_TOKENS) fail("WASM source preflight token budget exceeded", at);
  tokens.push({text: value, offset: at, id});
 };
 const wordStart = c => c !== undefined && /[A-Za-z_]/.test(c);
 const wordPart = c => c !== undefined && /[A-Za-z0-9_]/.test(c);
 const lineEnd = c => c === "\n" || c === "\r" || c === "\u0085" || c === "\u2028" || c === "\u2029";
 function quoted() {
  const start = pos, mark = text[pos++];
  while (pos < text.length) {
   const c = text[pos++];
   if (c === "\\") {
    if (pos >= text.length) fail("unterminated source literal", start);
    pos++;
   } else if (c === mark) {
    push("<quoted>", start);
    return;
   } else if (lineEnd(c)) fail("newline in source literal", start);
  }
  fail("unterminated source literal", start);
 }
 function blockComment() {
  const start = pos;
  pos += 2;
  let depth = 1;
  while (pos < text.length && depth) {
   if (text.startsWith("/*",pos)) {
    if (++depth > 128) fail("block comment nesting too deep", start);
    pos += 2;
   } else if (text.startsWith("*/",pos)) {depth--; pos += 2;}
   else pos++;
  }
  if (depth) fail("unterminated block comment", start);
 }
 function template(depth) {
  const start = pos;
  if (depth > MAX_TEMPLATE_DEPTH) fail("template nesting too deep", start);
  push("<template>", start);
  pos++;
  while (pos < text.length) {
   if (text[pos] === "\\") {
    if (pos + 1 >= text.length) fail("unterminated template literal", start);
    pos += 2;
   } else if (text[pos] === "`") {
    pos++;
    push("</template>", pos-1);
    return;
   } else if (text.startsWith("${",pos)) {
    if (++substitutions > MAX_SUBSTITUTIONS) fail("template interpolation count exceeded", pos);
    push("{", pos);
    pos += 2;
    code(true, depth);
    push("}", pos-1);
   } else pos++;
  }
  fail("unterminated template literal", start);
 }
 function code(interpolation, depth) {
  let braces = 0;
  while (pos < text.length) {
   const c = text[pos];
   if (/\s/.test(c) || c === "\u0085") {pos++; continue;}
   if (text.startsWith("//",pos)) {
    pos += 2;
    while (pos < text.length && !lineEnd(text[pos])) pos++;
    continue;
   }
   if (text.startsWith("/*",pos)) {blockComment(); continue;}
   if (c === "'" || c === '"') {quoted(); continue;}
   if (c === "`") {template(depth+1); continue;}
   if (interpolation && c === "{") {
    if (++braces > MAX_BRACES) fail("template interpolation braces exceeded", pos);
    push("{",pos++);
    continue;
   }
   if (interpolation && c === "}") {
    if (braces === 0) {pos++; return;}
    braces--;
    push("}",pos++);
    continue;
   }
   if (wordStart(c)) {
    const start = pos++;
    while (wordPart(text[pos])) pos++;
    push(text.slice(start,pos), start, true);
   } else push(c,pos++);
  }
  if (interpolation) fail("unterminated template interpolation", pos);
 }
 code(false, 0);
 return tokens;
}
