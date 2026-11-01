import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedModelSource} from "../scripts/compile-ores.mjs";

const bytes=text=>Buffer.from(text,"utf8");

test("wasm32 rejects unsupported nominal model declarations",()=>{
 for(const source of [
  "define model PriceEstimate() as AddTax(10) end",
  "define model x as Identity() end",
  "define pub model PriceEstimate() as AddTax(10) end",
  "pub define model PriceEstimate() as AddTax(10) end",
  "define /* bounded comment */ model PriceEstimate() as AddTax(10) end",
  "define\nmodel PriceEstimate() as AddTax(10) end"
 ]) assert.throws(()=>rejectUnsupportedModelSource(bytes(source)),
   /MODEL_LOWERING_UNSUPPORTED: wasm32/);
});

test("model remains contextual and comments or strings are inert",()=>{
 for(const source of [
  "fnc model():int{return 41;} fnc main():int{return model()+1;}",
  "// define model Fake as Op() end\nfnc main():int{return 42;}",
  "/* define model Fake as Op() end */ fnc main():int{return 42;}",
  "/* a /* define model Fake as Op() end */ b */ fnc main():int{return 42;}",
  'fnc main():int{const s = "define model Fake as Op() end";return 42;}'
 ]) assert.doesNotThrow(()=>rejectUnsupportedModelSource(bytes(source)));
});

test("model rejection offset counts UTF-8 bytes after Unicode comments",()=>{
 const prefix="/* café 🌟 */ ";
 const source=prefix+"define model x as Identity() end";
 const expected=Buffer.byteLength(prefix+"define ","utf8");
 assert.throws(()=>rejectUnsupportedModelSource(bytes(source)),error=>
   error.message.endsWith("at byte "+expected));
});

test("invalid UTF-8 rejects before source model scanning",()=>{
 assert.throws(()=>rejectUnsupportedModelSource(Uint8Array.from([0xc0,0xaf])),
   /encoded data was not valid/i);
});
