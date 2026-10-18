import test from "node:test";
import assert from "node:assert/strict";
import {admitSimd128} from "../scripts/simd128-feature.mjs";

const good={mode:"simd128",environment:"edge-wasi",profileAllowsSimd128:true,
 compilerHasVectorLowering:true,engineSupportsSimd128:true};
test("getter-controlled SIMD authority is rejected without invoking getter",()=>{
 let accessed=0;
 const hostile={...good};
 Object.defineProperty(hostile,"profileAllowsSimd128",{
  enumerable:true,get(){accessed++;return true;}
 });
 assert.throws(()=>admitSimd128(hostile),/known own data fields/);
 assert.equal(accessed,0);
});
test("inherited, array-shaped and unknown SIMD authorities fail closed",()=>{
 assert.throws(()=>admitSimd128(Object.assign(Object.create({}),good)),/plain data object/);
 assert.throws(()=>admitSimd128([]),/plain data object/);
 assert.throws(()=>admitSimd128({...good,override:"unsafe"}),/known own data fields/);
});
test("plain data still produces preflight-only, not compiler parity claims",()=>{
 assert.deepEqual(admitSimd128(good),{mode:"simd128",status:"PRE_FLIGHT_ONLY"});
});

test("omitted engine probe is assignable and scalar mode does not require SIMD",()=>{
 const result=admitSimd128({environment:"edge-wasi"});
 assert.deepEqual(result,{mode:"scalar",status:"PRE_FLIGHT_ONLY"});
});
test("explicit nonboolean engine support cannot bypass checks",()=>{
 assert.throws(()=>admitSimd128({environment:"edge-wasi",engineSupportsSimd128:"true"}),/boolean/);
});
