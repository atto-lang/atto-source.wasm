# ByteBuffer guest: bounded experimental Wasm profile

**Status: real Atto surface syntax compiled into executable Wasm; NOT canonical standard-library linking, typed-error conformance, or TenantVM isolation.**

## What runs

The experimental src/byte-buffer-guest-v1.mjs parser validates a deliberately restricted .atto source profile and emits a deterministic standalone WebAssembly module. It uses Wasm i32.load8_u and i32.store8 instructions and a fixed, zero-initialized 64-KiB memory; it has no host imports, no memory.grow and no host byte-buffer calls. The memory export exists for test introspection. A separate Wasm instance receives separate backing memory; its host still controls its execution.

Run the exact-source guest tests:

    npm run test:byte-buffer-guest-v1
    node --test tests/byte-buffer-guest-v1-real.test.mjs

The 11 positive fixtures under tests/fixtures/byte-buffer-v1 were copied byte-for-byte from atto-platform-conformance PR #104; tests require their exact original Git blob SHA before they compile. All 11 execute and return 1 as real WebAssembly guests. BB-001 returns 1n and produces physical bytes 78 56 34 12 00 00 00 00. The test additionally compiles and executes 256 varied positive Wasm guests and checks private memory per instance.

First local execution: Node.js 22.16.0, five out of five test groups passed. The executed compiler source had Git blob e6388fcbeb2cc346dbd6a84f59b7e4ab6b4a8dc4 and the executed test source had Git blob b3b61375ec1190f44ab42cbd0a686642adb1a00d, each matching the committed GitHub file. This is local compiled guest execution, not a source-org Actions run.

## Deliberate scope restrictions

- Source grammar: one package import of std.buffer under the older import module compatibility spelling; one public main function; one bounded val/let (optionally mut) byte buffer; straight-line u8/u16/u32 little/big endian reads or writes, immutable scalar locals, and a scalar return or comparison/conditional.
- Allocation size and all read/write offsets and values are constants. Logical length is 0 through 4096 bytes. Unrecognized code is rejected before Wasm emission. Duplicate locals, immutable writes, integer overflows, invalid byte ranges, invalid widths, unauthorized imports and host API calls fail closed.
- Compile-time invalid constant offsets/values are rejected with deterministic diagnostics and **no guest artifact**. The normative contract instead requires ordinary typed runtime BufferError objects. No negative BB-006..BB-022 error case is certified by this profile.
- The canonical standard-library implementation at atto-common-source PR #30 is **not parsed or linked**. The import is a narrow surface recognized only by this experimental compiler. Do not claim this proves standard-library M1 or production package resolution.
- Independent Wasm memory does not prove safe cross-tenant execution. Aggregate TenantVM quotas, actor ownership, handle generation, pointer denial, borrow-checked views, cancellation and safe reuse still require separate compiler/runtime enforcement.

## Next steps

1. Integrate the canonical std.buffer package/module resolver with an authenticated library source and sealed OwnedBytes ABI; prove that the class body actually compiles and links or that a formally verified intrinsic specialization preserves its semantics.
2. Implement dynamic offsets/values with normal guest typed BufferError flow; require the shared positive AND negative test suite, including failed-write atomicity.
3. Enforce real tenant/actor quota and lifetime authority, not just per-instance Wasm memory.
4. Obtain a stepful, exact-head CI guest receipt from an authorized runner; zero-step Actions failures do not qualify. Keep PR Draft and the full cross-backend parity matrix unverified.

Source-only or host-only checks cannot substitute for a real compiled guest; equally, this bounded compiled guest cannot substitute for the canonical library or security proof.
