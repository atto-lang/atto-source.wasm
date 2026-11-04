import test from "node:test";
import assert from "node:assert/strict";
import {verifyAttoScalarV1} from "../scripts/atto-scalar-v1-inventory.mjs";
test("19 common .atto scalar programs are exact-byte pinned, not executed",async()=>{
 const cases=await verifyAttoScalarV1();
 assert.equal(cases.length,19);
 assert.equal(cases.filter(x=>x.kind==="positive").length,10);
 assert.equal(cases.filter(x=>x.kind==="negative").length,9);
 assert.equal(cases[0].bytes.toString("utf8"),"pub fnc main(): int { return 40 + 2; }\n");
});
test("source-only corpus is not a signed executable guest receipt",async()=>{
 const cases=await verifyAttoScalarV1();
 assert.ok(cases.every(c=>!Object.hasOwn(c,"wasmSha256")&&!Object.hasOwn(c,"executed")));
});
