# `std/reflect` — closed-world AOT metadata (phase 1)

This local `.atto` implementation provides bounded descriptors and a sealed, owner-local metadata catalog; it does **not** perform host reflection, code generation, or automatic discovery of types. Use `import module reflect from "atto.std/reflect"`.

- Type kinds: 1 scalar, 2 enum, 3 struct, 4 class, 5 actor, 6 interface, 7 union, 8 opaque. IDs are **compiler/image-local**, not wire identifiers or a downcast authority.
- A `TypeInfo` may hold at most 128 emitted, externally visible fields; a `Catalog` holds at most 256 types. Duplicate field names and duplicate type names/IDs fail. Out-of-range reads return `""` or `0` (or `-1` for find methods). Builders must be sealed before registration; a sealed registry cannot accept further types.
- The compiler, not this library, decides what is reflectable and must exclude private members, actor sealed state, hidden fields, capabilities, raw offsets/pointers, and unregistered generics. Descriptors and caller-built catalogs are **informational values**, never proof that a runtime type or member exists or can be cast/invoked.
- Static AOT integration (follow-up): generate type and field descriptors from compiler-checked explicit opt-ins; root the finite catalog and any explicitly retained typed dispatch stubs in the linker; build exact-head positive and negative guest tests and inspect linked AOT artifacts for a zero-interpreter/JIT path. Unsupported dynamic reflection must be rejected before executable output.
- No reflective get/set, private member access, runtime method-by-name dispatch, arbitrary allocation of type instances, host class loading, FFI, dynamic evaluation, or runtime JIT is provided. Reflective invocation requires a separate compiler-generated capability-checked API.
- `tests/fixtures/std_reflect_aot_smoke.atto` is the positive source fixture. Its presence is not a claim that a backend has compiled or executed it.

See `atto-spec/spec/09-modules-and-aot.md` and `atto-spec/spec/24-aot-zero-gc-controlled-dynamism.md`. This is phase 1 of the standard library, not backend full guest AOT certification.
