import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";

// Independent, deliberately tiny BigInt source oracle for the import-free
// scalar/v1 contract. It cannot compile Oreslang, emit guest receipts, or
// substitute for required real LLVM -> Wasm execution.
const MIN = -(1n << 63n);
const MAX = (1n << 63n) - 1n;
const manifestUrl = new URL("../contracts/parity/portable-scalar-v1-20261101.json", import.meta.url);
const expectedGitBlob = "001e8894cbeb87509878a4de36263a1a327805b1";

function checked(value) {
  if (value < MIN || value > MAX) throw Error("checked i64 range exceeded");
  return value;
}
function tokenize(input) {
  if (typeof input !== "string" || input.length > 128) throw Error("invalid source budget");
  const result = [];
  for (let i=0; i<input.length;) {
    const c = input[i];
    if (c === " ") {i++; continue;}
    if ("()+-*".includes(c)) {result.push(c); i++; continue;}
    if (c >= "0" && c <= "9") {
      let end=i+1;
      while (end<input.length && /[0-9_]/.test(input[end])) end++;
      const literal=input.slice(i,end);
      if (!/^[0-9]+(?:_[0-9]+)*$/.test(literal)) throw Error("invalid digit separator");
      result.push({number: BigInt(literal.replaceAll("_",""))});
      i=end;
      continue;
    }
    throw Error("removed or unsupported source operator");
  }
  if (result.length === 0 || result.length > 128) throw Error("invalid token count");
  return result;
}
function evaluate(expression) {
  const tokens=tokenize(expression);
  let index=0;
  const peek=()=>tokens[index];
  const atom=(depth)=>{
    if (depth>32) throw Error("expression nesting exceeded");
    const token=tokens[index++];
    if (token === "+" || token === "-") {
      if (token === "-" && peek() && typeof peek() === "object" && peek().number === MAX+1n) {
        index++;
        return MIN;
      }
      const v=parse(5,depth+1);
      return checked(token === "-" ? -v : v);
    }
    if (token === "(") {
      const v=parse(0,depth+1);
      if (tokens[index++] !== ")") throw Error("unbalanced grouping");
      return v;
    }
    if (token && typeof token === "object") return checked(token.number);
    throw Error("expected number or grouped expression");
  };
  const parse=(minBp=0,depth=0)=>{
    let lhs=atom(depth+1);
    while (true) {
      const op=peek();
      const bp=op==="*" ? 3 : (op==="+" || op==="-") ? 1 : -1;
      if (bp < minBp) break;
      index++;
      const rhs=parse(bp+1,depth+1);
      lhs=checked(op==="+" ? lhs+rhs : op==="-" ? lhs-rhs : lhs*rhs);
    }
    return lhs;
  };
  const value=parse();
  if (index!==tokens.length) throw Error("unconsumed source");
  return value;
}
test("portable scalar-v1 expected values have an independent checked BigInt oracle", async()=>{
  const bytes=await readFile(manifestUrl);
  const hash=createHash("sha1").update(Buffer.from("blob "+bytes.length+"\0","ascii"))
    .update(bytes).digest("hex");
  assert.equal(hash,expectedGitBlob,"shared source contract was modified without review");
  const data=JSON.parse(bytes.toString("utf8"));
  assert.equal(data.schema_version,"2026-11-01.scalar-v1");
  assert.equal(data.scope,"import-free-pure-i64");
  assert.equal(data.positive.length,16);
  assert.equal(data.negative.length,6);
  const seen=new Set();
  for (const record of [...data.positive,...data.negative]) {
    assert.match(record.id,/^[a-z][a-z0-9-]{1,79}$/);
    assert.ok(!seen.has(record.id),"duplicate scalar ID");
    seen.add(record.id);
  }
  for (const record of data.positive) {
    assert.equal(evaluate(record.expression),BigInt(record.expected),record.id);
  }
  for (const record of data.negative) {
    assert.throws(()=>evaluate(record.expression),Error,record.id);
  }
});
test("scalar source oracle fails closed under boundary and grammar mutations",()=>{
  const invalid=[
    "", "1_", "1__0", "_1", "1_+1", "7%3", "7^3", "7^^3",
    "7/2", "1.5", "unsafe", "0x10", "()", "(2+3", "2+3)",
    "9223372036854775808", "-9223372036854775809",
    "9223372036854775807+1", "-9223372036854775808-1",
    "3037000500*3037000500", "-(-9223372036854775808)"
  ];
  for (const value of invalid) assert.throws(()=>evaluate(value),Error,value);
  for (const [value,expected] of [
    ["-9223372036854775808",MIN],
    ["9223372036854775807",MAX],
    ["20-5-3",12n],
    ["-(-42)",42n],
    ["2+3*4",14n],
    ["(2+3)*4",20n]
  ]) assert.equal(evaluate(value),expected,value);
});
