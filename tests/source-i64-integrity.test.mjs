import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";

// Must run even when no external LLVM compiler is supplied.
// A skipped execution probe cannot silently skip corpus-integrity controls.
const fixtureURL = new URL("../contracts/v1/numeric-parity/source-i64-cases.json",import.meta.url);
const BLOB = "bbc319c19ecd007109d33592e210091eb267e5a2";
const SHA256 = "39bddbe558ad1c336271f91e6403c4555f2f16a7ed33a3355ee897721b6ab02a";
const IDS = ["precedence","grouping","signed-multiplication","subtraction",
             "negative-result","max-minus-one","signed-minimum"];
const VALUES = ["14","20","27","76","-5","9223372036854775806",
                "-9223372036854775808"];

function verify(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length>0 && bytes.length<=8192);
  const header=Buffer.from("blob "+bytes.length+"\\0","ascii");
  assert.equal(createHash("sha1").update(header).update(bytes).digest("hex"),BLOB,
    "fixture must match reviewed Git blob");
  assert.equal(createHash("sha256").update(bytes).digest("hex"),SHA256,
    "fixture must match independent SHA-256");
  const source=bytes.toString("utf8");
  assert.equal(Buffer.from(source,"utf8").equals(bytes),true,"fixture must be valid UTF-8");
  const parsed=JSON.parse(source);
  assert.deepEqual(Object.keys(parsed).sort(),["cases","schema_version","scope","status"]);
  assert.equal(parsed.schema_version,"1.0.0");
  assert.equal(parsed.status,"reference-only-not-compiled-execution");
  assert.equal(typeof parsed.scope,"string");
  assert.equal(parsed.cases.length,IDS.length);
  for (const [i,c] of parsed.cases.entries()) {
    assert.deepEqual(Object.keys(c).sort(),["expected","expression","id"]);
    assert.equal(c.id,IDS[i],"case set/order changed");
    assert.equal(c.expected,VALUES[i],"oracle changed without review");
    assert.match(c.expression,/^[0-9()+* -]{1,256}$/,"non-portable expression");
  }
  return parsed;
}
test("reviewed portable source-i64 fixture verifies even without native compiler",async()=>{
  const bytes=await readFile(fixtureURL);
  assert.equal(verify(bytes).cases.length,7);
});
test("tampered i64 fixture cannot pass the independent digest gate",async()=>{
  const bytes=await readFile(fixtureURL);
  for(const invalid of [Buffer.concat([bytes,Buffer.from(" ")]),
                        bytes.subarray(0,bytes.length-1),
                        Buffer.from("{}", "utf8"),
                        Buffer.concat([Buffer.from([0xff]),bytes])]) {
    assert.throws(()=>verify(invalid));
  }
});
