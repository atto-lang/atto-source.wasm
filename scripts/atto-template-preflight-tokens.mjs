/** Quote-aware tokens for Wasm host admission; LLVM owns expression typing and codegen.
 * Template text is opaque but interpolation expressions are lexed as code.
 * No shadow interpreter or implicit scalar string lowering is introduced.
 */
export function lexicalTokensForPreflight(text) {
 if (typeof text !== "string" || text.length > 1_048_576)
  throw new RangeError("WASM source preflight byte budget exceeded");
 // JavaScript string length counts UTF-16 code units, not UTF-8 source bytes.
 // Reject malformed UTF-16 and enforce the same byte ceiling as file admission.
 let utf8Bytes = 0;
 for (let i = 0; i < text.length; ++i) {
  const cp = text.charCodeAt(i);
  if (cp >= 0xd800 && cp <= 0xdbff) {
   const low = text.charCodeAt(i + 1);
   if (!(low >= 0xdc00 && low <= 0xdfff))
    throw Error("WASM source preflight unpaired UTF-16 surrogate at offset " + i);
   ++i;
   utf8Bytes += 4;
  } else if (cp >= 0xdc00 && cp <= 0xdfff) {
   throw Error("WASM source preflight unpaired UTF-16 surrogate at offset " + i);
  } else {
   utf8Bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : 3;
  }
  if (utf8Bytes > 1_048_576)
   throw new RangeError("WASM source preflight byte budget exceeded");
 }
 if (text.indexOf(String.fromCharCode(0)) >= 0) throw Error("WASM source preflight NUL forbidden");
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
 function escape(start, templateLiteral) {
  pos++;
  if(pos >= text.length) fail("unterminated source literal escape", start);
  const c=text[pos++];
  if(c === "u") {
   const read4=()=>{
    if(pos+4>text.length || !/^[0-9A-Fa-f]{4}$/.test(text.slice(pos,pos+4)))
     fail("invalid Unicode escape",start);
    const code=parseInt(text.slice(pos,pos+4),16);
    pos+=4;
    return code;
   };
   const hi=read4();
   if(hi>=0xd800 && hi<=0xdbff){
    if(text.slice(pos,pos+2)!=="\\u")fail("unpaired Unicode surrogate",start);
    pos+=2;
    const lo=read4();
    if(lo<0xdc00 || lo>0xdfff)fail("unpaired Unicode surrogate",start);
   }else if(hi>=0xdc00 && hi<=0xdfff)
    fail("unpaired Unicode surrogate",start);
   return;
  }
  // Legacy ordinary strings preserve unknown escapes and raw newlines.
  // Only template literal escape sequences are restricted.
  if(!templateLiteral) {
   if(c==="\r" && text[pos]==="\n")pos++;
   return;
  }
  if(!["n","r","t","\\","'","\"","$","`"].includes(c))
   fail("invalid template escape",start);
 }
 function quoted() {
  const start = pos, mark = text[pos++];
  while (pos < text.length) {
   const c=text[pos];
   if(c==="\\"){escape(start,false);continue;}
   pos++;
   if(c===mark){push("<quoted>",start);return;}
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
    escape(start,true);
   } else if (text[pos] === "`") {
    pos++;
    push("</template>", pos-1);
    return;
   } else if (text.startsWith("${",pos)) {
    if (++substitutions > MAX_SUBSTITUTIONS) fail("template interpolation count exceeded", pos);
    push("{", pos);
    pos += 2;
    code(true, depth+1);
    push("}", pos-1);
   } else pos++;
  }
  fail("unterminated template literal", start);
 }
 function code(interpolation, depth) {
  let braces = 1, hasExpression = false;
  while (pos < text.length) {
   const c = text[pos];
   if (/\s/.test(c) || c === "\u0085") {pos++; continue;}
   if (text.startsWith("//",pos)) {
    pos += 2;
    while (pos < text.length && !lineEnd(text[pos])) pos++;
    continue;
   }
   if (text.startsWith("/*",pos)) {blockComment(); continue;}
   if (c === "'" || c === '"') {quoted();hasExpression=true;continue;}
   if (c === "`") {template(interpolation ? depth+1 : 0);hasExpression=true;continue;}
   if (interpolation && c === "{") {
    if (++braces > MAX_BRACES) fail("template interpolation braces exceeded", pos);
    hasExpression=true;push("{",pos++);
    continue;
   }
   if (interpolation && c === "}") {
    if (braces === 1) {
     if(!hasExpression) fail("empty template interpolation",pos);
     pos++;return;
    }
    braces--;
    push("}",pos++);
    continue;
   }
   if (wordStart(c)) {
    const start = pos++;
    while (wordPart(text[pos])) pos++;
    hasExpression=true;
    push(text.slice(start,pos), start, true);
   } else {hasExpression=true;push(c,pos++);}
  }
  if (interpolation) fail("unterminated template interpolation", pos);
 }
 code(false, 0);
 return tokens;
}
