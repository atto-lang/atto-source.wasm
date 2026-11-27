import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,writeFile,chmod,stat,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  rejectRetiredSourceOperators,compileOresToWasm
} from "../scripts/compile-ores.mjs";

const bytes = source => new TextEncoder().encode(source);
const bad = [
  ["modulo", "7 % 3", "%"],
  ["caret", "7 ^ 3", "^"],
  ["double-caret", "7 ^^ 3", "^^"],
  ["no-whitespace", "7%3", "%"],
  ["nested-expression", "(2 + 3) % (4 + 1)", "%"]
];

test("retired operators reject at a bounded, comment-aware Wasm bridge boundary", () => {
  for(const [name,expression,glyph] of bad) {
    const source = bytes("pub fnc main():int{return " + expression + ";}\n");
    assert.throws(() => rejectRetiredSourceOperators(source),
      error => error.message.includes("ATTO_REMOVED_OPERATOR") &&
        error.message.includes("'" + glyph + "'"), name);
  }
  assert.doesNotThrow(() => rejectRetiredSourceOperators(bytes(
    "pub fnc main():int{/* outer /* % */ ^ ^^ */ // % ^ ^^\n return 7;}")));
  assert.doesNotThrow(() => rejectRetiredSourceOperators(bytes(
    'pub fnc main():int{let s="% ^ ^^"; return 7;}')));
  assert.throws(() => rejectRetiredSourceOperators(Uint8Array.of(0xff)),
    /utf-8|encoded|valid/i, "invalid UTF-8 must fail closed");
});

test("retired operators cannot invoke an older compiler or publish Wasm", async () => {
  const work = await mkdtemp(join(tmpdir(),"atto-removed-op-wasm-"));
  try {
    const compiler=join(work,"fake-old-compiler.sh");
    const sentinel=join(work,"compiler-invoked");
    // If bridge preflight is bypassed, this executable leaves a sentinel.
    // It is not used as evidence that the native compiler rejected anything.
    await writeFile(compiler, "#!/bin/sh\nprintf called > " +
      JSON.stringify(sentinel) + "\nexit 0\n",{mode:0o700});
    await chmod(compiler,0o700);
    const hash=createHash("sha256").update(await import("node:fs/promises")
      .then(fs=>fs.readFile(compiler))).digest("hex");
    const source=join(work,"source.atto");
    for(const [name,expression] of bad) {
      await writeFile(source,"pub fnc main():int{return "+expression+";}\n");
      const output=join(work,name+".wasm");
      await assert.rejects(
        compileOresToWasm({compiler,source,output,compilerSha256:hash,publication:"atomic"}),
        /ATTO_REMOVED_OPERATOR/,name);
      for(const artifact of [sentinel,output,output+".provenance.json",
        output+".artifact.json",output+".current.json"]) {
        await assert.rejects(stat(artifact),{code:"ENOENT"},
          name+" may not execute native tools or publish "+artifact);
      }
    }
  } finally { await rm(work,{recursive:true,force:true}); }
});

// Source-only preflight; compiler behavior still requires exact guest execution.
test("canonical-i64-v5 delegates integer XOR and simple caret returns only",()=>{
 const gate=source=>rejectRetiredSourceOperators(bytes(source),"canonical-i64-v5");
 for(const source of ["pub fnc main():int{return 11^^4;}","pub fnc main():int{ ^ 42;}","pub fnc main():int{return (11 ^^ 4);}", "pub fnc main():int{return 7 /* ^^ */;}"])
  assert.doesNotThrow(()=>gate(source),source);
 for(const source of ["pub fnc main():int{return 7%3;}","pub fnc main():int{return 7 ^ 3;}","pub fnc main():int{return 7 ^ ^ 3;}","pub fnc main():int{return 7^^^3;}","pub fnc main():int{return 7^^=3;}",'pub fnc main():int{"hidden" ^ 42;}'])
  assert.throws(()=>gate(source),/ATTO_REMOVED_OPERATOR/,source);
 assert.throws(()=>rejectRetiredSourceOperators(bytes("7^^3"),"unknown"),/unknown source operator profile/);
});
