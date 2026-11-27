# Native Atto std.fs path-policy slice

Compiler-local implementation in `stdlib/std/fs_path_policy.atto`.
The functions are ordinary Atto `.atto` source, not Java/.NET/LLVM/Wasm guest shims.

## Contract

- `fs_path_admissible(path, max_scalars, allow_root)` checks a strict canonical **logical path** spelling, rejecting empty/absolute/backslash/drive-colon paths, dot and parent components, duplicate/trailing slashes, Windows-special characters and trailing dots/spaces.
- `fs_path_mutation_target_valid` denies mutation of the logical tenant root `"." `.
- `fs_path_component_count`, `fs_path_leaf_start` and `fs_path_extension_start` expose pure lexical information, with `-1` on invalid/no-value. Offsets count Unicode scalars, not UTF-8 bytes.
- `fixtures/fs/fs_path_policy_main.atto` contains 48 positive and negative branch checks, success exit 42. This source-only fixture does **not** compile the implementation without compiler source/link integration.

## Security and implementation limits

This is **not yet** the full `std.fs` module, built-in resolver, or functioning file/directory I/O. A valid pure predicate is **never authorization**. No filesystem permissions or host callbacks are installed by this change. The host still must bound raw UTF-8 bytes before decoding/allocating, anchor resolution to a tenant root using descriptor-relative operations, reject symlinks/mount crossing and platform aliases (including device names), check grants and tickets before each side effect, and maintain async cancel/revocation/cleanup semantics. The portable predicate intentionally rejects some lexically normalizable paths; it does not implement `normalize`. Actual `Path`, `PathBuf`, `File`, `FileStream`, `OpenOptions`, metadata, directory and read/write APIs remain integration work under atto-spec #117 and atto-common-source #29.

**Guest execution status: NOT_EXECUTED.** Neither review of these sources nor host-only tests proves Atto compiled guest behavior, native AOT or real filesystem access. Keep the PR draft until exact-head compiled guest and negative host-boundary tests have executed. Do not mirror private source to another organization without a currently approved export destination.
