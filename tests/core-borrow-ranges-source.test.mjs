// Restricted Atto source-policy MODEL ONLY. The compiler owns real loans.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,lstatSync} from "node:fs";
import {createHash} from "node:crypto";
import {runInNewContext} from "node:vm";

if (process.env.ATTO_REQUIRE_COMPILER_GUEST === "1" ||
    process.env.ATTO_REQUIRE_NATIVE_GUEST === "1") {
  throw Error("CORE_BORROW_NATIVE_GUEST_NOT_EXECUTED: source-only values cannot mint loans");
}
function file(path) {
  const url=new URL("../"+path,import.meta.url);
  const stat=lstatSync(url);
  assert.ok(stat.isFile()&&!stat.isSymbolicLink(),"regular source "+path);
  const bytes=readFileSync(url);
  assert.ok(bytes.length>0&&bytes.length<=1024*1024,"bounded source "+path);
  const value=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  assert.ok(value.endsWith("\n")&&!value.includes("\r")&&
    !value.includes("\0")&&!value.startsWith("\ufeff"),"strict UTF-8/LF "+path);
  return {value,bytes};
}
const contractFile=file("contracts/atto-core-borrow-ranges-v1.json");
const sourceFile=file("stdlib/core/borrow_ranges.atto");
const gitBlob=bytes=>createHash("sha1").update(
  Buffer.from("blob "+bytes.length+"\0")).update(bytes).digest("hex");
const EXPECTED_CONTRACT_BLOB="a6e35b7605c758559c9bdc094aacde152be7f2c0";
assert.equal(gitBlob(contractFile.bytes),EXPECTED_CONTRACT_BLOB,
  "changing the behavior contract requires an explicit versioned review");
const contract=JSON.parse(contractFile.value);
assert.equal(contract.schema,"atto-core-borrow-ranges-v1");
assert.equal(contract.status,"CANDIDATE_SOURCE_MODEL_ONLY_NOT_COMPILED");
assert.equal(contract.vectors.length,64);
assert.equal(Object.keys(contract.api).length,6);
function compileRestricted(src) {
  let text=src.replace(/\/\/[^\n]*/g,"")
    .replace(/^\s*define module borrow_ranges as\s*$/m,"")
    .replace(/^\s*end\s*$/m,"");
  const fn=/^\s*pub fnc ([a-z_][a-z0-9_]*)\(([\s\S]*?)\): bool \{([\s\S]*?)^\s*\}/gm;
  const matches=[...text.matchAll(fn)];
  assert.equal(text.replace(fn,"").trim(),"",
    "every source byte must be accounted for; no privileged host fallback");
  assert.deepEqual(matches.map(x=>x[1]).sort(),Object.keys(contract.api).sort(),
    "all six public core APIs must have exactly one definition");
  const compiled=[];
  for(const match of matches){
    const [_,name,formals,rawBody]=match;
    const args=formals.split(",").map(x=>x.trim()).filter(Boolean).map(x=>{
      const m=/^(int|bool) ([a-z_][a-z0-9_]*)$/.exec(x);
      assert.ok(m,"typed formal "+name+":"+x);
      return {type:m[1],name:m[2]};
    });
    assert.deepEqual([...args.map(x=>x.type),"bool"],contract.api[name],
      "typed public signature "+name);
    const body=rawBody.replace(
      /if\s+([\s\S]*?)\s+then\s+return\s+([^;]+);\s*fi/g,
      (_,condition,value)=>"if ("+condition.trim()+") return "+value.trim()+";");
    assert.doesNotMatch(body,/\b(?:then|fi|let|val|while|for|await|class|rt|ffi|asm|import|new)\b|[{}]/,
      "unexpected Atto construct in source-only model: "+name);
    const allowed=new Set(["if","return","true","false",...args.map(x=>x.name),
      ...Object.keys(contract.api)]);
    for(const token of body.matchAll(/[a-z_][a-z0-9_]*/g))
      assert.ok(allowed.has(token[0]),"unknown identifier "+token[0]);
    const remainder=body.replace(/[a-z_][a-z0-9_]*/g,"")
      .replace(/\d+/g,"").replace(/[+*\/%<>=!&|;(),\-\s]/g,"");
    assert.equal(remainder,"","source-only grammar gap "+name);
    compiled.push("function "+name+"("+args.map(x=>x.name).join(",")+"){"+body+"}");
  }
  return runInNewContext(compiled.join("\n")+
    "\n({"+Object.keys(contract.api).join(",")+"})",
    Object.create(null),{timeout:1500});
}
function verify(src=sourceFile.value) {
  const funcs=compileRestricted(src);
  for(const[index,v]of contract.vectors.entries()){
    assert.equal(v.id,"CBR-"+String(index+1).padStart(3,"0"));
    const types=contract.api[v.fn];assert.ok(types,"unknown API "+v.id);
    assert.equal(types.length,v.args.length+1,"arity "+v.id);
    for(let i=0;i<v.args.length;i++) {
      assert.equal(typeof v.args[i],types[i]==="bool"?"boolean":"number",v.id);
      if(types[i]==="int")assert.ok(Number.isSafeInteger(v.args[i]),v.id);
    }
    assert.equal(typeof v.expected,"boolean","bool result "+v.id);
    assert.equal(funcs[v.fn](...v.args),v.expected,v.id+" "+v.fn);
  }
  return contract.vectors.length;
}
test("backend-native core/borrow_ranges matches 64 candidate policy vectors",()=>{
  assert.equal(verify(),64);
  console.log("ATTO_CORE_BORROW_SOURCE_ONLY|vectors=64|guest=NOT_EXECUTED"+
    "|contract_blob="+EXPECTED_CONTRACT_BLOB+
    "|source_blob="+gitBlob(sourceFile.bytes));
});
test("seven mutation negatives reject unsafe core loan decisions and host escapes",()=>{
  const alter=(before,after)=>{
    assert.ok(sourceFile.value.includes(before),"mutation anchor: "+before);
    return sourceFile.value.replace(before,after);
  };
  const edits=[
    ["return length_bytes <= region_bytes - start_bytes;",
     "return length_bytes < region_bytes - start_bytes;"],
    ["if !range_fits(region_bytes, left_start, left_length) then return true; fi",
     "if !range_fits(region_bytes, left_start, left_length) then return false; fi"],
    ["return !ranges_overlap(region_bytes, left_start, left_length, right_start, right_length);",
     "return ranges_overlap(region_bytes, left_start, left_length, right_start, right_length);"],
    ["if writer_held || queued_writers != 0 then return false; fi",
     "if writer_held && queued_writers != 0 then return false; fi"],
    ["return active_readers == 0 && !writer_held;",
     "return active_readers >= 0 && !writer_held;"],
    ["return owner_live && active_readers == 0 && !writer_held;",
     "return !owner_live && active_readers == 0 && !writer_held;"],
    ["return !ranges_overlap(region_bytes, left_start, left_length, right_start, right_length);",
     "return java:host_call;"]
  ];
  for(const [before,after]of edits)
    assert.throws(()=>verify(alter(before,after)),undefined,
      "mutated guest source cannot be admitted by the oracle");
});
