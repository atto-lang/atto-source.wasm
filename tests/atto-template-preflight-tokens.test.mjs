import test from "node:test";
import assert from "node:assert/strict";
import {lexicalTokensForPreflight} from "../scripts/atto-template-preflight-tokens.mjs";
import {rejectUnsupportedStateContainerVirtualActorSource, rejectUnsupportedDurableM0Source} from "../scripts/compile-ores.mjs";
const bytes = s => new TextEncoder().encode(s);
const fixtures = [["fnc main():int { val text = `define state container Example`; return 0; }",false],["fnc main():int { val text = 'define state container Example'; return 0; }",false],["fnc main():int { val text = `first ${\"{\"} then ${define state container Example}`; }",true],["fnc main():int { val text = `nested ${`literal ${define virtual actor N}`}`; }",true],["fnc main():int { /* define state container Fake */ define state container Real; }",true]];
function forbidden(tokens) {
 return tokens.some((v,i)=> v.text==="define" && (
    v.text==="define" && tokens[i+1]?.text==="state" && tokens[i+2]?.text==="container" ||
    tokens[i+1]?.text==="virtual" && tokens[i+2]?.text==="actor"));
}
for (const [source, expected] of fixtures) test("quote-aware token identity: "+source.slice(0,46),()=>{
 assert.equal(forbidden(lexicalTokensForPreflight(source)),expected);
 if (expected) assert.throws(()=>rejectUnsupportedStateContainerVirtualActorSource(bytes(source)),/STATE_CONTAINER_BACKEND_UNSUPPORTED|VIRTUAL_ACTOR_BACKEND_UNSUPPORTED/);
 else assert.doesNotThrow(()=>rejectUnsupportedStateContainerVirtualActorSource(bytes(source)));
});
const invalid=["`unterminated","`hi ${name`","`x ${'unclosed}`","'abc\nxyz'","`x ${ /* not closed */ y `","`x ${ `y ${x}`"];
for(const source of invalid) test("malformed quoted/template rejection: "+source.slice(0,36),()=>{
 assert.throws(()=>lexicalTokensForPreflight(source),/unterminated|newline/);
 assert.throws(()=>rejectUnsupportedDurableM0Source(bytes(source)),/unterminated|newline/);
});
test("template escape and nested brace/comment isolation",()=>{
 const source = "val String item = `one \\` two ${\"{\" + /* ignored } */ \"}\"}`;";
 const tokens = lexicalTokensForPreflight(source);
 assert.equal(tokens.filter(t=>t.id && t.text==="ignored").length,0);
});
test("bounded interpolation / nesting",()=>{
 assert.throws(()=>lexicalTokensForPreflight("`"+ "${x}".repeat(1025) +"`"),/count exceeded/);
 assert.throws(()=>lexicalTokensForPreflight("`"+"${`".repeat(33)+"x"+"`}".repeat(33)+"`"),/nesting too deep/);
});

for (const source of ["`empty ${}`","`only comments ${/* ignored */}`","`spaces ${   }`",
                      "`bad \\q`","`bad \\u12G4`","`bad \\u123`"]) {
 test("invalid template escape or empty interpolation: "+source,()=>{
  assert.throws(()=>lexicalTokensForPreflight(source),/invalid|empty/);
  assert.throws(()=>rejectUnsupportedDurableM0Source(bytes(source)),/invalid|empty/);
 });
}
test("direct scanner source and NUL budgets remain fail closed",()=>{
 assert.throws(()=>lexicalTokensForPreflight("\\0"),/NUL/);
 assert.throws(()=>lexicalTokensForPreflight("x".repeat(1_048_577)),/budget/);
});
