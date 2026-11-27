/**
 * Experimental, explicit end-to-end bridge:
 * native AttoLang/legacy source (.atto/.ores -> LLVM IR) -> clang wasm32 -> Wasm module.
 * There is no fallback or mock compiler; caller must pass a real binary.
 */
import {spawnSync} from "node:child_process";
import {types} from "node:util";
import {snapshotGuestBytes} from "../src/snapshot-guest-bytes.mjs";
import {rejectBidirectionalSourceControls} from "./source-bidi-admission.mjs";
import {scalarAt,isSourceNameStart,sourceNameEnd} from "../src/source-unicode-identifiers.mjs";
import {constants} from "node:fs";
import {createHash} from "node:crypto";
import {writeFile,mkdir,mkdtemp,rm,rename,realpath,stat,open} from "node:fs/promises";
import {dirname,resolve,isAbsolute,join,basename,extname} from "node:path";
import {fileURLToPath} from "node:url";
import {assertCoreI64Entry} from "./core-i64-abi.mjs";
import {restrictedBuildEnvironment} from "./restricted-build-environment.mjs";
import {inspectWasmBytes} from "./inspect-core-memory.mjs";
import {assertWasm32IrTarget} from "./wasm32-ir-target.mjs";
import {assertCheckedOverflowIr} from "./checked-overflow-ir.mjs";
import {publishAtomicRelease} from "./atomic-release.mjs";
import {rejectUnsupportedActorThreadSource} from "../src/actor-max-threads-source-policy.mjs";
import {rejectUnsupportedUnsafeSource} from "../src/unsafe-source-policy.mjs";
const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const MAX_SOURCE_BYTES=1024*1024,MAX_COMPILER_BYTES=256*1024*1024,MAX_WASM_BYTES=16*1024*1024;
// The scalar Wasm bridge accepts ONE standalone source file, not a graph.
// Validate the pinned source snapshot before invoking even a "real" compiler:
// a compiler silently ignoring an import must not publish a valid-looking
// scalar Wasm with incomplete source provenance. This is an admission scanner,
// not a substitute for parsing or linking modules.
export function assertScalarSourceHasNoImports(bytes){
 rejectSourceTerminalControls(bytes);
 const source=rejectBidirectionalSourceControls(bytes);
 // A NUL byte is invalid source, even if a downstream scalar compiler
 // chooses to truncate or ignore it before resolving the source graph.
 if(source.includes("\0"))throw Error("NUL byte in Oreslang source");
 let i=0;
 while(i<source.length){
  const ch=source[i],next=source[i+1];
  if(ch==="/"&&next==="/"){
   // A CR-only line ending is still a new source line. Otherwise an import
   // after \\r could be hidden from this pre-publication admission check.
   i+=2;
   while(i<source.length&&!["\r","\n","\u0085","\u2028","\u2029"].includes(source[i]))i++;
   continue;
  }
  if(ch==="/"&&next==="*"){
   // The Java and LLVM source lexers admit nested comments. Keep this
   // preflight aligned instead of treating the first inner */ as the end.
   i+=2;let depth=1;
   while(i<source.length&&depth>0){
    if(source[i]==="/"&&source[i+1]==="*"){
     if(++depth>128)throw Error("Oreslang block comment nesting limit exceeded");
     i+=2;continue;
    }
    if(source[i]==="*"&&source[i+1]==="/"){depth--;i+=2;continue;}
    i++;
   }
   if(depth!==0)throw Error("unterminated Oreslang block comment");
   continue;
  }
  if(ch==='"'||ch==="'"||ch==="`"){
   const quote=ch;i++;let closed=false;
   while(i<source.length){
    if(source[i]==="\\"){i+=2;continue}
    if(source[i]===quote){i++;closed=true;break}
    i++;
   }
   if(!closed)throw Error("unterminated Oreslang string or character literal");
   continue;
  }
  if(isSourceNameStart(scalarAt(source,i))){
   const begin=i;
   i=sourceNameEnd(source,i);
   if(source.slice(begin,i)==="import")
    throw Error("source imports require verified complete Wasm module graph");
   continue;
  }
  i++;
 }
}



const intrinsicGetter = (prototype, name) => Function.prototype.call.bind(
 Object.getOwnPropertyDescriptor(prototype, name).get);
const typedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const sourceTypedLength = intrinsicGetter(typedArrayProto, "byteLength");
const sourceTypedBuffer = intrinsicGetter(typedArrayProto, "buffer");
const sourceDataViewLength = intrinsicGetter(DataView.prototype, "byteLength");
const sourceDataViewBuffer = intrinsicGetter(DataView.prototype, "buffer");
const sourceArrayBufferLength = intrinsicGetter(ArrayBuffer.prototype, "byteLength");

// Source admission must enforce the physical byte budget, never a spoofable
// .byteLength property from a Uint8Array/DataView subclass or a Proxy.
// Shared backing is rejected: another worker could change source during scanning.
function physicalSourceByteLength(input) {
 if(input == null || types.isProxy(input) || types.isSharedArrayBuffer(input))
  throw new TypeError("WASM source preflight requires nonshared byte input");
 if(types.isTypedArray(input)) {
  if(types.isSharedArrayBuffer(sourceTypedBuffer(input)))
   throw new TypeError("WASM source preflight forbids shared backing");
  return sourceTypedLength(input);
 }
 if(types.isDataView(input)) {
  if(types.isSharedArrayBuffer(sourceDataViewBuffer(input)))
   throw new TypeError("WASM source preflight forbids shared backing");
  return sourceDataViewLength(input);
 }
 if(types.isArrayBuffer(input)) return sourceArrayBufferLength(input);
 throw new TypeError("WASM source preflight requires byte input");
}

// Scan exact physical bytes using the existing intrinsic-backed admission primitive.
export function rejectSourceTerminalControls(sourceBytes) {
 const length=physicalSourceByteLength(sourceBytes);
 if(length>MAX_SOURCE_BYTES) throw new RangeError("WASM terminal-control preflight byte budget exceeded");
 const bytes=snapshotGuestBytes(sourceBytes,MAX_SOURCE_BYTES);
 for(let i=0;i<bytes.length;i++) {
  if(bytes[i]===0x1b || bytes[i]===0x7f)
   throw Error("SOURCE_TERMINAL_CONTROL: ESC/DEL in source at byte "+i);
 }
}
function tupleV2Tokens(sourceBytes){
 // Exported source-admission gates can be called before the CLI's bounded file
 // snapshot. Enforce the same byte budget before decode or token allocation.
 const physicalLength=physicalSourceByteLength(sourceBytes);
 if(!Number.isSafeInteger(physicalLength))
  throw new TypeError("WASM source preflight requires byte input");
 if(physicalLength>MAX_SOURCE_BYTES)
  throw new RangeError("WASM source preflight byte budget exceeded");
 rejectSourceTerminalControls(sourceBytes);
 const text=rejectBidirectionalSourceControls(sourceBytes);
 // Unicode decoding alone does not reject raw NUL. Check before any tokenizer
 // can erase a comment or quoted literal, and prior to compiler invocation or
 // staging. The byte budget above bounds this conversion and its allocation.
 const nul=text.indexOf("\0");
 if(nul!==-1) {
  const offset=new TextEncoder().encode(text.slice(0,nul)).byteLength;
  throw Error("WASM source preflight contains NUL byte at byte offset "+offset);
 }
 const tokens=[];
 const MAX_SOURCE_TOKENS=100_000;
 const pushToken=token=>{
  if(tokens.length>=MAX_SOURCE_TOKENS)
   throw new RangeError("WASM source preflight token budget exceeded");
  tokens.push(token);
 };
 for(let i=0;i<text.length;){
  const c=text[i];
  // U+0085 (NEL) is AttoLang whitespace and a //-comment boundary, but
  // JavaScript /\\s/ excludes it. Treat it consistently or unsupported
  // declarations can be split into punctuation tokens and evade preflight.
  if(/\s/.test(c)||c==="\u0085"){i++;continue}
  if(c==="/"&&text[i+1]==="/"){
   i+=2;while(i<text.length&&!["\n","\r","\u0085","\u2028","\u2029"].includes(text[i]))i++;continue;
  }
  if(c==="/"&&text[i+1]==="*"){
   const start=i;i+=2;let depth=1;
   while(i<text.length&&depth){
    if(text[i]==="/"&&text[i+1]==="*"){if(++depth>128)throw Error("block comment nesting too deep at byte "+start);i+=2}
    else if(text[i]==="*"&&text[i+1]==="/"){depth--;i+=2}
    else i++;
   }
   if(depth)throw Error("unterminated block comment at byte "+start);
   continue;
  }
  if(c==="\""||c==="'"){
   const quote=c;const start=i++;let escaped=false,closed=false;
   while(i<text.length){
    const q=text[i++];
    if(escaped){escaped=false;continue}
    if(q==="\\"){escaped=true;continue}
    if(q===quote){closed=true;break}
   }
   if(!closed)throw Error("unterminated source literal at byte "+start);
   continue;
  }
  if(isSourceNameStart(scalarAt(text,i))){
   const start=i;i=sourceNameEnd(text,i);
   pushToken({text:text.slice(start,i),offset:start,id:true});continue;
  }
  pushToken({text:c,offset:i,id:false});i++;
 }
 return tokens;
}

/**
 * Defense in depth for retired language operators. This bounded tokenizer
 * ignores strings and nested comments, while the exact pinned LLVM compiler
 * remains responsible for full grammar and type checking. A bridge-only
 * rejection is never evidence of native compiler semantic parity.
 */
export function rejectRetiredSourceOperators(sourceBytes,operatorProfile="legacy"){
 if(!["legacy","canonical-i64-v5"].includes(operatorProfile))
  throw Error("unknown source operator profile");
 const tokens=tupleV2Tokens(sourceBytes);
 const canonical=operatorProfile==="canonical-i64-v5";
 const raw=canonical?new TextDecoder("utf-8",{fatal:true}).decode(sourceBytes):"";
 for(let i=0;i<tokens.length;i++){
  const token=tokens[i];
  if(token.id || (token.text!=="%" && token.text!=="^"))continue;
  const isDouble=token.text==="^" && tokens[i+1]?.text==="^" &&
    !tokens[i+1]?.id && tokens[i+1].offset===token.offset+1;
  // Only the explicit canonical profile delegates adjacent binary XOR.
  // Reject triple carets and the unapproved compound spelling.
  if(canonical && isDouble &&
     !(tokens[i+2]?.offset===token.offset+2 &&
       ["^","="].includes(tokens[i+2]?.text))) { i++; continue; }
  if(canonical && !isDouble && token.text==="^"){
   const previous=tokens[i-1];
   // The tokenizer omits literals and comments. Inspect the raw gap so
   // a hidden literal cannot turn an infix caret into a statement boundary.
   if(previous && ["{",";"].includes(previous.text) &&
      /^[\s\u0085]*$/u.test(raw.slice(previous.offset+1,token.offset)) &&
      tokens[i+1]?.text!=="^") continue;
  }
  const glyph=isDouble?"^^":token.text;
  throw Error("ATTO_REMOVED_OPERATOR: '"+glyph+
    "' is not an AttoLang source operator at offset "+token.offset);
 }
}

/**
 * Conservative source admission for new declaration families. This bridge
 * does not own the language parser: native LLVM must also reject unimplemented
 * declarations. Scan exact declaration-head tokens only, never raw substrings.
 */
/**
 * Durable activity/workflow declarations have no Wasm replay/history ABI.
 * Fail before invoking even a pinned LLVM compiler or writing guest artifacts.
 * This only detects unsupported declaration heads; it does not parse AttoLang.
 * Shared tokenizer ignores strings/comments and rejects malformed UTF-8.
 */
export function rejectUnsupportedDurableM0Source(sourceBytes) {
 const tokens=tupleV2Tokens(sourceBytes);
 for(let i=0;i<tokens.length;i++) {
  let j=i;
  if(tokens[j]?.id&&tokens[j].text==="pub" &&
     tokens[j+1]?.id&&tokens[j+1].text==="define")j++;
  if(tokens[j]?.text!=="define"||!tokens[j]?.id)continue;
  j++;
  if(tokens[j]?.id&&tokens[j].text==="pub")j++;
  const declaration=tokens[j];
  if(declaration?.id &&
     (declaration.text==="activity"||declaration.text==="workflow"))
   throw Error("DURABLE_M0_BACKEND_UNSUPPORTED: Wasm durable "+
      declaration.text+" requires a versioned manifest and replay ABI at offset "+
      declaration.offset);
 }
}

export function rejectUnsupportedStateContainerVirtualActorSource(sourceBytes) {
 const tokens=tupleV2Tokens(sourceBytes);
 for(let i=0;i<tokens.length;i++) {
  let j=i;
  if(tokens[j]?.text==="pub" && tokens[j+1]?.text==="define") j++;
  if(tokens[j]?.text!=="define") continue;
  j++;
  if(tokens[j]?.text==="pub") j++;
  const first=tokens[j], second=tokens[j+1];
  if(!first?.id||!second?.id)continue;
  if(first.text==="state"&&second.text==="container")
   throw Error("STATE_CONTAINER_BACKEND_UNSUPPORTED: Wasm bridge needs protected heap region and critical guard lowering at offset "+first.offset);
  if(first.text==="virtual"&&second.text==="actor")
   throw Error("VIRTUAL_ACTOR_BACKEND_UNSUPPORTED: Wasm bridge needs logical key and activation fencing at offset "+first.offset);
 }
}

/**
 * Wasm source bridge capability gate. This backend has no tuple-value ABI,
 * optional-tail representation, or readonly structural tuple view yet.
 */
export function rejectUnsupportedTupleV2Source(sourceBytes){
 const tokens=tupleV2Tokens(sourceBytes);
 for(let i=0;i<tokens.length;i++){
  if(!(tokens[i].id&&(tokens[i].text==="fnc"||tokens[i].text==="routine")))continue;
  if(!(tokens[i+1]?.id))continue; // declaration name
  let cursor=i+2;
  if(tokens[cursor]?.text==="<"){
   let depth=0;
   for(;cursor<tokens.length;cursor++){
    if(tokens[cursor].text==="<")depth++;
    else if(tokens[cursor].text===">"){
     if(--depth===0){cursor++;break}
    }
   }
   if(depth!==0)continue; // malformed generics remain the compiler's diagnostic.
  }
  if(tokens[cursor]?.text!=="(")continue;
  const first=tokens[cursor+1];
  if(!first||first.text===")")continue;
  if(first.text==="("){
   throw Error("wasm structural tuple v2 parameter ABI unsupported at byte "+first.offset);
  }
  if(first.id&&first.text==="structural"){
   throw Error("wasm structural tuple v2 readonly-view ABI unsupported at byte "+first.offset);
  }
  if(first.id&&first.text==="tuple"&&tokens[cursor+2]?.text==="("){
   throw Error("wasm structural tuple v2 parameter ABI unsupported at byte "+first.offset);
  }
 }
}
/**
 * Fail closed until actual LLVM source → wasm32 inverted-row lowering exists.
 * A bounded comment/string-aware scanner only diagnoses unsupported source:
 * it does NOT recognize a valid layout or replace the compiler/typechecker.
 * There is no ordinary Array<T>, actor shard or scalar fallback for these.
 */
export function rejectUnsupportedInvertedLayoutSource(sourceBytes){
 const tokens=tupleV2Tokens(sourceBytes);
 const is=(i,text)=>tokens[i]?.id===true&&tokens[i].text===text;
 for(let i=0;i<tokens.length;i++){
  if(is(i,"define")||is(i,"pub")&&is(i+1,"define")){
   let j=i+(is(i,"define")?1:2);
   if(is(j,"pub"))j++;
   if(is(j,"inverted")&&(is(j+1,"struct")||is(j+1,"class"))){
    throw Error("wasm inverted "+tokens[j+1].text+
      " requires typed one-level SoA source lowering at byte "+tokens[j].offset);
   }
  }
  if(is(i,"InvertedArray")&&tokens[i+1]?.text==="<"){
   throw Error("wasm inverted collection requires checked owner/row/column ABI at byte "+
     tokens[i].offset);
  }
 }
}
/**
 * Structural match-arm patterns need typed metadata and readonly loan
 * lowering; a scalar-only Wasm guest may never materialize them by accident.
 * Reuses the bounded UTF-8 lexer so strings/comments are never evidence.
 */
export function rejectUnsupportedStructuralPatternSource(sourceBytes){
 const tokens=tupleV2Tokens(sourceBytes);
 for(let i=0;i+1<tokens.length;i++){
  if(tokens[i].id && tokens[i].text==="on" &&
     tokens[i+1].id && tokens[i+1].text==="structural"){
   throw Error("wasm structural pattern lowering unsupported at byte "+tokens[i+1].offset);
  }
 }
}
/**
 * Current core-wasm.i64-v1 cannot lower heap aliases, vector relocation or
 * shared mutation. Deny source ownership forms BEFORE invoking native LLVMc;
 * an eventual compiler backend must replace this explicit capability gate
 * only after guest, Worker and linear-memory lifetime evidence exists.
 * Lexical tokenization ignores source comments and string contents.
 */
/**
 * A Mutex<T> is a sealed, identity-bearing class. This scalar Wasm bridge
 * cannot execute its async lease ABI, but must distinguish a missing `new`
 * from a legal class constructor with unavailable runtime lowering. The
 * bounded shared tokenizer excludes nested comments and quoted literals.
 */
export function rejectMutexResourceClassSource(sourceBytes){
 const tokens=tupleV2Tokens(sourceBytes);
 for(let i=0;i<tokens.length;i++){
  if(!tokens[i]?.id||tokens[i].text!=="Mutex"||tokens[i+1]?.text!=="<")continue;
  let depth=0,close=-1;
  for(let j=i+1;j<tokens.length;j++){
   if(tokens[j].text==="<")depth++;
   else if(tokens[j].text===">"){
    if(--depth===0){close=j;break}
    if(depth<0)break;
   }
  }
  if(close<0||tokens[close+1]?.text!=="(")continue; // type, not invocation
  const offset=tokens[i].offset;
  if(tokens[i-1]?.text!=="new")
   throw Error("E_NEW_REQUIRED: Mutex<T> is a resource class at byte "+offset);
  throw Error("E_LOCK_UNSUPPORTED: wasm scalar bridge lacks mutex scheduler at byte "+offset);
 }
}

export function rejectUnsupportedHeapContainerSource(sourceBytes){
 const tokens=tupleV2Tokens(sourceBytes);
 const nominal=new Set(["Box","Arc","Weak","Rc","RefCell",
  "Vector","Array","List","Mutex","RwLock","SharedMutex"]);
 for(let i=0;i<tokens.length;i++){
  const token=tokens[i];
  if(!token.id)continue;
  // A user-defined function named Box/Arc is not a heap type use.
  const declaration=tokens[i-1]?.id&&
      ["fnc","routine"].includes(tokens[i-1].text);
  if(!declaration&&nominal.has(token.text)&&
      ["<","[","("].includes(tokens[i+1]?.text)){
   throw Error("wasm heap/container ownership ABI unsupported: "+
      token.text+" at byte "+token.offset);
  }
  // Alias syntax must never escape this precompiler ownership admission.
  // The scalar Wasm backend has no compiled typed-loan/ownership-bang ABI.
  // Distinguish !eq (inequality) from a postfix ownership bang.
  const bang=["borrow","take","copy","share"].includes(token.text) &&
    tokens[i+1]?.text==="!" &&
    !(tokens[i+2]?.id&&tokens[i+2].text==="eq");
  const mutBang=token.text==="mut" && tokens[i+1]?.id &&
    tokens[i+1].text==="borrow" && tokens[i+2]?.text==="!";
  if(bang||mutBang){
   throw Error("wasm heap loan/transfer lowering unsupported at byte "+
      token.offset);
  }
  if(token.text!=="rt")continue;
  const a=tokens[i+1],b=tokens[i+2];
  if(a?.id&&["borrow","take"].includes(a.text) ||
     a?.text==="mut"&&b?.id&&["borrow","share"].includes(b.text)){
   throw Error("wasm heap loan/transfer lowering unsupported at byte "+
      token.offset);
  }
 }
}

/** Actor pipeline transport is not lowered by the scalar Wasm bridge.
 * This is a fail-closed source admission gate, NOT guest actor execution.
 * Token positions preserve contextual bang adjacency; quoted text, comments,
 * ordinary identifiers and functional |> remain untouched.
 */
export function rejectUnsupportedActorPipeSource(sourceBytes) {
 const tokens=tupleV2Tokens(sourceBytes);
 const reservedBefore=new Set([
  "fnc","routine","method","define","pub","static","val",
  "let","const","final","return","spawn","pipe","rpipe",
  "stop","await","as","case"
 ]);
 const forbiddenNext=new Set(["then","fi","end","else","as","case","over"]);
 for(let i=0;i<tokens.length;i++) {
  const current=tokens[i];
  if(!current.id)continue;
  if(!["pipe","rpipe","stop"].includes(current.text))continue;
  const prev=tokens[i-1],next=tokens[i+1];
  // The ! belongs to the contextual operator only when contiguous. A
  // separate logical ! or an identifier suffix must never be rewritten.
  const bang=next?.text==="!" &&
      next.offset===current.offset+current.text.length;
  const rhs=tokens[i+(bang?2:1)];

  // No actor lifecycle STOP is executable in the scalar Wasm profile.
  // A globally rewritten 'stop!' would be unsafe; this only recognizes the
  // exact contiguous operator in a token stream that skips literals/trivia.
  if(current.text==="stop") {
    if(bang)throw Error("wasm graceful actor stop! source lowering unsupported at byte "+current.offset);
    continue;
  }

  // A contiguous bang spelling reserves the entire source operator, even
  // when its endpoints are missing or malformed. The actual compiler must
  // reject such source, but no scalar artifact should reach that invocation.
  if (bang)
    throw Error("wasm actor "+current.text+"! source lowering unsupported at byte "+current.offset);

  const classCall=current.text==="pipe" && prev?.text==="." &&
      tokens[i-2]?.id && tokens[i-2].text==="ActorUtils";
  const classColonCall=current.text==="pipe" && prev?.text===":" &&
      tokens[i-2]?.text===":" &&
      tokens[i-3]?.id && tokens[i-3].text==="ActorUtils";
  const leftEnd=prev && ((prev.id && !reservedBefore.has(prev.text)) ||
      [")","]","}"].includes(prev.text));
  const rightStart=rhs && ((rhs.id&&!forbiddenNext.has(rhs.text)) ||
      ["(","["].includes(rhs.text));
  // Reject named-actor and stream/channel edges in both lexical directions.
  // Never emit a scalar Wasm guest for unknown continuous transport.
  if(classCall||classColonCall||(leftEnd&&rightStart))
    throw Error("wasm actor "+current.text+(bang?"!":"")+" source lowering unsupported at byte "+current.offset);
 }
}
/** ActorGroup/Topic source lowering is not implemented by the Wasm bridge yet. */
export function rejectUnsupportedActorPubSubSource(sourceBytes){
 const tokens=tupleV2Tokens(sourceBytes);
 for(let i=0;i<tokens.length;i++){
  const current=tokens[i];
  const actorGroupCall=
    current?.id && current.text==="actor" &&
    tokens[i+1]?.text==="." && tokens[i+2]?.id &&
    tokens[i+2].text==="group";
  const typedHandle=
    current?.id && (current.text==="Topic" || current.text==="Subscription") &&
    tokens[i+1]?.text==="<";
  const typedTopicCall=
    current?.text==="." && tokens[i+1]?.id &&
    tokens[i+1].text==="topic" && tokens[i+2]?.text==="<";
  // An imported or local handle may omit the Topic type spelling.
  // Conservatively reject the unresolved member, not free functions.
  const tryPublishMember=
    current?.text==="." && tokens[i+1]?.id &&
    tokens[i+1].text==="try_publish";
  if(actorGroupCall || typedHandle || typedTopicCall || tryPublishMember)
   throw Error("wasm ActorGroup/Topic source lowering unsupported at byte "+current.offset);
 }
}
// A preflight stat + readFile(path) is not a byte-budget: the file can be
// replaced or expanded before readFile allocates. Open once with NOFOLLOW,
// reject FIFOs/non-files, read exactly the statted budget and verify the
// opened inode did not change during the copy.
export async function readBoundedRegularFile(path,maxBytes,errorLabel="input exceeds byte budget"){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>MAX_COMPILER_BYTES)
  throw new TypeError("invalid input byte budget");
 if(!Number.isInteger(constants.O_NOFOLLOW)||!Number.isInteger(constants.O_NONBLOCK))
  throw Error("bounded no-follow file reads unsupported on this host");
 let fd;
 try{fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)}
 catch(error){
  if(["ELOOP","EISDIR","ENXIO"].includes(error?.code))
   throw Error("symlink or special input file is forbidden");
  throw error;
 }
 try{
  const before=await fd.stat();
  if(!before.isFile()||!Number.isSafeInteger(before.size)||
     before.size<0||before.size>maxBytes)throw Error(errorLabel);
  const bytes=Buffer.alloc(before.size);
  let at=0;
  while(at<bytes.length){
   const {bytesRead}=await fd.read(bytes,at,bytes.length-at,at);
   if(bytesRead===0)throw Error("input was truncated during snapshot");
   at+=bytesRead;
  }
  const after=await fd.stat();
  if(!after.isFile()||after.size!==before.size||
     after.dev!==before.dev||after.ino!==before.ino||
     after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)
   throw Error("input changed during snapshot");
  return {bytes,stat:before};
 }finally{await fd.close()}
}

function rejectStartSection(bytes){
 let i=8;
 const u32=()=>{let value=0;for(let j=0;j<5;j++){
  if(i>=bytes.length)throw Error("truncated Wasm section length");
  const v=bytes[i++];
  if(j===4 && (v&0xf0))throw Error("invalid Wasm section length");
  value+=(v&127)*2**(7*j);
  if(!(v&128))return value;
 }throw Error("invalid Wasm LEB128 length")};
 while(i<bytes.length){
  const id=bytes[i++],length=u32(),end=i+length;
  if(end>bytes.length)throw Error("truncated linked Wasm module");
  if(id===8)throw Error("linked module has forbidden start section");
  i=end;
 }
}

async function rejectMixedPublication(published,publication){
 const conflicts=publication==="atomic"?
  [published,published+".artifact.json",published+".provenance.json"]:
  [published+".current.json",published+".releases"];
 for(const path of conflicts){
  try{
   await stat(path);
   throw Error("legacy and atomic artifact publications cannot share an output path");
  }catch(error){if(error.code!=="ENOENT")throw error}
 }
}
// Cooperating compiler processes serialize the actual publication boundary,
// not source compilation. An abandoned lock fails closed until cleaned by an
// operator; never steal a lock based on an untrusted pid/time claim.
async function withPublicationLock(published,publication,callback){
 const lock=published+".publication.lock";
 let acquired=false;
 for(let attempt=0;attempt<160;attempt++){
  try{await mkdir(lock,{mode:0o700});acquired=true;break}
  catch(error){
   if(error.code!=="EEXIST")throw error;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
 }
 if(!acquired)throw Error("artifact publication lock unavailable");
 try{
  // This second admission check is serialized across cooperating compilers.
  await rejectMixedPublication(published,publication);
  return await callback();
 }finally{
  await rm(lock,{recursive:true,force:true});
 }
}
const absolute=(value,label)=>{if(!value||!isAbsolute(value))throw Error(label+" must be an absolute path");return value};
function run(command,args,{input,cwd}={}){
 // The native source compiler and clang/lld are trusted build tools, not
 // sandboxes. Keep their ambient environment free of CI tokens, Node hooks,
 // cloud credentials and dynamic-loader overrides. Compile in the private
 // scratch workspace so accidental relative writes cannot hit the checkout.
 const output=spawnSync(command,args,{
  input,cwd,env:restrictedBuildEnvironment(),
  encoding:"utf8",timeout:30000,maxBuffer:4*1024*1024,windowsHide:true
 });
 if(output.error||output.status!==0||output.signal){
  // Keep the historic diagnostic message, but retain process evidence. A
  // rejected compiler that wrote partial IR to stdout or died by signal must
  // not be mistaken for an intentional source-level capability denial.
  const failure=new Error("command failed ("+command+"): "+
    (output.error?.message||output.stderr||"exit "+output.status).slice(0,4000));
  failure.status=output.status;
  failure.signal=output.signal;
  failure.stdout=output.stdout||"";
  failure.stderr=output.stderr||"";
  if(output.error){
   failure.code=output.error.code;
   failure.errno=output.error.errno;
   failure.syscall=output.error.syscall;
   failure.cause=output.error;
  }
  throw failure;
 }
 return output.stdout||"";
}
export async function compileOresToWasm({compiler,source,output,exportName="main",clang=process.env.CLANG||"clang",compilerSha256,environment,publication="legacy",wasmLinker,checkedOverflowOperation,operatorProfile="legacy"}){
 absolute(compiler,"compiler");
 absolute(source,"source");
 absolute(output,"output");
 if (wasmLinker !== undefined) absolute(wasmLinker,"wasm linker");
 const sourceExtension=extname(source).toLowerCase();
 if(sourceExtension!==".atto"&&sourceExtension!==".ores")
  throw Error("source file must use canonical .atto or legacy .ores extension");
 // Resolve directory symlinks ONCE and use that physical pathname for
 // publication, not the caller's possibly aliased directory spelling.
 // A lexical resolve() comparison alone can overwrite compiler/source
 // inputs through an alternate symlinked parent directory.
 await mkdir(dirname(output),{recursive:true});
 // Resolve directory aliases, but keep the source leaf itself intact so
 // readBoundedRegularFile's O_NOFOLLOW open can reject a caller-supplied
 // symlink instead of silently following it through realpath(source).
 const [sourceParent,compilerPath,outputParent]=await Promise.all([
  realpath(dirname(source)),realpath(compiler),realpath(dirname(output))
 ]);
 const sourcePath=join(sourceParent,basename(source));
 const published=join(outputParent,basename(output));
 const protectedInputs=new Set([sourcePath,compilerPath]);
 if(!["atomic","legacy"].includes(publication))throw Error("invalid artifact publication mode");
 if(checkedOverflowOperation!==undefined && !["sadd","ssub","smul"].includes(checkedOverflowOperation))
  throw Error("invalid checked overflow witness operation");
 for(const destination of [published,published+".provenance.json",published+".artifact.json",published+".current.json",published+".releases",published+".publication.lock"]){
  if(protectedInputs.has(destination))
   throw Error("output or artifact metadata path overlaps a compiler/source input");
 }
 if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(exportName))throw Error("unsupported export name");
 // Preflight before readFile() to avoid allocating attacker-sized compiler
 // binaries or source buffers, then check the lengths again after reading.
 const [sourceStat,compilerStat]=await Promise.all([stat(sourcePath),stat(compilerPath)]);
 if(!sourceStat.isFile()||sourceStat.size>MAX_SOURCE_BYTES)
  throw Error("source exceeds 1 MiB compiler bridge budget or is not a regular file");
 if(!compilerStat.isFile()||compilerStat.size>MAX_COMPILER_BYTES)
  throw Error("compiler exceeds 256 MiB executable budget or is not a regular file");
 // A destination that already exists might itself be a symlink or hard link
 // to an input. Reject by inode identity before publishing over the link.
 // Merely canonicalizing its parent directory does not catch this case.
 for(const destination of [published,published+".provenance.json",published+".artifact.json",published+".current.json",published+".releases"]){
  try{
   const existing=await stat(destination);
   if([sourceStat,compilerStat].some(input=>
      input.dev===existing.dev&&input.ino===existing.ino))
    throw Error("output or artifact metadata path overlaps a compiler/source input");
  }catch(error){if(error?.code!=="ENOENT")throw error}
 }
 await rejectMixedPublication(published,publication);
 // Read and pin the SOURCE first. An unresolved import is a fatal admission
 // error in this standalone scalar bridge, so do not read or execute a
 // potentially 256 MiB compiler binary before denying that source.
 // This ordering also makes unlinked-module attacks cheap to reject.
 const sourceSnapshot=await readBoundedRegularFile(
  sourcePath,MAX_SOURCE_BYTES,"source exceeds 1 MiB compiler bridge budget");
 if(sourceSnapshot.stat.dev!==sourceStat.dev||sourceSnapshot.stat.ino!==sourceStat.ino)
  throw Error("source input changed between preflight and snapshot");
 const sourceBytes=sourceSnapshot.bytes;
 // Never silently compile a partial graph, even with a real trusted LLVM binary.
 assertScalarSourceHasNoImports(sourceBytes);
 const compilerSnapshot=await readBoundedRegularFile(
  compilerPath,MAX_COMPILER_BYTES,"compiler exceeds 256 MiB executable budget");
 if(compilerSnapshot.stat.dev!==compilerStat.dev||compilerSnapshot.stat.ino!==compilerStat.ino)
  throw Error("compiler input changed between preflight and snapshot");
 const compilerBytes=compilerSnapshot.bytes;
 // ActorGroup/Topic lowering is a distinct gate from physical actor threading.
 // Reject before invoking LLVM or staging any guest artifact.
 rejectUnsupportedActorPubSubSource(sourceBytes);
 rejectUnsupportedActorPipeSource(sourceBytes);
 // Source actors/physical actor threading are not implemented by this
 // scalar Wasm bridge. Reject before invoking the pinned native compiler.
 // G0 unsafe gate is independent of the caller-supplied compiler binary.
 rejectUnsupportedUnsafeSource(sourceBytes);
 rejectUnsupportedActorThreadSource(sourceBytes);
 // Do not delegate retired operators to an old pinned compiler that might
 // still accept them. This is preflight only, not native rejection evidence.
 if(!["legacy","canonical-i64-v5"].includes(operatorProfile))
  throw Error("unknown source operator profile");
 if(operatorProfile==="canonical-i64-v5" &&
    (typeof compilerSha256!=="string" || !/^[a-f0-9]{64}$/.test(compilerSha256)))
  throw Error("canonical-i64-v5 requires an exact compiler SHA-256 pin");
 rejectRetiredSourceOperators(sourceBytes,operatorProfile);
 // Fail before compiler execution or artifact staging if this Wasm backend
 // does not own the requested aggregate ABI yet.
 rejectUnsupportedDurableM0Source(sourceBytes);
 rejectUnsupportedStateContainerVirtualActorSource(sourceBytes);
 rejectUnsupportedTupleV2Source(sourceBytes);
 rejectUnsupportedStructuralPatternSource(sourceBytes);
 rejectUnsupportedInvertedLayoutSource(sourceBytes);
 rejectMutexResourceClassSource(sourceBytes);
 rejectUnsupportedHeapContainerSource(sourceBytes);
 const actualCompilerHash=sha(compilerBytes);
 if(compilerSha256!==undefined&&compilerSha256!==actualCompilerHash)throw Error("compiler binary SHA-256 does not match pinned hash");
 if(environment!==undefined&&!["browser","edge-js","edge-wasi"].includes(environment))
  throw Error("unsupported portable host environment");
 // Compile exactly the already-hashed source snapshot, not a mutable path.
 // The current scalar subset supports standalone .atto/.ores source files;
 // relative source imports must be resolved and pinned by a future module graph gate.
 const scratch=await mkdtemp(join(outputParent,".oreslang-wasm-"));
 const provisional=join(scratch,"guest.wasm");
 try{
 // Preserve the approved language suffix: the native LLVM CLI uses this
 // extension for frontend admission. Never disguise .atto as .ores.
 const stagedSource=join(scratch,"source"+sourceExtension);
 const stagedCompiler=join(scratch,"compiler-exact");
 await writeFile(stagedSource,sourceBytes,{mode:0o400,flag:"wx"});
 // Execute the exact compiler bytes whose SHA-256 we pinned, not a mutable
 // caller-supplied pathname that may be replaced between hashing and exec.
 // The private scratch directory prevents pathname substitution by another
 // filesystem principal; this is not a sandbox for a malicious compiler.
 await writeFile(stagedCompiler,compilerBytes,{mode:0o500,flag:"wx"});
 // This is a Wasm compiler bridge in every publication mode. Never
 // accept host-targeted LLVM IR just because the linker targets wasm32.
 const ir=run(stagedCompiler,["--tree-shake","--tree-shake-root=main","--target=wasm32",stagedSource],{cwd:scratch});
 if(sha((await readBoundedRegularFile(stagedCompiler,MAX_COMPILER_BYTES,"staged compiler exceeds executable budget")).bytes)!==actualCompilerHash)
  throw Error("staged compiler executable changed during execution");
 // The executable itself is also caller-owned mutable input. Never publish
 // provenance tied to a compiler digest if its executable changed in flight.
 if(sha((await readBoundedRegularFile(compilerPath,MAX_COMPILER_BYTES,"compiler exceeds 256 MiB executable budget")).bytes)!==actualCompilerHash)
  throw Error("compiler executable changed during execution; refusing stale provenance");
 // Reject mutation of the snapshotted compilation input even when the
 // original caller path remains unchanged.
 if(sha((await readBoundedRegularFile(stagedSource,MAX_SOURCE_BYTES,"staged source exceeds source budget")).bytes)!==sha(sourceBytes))
  throw Error("staged compiler input changed during execution");
 // Validate signed-i64 overflow witness against the exact native compiler IR before publication.
 if(checkedOverflowOperation!==undefined) assertCheckedOverflowIr(ir,checkedOverflowOperation);
 // Require a genuine LLVM triple declaration, not a comment or string.
 // Ensure an actual target triple exists, not a comment, duplicate, or
 // native-target fallback masquerading as wasm32.
 assertWasm32IrTarget(ir);
 if(!new RegExp("define\\s+i64\\s+@"+exportName+"\\s*\\(\\s*\\)").test(ir))throw Error("compiler did not emit the expected i64 @"+exportName+"() export");
 if(ir.length>2*1024*1024)throw Error("generated IR exceeds 2 MiB");
 // Avoid shell expansion and avoid relying on persistent temporary LLVM IR.
 // Clang reads the native compiler's verified stdout as LLVM IR.
 run(clang,[...(wasmLinker ? ["-fuse-ld="+wasmLinker] : []),
   "--target=wasm32","-x","ir","-Oz","-nostdlib",
   "-Wl,--no-entry","-Wl,--export="+exportName,
   "-Wl,--initial-memory=131072","-Wl,--max-memory=131072",
   "-o",provisional,"-"],{input:ir,cwd:scratch});
 const wasm=(await readBoundedRegularFile(provisional,MAX_WASM_BYTES,
  "linked Wasm exceeds 16 MiB artifact budget")).bytes;
 // Validate strict no-managed-guest policy before engine compilation.
 // inspectWasmBytes also enforces a single bounded linear memory.
 const memory=inspectWasmBytes(wasm,{maxModuleBytes:MAX_WASM_BYTES,maxMemoryPages:2});
 rejectStartSection(wasm);
 const module=new WebAssembly.Module(wasm);
 const imports=WebAssembly.Module.imports(module);
 if(imports.length)throw Error("guest Wasm unexpectedly imports host modules: "+imports.map(x=>x.module+"."+x.name).join(","));
 const guestExports=WebAssembly.Module.exports(module);
 if(!guestExports.some(x=>x.name===exportName&&x.kind==="function"))throw Error("guest Wasm missing requested export");
 if(!guestExports.some(x=>x.name==="memory"&&x.kind==="memory"))throw Error("guest Wasm missing required bounded memory export");
 assertCoreI64Entry(wasm,exportName);
 // The artifact manifest advertises an exact 2-page memory maximum. Check
 // the binary rather than relying on Clang flags or its version string.
 if(memory.memoryCount!==1||!memory.hasMemoryMaximum||memory.memoryMaximum!==2)
  throw Error("linked Wasm memory must declare exactly one bounded 2-page memory");
 const record={
  schemaVersion:1,kind:"llvm-ores-to-wasm32-core-experimental",treeShaking:"llvm-direct-calls-v1",
  compilerSha256:actualCompilerHash,sourceSha256:sha(sourceBytes),
  llvmIrSha256:sha(Buffer.from(ir,"utf8")),wasmSha256:sha(wasm),
  exportName,importCount:imports.length,wasmBytes:wasm.length,
  clangVersion:run(clang,["--version"],{cwd:scratch}).split("\n")[0],
  note:"Binary provenance: exact compiler executable bytes, not proof of source-repository commit or feature parity."
 };
 let manifest=null;
 if(environment){
  manifest={
   schemaVersion:1,artifactType:"oreslang.core-wasm.i64-v1",
   target:"wasm32",environment,backend:"wasm",entry:exportName,
   wasmSha256:sha(wasm),wasmBytes:wasm.length,requiredCapabilities:[],
   imports:[],memory:{maximumPages:2},
   producer:{compilerSha256:actualCompilerHash,
     sourceSha256:sha(sourceBytes),llvmIrSha256:sha(Buffer.from(ir,"utf8"))}
  };
  await writeFile(join(scratch,"artifact.json"),JSON.stringify(manifest,null,2)+"\n");
 }
 await writeFile(join(scratch,"provenance.json"),JSON.stringify(record,null,2)+"\n");
 return await withPublicationLock(published,publication,async()=>{
 if(publication==="atomic"){
  // The content-addressed release is privately staged and sealed first.
  // Only a single pointer rename makes it visible to verified readers.
  const publishedRelease=await publishAtomicRelease({
   output:published,wasm,manifest,provenance:record
  });
  return {...record,releaseSha256:publishedRelease.releaseSha256,
   publication:"atomic",pointer:publishedRelease.pointer};
 }
 // Publish metadata first; never expose a new executable after metadata
 // publication failed. Consumers must still SHA-check all sidecars: separate
 // files cannot be atomically committed as one transaction.
 if(environment)await rename(join(scratch,"artifact.json"),published+".artifact.json");
 await rename(join(scratch,"provenance.json"),published+".provenance.json");
 await rename(provisional,published);
 return record;
 });
 }finally{await rm(scratch,{recursive:true,force:true})}
}
const calledFromCli=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(calledFromCli){
 try{
  const usedOptions=new Set();
  const options=Object.fromEntries(process.argv.slice(2).map(x=>{
   const m=/^--(compiler|source|output|export|clang|compiler-sha256|environment|publication)=(.*)$/.exec(x);
   if(!m)throw Error("unexpected CLI option: "+x);
   if(usedOptions.has(m[1]))throw Error("duplicate CLI option: "+m[1]);
   usedOptions.add(m[1]);
   return[m[1],m[2]];
  }));
  const record=await compileOresToWasm({
   compiler:options.compiler,source:options.source,
   output:options.output||resolve(projectRoot,"build/guest.wasm"),
   exportName:options.export||"main",clang:options.clang||process.env.CLANG||"clang",
   compilerSha256:options["compiler-sha256"],environment:options.environment,publication:options.publication||"legacy"
  });
  console.log(JSON.stringify(record,null,2));
 }catch(error){console.error(error.stack||error.message);process.exitCode=1}
}
