import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedTupleV2Source} from "../scripts/compile-ores.mjs";

const bytes=s=>Buffer.from(s,"utf8");

test("wasm tuple-v2 source boundary rejects semantic parameter forms",()=>{
 for(const source of [
  "fnc take(tuple (int,int,string?) value):int{return 1;}",
  "fnc take((int,int,string?) value):int{return 1;}",
  "fnc take(structural (int,int,string?) value):int{return 1;}",
  "routine take(tuple (int,int) value):int{return 1;}",
  "fnc take<T>(tuple (int,int) value):int{return 1;}",
  "fnc take<T,U>((int,int) value):int{return 1;}"
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


test("Unicode line boundaries cannot hide unsupported structural tuple syntax", () => {
  for (const boundary of ["\r", "\r\n", "\n", "\u0085", "\u2028", "\u2029"]) {
    const active = "// innocuous" + boundary +
                   "fnc take((int,int) value):int{return 1;}";
    assert.throws(() => rejectUnsupportedTupleV2Source(bytes(active)),
                  /wasm structural tuple v2/, JSON.stringify(boundary));
    const decoy = "// fnc take((int,int) value):int{return 1;}" + boundary +
                  "fnc main():int{return 42;}";
    assert.doesNotThrow(() => rejectUnsupportedTupleV2Source(bytes(decoy)),
                        JSON.stringify(boundary));
  }
});

test("shared token budget and malformed-source gates apply to tuple admission", () => {
  assert.throws(() => rejectUnsupportedTupleV2Source(bytes("/*".repeat(129) + "*/".repeat(129))),
                /source comment nesting exceeded/);
  assert.throws(() => rejectUnsupportedTupleV2Source(bytes('fnc main(){ return "unterminated; }')),
                /unterminated source string/);
  const tick = String.fromCharCode(96);
  const interpolation = "fnc main(){return " + tick + "interpolate $" + "{value}" + tick + ";}";
  assert.throws(() => rejectUnsupportedTupleV2Source(bytes(interpolation)),
                /template interpolation unsupported/);
  assert.throws(() => rejectUnsupportedTupleV2Source(bytes(";".repeat(100_001))),
                /source token budget exceeded/);
});
