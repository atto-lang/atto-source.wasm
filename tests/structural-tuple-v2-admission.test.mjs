import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedTupleV2Source} from "../scripts/compile-ores.mjs";

const bytes=s=>Buffer.from(s,"utf8");

test("wasm tuple-v2 source boundary rejects semantic parameter forms",()=>{
 for(const source of [
  "fnc take(tuple (int,int,string?) value):int{return 1;}",
  "fnc take((int,int,string?) value):int{return 1;}",
  "fnc take(structural (int,int,string?) value):int{return 1;}",
  "routine take(tuple (int,int) value):int{return 1;}"
 ]){
  assert.throws(()=>rejectUnsupportedTupleV2Source(bytes(source)),
    /wasm structural tuple v2/);
 }
});

test("tuple-v2 scanner ignores comments and quoted decoys",()=>{
 for(const source of [
  "// fnc fake((int,int,string?) value):int{return 0;}\nfnc main():int{return 42;}",
  "/* fnc fake(tuple (int,int) value):int{return 0;} */ fnc main():int{return 42;}",
  "fnc main():int{ const s = \"fnc fake((int,int) x)\"; return 42; }"
 ]){
  assert.doesNotThrow(()=>rejectUnsupportedTupleV2Source(bytes(source)));
 }
});

test("contextual tuple identifier is not globally reserved",()=>{
 assert.doesNotThrow(()=>rejectUnsupportedTupleV2Source(bytes(
  "fnc tuple():int{return 42;} fnc main():int{return tuple();}"
 )));
});

test("nested block comments cannot smuggle a false tuple detection",()=>{
 assert.doesNotThrow(()=>rejectUnsupportedTupleV2Source(bytes(
  "/* outer /* fnc fake(structural (int,int) x) */ done */ fnc main():int{return 42;}"
 )));
});

test("invalid UTF-8 fails before semantic source scanning",()=>{
 assert.throws(()=>rejectUnsupportedTupleV2Source(Uint8Array.from([0xc0,0xaf])),
   /encoded data was not valid/i);
});
