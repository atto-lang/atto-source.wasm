# core/types v1 — WebAssembly

This backend owns its own `core/types.atto`; it imports no other backend's standard library source.

`int` is signed i64. The module supplies logical scalar value widths, signed 64-bit extrema, and `fits_i8/i16/i32/i64/u8/u16/u32/u64(int)` range checks. These predicates do **not** create narrowed values, prove sized integer compiler enforcement, reveal object/ABI layouts, or perform allocations/host reflection. `fits_u64` only admits nonnegative signed-int inputs.

`void` is a valueless return marker, not an inhabited `Unit`. A future `Unit` singleton, opaque compiler-minted `TypeId`, and static `TypeInfo<T>` metadata require separately verified backend compiler support; user strings/numbers must not substitute for nominal identity.

Conformance target: compile and execute `tests/fixtures/core-types-v1/edge-positive.atto` linked to this source (exit 0); compiler-reject `void-value-negative.atto` with no artifact. Record exact-head, target/toolchain, actual runner steps and failures. **NOT_EXECUTED**: no compiler/guest evidence has been established for this PR. Do not infer AOT or cross-compiler parity from staged source or source-free checks.

## Namespace-only core source

Canonical `use namespace types;` file header plus public top-level functions; no `define module` wrapper. Consumers still explicitly import the symbols. Compiler parse, namespace source identity, static imports, and executed linked guests require separate proofs. Until the current PR compiles and runs, namespace guest parity remains NOT_EXECUTED.
