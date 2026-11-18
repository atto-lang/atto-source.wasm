// Cross-backend parity PR #19 exact-source candidates: Wasm must execute real LLVM output.
// Missing compiler can skip ordinary optional tests, but required runs must fail closed.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {compileOresToWasm} from "../scripts/compile-ores.mjs";

const cases = [
  ["40-wide-i64-difference", "// 40: wide-i64-difference\n// Candidate scalar exactness fixture; no compiler-backed execution claimed.\npub fnc main(): int { return 9007199254740993 - 9007199254740951; }\n"],
  ["41-min-i64-successor", "// 41: min-i64-successor\n// Candidate scalar exactness fixture; no compiler-backed execution claimed.\npub fnc main(): int { return (-9223372036854775807 - 1) + 9223372036854775807 + 43; }\n"],
  ["42-max-i64-predecessor", "// 42: max-i64-predecessor\n// Candidate scalar exactness fixture; no compiler-backed execution claimed.\npub fnc main(): int { return 9223372036854775807 - (9223372036854775807 - 42); }\n"],
  ["43-wide-checked-product", "// 43: wide-checked-product\n// Candidate scalar exactness fixture; no compiler-backed execution claimed.\npub fnc main(): int { return 3037000499 * 3037000499 - 9223372030926248959; }\n"],
  ["44-double-negative-product", "// 44: double-negative-product\n// Candidate scalar exactness fixture; no compiler-backed execution claimed.\npub fnc main(): int { return (1 - 43) * -1; }\n"],
  ["45-grouped-negation", "// 45: grouped-negation\n// Candidate scalar exactness fixture; no compiler-backed execution claimed.\npub fnc main(): int { return -(-42); }\n"],
  ["46-named-bitxor", "// 46: named-bitxor\n// Candidate scalar exactness fixture; no compiler-backed execution claimed.\npub fnc main(): int { return Integer.bitXor(40, 2); }\n"],
  ["47-mantissa-precision-product", "// 47: mantissa-precision-product\n// Candidate scalar exactness fixture; no compiler-backed execution claimed.\npub fnc main(): int { return (9007199254740993 - 9007199254740992) * 42; }\n"],
  ["48-max-i64-delta", "// 48: max-i64-delta\n// Candidate scalar exactness fixture; no compiler-backed execution claimed.\npub fnc main(): int { return 9223372036854775807 - 9223372036854775765; }\n"],
  ["49-signed-boundary-product", "// 49: signed-boundary-product\n// Candidate scalar exactness fixture; no compiler-backed execution claimed.\npub fnc main(): int { return (9223372036854775807 - 9223372036854775800) * 6; }\n"],
];
const compiler = process.env.ORESLANG_LLVM_COMPILER;
const compilerSha256 = process.env.ORESLANG_LLVM_COMPILER_SHA256;
const required = process.env.ORESLANG_REQUIRE_REAL_COMPILER === "1";

test("ten signed-i64 candidate sources have unique identities and full syntax", () => {
  assert.equal(cases.length, 10);
  assert.equal(new Set(cases.map(([name])=>name)).size, 10);
  for(const [name,source] of cases) {
    assert.match(name,/^(?:4[0-9])-[a-z0-9-]+$/);
    assert.match(source,/^\/\/ \d\d: [a-z0-9-]+\n/);
    assert.match(source,/pub fnc main\(\): int \{ return .*; \}\n$/);
  }
});

for(const [name,src] of cases) {
  test("compiler-backed LLVM-to-Wasm signed64 guest "+name, async t => {
    if(!compiler || !compilerSha256) {
      if(required) throw Error("required exact compiler and SHA-256 must be configured; never skip required guest execution");
      t.skip("requires ORESLANG_LLVM_COMPILER and ORESLANG_LLVM_COMPILER_SHA256");
      return;
    }
    assert.match(compilerSha256,/^[0-9a-f]{64}$/);
    const dir=await mkdtemp(join(tmpdir(),"ores-wasm-i64-parity-"));
    t.after(()=>rm(dir,{recursive:true,force:true}));
    const source=join(dir,"main.ores"),output=join(dir,"main.wasm");
    await writeFile(source,src,{flag:"wx",mode:0o400});
    await compileOresToWasm({compiler:resolve(compiler),compilerSha256,source,output});
    const bytes=await readFile(output);
    assert(bytes.length>8,"empty Wasm artifact must not count as guest execution");
    const {instance}=await WebAssembly.instantiate(bytes,{});
    assert.equal(typeof instance.exports.main,"function");
    assert.equal(instance.exports.main(),42n,"native wasm32 signed64 result mismatch");
  });
}
