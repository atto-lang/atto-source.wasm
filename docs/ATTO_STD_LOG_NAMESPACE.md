# `std/log` namespace — backend-owned native Atto source (wasm)

This implementation belongs to `atto-source.wasm`. It is independently maintained and may differ from other `atto-source.*` sources. No runtime module wrapper, canonical byte-identical library dependency, host-language logger, implicit console access or cross-actor mutable buffer is supplied.

## Implemented in `.atto`

`stdlib/log.atto` uses the flat file-root header `namespace log;`. The first milestone exports `valid_severity`, `valid_threshold`, `enabled`, `severity_name`, and `sink_byte_budget_ok`. The public ABI uses severity TRACE=10, DEBUG=20, INFO=30, WARN=40, ERROR=50, FATAL=60, and threshold-only OFF=70. Invalid levels and thresholds fail closed. The sink byte policy uses checked subtraction and returns a boolean preflight; actual byte sizes must already be authenticated by a trusted output boundary. Caller-controlled sizes do NOT grant capability.

## Remaining work

This backend does **not** yet have a certified `.atto` LogEntry, bounded actor-owned Buffer, single-consumer ACK, permission-checked async stderr/stdout/file sink, UTF-8 size authentication, cancellation/supervisor teardown, or exact guest/AOT execution. On browsers/unsupported targets, do not pretend that a native file/console writer exists. These pieces must follow independently for this backend.

`node --test tests/log_policy_contract.test.mjs` uses the fail-closed, no-eval `tests/atto_pure_subset.mjs` parser to interpret a tiny scalar source subset across a severity/threshold matrix and byte-boundary cases. The **6/6 local checks** cover both semantics and parser rejection of unsupported host syntax; they remain source-only. The check is explicitly **SOURCE-ONLY**, not this compiler compiling or executing `.atto`. The workflow pins an exact PR head. Require real nonempty runner steps for CI credit; `steps=[]`/no runner is NOT_EXECUTED. Do not export private sources across organizations without independently authenticated export authorization.

### Convergence target

Java/Graal is implementing a richer `namespace log;` record/Buffer surface at [atto-source.java#1784](https://github.com/atto-lang/atto-source.java/pull/1784). Match its public behavior when safe, but keep all native `.atto` code backend-local rather than importing a shared canonical implementation. Namespace files may aggregate into a package only after the compiler's namespace linking and manifest admission are proven.
