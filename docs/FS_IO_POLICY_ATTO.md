# Native Atto std.fs byte I/O policy — candidate

This backend owns `stdlib/std/fs_io_policy.atto` independently. It is not linked from a shared common-source package and may evolve differently from other backends while preserving the proposed public `std.fs` semantics.

The four `fs_io_*` functions implement a pure bounded chunk-size choice, confirmed partial-write progress checks, read completion bounds (including EOF) and overflow-safe append budget preflight. The companion `fixtures/fs/fs_io_policy_main.atto` has 31 expected-exit-42 checks.

Wasm/Browser files require explicit tenant virtual or mounted FS; this file never accesses host disk or wires the pending VFS adapter.

**Capability boundary:** none of these functions grants FS_READ/FS_WRITE, validates a path, resolves a symlink, opens a descriptor, schedules async completion or proves that a write occurred. The host must deny before side effects, confine to tenant/actor roots, recheck budgets without TOCTOU, cap chunks, verify completion identity and close/cancel safely. No synchronous guest-carrier blocking.

**Status:** source-candidate / guest NOT_EXECUTED. Even successful host-only or static source tests do not make `import * as fs from "std.fs";` resolvable. Do not enable `fs.read_text` or `fs.write_text` until the typed async host ABI, built-in module linking, real compiled guest and negative permission/path/cancel tests pass.

Normative contract proposal: [atto-spec #117](https://github.com/atto-lang/atto-spec/pull/117); host ABI proposal: [atto-common-source #29](https://github.com/atto-lang/atto-common-source/pull/29).

## Import selector

The canonical built-in import is `import * as fs from "std.fs";`, **without** `pkg`. The compiler must select its own registered std.fs implementation; it may not reinterpret the name as a project file or third-party package, nor grant filesystem capabilities merely because a module imports it. Relative source files still use `"./path.atto"` and external dependencies use explicit `pkg`. This is a proposed resolver contract: the present source candidate and 31-vector fixture do not prove built-in import linking or physical I/O.
