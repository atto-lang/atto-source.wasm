import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

// This is an actual LLVM-to-wasm32 source-compiled module guest test.
// A source-only Node test with no pinned LLVM compiler is NOT execution evidence.
// The normal npm suite skips it; required=true must fail closed.
const required=process.env.ATTO_WASM_STATIC_AOT_REQUIRED==="1";
const compilerPath=process.env.ORESLANG_LLVM_COMPILER;
const compilerDigest=process.env.ORESLANG_LLVM_COMPILER_SHA256;
const compilerHead=process.env.ORESLANG_LLVM_SOURCE_SHA;
const canExecute=Boolean(compilerPath && compilerDigest && compilerHead);
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
const sourcePath=file=>fileURLToPath(new URL("./fixtures/static-dispatch-aot/"+file,import.meta.url));

function run(command,args,options={}) {
  const result=spawnSync(command,args,{
    encoding:"utf8",maxBuffer:8*1024*1024,timeout:60000,
    env:{PATH:process.env.PATH||"/usr/bin:/bin",LANG:"C.UTF-8",LC_ALL:"C.UTF-8"},
    ...options
  });
  assert.ifError(result.error);
  assert.equal(result.signal,null,"compiler or linker was killed");
  return result;
}

function directTargets(ir) {
  const observed=new Set();
  for (const raw of ir.split(/\r?\n/)) {
    const line=raw.trim();
    if (line.startsWith(";") || !/\b(?:call|invoke)\b/.test(line)) continue;
    // Match only call/invoke sites, never LLVM declarations, definitions,
    // attribute groups, or comments containing fabricated method names.
    const call=/\b(?:call|invoke)\s+i64\s+(?:@"([^"]+)"|@([A-Za-z_$][\w.$-]*))\s*\(/.exec(line);
    if (call) observed.add(call[1]||call[2]);
    // Closed-world guest: reject EVERY i64 call without an explicit @symbol.
    // Bare %, typed pointers and bitcast indirect operands all fail closed.
    if (/\b(?:call|invoke)\s+i64\b/.test(line) && !call)
      throw Error("WASM_STATIC_AOT_INDIRECT_CALL: "+line);
  }
  return observed;
}

test("pinned LLVM-to-wasm32 class overload lowers to exact direct calls and executable module",{
  skip:!canExecute && !required
},()=>{
  assert.match(compilerPath||"",/^\//,"requires absolute pinned compiler path");
  assert.match(compilerHead||"",/^[a-f0-9]{40}$/,"requires exact LLVM source head");
  assert.match(compilerDigest||"",/^[a-f0-9]{64}$/,"requires source-owned compiler SHA-256");
  const st=statSync(compilerPath);
  assert.ok(st.isFile() && st.size>0 && st.size<=256*1024*1024);
  const compilerBytes=readFileSync(compilerPath);
  assert.equal(digest(compilerBytes),compilerDigest,"unverified native compiler identity");
  const dir=mkdtempSync(join(tmpdir(),"atto-wasm-static-aot-"));
  try {
    const pinned=join(dir,"pinned-llvmc");
    writeFileSync(pinned,compilerBytes,{mode:0o500,flag:"wx"});
    const accepted=run(pinned,["--target=wasm32",
      sourcePath("class-overload-direct-42.atto")]);
    assert.equal(accepted.status,0,"compiler rejected .atto overload guest: "+accepted.stderr);
    assert.ok(accepted.stdout.startsWith("; ModuleID") ||
      accepted.stdout.includes("target triple"),"no compiler-emitted LLVM IR");
    const targets=directTargets(accepted.stdout);
    for(const target of ["Box.read$arity0","Box.read$arity1"])
      assert.ok(targets.has(target),"missing direct AOT target "+target);
    const wasmPath=join(dir,"class-overload-direct-42.wasm");
    const clang=process.env.CLANG||"/usr/bin/clang-19";
    const emitted=run(clang,[
      "--target=wasm32","-x","ir","-Oz","-nostdlib",
      "-Wl,--no-entry","-Wl,--export=main","-Wl,--export-memory",
      "-Wl,--initial-memory=131072","-Wl,--max-memory=131072",
      "-o",wasmPath,"-"
    ],{input:accepted.stdout});
    assert.equal(emitted.status,0,"wasm32 linker failed: "+emitted.stderr);
    const wasm=readFileSync(wasmPath);
    const compiled=new WebAssembly.Module(wasm);
    assert.deepEqual(WebAssembly.Module.imports(compiled),[],
      "precompiled closed guest acquired host imports");
    const instance=new WebAssembly.Instance(compiled,{});
    assert.equal(instance.exports.main(),42n,
      "real compiled wasm32 guest did not execute required overload behavior");

    const rejected=run(pinned,["--target=wasm32",
      sourcePath("class-duplicate-slot-reject.atto")]);
    assert.notEqual(rejected.status,0,"duplicate overload slot compiled");
    assert.equal(rejected.stdout,"","rejected guest emitted executable LLVM IR");
    assert.match(rejected.stderr,/duplicate native method/i);

    assert.equal(digest(readFileSync(pinned)),compilerDigest,
      "compiler binary changed during guest verification");
    console.log("WASM32_STATIC_DISPATCH_COMPILED_GUEST_PASS|result=42|"+
      "direct_calls=2|negative=1|wasm_sha256="+digest(wasm)+
      "|llvm_source_head="+compilerHead);
  }finally{
    rmSync(dir,{recursive:true,force:true});
  }
});

test("LLVM direct-target predicate rejects fabricated evidence and indirect calls",()=>{
  const forged='; call i64 @"Box.read$arity0"(ptr %x)\n'+
    'define i64 @"Box.read$arity1"(ptr %x){ ret i64 42 }';
  const targets=directTargets(forged);
  assert.equal(targets.size,0,"comment or declaration impersonated a direct call");
  const valid=directTargets('%v = call i64 @"Box.read$arity0"(ptr %x)\n'+
    '%w = invoke i64 @"Box.read$arity1"(ptr %x, i64 2) to label %ok unwind label %fail');
  assert.ok(valid.has("Box.read$arity0"));
  assert.ok(valid.has("Box.read$arity1"));
  const lookalike=directTargets('%v = call i64 @"Box.read$arity01"(ptr %x)');
  assert.equal(lookalike.has("Box.read$arity0"),false);
  assert.throws(()=>directTargets('%v = call i64 (ptr) %fp(ptr %x)'),
    /WASM_STATIC_AOT_INDIRECT_CALL/);
  for (const forgedCall of [
    '%v = call i64 ptr %fp(ptr %x)',
    '%v = call i64 bitcast (ptr @fake to ptr)(ptr %x)',
    '%v = invoke i64 %callee(ptr %x) to label %ok unwind label %bad',
    '%v = call i64 (ptr) %fp(ptr %x) #1'
  ]) {
    assert.throws(()=>directTargets(forgedCall), /WASM_STATIC_AOT_INDIRECT_CALL/,
      'unproved dispatch escaped: '+forgedCall);
  }
});
