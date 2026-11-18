# AttoLang scalar macro Wasm32 executable-parity gate

**Status: runnable gate authored; no stepful private LLVM-to-Wasm macro execution
certified.** Wasm uses the **production LLVM compiler** to lower `.atto`
macros, then the existing strict bridge checks the wasm32 IR target, invokes
Clang/lld, enforces memory/import/export policies, publishes content-addressed
Wasm and executes the guest in an isolated worker. There is no JavaScript
macro expander, transpiler or synthetic return-42 shortcut.

The 16 pinned `.atto` files in `tests/fixtures/macro-scalar-v1` have
byte-identical Git blob SHAs to the corresponding .NET PR #346 and
LLVM PR #1026 sources: seven positive guest-value-42 programs and nine
compiler-negative programs. LLVM stores two matching blobs under different
filenames: `dynamic-const-reject.atto` (Wasm `runtime-const-reject.atto`)
and `template-twice-unresolved-name-reject.atto` (Wasm
`template-twice-name-reject.atto`). LLVM also has an **extra** bound-main
rejection that is not shared with the .NET/Wasm scalar-entry subset.
Two extra negative cases verify unused invalid macro declarations and checked
unary signed-min overflow, rather than silently treating them as runtime calls.
Node's default `npm test` proves only this source integrity and explicitly
**SKIPS** native macro guest parity unless requested.

To demand **actual** Wasm32 execution, an independently authorized local
source-bound environment must supply:

- `ORESLANG_MACRO_WASM_PARITY_REQUIRED=1`
- `ORESLANG_MACRO_WASM_EXPECTED_HEAD=<exact committed Wasm SHA>`
- `ORESLANG_LLVM_SOURCE_SHA=b83f540269a256e549cc9160b6b43bf37d33fb0f`
- `ORESLANG_LLVM_SOURCE_TREE=26e85b258061b206e4a145825df6dfe11065a499`
- `ORESLANG_LLVM_SOURCE_ROOT=<absolute path to authorized exact local LLVM checkout>`
- `ORESLANG_LLVM_COMPILER=<absolute reviewed native compiler executable>`
- `ORESLANG_LLVM_COMPILER_SHA256=<sha256 actual executable bytes>`
- `CLANG=<absolute resolved clang/lld executable>`
- `ORESLANG_MACRO_WASM_CLANG_SHA256=<sha256 of actual clang executable>`
- `WASM_LD=<absolute reviewed wasm-ld executable>`
- `ORESLANG_MACRO_WASM_LLD_SHA256=<sha256 of actual wasm-ld executable>`

Then run `npm run test:macro-wasm32` with Node >=22 and a real wasm32
Clang/lld toolchain. The reviewer must independently verify that the exact
LLVM checkout built that compiler; environment-provided claims alone do not
establish source/compiler provenance. The strict lane now reads the local
LLVM Git HEAD/tree and checks tracked cleanliness before/after; it hashes the
reviewed Clang driver **and** the explicitly selected wasm-ld linker
executable before/after as well. Clang receives a literal
`-fuse-ld=<resolved absolute wasm-ld path>` argument, not an unpinned PATH
lookup. This still does not
substitute for an independently witnessed exact-checkout compiler build.
The native compiler and linker run from an isolated temporary working
directory with a constrained child environment: PATH and locale only on
POSIX (plus OS-required Windows process lookup fields), never inherited CI
tokens, cloud credentials, `NODE_OPTIONS`, `LD_PRELOAD` or similar hooks.
This is least-privilege process hygiene, **not** a malicious compiler sandbox. The suite rejects absent/mismatched
SHA pins, outputs native binary SHA receipts, checks seven guest values of
42n, nine typed compiler rejections, no artifacts on rejected sources, and
compares source heads and executable bytes before/after.

.NET and LLVM host exit/status conventions differ: .NET prints `42\n`
and exits 0; LLVM native host exits 42; Wasm exports `main() -> i64` and
the isolated runner returns `42n`. These are equivalent guest integer
values, not interchangeable transport/exit ABIs.

A source-free CLI or a zero-step Actions failure is **not** guest parity.
No private compiler source may be exported to another organization merely to
find available CI minutes. Keep backend promotion blocked until runner
admission, actual compilation, native linking/instantiation, independent
review and three-backend pinned-source evidence all exist.
