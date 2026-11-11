import test from "node:test";
import assert from "node:assert/strict";
import {admitSimd128,isSimd128EngineSupported} from "../scripts/simd128-feature.mjs";
const env="edge-wasi";
test("real Wasm SIMD engine capability probe returns a boolean",()=>{
 assert.equal(typeof isSimd128EngineSupported(),"boolean");
});
test("scalar remains default and does not need SIMD",()=>{
 assert.deepEqual(admitSimd128({environment:env,engineSupportsSimd128:false}),
  {mode:"scalar",status:"PRE_FLIGHT_ONLY"});
});
test("unknown mode and environment fail closed",()=>{
 assert.throws(()=>admitSimd128({environment:env,mode:"guess"}),/unknown SIMD mode/);
 assert.throws(()=>admitSimd128({environment:"baremetal"}),/unsupported Wasm environment/);
});
test("target policy, real codegen and runtime are independent gates",()=>{
 const good={mode:"simd128",environment:env,
  profileAllowsSimd128:true,compilerHasVectorLowering:true,
  engineSupportsSimd128:true};
 assert.deepEqual(admitSimd128(good),{mode:"simd128",status:"PRE_FLIGHT_ONLY"});
 for(const key of ["profileAllowsSimd128","compilerHasVectorLowering","engineSupportsSimd128"])
   assert.throws(()=>admitSimd128({...good,[key]:false}));
});
test("capability strings do not bypass admission",()=>{
 assert.throws(()=>admitSimd128({mode:"simd128",environment:env,
  profileAllowsSimd128:"true",compilerHasVectorLowering:true,
  engineSupportsSimd128:true}),/must be boolean/);
});
