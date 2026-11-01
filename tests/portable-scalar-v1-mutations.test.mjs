// HOST-ONLY mutation gates: never claim these as compiler-backed Oreslang passes.
import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {
  PORTABLE_SCALAR_BLOB,gitBlobSha,verifyPortableScalarCorpusBytes
} from "../scripts/portable-scalar-corpus.mjs";

const file=new URL("../contracts/parity/portable-scalar-v1-20261101.json",import.meta.url);
const reference=await readFile(file);
const original=verifyPortableScalarCorpusBytes(reference);

function checkedMutation(label,mutate,diagnostic){
  test("portable corpus rejects "+label,()=>{
    const doc=structuredClone(original);
    mutate(doc);
    const bytes=Buffer.from(JSON.stringify(doc)+"\n","utf8");
    assert.throws(()=>verifyPortableScalarCorpusBytes(bytes,{
      expectedBlob:gitBlobSha(bytes)
    }),diagnostic);
  });
}
test("portable scalar exact Git blob is pinned and 16+6 cases are admitted",()=>{
  assert.equal(gitBlobSha(reference),PORTABLE_SCALAR_BLOB);
  assert.equal(original.positive.length,16);
  assert.equal(original.negative.length,6);
  assert.equal(original.positive.map(x=>x.id).length+
    original.negative.map(x=>x.id).length,22);
});
test("portable scalar rejects a one-byte tamper against reviewed Git blob",()=>{
  const mutant=Buffer.from(reference);
  mutant[mutant.length-2]^=1;
  assert.throws(()=>verifyPortableScalarCorpusBytes(mutant),
    /Git blob differs/);
});
test("portable scalar rejects an empty file",()=>{
  assert.throws(()=>verifyPortableScalarCorpusBytes(Buffer.alloc(0),
    {expectedBlob:gitBlobSha(Buffer.alloc(0))}),/bounded nonempty/);
});
test("portable scalar rejects an oversized corpus before parsing JSON",()=>{
  const bytes=Buffer.alloc(16385,0x20);
  assert.throws(()=>verifyPortableScalarCorpusBytes(bytes,
    {expectedBlob:gitBlobSha(bytes)}),/bounded nonempty/);
});
test("portable scalar rejects an invalid UTF8 sequence after hash admission",()=>{
  const bytes=Buffer.from([0xc3,0x28]);
  assert.throws(()=>verifyPortableScalarCorpusBytes(bytes,{
    expectedBlob:gitBlobSha(bytes)
  }),/encoded|UTF|valid/i);
});
test("portable scalar rejects malformed JSON after re-pinning the changed bytes",()=>{
  const bytes=Buffer.from("{unclosed","utf8");
  assert.throws(()=>verifyPortableScalarCorpusBytes(bytes,{
    expectedBlob:gitBlobSha(bytes)
  }),SyntaxError);
});
checkedMutation("schema downgrade",d=>{d.schema_version="0.0.1"},/schema\/scope drift/);
checkedMutation("scope inflation",d=>{d.scope="all-actors-and-stdlib"},/schema\/scope drift/);
checkedMutation("deleted positive",d=>{d.positive.pop()},/inventory incomplete/);
checkedMutation("deleted negative",d=>{d.negative.pop()},/inventory incomplete/);
checkedMutation("duplicate case identity across positive and negative",d=>{
  d.negative[0].id=d.positive[0].id;
},/duplicate case identity/);
checkedMutation("duplicate case expression",d=>{
  d.positive[1].expression=d.positive[0].expression;
},/duplicate expression/);
checkedMutation("unsafe case identifier",d=>{
  d.positive[0].id="../fake-receipt";
},/duplicate case identity/);
checkedMutation("source injection instead of scalar expression",d=>{
  d.positive[0].expression="1; import fnc x from \"/tmp/secret\"";
},/unsafe or duplicate expression/);
checkedMutation("removed operator as accepted expression",d=>{
  d.positive[0].expression="7 % 3";
},/unsafe or duplicate expression/);
checkedMutation("impossible expected positive i64",d=>{
  d.positive[0].expected="9223372036854775808";
},/outside signed i64/);
checkedMutation("malformed expected exponent",d=>{
  d.positive[0].expected="1e9";
},/malformed expected i64/);
checkedMutation("noncanonical negative zero",d=>{
  d.positive[0].expected="-0";
},/malformed expected i64/);
checkedMutation("unknown negative diagnostic class",d=>{
  d.negative[0].reason="always-pass";
},/negative diagnostic class/);
checkedMutation("removed-operator control with no removed operator",d=>{
  d.negative[1].expression="7 + 3";
},/removed operator control/);
checkedMutation("division control with no division",d=>{
  d.negative[0].expression="7 - 3";
},/division control/);
checkedMutation("out-of-range control with an in-range value",d=>{
  d.negative[4].expression="9223372036854775807";
},/out-of-range control/);
