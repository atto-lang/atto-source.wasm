import test from "node:test";
import assert from "node:assert/strict";
import {requiresMacroWasm32Guest} from "../scripts/macro-wasm32-guest-gate.mjs";

test("standalone host-only suite can skip a nonrequested native guest", () => {
  assert.equal(requiresMacroWasm32Guest({}), false);
  assert.equal(requiresMacroWasm32Guest({
    ORESLANG_MACRO_WASM_PARITY_REQUIRED:"0",
    ORESLANG_REQUIRE_REAL_COMPILER:"0"
  }), false);
});
test("macro-only required flag forces native compiler and wasm32 guest", () => {
  assert.equal(requiresMacroWasm32Guest({ORESLANG_MACRO_WASM_PARITY_REQUIRED:"1"}), true);
});
test("general real-compiler-required lane cannot silently skip macro guests", () => {
  assert.equal(requiresMacroWasm32Guest({ORESLANG_REQUIRE_REAL_COMPILER:"1"}), true);
  assert.equal(requiresMacroWasm32Guest({
    ORESLANG_REQUIRE_REAL_COMPILER:"1",
    ORESLANG_MACRO_WASM_PARITY_REQUIRED:"0"
  }), true);
});
test("typos, blank values and noncanonical booleans fail closed", () => {
  for (const value of ["", "true", "false", "yes", "01", "2", " 1 "])
    for (const key of ["ORESLANG_MACRO_WASM_PARITY_REQUIRED",
                       "ORESLANG_REQUIRE_REAL_COMPILER"]) {
      assert.throws(() => requiresMacroWasm32Guest({[key]:value}),
                    /must be explicitly 0 or 1/);
    }
});

test("reads each dynamic gate flag exactly once before deciding admission", () => {
  let generalReads = 0;
  const general = {};
  Object.defineProperty(general, "ORESLANG_REQUIRE_REAL_COMPILER", {
    get() { generalReads++; return generalReads === 1 ? "1" : "0"; }
  });
  assert.equal(requiresMacroWasm32Guest(general), true);
  assert.equal(generalReads, 1, "validated required=1 must not turn into skip=0");

  let macroReads = 0;
  const macro = {};
  Object.defineProperty(macro, "ORESLANG_MACRO_WASM_PARITY_REQUIRED", {
    get() { macroReads++; return macroReads === 1 ? "1" : "0"; }
  });
  assert.equal(requiresMacroWasm32Guest(macro), true);
  assert.equal(macroReads, 1);
});

test("malformed environment carriers cannot silently disable required guest tests",()=>{
  for(const value of [null,0,1,true,false,"1","0",[],["1"]])
    assert.throws(()=>requiresMacroWasm32Guest(value),
      /requires an environment record/);
  assert.equal(requiresMacroWasm32Guest(Object.create(null)),false);
  const explicit=Object.create(null);
  explicit.ORESLANG_REQUIRE_REAL_COMPILER="1";
  assert.equal(requiresMacroWasm32Guest(explicit),true);
});

test("prototype-inherited macro gate flags fail closed before getter execution",()=>{
  for(const key of ["ORESLANG_MACRO_WASM_PARITY_REQUIRED",
                    "ORESLANG_REQUIRE_REAL_COMPILER"]){
    for(const value of ["0","1"]){
      const inherited=Object.create({[key]:value});
      assert.throws(()=>requiresMacroWasm32Guest(inherited),/inherited flag/);
    }
    let reads=0;
    const proto=Object.create(null);
    Object.defineProperty(proto,key,{get(){reads++;throw Error("inherited getter executed");}});
    assert.throws(()=>requiresMacroWasm32Guest(Object.create(proto)),/inherited flag/);
    assert.equal(reads,0);
  }
  assert.equal(requiresMacroWasm32Guest(Object.create(null)),false);
  assert.equal(requiresMacroWasm32Guest(
    {ORESLANG_REQUIRE_REAL_COMPILER:"1"}),true);
});

test("own required flags never override unsafe inherited companion flags",()=>{
 for(const [ownKey,inheritedKey] of [
   ["ORESLANG_MACRO_WASM_PARITY_REQUIRED","ORESLANG_REQUIRE_REAL_COMPILER"],
   ["ORESLANG_REQUIRE_REAL_COMPILER","ORESLANG_MACRO_WASM_PARITY_REQUIRED"]
 ]){
   let getterReads=0;
   const prototype=Object.create(null);
   Object.defineProperty(prototype,inheritedKey,{
     get(){getterReads++;throw Error("inherited getter must not run");}
   });
   const flags=Object.create(prototype);
   Object.defineProperty(flags,ownKey,{value:"1",enumerable:true});
   assert.throws(()=>requiresMacroWasm32Guest(flags),/inherited flag/);
   assert.equal(getterReads,0);
 }
 assert.equal(requiresMacroWasm32Guest({
   ORESLANG_MACRO_WASM_PARITY_REQUIRED:"1",
   ORESLANG_REQUIRE_REAL_COMPILER:"0"
 }),true);
});
