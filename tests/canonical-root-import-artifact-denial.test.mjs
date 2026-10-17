import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,access,rm} from "node:fs/promises";
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
  'import fnc helper from "../lib/helper";\npub fnc main(): int { return 42; }\n',
  'import fnc helper from ".hidden/helper";\npub fnc main(): int { return 42; }\n',
  'import fnc helper from "pkg:math/helper";\npub fnc main(): int { return 42; }\n',
  'import "+/lib/helper";\npub fnc main(): int { return 42; }\n',
  '// comment ends at CR\rimport fnc helper from "+/lib/helper";\rpub fnc main(): int { return helper(); }\r',
  '// comment ends at CRLF\r\nimport fnc helper from "+/lib/helper";\r\npub fnc main(): int { return helper(); }\r\n',
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

// A real project manifest and existing imported target must not be mistaken
// for a verified transitive wasm32 graph. The one-source scalar compiler
// bridge rejects this otherwise valid Java-shaped package-root scenario.
test("configured project.root source graph is denied before Wasm publication",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ores-wasm-configured-root-"));
  try{
    const app=join(root,"app"),src=join(app,"src");
    await mkdir(src,{recursive:true});
    await writeFile(join(root,".ores.pkg.toml"),
      'schema_version = "1"\n[project]\nroot = "app"\n');
    await writeFile(join(src,"helper.ores"),
      'pub fnc helper(): int { return 42; }\n');
    const source=join(src,"main.ores");
    await writeFile(source,
      'import fnc helper from "+/src/helper";\npub fnc main(): int { return helper(); }\n');
    const compiler=join(root,"compiler-stub"),output=join(root,"guest.wasm");
    await writeFile(compiler,"non-executed source-free placeholder",{mode:0o500});
    for(const publication of ["legacy","atomic"]){
      await assert.rejects(
        compileOresToWasm({compiler,source,output,publication}),
        /source imports require verified complete Wasm module graph/);
      for(const suffix of ["",".provenance.json",".artifact.json",
                           ".current.json",".releases",".publication.lock"]){
        await assert.rejects(access(output+suffix),{code:"ENOENT"});
      }
    }
  }finally{await rm(root,{recursive:true,force:true})}
});

// Existing files and a real nested package marker must not make an
// incomplete single-source Wasm compilation appear to support source graphs.
// Both explicit relative and bare child imports remain publication-denied.
test("Wasm refuses nested-package relative and bare imports before artifacts",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ores-wasm-nested-imports-"));
  try{
    const routes=join(root,"src","routes"),child=join(routes,"child");
    await mkdir(child,{recursive:true});
    await writeFile(join(root,".ores.pkg.toml"),'schema_version = "1"\n');
    await writeFile(join(child,".oreslangc.cfg.toml"),'schema_version = "1"\n');
    await writeFile(join(child,"secret.ores"),'pub fnc secret(): int { return 42; }\n');
    const source=join(routes,"main.ores");
    const compiler=join(root,"compiler-stub"),output=join(root,"guest.wasm");
    await writeFile(compiler,"non-executed placeholder",{mode:0o500});
    for(const specifier of ["./child/secret","child/secret"]){
      await writeFile(source,
        'import fnc secret from "'+specifier+'";\npub fnc main(): int { return secret(); }\n');
      for(const publication of ["legacy","atomic"]){
        await assert.rejects(
          compileOresToWasm({compiler,source,output,publication}),
          /source imports require verified complete Wasm module graph/);
        for(const suffix of ["",".provenance.json",".artifact.json",
                             ".current.json",".releases",".publication.lock"]){
          await assert.rejects(access(output+suffix),{code:"ENOENT"});
        }
      }
    }
  }finally{await rm(root,{recursive:true,force:true})}
});

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
