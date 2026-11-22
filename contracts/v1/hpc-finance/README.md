# HPC finance Oreslang multi-backend parity contract v1

Canonical fixture: `contracts/v1/hpc-finance/risk-gate-v1.tsv`.
Exact Git blob: `cec489c1f7603617797340dd1b4a71cc85acfebd` (23 distinct decisions: 3 approved, 20 rejected). The originating fixture is `oreslang-hpc-finance/fixtures/risk-gate-v1.tsv` at finance PR #18. Only same-organization repository content was copied; no cross-organization private-source mirror, token, or CI carrier was created.

**This milestone is NOT compiled Oreslang guest parity.** Each backend runs an independently implemented **host reference** for 23 rows, all 180 finite side/quantity/price/maximum combinations with the code-0..7 histogram `[2,24,12,6,60,48,16,12]`, and corruption/duplicate/missing-case denials. These protect the shared contract while production compiler support remains incomplete.

Required production parity from the Java/GraalVM/finance contract:
1. Source admission for typed `float` (binary64) arithmetic, arrays, named module imports, `Result<T,E>`, `Option<T>`, computation and nonfinite guards **without implicit conversions, unsafe fast-math, or hidden fallbacks**.
2. Compile/execute finance's 11 `.ores` guest fixtures and return 182 byte-exact boolean outcomes, with no unreviewed source translation. Maintain a distinct per-backend source/tree/compiler/runtime identity and real nonzero-step execution receipts.
3. Implement `Region<T>` checked physical lengths, privilege/effect checking and deterministic compute kernel lowering. Verify all 23 risk decisions in an **actual compiled Region guest**, not host arithmetic.
4. Reject unsupported features at compiler admission, with no output artifact. Native actor authorization separately requires unique transfers and **zero venue calls for every denied risk decision**.
5. Provide independent approval, actual runner admission, compiler binary/toolchain SHA, guest receipt stdout/stderr checksums, negative tests and native ABI/hardware evidence before promotion.

**Current feature gap:** LLVM's scalar source frontend lacks fully supported finance binary64/Region guest execution; Wasm delegates source compilation to LLVM and explicitly records `binary64_ordering: unsupported_explicit`; .NET's shipping scalar source frontend rejects finance float/Region syntax, and managed host oracle tests are not NativeAOT executions. Java's finance guest tests are also authored but unverified. Parity is an implementation goal, **not achieved** by these host gates.

Never classify `steps=[]` or `runner_id=0` as a passing test or source defect. Do not transfer private source to another organization without separate authorization.
