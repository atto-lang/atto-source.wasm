# std/metrics, std/json and std/zorde — wasm backend-owned stage

The source files at `stdlib/std/metrics.atto`, `stdlib/std/json.atto`,
and `stdlib/std/zorde.atto` are **candidate native AttoLang implementations**.
They are compiler-repository-owned and can diverge from Java or LLVM
implementation details. They were seeded from the same bounded Atto language
algorithms so their public semantics can be compared using the portable
contract. **No import registration or compilation pass is claimed.**

The reference suite in `contracts/std-metrics-json-zorde-source-v1.json`
provides source-free JSON signed-i64 edge cases, Zorde canonical unsigned
varuint31, ZigZag31, binary envelope examples, and inclusive metric
histogram examples. Run source-only checks with:

```sh
node --test tests/std-metrics-json-zorde-source-contract.test.mjs
```

This is **not** a compiler test. The focused workflow
`.github/workflows/std-metrics-json-zorde-source.yml` records the exact
source SHA/tree, but only when actual runner steps execute.

## wasm compiler integration required

The actual Atto source-to-Wasm compiler currently lives in atto-source.rs. Use authenticated compiler artifact to build the .atto guest into Wasm and execute in Node/browser workers. Never count this host repository as an independent second source compiler.

## Semantic boundaries

- Public API targets: Counter, Gauge, Histogram and detached snapshots;
  strict JSON Document parser/lossless re-emission with i32/i64 scalar helpers;
  Zorde checked Reader/Writer, canonical varuint31 and schema-bound frame
  and bool/ZigZag31 codecs.
- `std/zorde` is the public name, **not** `std/serde`. The ZORD framing
  envelope is provisional and is not the independent Zorde production
  schema/codec format.
- Do not bypass the canonical `alloc/json` PRs for recursive `JsonValue`,
  streaming JSON or typed decode, or duplicate independent Zorde
  schema/WIT/Protobuf/MessagePack/CBOR implementation.
- Fail closed on unsupported compiler grammar, typechecker/lowering paths,
  scheduler/ownership effects and AOT restrictions. Host-language reference
  tests are not evidence of guest execution.
- No Java/Graal/LLVM passing test, identical Git blob or source-only
  Node test can substitute for **this backend's** compiled guest receipt.
- Do not transfer any private Git tree to a separate organization without
  the independently authorized exact source head/tree, destination numeric
  repository ID, readers, retention and pinned test plan.

## Status

`SOURCE_STAGED`; `COMPILER_IMPORT=NOT_EXECUTED`;
`GUEST_EXECUTION=NOT_EXECUTED`; `NATIVE_AOT=NOT_EXECUTED`.

First requirement for claiming parity: run positive and negative actual
`.atto` guest fixtures, verify expected 127-observation Java baseline
and portable vectors under this backend's target profile, and publish
independently verifiable source/compiler SHAs plus nonzero runner steps.

## Candidate compiled guest harness (independent evidence still required)

The three backend-local guest programs are pinned at
`tests/fixtures/std-metrics-json-zorde/{metrics,json,zorde}.atto` and
`expected-stdout.json` records 127 exact stdout lines **and each file's
Git blob SHA**. A runner adapter that genuinely compiles and executes
one .atto file per invocation can be passed explicitly:

```sh
node scripts/verify-std-metrics-json-zorde-guest.mjs \
  /absolute/path/to/trusted-atto-guest-runner \
  <independently-verified-binary-sha256>
```

This script fails on a changed fixture, wrong runner SHA, timeout, nonzero
exit or stdout mismatch, and reports **candidate** output matching only.
It cannot independently attest that a custom adapter actually invoked
the canonical compiler; a trusted GitHub job verifier must cross-check
compiler identity, exact source/tree, non-setup step receipts and artifacts
before parity may be reported as `PASS`.
