import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,access,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assertScalarSourceHasNoImports,compileOresToWasm} from "../scripts/compile-ores.mjs";

// LLVM's experimental host scalar +/ linking is not a wasm32 module graph.
// A syntactically valid Oreslang import may NEVER produce scalar-only Wasm
// artifacts with silently missing source units, even with a stub compiler.
const denied = [
  'import fnc helper from "+/lib/helper";\npub fnc main(): int { return helper(); }\n',
  'import module telemetry from "+/lib/telemetry";\npub fnc main(): int { return 42; }\n',
  'import fnc helper from "./helper";\npub fnc main(): int { return 42; }\n',
  'import fnc helper from "pkg:math/helper";\npub fnc main(): int { return 42; }\n',
  'import "+/lib/helper";\npub fnc main(): int { return 42; }\n',
];

for(const [i,sourceText] of denied.entries()){
  test("Wasm denies unresolved Oreslang source import "+(i+1)+" before any artifact publication",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"ores-wasm-root-import-"));
    try{
      const source=join(directory,"entry.ores");
      const compiler=join(directory,"compiler-stub");
      const output=join(directory,"guest.wasm");
      await writeFile(source,sourceText);
      await writeFile(compiler,"source-free compiler placeholder", {mode:0o500});
      assert.throws(()=>assertScalarSourceHasNoImports(new TextEncoder().encode(sourceText)),
        /source imports require verified complete Wasm module graph/);
      for(const publication of ["legacy","atomic"]){
        await assert.rejects(compileOresToWasm({compiler,source,output,publication}),
          /source imports require verified complete Wasm module graph/);
        for(const suffix of ["",".provenance.json",".artifact.json",".current.json",
                             ".releases",".publication.lock"]){
          await assert.rejects(access(output+suffix),{code:"ENOENT"});
        }
      }
    }finally{await rm(directory,{recursive:true,force:true})}
  });
}

test("Wasm scanner ignores quoted import text and comments but not real code",()=>{
  for(const text of [
    '// import fnc helper from "+/lib/helper";\npub fnc main(): int {return 42;}\n',
    '/* import module ignored from "+/lib/helper"; */\npub fnc main(): int {return 42;}\n',
    '/* nested /* import "+/lib/helper"; */ okay */\npub fnc main(): int {return 42;}\n',
    'pub fnc main(): int { val String s = "import fnc helper from \\\"+/lib/helper\\\""; return 42; }\n'
  ]) assert.doesNotThrow(()=>assertScalarSourceHasNoImports(new TextEncoder().encode(text)));
  assert.throws(()=>assertScalarSourceHasNoImports(
    new TextEncoder().encode('pub fnc main(): int{return 42;}\rimport fnc helper from "+/lib/helper";')),
    /verified complete Wasm module graph/);
});
