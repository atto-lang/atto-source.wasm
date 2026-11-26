import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile,mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

const bytes=await readFile(new URL("../contracts/atto-xo-checked-debit-v1/cases.tsv",import.meta.url));
const sha=createHash("sha1").update("blob "+bytes.length+"\0").update(bytes).digest("hex");
const expectedBlob="6831dbd0c18eeaa2078fa5f3e324d0f88b40771e";
const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
const rows=text.split("\n");
const compiler=process.env.ORESLANG_LLVM_COMPILER;
const required=process.env.ORESLANG_SCALAR_PARITY_REQUIRED==="1";

test("Atto-XO exact corpus inventory (host-only)",()=>{
  assert.equal(sha,expectedBlob);
  assert.equal(rows.length,8);
  assert.equal(rows[7],"");
  const ids=new Set();
  let values=0,overflows=0;
  for(const row of rows.slice(0,7)){
    const fields=row.split("|");
    assert.equal(fields.length,8);
    const [id,expected,,,,,,source]=fields;
    assert.match(id,/^[a-z-]+$/);
    assert(!ids.has(id),id);
    ids.add(id);
    assert(source.includes("pub fnc debit("));
    if(expected==="overflow")overflows++;
    else {assert.match(expected,/^(42|43)$/);values++;}
  }
  assert.deepEqual([values,overflows],[3,4]);
});

test("Atto-XO unchanged source -> LLVM -> wasm32 guest execution",async t=>{
  assert.equal(sha,expectedBlob);
  if(!compiler){
    if(required)assert.fail("strict scalar parity requires a real LLVM compiler");
    t.skip("NOT_EXECUTED: ORESLANG_LLVM_COMPILER not configured");
    return;
  }
  const binary=resolve(compiler);
  const pin=process.env.ORESLANG_LLVM_COMPILER_SHA256;
  assert.match(pin??"",/^[a-f0-9]{64}$/,"exact compiler binary SHA-256 required");
  assert.equal(createHash("sha256").update(await readFile(binary)).digest("hex"),pin);
  let values=0,overflows=0;
  const dir=await mkdtemp(join(tmpdir(),"atto-xo-debit-wasm-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const row of rows.slice(0,7)){
    const [id,expected,,,,,,source]=row.split("|");
    assert.match(id,/^[a-z-]+$/);
    const input=join(dir,id+".atto"),output=join(dir,id+".wasm");
    await writeFile(input,source);
    await compileOresToWasm({compiler:binary,source:input,output});
    const module=new WebAssembly.Module(await readFile(output));
    assert.deepEqual(WebAssembly.Module.imports(module),[],id+": host imports forbidden");
    const instance=await WebAssembly.instantiate(module,{});
    assert.equal(typeof instance.exports.main,"function",id);
    if(expected==="overflow"){
      assert.throws(()=>instance.exports.main(),WebAssembly.RuntimeError,id);
      overflows++;
    }else{
      assert.equal(instance.exports.main(),BigInt(expected),id);
      values++;
    }
  }
  assert.deepEqual([values,overflows],[3,4]);
  assert.equal(createHash("sha256").update(await readFile(binary)).digest("hex"),pin);
});
