// HOST-ONLY risk reference, NOT execution of compiled Oreslang in Wasm.
// Float/Region finance guest parity remains blocked until LLVM compiler emits
// actual wasm32 guest binaries and verifies the same source corpus.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";

const path = new URL("../contracts/v1/hpc-finance/risk-gate-v1.tsv",import.meta.url);
const bytes = readFileSync(path);
const gitBlob = createHash("sha1").update(
  Buffer.from("blob "+bytes.length+"\0","ascii")).update(bytes).digest("hex");
const expectedBlob = "cec489c1f7603617797340dd1b4a71cc85acfebd";
const capabilities = JSON.parse(readFileSync(
  new URL("../contracts/v1/numeric-parity/backend.json",import.meta.url),"utf8"));

function requireLines(text) {
  assert.ok(text.length>0 && text.length<=8192,"bounded finance risk corpus");
  const lines=text.split("\n").filter(line=>line && !line.startsWith("#"));
  assert.equal(lines.length,23,"exact 23-case finance inventory");
  return lines;
}
function numeric(field) {
  if(field==="NaN")return NaN;
  if(field==="+Infinity")return Infinity;
  if(field==="-Infinity")return -Infinity;
  assert.match(field,/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/,"explicit decimal only");
  const result=Number(field);
  assert.ok(Number.isFinite(result),"unexpected nonfinite numeric literal");
  return result;
}
function decision(side,qty,price,maximum) {
  let reason=0;
  if(!Number.isFinite(qty)||!Number.isFinite(price)||
    !Number.isFinite(maximum)||maximum<0) reason=4;
  else if(side===0)reason=1;
  else if(side!==1&&side!==-1)reason=5;
  else if(qty<0)reason=2;
  else if(qty===0)reason=7;
  else if(price<=0)reason=6;
  else if(qty>maximum)reason=3;
  return {approved:reason===0,reason};
}
function verify(lines) {
  assert.equal(lines.length,23,"inventory size");
  const ids=new Set();
  let approved=0,denied=0;
  for(const line of lines) {
    assert.ok(line.length<=256,"bounded corpus line");
    const fields=line.split("|");
    assert.equal(fields.length,7,"all finance fields required");
    assert.match(fields[0],/^[a-z][a-z0-9_]{1,79}$/);
    assert.ok(!ids.has(fields[0]),"duplicate case ID");
    ids.add(fields[0]);
    const side=Number(fields[1]);
    assert.ok(Number.isInteger(side),"integer side required");
    assert.ok(["true","false"].includes(fields[5]),"boolean decision required");
    const actual=decision(side,numeric(fields[2]),numeric(fields[3]),numeric(fields[4]));
    assert.equal(actual.approved,fields[5]==="true",fields[0]);
    assert.equal(actual.reason,Number(fields[6]),fields[0]);
    actual.approved?approved++:denied++;
  }
  assert.equal(approved,3);assert.equal(denied,20);
}

test("hpc finance WASM host-only reference binds reviewed 23-row blob",()=>{
  assert.equal(gitBlob,expectedBlob,"finance risk fixture changed without review");
  verify(requireLines(bytes.toString("utf8")));
});

test("hpc finance WASM host reference checks 180 risk decisions and reason codes",()=>{
  const counts=Array(8).fill(0);
  let total=0;
  for(const side of [-2,-1,0,1,2])
    for(const qty of [-1,0,1,3])
      for(const price of [-1,0,10])
        for(const maximum of [-1,0,2]) {
          const result=decision(side,qty,price,maximum);
          assert.equal(result.approved,result.reason===0);
          counts[result.reason]++;
          total++;
        }
  assert.equal(total,180);
  assert.deepEqual(counts,[2,24,12,6,60,48,16,12]);
});

test("hpc finance WASM host reference denies duplicate, omitted and mutated cases",()=>{
  const lines=requireLines(bytes.toString("utf8"));
  const duplicate=[...lines];duplicate[22]=lines[0];
  assert.throws(()=>verify(duplicate));
  assert.throws(()=>verify(lines.slice(1)));
  const corruptReason=[...lines];corruptReason[0]=lines[0].replace(/\|0$/,"|5");
  assert.throws(()=>verify(corruptReason));
  const corruptApproval=[...lines];corruptApproval[0]=lines[0].replace("|true|","|false|");
  assert.throws(()=>verify(corruptApproval));
  assert.throws(()=>numeric("1e300garbage"));
});

test("hpc finance WASM binary64 guest capability must remain unclaimed",()=>{
  assert.equal(capabilities.backend,"wasm");
  assert.equal(capabilities.capabilities.binary64_ordering,"unsupported_explicit",
    "binary64 support needs executed source-level Wasm guest proof before promotion");
  assert.equal(capabilities.capabilities.source_division_to_float,"unsupported_explicit");
});

test("hpc finance 11-guest contract is pinned but explicitly UNEXECUTED",()=>{
  const manifestBytes=readFileSync(
    new URL("../contracts/v1/hpc-finance/guest-manifest.json",import.meta.url));
  const blob=createHash("sha1").update(
    Buffer.from("blob "+manifestBytes.length+"\\0","ascii"))
    .update(manifestBytes).digest("hex");
  assert.equal(blob,"062cff056919708b2cc9e6f9a6f4cb6ec00661e8");
  const manifest=JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.status,"authored-not-compiler-executed");
  assert.equal(manifest.programs.length,11);
  assert.equal(manifest.programs.reduce((sum,item)=>sum+item.assertions,0),182);
  assert.equal(manifest.risk_fixture_git_blob,expectedBlob);
  assert.deepEqual(manifest.expected_reason_distribution,[2,24,12,6,60,48,16,12]);
  assert.equal(new Set(manifest.programs.map(x=>x.id)).size,11);
  for(const p of manifest.programs) {
    assert.match(p.git_blob,/^[a-f0-9]{40}$/);
    assert.match(p.path,/^tests\/[a-z0-9_]+\.ores$/);
  }
});
