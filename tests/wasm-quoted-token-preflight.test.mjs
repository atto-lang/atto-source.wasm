import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,access,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  compileOresToWasm,
  rejectUnsupportedStateContainerVirtualActorSource,
  rejectUnsupportedTupleV2Source,
  rejectUnsupportedStructuralPatternSource
} from "../scripts/compile-ores.mjs";

const gates=[
  rejectUnsupportedStateContainerVirtualActorSource,
  rejectUnsupportedTupleV2Source,
  rejectUnsupportedStructuralPatternSource
];

test("all bridge token preflights reject unterminated quotes",()=>{
  const malformed=['"unterminated',"'unterminated",'"dangling\\'];
  for(const gate of gates){
    for(const input of malformed){
      assert.throws(()=>gate(Buffer.from(input,"utf8")),
        /unterminated quoted source token at byte /);
    }
    assert.throws(()=>gate(Buffer.from([0xc3,0x28])),TypeError);
  }
});

test("closed quotes and quoted lookalikes in comments are not capability tokens",()=>{
  const allowed=[
    '"define state container"',
    "'on structural'",
    '// "unclosed inside line comment\n',
    '/* "unclosed inside block comment */',
    'pub fnc main(): int { return 42; }'
  ];
  for(const gate of gates){
    for(const input of allowed)
      assert.doesNotThrow(()=>gate(Buffer.from(input,"utf8")));
  }
});

test("malformed .atto source cannot execute the pinned compiler or publish Wasm",async()=>{
  const root=await mkdtemp(join(tmpdir(),"atto-wasm-unclosed-quote-"));
  try{
    const source=join(root,"guest.atto");
    const compiler=join(root,"compiler.sh");
    const output=join(root,"guest.wasm");
    const marker=join(root,"COMPILER_EXECUTED");
    await writeFile(source,'pub fnc main(): int { return 42; }\n"unterminated');
    await writeFile(compiler,'#!/bin/sh\nprintf executed > '+
      JSON.stringify(marker)+'\n',{mode:0o700});
    await assert.rejects(
      compileOresToWasm({compiler,source,output}),
      /unterminated (?:quoted source token|source string)/);
    await assert.rejects(access(marker),/ENOENT/);
    await assert.rejects(access(output),/ENOENT/);
  }finally{await rm(root,{recursive:true,force:true})}
});
