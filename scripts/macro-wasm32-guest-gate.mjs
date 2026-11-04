/**
 * Fail-closed macro-wasm32 guest evidence gate.
 * A blanket compiler-required lane must not silently skip the macro guest
 * because the narrower macro-only toggle was absent.
 */
export function requiresMacroWasm32Guest(env = process.env) {
  // A malformed environment carrier must not downgrade required guest tests
  // to optional by making both flag lookups silently return undefined.
  if (env === null || typeof env !== "object" || Array.isArray(env))
    throw new TypeError("macro guest gate requires an environment record");
  // Snapshot each flag exactly once: accessor-backed input must not change
  // the decision between validation and execution admission.
  const flags = Object.create(null);
  for (const key of ["ORESLANG_MACRO_WASM_PARITY_REQUIRED",
                     "ORESLANG_REQUIRE_REAL_COMPILER"]) {
    // Never inherit required-test authority from a forged prototype.
    // Refuse ambiguous carriers rather than accepting or silently skipping.
    if (key in env && !Object.hasOwn(env,key))
      throw Error(key + " inherited flag cannot decide native guest admission");
    const value = env[key];
    if (value !== undefined && value !== "0" && value !== "1")
      throw Error(key + " must be explicitly 0 or 1; unknown value cannot skip guest execution");
    flags[key] = value === "1";
  }
  return flags.ORESLANG_MACRO_WASM_PARITY_REQUIRED ||
         flags.ORESLANG_REQUIRE_REAL_COMPILER;
}
