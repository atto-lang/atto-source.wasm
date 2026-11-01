import test from "node:test";
import assert from "node:assert/strict";
import { assertStateInjectionFrontendRejection } from "../scripts/verify-real-compiler.mjs";

const nativeDenied = {
  status: 1, signal: null, error: undefined, stdout: "",
  stderr: "oreslang-llvmc: STATE_INJECTION_UNSUPPORTED: @Inject requires native typed region and borrow lowering at byte 0"
};

test("WASM relies on native compiler-owned injected-state denial", () => {
  assert.equal(assertStateInjectionFrontendRejection(nativeDenied), true);
  assert.equal(assertStateInjectionFrontendRejection({
    ...nativeDenied,
    stderr: "oreslang-llvmc: STATE_INJECTION_UNSUPPORTED: @StateBacked requires native typed region and borrow lowering at byte 0"
  }), true);
});

test("incidental parser refusal cannot masquerade as state-injection capability gate", () => {
  for (const stderr of [
    "oreslang-llvmc: unexpected token @Inject at byte 0",
    "oreslang-llvmc: unknown variable MutableStateContainer",
    "oreslang-llvmc: annotation ignored",
    ""
  ]) {
    assert.throws(() => assertStateInjectionFrontendRejection({
      ...nativeDenied, stderr
    }), /compiler-owned capability gate|diagnosed error/);
  }
});

test("native frontend must never emit IR, crash or accept unsupported injection", () => {
  for (const mutated of [
    {...nativeDenied, status: 0},
    {...nativeDenied, stdout: "define i64 @main() { ret i64 42 }"},
    {...nativeDenied, signal: "SIGSEGV", status: null},
    {...nativeDenied, error: new Error("spawn failed")}
  ]) {
    assert.throws(() => assertStateInjectionFrontendRejection(mutated),
      /diagnosed error/);
  }
});
