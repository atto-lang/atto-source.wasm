import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedAdtSource} from "../scripts/compile-ores.mjs";
const bytes=s=>Buffer.from(s,"utf8");
const rejected=[
 ["nullary enum","define enum Stage as Ready=1 end"],
 ["payload enum","define enum Message as Count: int=1 end"],
 ["implicit max overflow","define enum Edge as Last=2147483647 Overflow end"],
 ["tagged pattern","define pattern Messages as Stage.Ready end"],
 ["match pattern","define match pattern Events as Stage.Ready end"],
 ["published pattern","define pub pattern Messages as Stage.Ready end"],
 ["Some typed value","fnc main(Option<bool> value):int {return 0;}"],
 ["Result typed value","fnc main(Result<int,int> value):int{return 0;}"],
 ["Some match","match x over on Some(true)->{return 1;} end"],
 ["None match","match x over on None->{return 0;} end"],
 ["Ok match","match x over on Ok(v)->{return v;} end"],
 ["Err match","match x over on Err(e)->{return 0;} end"],
 ["qualified case","match m over on Stage.Ready->{return 1;} end"],
 ["qualified nested case","match m over on pkg.Message.Foo->{return 1;} end"]
];
for(const [label,source] of rejected){
 test("wasm ADT unsupported source rejects: "+label,()=>{
  assert.throws(()=>rejectUnsupportedAdtSource(bytes(source)),/wasm .*ADT .*unsupported|wasm Option\/Result payload ADT lowering unsupported/i);
 });
}
const inert=[
 ["line comment","fnc main():int {return 42;} // define enum X"],
 ["nested comment","/* define /* enum X */ match pattern */ fnc main():int {return 42;}"],
 ["quoted string",'fnc main():int { const x = "define enum X"; return 42; }'],
 ["escaped quoted string",'fnc main():int { const x = "foo \\"on Some\\"";return 42;}'],
 ["unrelated method call","fnc main():int {return math.inc(42);}"],
 ["scalar function","define pub fnc main():int{return 7;}"],
 ["unqualified scalar match","match x over on true->{return 1;} end"],
 ["literal Result wording","fnc main():int{return 7;} // Result<int,int>"]
];
for(const [label,source] of inert){
 test("wasm ADT lexical gate does not false reject: "+label,()=>{
  assert.doesNotThrow(()=>rejectUnsupportedAdtSource(bytes(source)));
 });
}
test("wasm ADT preflight refuses malformed UTF-8",()=>{
 assert.throws(()=>rejectUnsupportedAdtSource(Uint8Array.from([0xc0,0xaf])),/encoded data was not valid/i);
});
test("wasm ADT preflight refuses unterminated nested comment",()=>{
 assert.throws(()=>rejectUnsupportedAdtSource(bytes("/* outer /* inner */")),/unterminated block comment/i);
});
