/**
 * Conservative IR-shape gate for experimental pure signed-i64 Wasm fixtures.
 * Applied to the exact compiler IR before Clang receives it. Not a full
 * LLVM verifier, owner/actor safety proof, or substitute for guest execution.
 */
const OPS=new Set(["sadd","ssub","smul"]);
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
  const pairs=[...ir.matchAll(PAIR)];
  const pairOps=new Map(pairs.map(match=>[match[1],match[2]]));
  if(![...pairOps.values()].includes(operation))
    throw Error("checked overflow IR lacks required signed-i64 overflow intrinsic "+operation);
  const flags=new Map([...ir.matchAll(FLAG)]
    .filter(match=>pairOps.has(match[2])).map(match=>[match[1],match[2]]));
  const guards=[...ir.matchAll(GUARD)];
  const traps=[...ir.matchAll(TRAP)];
  const failures=[...ir.matchAll(FAILURE)];
  const names=new Set(failures.map(match=>match[1]));
  if(!flags.size||!guards.length||!traps.length||
     guards.length!==traps.length||failures.length!==traps.length||
     new Set(guards.map(match=>match[2])).size!==guards.length||
     guards.some(match=>!flags.has(match[1])||!names.has(match[2])) ||
     !guards.some(match=>pairOps.get(flags.get(match[1]))===operation))
    throw Error("checked overflow IR lacks complete operation-specific flag-derived conditional trap path");
  const unreachable=[...ir.matchAll(/^\s*unreachable\b/gm)];
  if(unreachable.length!==failures.length)
    throw Error("checked overflow IR contains unrelated unreachable control flow");
}
