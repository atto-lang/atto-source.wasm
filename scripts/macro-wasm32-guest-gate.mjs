/**
 * Fail-closed macro-wasm32 guest evidence gate.
 * A blanket compiler-required lane must not silently skip the macro guest
 * because the narrower macro-only toggle was absent.
 */
export function requiresMacroWasm32Guest(env = process.env) {
  for (const key of ["ORESLANG_MACRO_WASM_PARITY_REQUIRED",
                     "ORESLANG_REQUIRE_REAL_COMPILER"]) {
    const value = env[key];
    if (value !== undefined && value !== "0" && value !== "1")
      throw Error(key + " must be explicitly 0 or 1; unknown value cannot skip guest execution");
  }
  return env.ORESLANG_MACRO_WASM_PARITY_REQUIRED === "1" ||
         env.ORESLANG_REQUIRE_REAL_COMPILER === "1";
}
