import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readBoundedRegularFile} from "../scripts/compile-ores.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";
import {assertNativeFrontendRejection} from "../scripts/verify-real-compiler.mjs";

const required = process.env.ORESLANG_METHOD_PARITY_REQUIRED === "1";
const ready = Boolean(process.env.ORESLANG_LLVM_COMPILER);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

function run(command,args,options={}) {
  const result=spawnSync(command,args,{encoding:"utf8",timeout:30000,
    maxBuffer:4*1024*1024,...options});
  assert.ifError(result.error);
  assert.equal(result.signal,null,"process timed out or was killed");
  return result;
}

test("real wasm32 receiver execution and exact duplicate diagnostics",{
  skip: !ready && !required
},async()=>{
  const compiler=process.env.ORESLANG_LLVM_COMPILER;
  const digest=process.env.ORESLANG_LLVM_COMPILER_SHA256;
  assert.match(compiler||"", /^\//);
  assert.match(digest||"", /^[a-f0-9]{64}$/);
  assert.match(process.env.ORESLANG_LLVM_SOURCE_SHA||"", /^[a-f0-9]{40}$/);
  const bytes=(await readBoundedRegularFile(compiler,256*1024*1024,
    "bounded real LLVM compiler required")).bytes;
  assert.equal(sha(bytes),digest);
  const dir=mkdtempSync(join(tmpdir(),"ores-wasm-receiver-"));
  try {
    const pinned=join(dir,"compiler");
    writeFileSync(pinned,bytes,{mode:0o500,flag:"wx"});
    const accepted=[
      ["read",`define class Foo as let int value=40;
        pub x(self, int n):int{return self.value+n;}end
        pub fnc main():int{let Foo f=new Foo();return f.x(2);}`],
      ["mut",`define class Foo as let int value=40;
        pub y(mut self, int n):void{self.value=self.value+n;return;}
        pub x():int{return self.value;}end
        pub fnc main():int{let mut Foo f=new Foo();f.y(2);return f.x();}`],
      ["distinct",`define class Foo as let int value=40;
        pub x(int n):int{return n;}
        pub y(mut self, int n):int{return self.value+n;}end
        pub fnc main():int{let mut Foo f=new Foo();return f.x(1)+f.y(1);}`]
    ];
    for (const [name,source] of accepted) {
      const input=join(dir,name+".ores"),output=join(dir,name+".wasm");
      writeFileSync(input,source,{mode:0o600,flag:"wx"});
      // The existing tree-shake mode excludes class owners. Compile the
      // complete bounded guest, rather than silently pruning method roots.
      const built=run(pinned,["--target=wasm32",input]);
      assert.equal(built.status,0,name+": "+built.stderr);
      assert.match(built.stdout,/target triple = "wasm32/);
      const linked=run(process.env.CLANG||"clang",[
        "--target=wasm32","-x","ir","-Oz","-nostdlib",
        "-Wl,--no-entry","-Wl,--export=main","-Wl,--export-memory",
        "-Wl,--initial-memory=131072","-Wl,--max-memory=131072",
        "-o",output,"-"
      ],{input:built.stdout});
      assert.equal(linked.status,0,name+": "+linked.stderr);
      const wasm=readFileSync(output);
      const observed=await runIsolatedCoreGuest(wasm,{
        expectedSha256:sha(wasm),timeoutMs:5000
      });
      assert.equal(observed.value,42n,name);
      assert.equal(observed.admission.hostCapabilities,0);
    }
    const rejected=[
      ["zero-forward",`define class Foo as x():void{return;} x(mut self)():void{return;}end
         pub fnc main():int{return 42;}`,"x/0"],
      ["zero-reverse",`define class Foo as x(mut self)():void{return;} x():void{return;}end
         pub fnc main():int{return 42;}`,"x/0"],
      ["one-forward",`define class Foo as x(int n):int{return n;}
         x(mut self, int n):int{return n;}end pub fnc main():int{return 42;}`,"x/1"],
      ["one-reverse",`define class Foo as x(mut self, int n):int{return n;}
         x(int n):int{return n;}end pub fnc main():int{return 42;}`,"x/1"]
    ];
    for (const [name,source,slot] of rejected) {
      const input=join(dir,name+".ores");
      writeFileSync(input,source,{mode:0o600,flag:"wx"});
      const result=run(pinned,["--target=wasm32",input]);
      assertNativeFrontendRejection(result);
      assert.ok(result.stderr.includes("duplicate native method name/arity '"+slot+"'"),
        "rejection must identify exact receiver-erased "+slot);
    }
    assert.equal(sha((await readBoundedRegularFile(pinned,256*1024*1024,
      "pinned compiler size")).bytes),digest);
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
});
