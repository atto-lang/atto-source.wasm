/**
 * Conservative IR-shape gate for experimental pure signed-i64 Wasm fixtures.
 * Applied to the exact compiler IR before Clang receives it. Not a full
 * LLVM verifier, owner/actor safety proof, or substitute for guest execution.
 */
const OPS=new Set(["sadd","ssub","smul"]);

// Only numeric-specific frontend admission errors can count as an overflow
// rejection. Generic "oreslang-llvmc:" setup, syntax or CLI errors cannot.
export function isSignedI64OverflowDiagnostic(error) {
  const diagnostic=String(error?.message || error);
  return /\boreslang-llvmc:[^\n]*(?:\boverflow\b|out.of.range|out.of.bounds|invalid i64)/i
    .test(diagnostic);
}
const PAIR=/^\s*(%[A-Za-z_.$][A-Za-z_0-9.$]*)\s*=\s*call\s+\{\s*i64\s*,\s*i1\s*\}\s+@llvm\.(sadd|ssub|smul)\.with\.overflow\.i64\s*\(/gm;
const FLAG=/^\s*(%[A-Za-z_.$][A-Za-z_0-9.$]*)\s*=\s*extractvalue\s+\{\s*i64\s*,\s*i1\s*\}\s+(%[A-Za-z_.$][A-Za-z_0-9.$]*)\s*,\s*1\b/gm;
const GUARD=/^\s*br\s+i1\s+(%[A-Za-z_.$][A-Za-z_0-9.$]*)\s*,\s*label\s+%(i64\.overflow\.trap(?:\.\d+)?)\s*,\s*label\s+%i64\.checked\.continue(?:\.\d+)?\b/gm;
const TRAP=/\bcall\s+void\s+@llvm\.trap\s*\(\s*\)/g;
const FAILURE=/^\s*(i64\.overflow\.trap(?:\.\d+)?):\s*(?:;[^\n]*)?\n\s*call\s+void\s+@llvm\.trap\s*\(\s*\)\s*\n\s*unreachable\b/gm;

/** Require an intrinsic's overflow flag to branch to the actual trap block.
 * Reject other traps/unreachable: a generic Wasm.RuntimeError is not proof.
 */
export function assertCheckedOverflowIr(ir,operation){
  if(typeof ir!=="string"||ir.length>2*1024*1024)
    throw Error("invalid checked overflow LLVM IR");
  if(!OPS.has(operation))
    throw Error("unsupported checked overflow operation");
  if(!/^\s*target triple = "wasm32-[^"\n]+"\s*$/m.test(ir))
    throw Error("checked overflow IR lacks real wasm32 target triple");
  // Only the reviewed i64 guest entrypoint can justify an overflow trap.
  // A valid-looking checked helper elsewhere in the module is not proof
  // that main performs any checked arithmetic.
  const entries=[...ir.matchAll(/^define[ \t]+i64[ \t]+@main[ \t]*\([ \t]*\)[^\n{]*\{[^\n]*\n([\s\S]*?)^\}[ \t]*$/gm)];
  if(entries.length!==1)
    throw Error("checked overflow IR requires exactly one i64 guest main body");
  const body=entries[0][1];
  const pairs=[...body.matchAll(PAIR)];
  const pairOps=new Map(pairs.map(match=>[match[1],match[2]]));
  if(![...pairOps.values()].includes(operation))
    throw Error("checked overflow IR lacks required signed-i64 overflow intrinsic "+operation);
  const flags=new Map([...body.matchAll(FLAG)]
    .filter(match=>pairOps.has(match[2])).map(match=>[match[1],match[2]]));
  const guards=[...body.matchAll(GUARD)];
  const traps=[...body.matchAll(TRAP)];
  const failures=[...body.matchAll(FAILURE)];
  const names=new Set(failures.map(match=>match[1]));
  if(!flags.size||!guards.length||!traps.length||
     guards.length!==traps.length||failures.length!==traps.length||
     new Set(guards.map(match=>match[2])).size!==guards.length||
     guards.some(match=>!flags.has(match[1])||!names.has(match[2])) ||
     !guards.some(match=>pairOps.get(flags.get(match[1]))===operation))
    throw Error("checked overflow IR lacks complete operation-specific flag-derived conditional trap path");
  const unreachable=[...body.matchAll(/^\s*unreachable\b/gm)];
  if(unreachable.length!==failures.length)
    throw Error("checked overflow IR contains unrelated unreachable control flow");
}
