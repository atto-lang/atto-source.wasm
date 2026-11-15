# Strict platform-core-v1 native LLVM → wasm32 source-guest parity gate

The same 12 scalar fixture files and `manifest.json` are Git-blob-identical in
`oreslang-source.java`, `oreslang-source.llvm`, and `oreslang-source.wasm`.
The Rust Cranelift source compiler now has a **draft** candidate import of
these same fixtures in Rust PR #70. These files are **candidate language
contracts**, not claims that all compilers run them.

The new `tests/platform-core-v1-source-guest.test.mjs` validates all 12
canonical Git blob fingerprints and the manifest even without a native LLVM
compiler. In default `npm test`, real guest tests are marked **SKIP** if
strict mode was not requested; a skipped test is **not** parity evidence.

## Required executed gate (on an authorized source-local runner)

```sh
export ORESLANG_LLVM_COMPILER=/absolute/path/to/reviewed/oreslang-llvmc
export ORESLANG_LLVM_COMPILER_SHA256=<reviewed-lowercase-64-hex-hash>
npm run test:platform-core-v1-guest
```

The strict `ORESLANG_PLATFORM_CORE_V1_REQUIRED=1` gate requires the compiler,
verifies its actual binary SHA-256, compiles **unmodified canonical Oreslang
source bytes**, uses the Wasm bridge's checked compiler snapshot and target
admission, requires zero host imports and an exported `main: () -> i64`,
then observes all seven full-width i64 results via an actual Wasm guest.
Four negatives must fail compilation without publishing a module; the fifth
(`reject-overflow.ores`) must compile then trap without a wrapped result.
The exact negative error classification and stage should be corroborated
against Java/LLVM/Rust backend logs; an incidental compiler crash is NOT
equivalent to an intentional source diagnostic.

The strict test will **fail**, rather than skip, if the LLVM compiler path or
reviewed SHA-256 pin is missing. Running the test against a different LLVM
binary, a stub, a fake Wasm file, or only the host test is not parity.

## Platform and broader language limits

This standalone bridge is still a deliberately narrow, zero-import core
Wasm host. It cannot support the mobile/iOS/JNI handoff API, desktop event
loop, IoT network-stream capability, Cortex-M IRQ bridge, FPGA/ASIC
synthesis, native actors, protected state, zero-copy ownership, Task/select,
supervisor CONTROL, async I/O, or external host imports solely from this
scalar test. Each needs a target ABI, permission/ownership admission, real
guest source integration and target-specific execution evidence.

Compiler matching means Java and LLVM must also compile, execute, and
diagnose the *same exact sources* on their own backends. Identical fixture
Git trees or Java-led design descriptions are insufficient.

No unapproved cross-organization private-source mirror is permitted while
the P0 conformance source-transfer incidents #22 and #77 remain open.
Keep this draft pending exact-head source-local CI execution, protected
private main and genuinely independent reviewer approval.
