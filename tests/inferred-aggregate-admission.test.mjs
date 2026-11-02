import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedInferredAggregateSource} from "../scripts/compile-ores.mjs";
const bytes = source => Buffer.from(source,"utf8");

test("Wasm bridge explicitly rejects all aggregate constructor spellings before native compiler",()=>{
 const unsupported=[
   "const p = infer struct{x: 1};",
   "const p = infer<Local> struct{x: 1};",
   "const p = infer record{x: 1};",
   "const p = record{x: 1};",
   "const p = struct{x:int}{x:1};",
   "const p = infer struct{...old, extra: true};",
   "const p = record{...old, n: 1};",
   "const p = infer /* comment */ record /* comment */ {x:1};",
   "const p = record /* comment */ {x:1};"
 ];
 for(const source of unsupported)
  assert.throws(()=>rejectUnsupportedInferredAggregateSource(bytes(source)),
    /wasm inferred aggregate lowering unsupported/,source);
});

test("Contextual identifiers, nested comments and quoted spelling do not trigger aggregate lowering",()=>{
 const valid=[
  "fnc struct():int{return 1;}",
  "fnc record():int{return 1;}",
  "const infer = 1;",
  "// infer struct{x:1}\nfnc main():int{return 42;}",
  "/* outer /* record{x:1} */ done */ fnc main():int{return 42;}",
  'fnc main():int{const s="infer record{x:1}";return 42;}',
  "fnc main():int{const s='struct{x:1}';return 42;}"
 ];
 for(const source of valid)
  assert.doesNotThrow(()=>rejectUnsupportedInferredAggregateSource(bytes(source)),source);
});

test("Malformed UTF-8 never becomes admitted aggregate source",()=>{
 assert.throws(()=>rejectUnsupportedInferredAggregateSource(Uint8Array.from([0xc0,0xaf])),
    /encoded data was not valid/i);
});
