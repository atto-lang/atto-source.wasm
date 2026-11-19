import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";

// Source-only, independent signed-i64 oracle. It does not compile Oreslang,
// run WASM, prove a native trap or create guest ORES_TEST receipts.
const MIN=-(1n<<63n), MAX=(1n<<63n)-1n;
const url=new URL("../contracts/parity/portable-scalar-v3-20261101.json",import.meta.url);
const reviewedBlob="cd51c7320812d1ee032a211890cb427c984b2ea2";
class CompilerRejection extends Error {}
class CheckedOverflow extends Error {}
const checked=x=>{
  if(x<MIN||x>MAX) throw new CheckedOverflow("checked signed i64 overflow");
  return x;
};
function tokenize(source) {
  if(typeof source!=="string"||source.length===0||source.length>128)
    throw new CompilerRejection("invalid source size");
  const tokens=[];
  for(let i=0;i<source.length;) {
    const c=source[i];
    if(c===" "){i++;continue;}
    if("()+-*".includes(c)){tokens.push(c);i++;continue;}
    if(c>="0"&&c<="9") {
      let j=i+1;
      while(j<source.length&&/[0-9_]/.test(source[j]))j++;
      const raw=source.slice(i,j);
      if(!/^[0-9]+(?:_[0-9]+)*$/.test(raw))
        throw new CompilerRejection("invalid numeric separator");
      tokens.push({value:BigInt(raw.replaceAll("_",""))});
      i=j;
      continue;
    }
    throw new CompilerRejection("removed or unsupported operator");
  }
  if(tokens.length===0||tokens.length>128)throw new CompilerRejection("token budget");
  return tokens;
}
function evaluate(source) {
  const tokens=tokenize(source);
  let index=0;
  const peek=()=>tokens[index];
  const atom=depth=>{
    if(depth>32)throw new CompilerRejection("nesting budget");
    const token=tokens[index++];
    if(token==="+"||token==="-") {
      // -2^63 is the one valid signed literal beyond positive MAX.
      if(token==="-"&&peek()&&typeof peek()==="object"&&peek().value===MAX+1n) {
        index++;
        return MIN;
      }
      const rhs=parse(5,depth+1);
      return checked(token==="-"?-rhs:rhs);
    }
    if(token==="(") {
      const value=parse(0,depth+1);
      if(tokens[index++]!==")")throw new CompilerRejection("unclosed grouping");
      return value;
    }
    if(token&&typeof token==="object") {
      if(token.value>MAX)throw new CompilerRejection("out of range literal");
      return token.value;
    }
    throw new CompilerRejection("expected scalar atom");
  };
  const parse=(min=0,depth=0)=>{
    let lhs=atom(depth+1);
    for(;;) {
      const op=peek();
      const priority=op==="*"?3:op==="+"||op==="-"?1:-1;
      if(priority<min)break;
      index++;
      const rhs=parse(priority+1,depth+1);
      lhs=checked(op==="+"?lhs+rhs:op==="-"?lhs-rhs:lhs*rhs);
    }
    return lhs;
  };
  const result=parse();
  if(index!==tokens.length)throw new CompilerRejection("unexpected trailing token");
  return result;
}
async function corpus() {
  const bytes=await readFile(url);
  const blob=createHash("sha1").update(Buffer.from("blob "+bytes.length+"\0","ascii"))
    .update(bytes).digest("hex");
  assert.equal(blob,reviewedBlob,"v3 corpus changed without a reviewed source pin");
  const data=JSON.parse(bytes.toString("utf8"));
  assert.equal(data.schema_version,"2026-11-01.scalar-v3");
  assert.equal(data.scope,"import-free-pure-i64");
  assert.equal(data.status,"AUTHORED_ONLY_NOT_EXECUTED");
  assert.deepEqual([data.positive.length,data.compile_reject.length,data.checked_overflow.length],[12,5,4]);
  const seen=new Set();
  for(const item of [...data.positive,...data.compile_reject,...data.checked_overflow]){
    assert.match(item.id,/^[a-z][a-z0-9-]{1,79}$/);
    assert.equal(seen.has(item.id),false,"duplicate vector ID");
    seen.add(item.id);
  }
  return data;
}
test("v3 independent source oracle preserves 12 positive signed i64 results",async()=>{
  const data=await corpus();
  for(const item of data.positive)
    assert.equal(evaluate(item.expression),BigInt(item.expected),item.id);
});
test("v3 source oracle separates 5 compiler rejections from 4 checked overflows",async()=>{
  const data=await corpus();
  for(const item of data.compile_reject)
    assert.throws(()=>evaluate(item.expression),CompilerRejection,item.id);
  for(const item of data.checked_overflow)
    assert.throws(()=>evaluate(item.expression),CheckedOverflow,item.id);
});
test("v3 source oracle is fail closed under malicious grammar and range mutations",()=>{
  for(const input of [
    "", "7 % 3", "7 ^ 3", "7 ^^ 3", "7/2", "1.0", "0x10",
    "1_", "1__0", "_1", "1_+2", "unsafe", "()", "(1+2", "1+2)",
    "9223372036854775808", "-9223372036854775809", "1a",
  ]) assert.throws(()=>evaluate(input),CompilerRejection,input);
  for(const input of [
    "9223372036854775807+1",
    "(-9223372036854775807-1)-1",
    "3037000500*3037000500",
    "-(-9223372036854775808)",
  ]) assert.throws(()=>evaluate(input),CheckedOverflow,input);
  assert.equal(evaluate("-9223372036854775808"),MIN);
  assert.equal(evaluate("9223372036854775807"),MAX);
  assert.equal(evaluate("20-5-3"),12n);
  assert.equal(evaluate("2+3*4"),14n);
  assert.equal(evaluate("(2+3)*4"),20n);
});
