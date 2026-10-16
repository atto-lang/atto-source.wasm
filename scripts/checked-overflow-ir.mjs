/**
 * Experimental source-conformance gate for signed-i64 overflow fixtures.
 *
 * This is a conservative structural check of the *exact LLVM IR handed to
 * Clang*. It is not a full LLVM verifier or a general-purpose proof of
 * arithmetic effects. The native LLVM compiler must still be pinned and the
 * completed Wasm binary actually executed.
 */
const OPERATIONS=new Set(["sadd","ssub","smul"]);
const PAIR=/\bcall\s+\{\s*i64\s*,\s*i1\s*\}\s+@llvm\.(sadd|ssub|smul)\.with\.overflow\.i64\s*\(/g;
const FLAG=/\bextractvalue\s+\{\s*i64\s*,\s*i1\s*\}\s+%[\w.]+\s*,\s*1\b/g;
const GUARD=/\bbr\s+i1\s+%[\w.]+\s*,\s*label\s+%i64\.overflow\.trap(?:\.\d+)?\s*,\s*label\s+%i64\.checked\.continue(?:\.\d+)?\b/g;
const TRAP=/\bcall\s+void\s+@llvm\.trap\s*\(\s*\)/g;
const FAILURE=/^\s*i64\.overflow\.trap(?:\.\d+)?:\s*(?:;[^\n]*)?\n\s*call\s+void\s+@llvm\.trap\s*\(\s*\)\s*\n\s*unreachable\b/gm;

// Fail closed on any unrelated trap. Every trap must occur in the checked
// overflow failure block pattern emitted by lower_checked_scalar/checked_pure_i64.
export function assertCheckedOverflowIr(ir,operation){
  if(typeof ir!=="string"||ir.length>2*1024*1024)throw Error("invalid checked overflow LLVM IR");
  if(!OPERATIONS.has(operation))throw Error("unsupported checked overflow operation");
  if(!/^\s*target triple = "wasm32-[^"\n]+"\s*$/m.test(ir))
    throw Error("checked overflow IR lacks real wasm32 target triple");
  const pairs=[...ir.matchAll(PAIR)];
  if(!pairs.some(match=>match[1]===operation))
    throw Error("checked overflow IR lacks required signed-i64 overflow intrinsic "+operation);
  const flags=[...ir.matchAll(FLAG)];
  const guards=[...ir.matchAll(GUARD)];
  const traps=[...ir.matchAll(TRAP)];
  const failures=[...ir.matchAll(FAILURE)];
  if(!flags.length||!guards.length||!traps.length||
     flags.length<traps.length||guards.length!==traps.length||
     failures.length!==traps.length)
    throw Error("checked overflow IR lacks complete conditional overflow/trap control flow");
  // Do not silently classify an unrelated Wasm trap as numerical overflow.
  // Raw 'unreachable' without llvm.trap must not be admitted.
  const unreachable=[...ir.matchAll(/^\s*unreachable\b/gm)];
  if(unreachable.length!==failures.length)
    throw Error("checked overflow IR contains unrelated unreachable control flow");
}
