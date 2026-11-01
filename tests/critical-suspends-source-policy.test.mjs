import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedCriticalSuspendsSource} from "../scripts/compile-ores.mjs";
const bytes=s=>new TextEncoder().encode(s);
const cases=[
 ["async fnc main():int{return 1;}","E_CALLABLE_MODIFIERS"],
 ["critical suspends fnc main():void {}","E_CALLABLE_MODIFIERS"],
 ["suspends critical fnc main():void {}","E_CALLABLE_MODIFIERS"],
 ["critical fnc main():int{return 1;}","E_CRITICAL_UNSUPPORTED"],
 ["suspends fnc main():int{return 1;}","E_SUSPENDS_UNSUPPORTED"],
 ["fnc main():int{critical {return 1;}}","E_CRITICAL_UNSUPPORTED"],
 ["fnc main():int{try critical {return 1;} else {return 0;}}","E_CRITICAL_UNSUPPORTED"],
 ["fnc main():int{return await pending;}","E_SUSPENDS_UNSUPPORTED"],
 ["define isolated actor A as pub critical inc():void {} end","E_CRITICAL_UNSUPPORTED"],
 ["fnc main():int{return critical[read];}","E_CRITICAL_UNSUPPORTED"],
 ["suspends/*comment*/critical fnc main():void {}","E_CALLABLE_MODIFIERS"]
];
test("Wasm refuses every unlowered critical/suspends feature before native compiler launch",()=>{
 for(const [source,diagnostic] of cases)
  assert.throws(()=>rejectUnsupportedCriticalSuspendsSource(bytes(source)),
    error=>error.message.includes(diagnostic),source);
});
test("comment, string and unrelated identifiers do not forge critical features",()=>{
 for(const source of [
  "fnc main():int{return 42;} // critical suspends await async fnc",
  "fnc main():int{return 42;} /* critical /* await suspends */ async fnc */",
  "fnc main():string{return \"critical suspends await async fnc\";}",
  "fnc critical_count():int{return 42;}",
  "fnc main():int{return critical_count;}",
  "fnc main():int{return 42;} // try critical"
 ])assert.doesNotThrow(()=>rejectUnsupportedCriticalSuspendsSource(bytes(source)),source);
});
test("does not ban async task expressions solely because they contain async",()=>{
 assert.doesNotThrow(()=>rejectUnsupportedCriticalSuspendsSource(
  bytes("fnc main():int{return async task |int value| -> value;}")));
 // This is only a critical/suspends guard; a different compiler capability
 // may reject the task. The guard does not confer Task execution support.
});
test("source policy rejects malformed UTF-8 instead of interpreting lossily",()=>{
 assert.throws(()=>rejectUnsupportedCriticalSuspendsSource(new Uint8Array([0xc3,0x28])),/encoded|UTF|valid/i);
});
test("CR and Unicode line separators cannot hide executable critical tokens",()=>{
 for(const separator of ["\r","\u0085","\u2028","\u2029"]){
  const source="fnc main():int{return 42;} // harmless"+separator+"critical { illegal(); }";
  assert.throws(()=>rejectUnsupportedCriticalSuspendsSource(bytes(source)),/E_CRITICAL_UNSUPPORTED/);
 }
});
test("unterminated strings and templates fail before compiler invocation",()=>{
 for(const source of [
  'fnc main():int{return "critical',
  "fnc main():int{return `critical`;}"
 ])assert.throws(()=>rejectUnsupportedCriticalSuspendsSource(bytes(source)),
  /unterminated source literal|does not support template literal/);
});
test("Wasm source policy is independent from host-import and runtime admission",()=>{
 const unsafe="suspends fnc main():int{return await io();}";
 assert.throws(()=>rejectUnsupportedCriticalSuspendsSource(bytes(unsafe)),/E_SUSPENDS_UNSUPPORTED/);
});
