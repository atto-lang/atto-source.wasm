# Name-first and type-first formal declarations: Wasm LLVM-delegated gate

**Status: authored target fixtures, no executed Wasm guest receipts.**

The wasm32 source bridge delegates AttoLang source compilation to an
externally supplied *pinned* native LLVM compiler; it does not have an
independent parameter parser and must not manufacture one. The target
contract pins the native LLVM draft head `e8b3d4331e3d9738ab95a34c635d2210ea9b00fe`
and exact byte SHA256 for seven `.atto` sources.

Three required scalar control cases use `int x`, `x: int` and a mixed
declaration. The strict opt-in test demands a real LLVM compiler with
binary SHA and source SHA, invokes the existing Wasm compilation bridge,
checks atomic-release provenance and invokes the isolated Wasm guest
(expected result 42). Four unsupported `x?: int`/`x: int?`/default
forms must fail with compiler-owned diagnostic and publish no Wasm bytes.

Run `npm run test:formal-orders` only when a reviewed compiler binary,
source head, and wasm32 Clang toolchain are available. Missing compiler
pins are hard failures under that strict entrypoint. Ordinary `npm test`
may skip **guest execution** but the skip must never count as a parity pass.
No optional/default ABI, native Option call ABI, or general five-backend
guest behavior is claimed. See shared language contract PR #51.
