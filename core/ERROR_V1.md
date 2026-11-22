# core/error source library candidate — atto-source.wasm

Version: 1, 2026-11-22.

This compiler **owns** `core/error.atto`; it does not import shared
canonical source bytes from another compiler repository. It matches the
candidate 99-class `std/error` catalog (Java PR #662), including its
stable codes and five advisory retry values.

Public functions:
- `is_known_core_code(code)`
- `code_group(code) -> Option<int>`
- `is_bounds_code(code)`
- `is_retry_advisory_code(code)`
- `is_actor_api_code(code)`
- `valid_message_length(bytes,maximum)`

Import intent: `core/error` and `atto.core/error`; native source import
resolution MUST be verified independently for this backend.

**Security boundary:** numeric codes are untrusted diagnostic values, NOT
proof of nominal Error ancestry or authorization to catch, throw, panic,
raise, access actor CONTROL, or retry. The predicates never turn an integer
into an Error. This module does not define or replace the compiler-owned
Error root, allocators, cause graphs or trace capture.

The `core/tests/error_v1_smoke.atto` file is an unadmitted guest-execution
fixture, not a passing test. Run real compiler import+typecheck and AOT/JIT
guest-execution tests on the exact PR head; fail closed when Option,
module linking, or Error lowering is unsupported. Coordinate with this
compiler's sibling slice/iter/cmp PR and atto-source.java#1768,
atto-source.llvm#867. No code-identity parity claim is made.
