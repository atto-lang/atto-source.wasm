import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {assertWithFrontendRejection} from "../scripts/verify-real-compiler.mjs";

const good = {
  status:1, error:undefined, signal:null, stdout:"",
  stderr:"oreslang-llvmc: WITH_BACKEND_UNSUPPORTED: immutable with field reconstruction requires checked rt copy/take ownership at byte 40"
};
test("with requires a pinned compiler-owned diagnostic, never a JS-simulated guest", () => {
  assert.equal(assertWithFrontendRejection(good),true);
  for(const mutated of [
    {...good,status:0},
    {...good,status:2},
    {...good,stdout:"define i64 @main() { ret i64 42 }"},
    {...good,signal:"SIGSEGV",status:null},
    {...good,stderr:"oreslang-llvmc: expected ';'"},
    {...good,stderr:"host shim: WITH_BACKEND_UNSUPPORTED"}
  ]) assert.throws(()=>assertWithFrontendRejection(mutated));
});
test("Wasm with .atto source fixture is stable and explicitly unsupported", () => {
  const src=readFileSync(new URL("../contracts/with-ownership-v1/contextual-with-scalar.atto",import.meta.url),"utf8");
  assert.equal(src,"pub fnc main(): int {\n    return 42 with {x => 1};\n}\n");
  assert.ok(!src.includes("this."));
});
