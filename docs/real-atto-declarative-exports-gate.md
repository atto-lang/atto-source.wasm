# Real AttoLang declarative-export verification (release gate)

This checks **real native `attoc` -> `.atto` compilation -> WebAssembly execution and metadata** against the Wasm host's `atto.exports.v1` decoder. It is not a replacement for the Forge CTest suite, LLVM Wasm32 compilation, browser-worker tests, or independently approved source CI.

## Preconditions

1. Build the independently reviewed `atto-lang/atto-source.rs` browser compiler from its exact approved source revision, in an authorized runner. Its [declarative exports PR #85](https://github.com/atto-lang/atto-source.rs/pull/85) defines the compatible subset. Record the source commit and root tree in the build receipt. A repository name or user-supplied revision string does **not** attest the binary's provenance.
2. Preserve the compiler executable in the **same authorized environment** (no cross-organization copying of private source without independent permission). Record its SHA-256 and pin that digest below.
3. Use Node.js 22 or later. Both paths must be absolute. Do not change the compiler after its digest is recorded.

```sh
cargo build --manifest-path /approved/atto-source.rs/Cargo.toml --locked --release --bin attoc
ATTOC_PATH=/approved/atto-source.rs/target/release/attoc
ATTOC_SHA256="$(sha256sum "$ATTOC_PATH" | cut -d' ' -f1)"
export ATTOC_PATH ATTOC_SHA256
npm run test:real-atto-exports
```

## Exact checks

The verifier reads, bounds, SHA-256 checks, and copies the compiler into an isolated temporary directory **before** executing it. The emitted artifact must be a genuine valid WebAssembly module with one `atto.exports.v1` section and the exact entries:

| Name | Kind | Language visibility |
|---|---|---|
| `Bar` | `class` | package |
| `Foo` | `class` | public |
| `calculate` | `fnc` | public |

It compiles identical declarations with exports before and after the definitions and requires **byte-identical artifacts**. It checks that `Bar` is absent from public exports; none of `Bar`, `Foo`, or `calculate` may appear on the *host* Wasm export surface. A real WebAssembly instance must execute `main(): i64` and return **42n**, with no host imports.

Finally, three independent source programs must fail through the native compiler's expected `E_UNBOUND`, `E_DUPLICATE`, and `E_EXPORT_KIND` diagnostics, with exit code 1, empty stdout, and **no generated Wasm artifact**. Missing compiler, incorrect SHA, crash, timeout, or malformed artifact is a hard failure. There is **no successful skip mode**.

`npm test` always runs `tests/real-atto-exports-runner.test.mjs`, which tests missing/untrusted compiler rejection locally; it does **not** falsely claim that a native compiler was executed. The real integration receipt comes only from the separate explicit `npm run test:real-atto-exports` command.

## Release/merge gate

The relevant PRs are [Rust compiler #85](https://github.com/atto-lang/atto-source.rs/pull/85), [Wasm host #486](https://github.com/ores-truffle-oreslang/oreslang-source.wasm/pull/486), and [Forge #278](https://github.com/ores-truffle-oreslang/oreslang-source.forge/pull/278).

- Attach source commit/tree, pinned compiler SHA-256, generated Wasm SHA-256, exact test command, and nonempty runner steps.
- Run full backend suites including GCC/Clang Forge CTest and Wasm `npm test`; the real-Atto verifier is additional evidence, not a substitute.
- Obtain independent security/CodeOwner reviews and satisfy protected-main checks before merging.
- Do not move any private source or compiler artifact to an unrelated organization until **that exact source snapshot and destination** are independently authorized.

**Current scope:** the Rust browser frontend supports file-level export metadata but not multi-file import enforcement. Forge stage-0 only supports function exports; unsupported nominal class/actor/enum exports must fail explicitly. An export metadata pass never proves complete backend/linker parity.
