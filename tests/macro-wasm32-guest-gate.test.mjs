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
