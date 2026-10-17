# Oreslang scoped host-permission parity contract v1

**Status: normative target, NOT a five-backend parity certification.** The experimental LLVM, .NET, WASM, and Forge backends currently support narrower scalar or zero-host-import slices. They must reject unsupported host-I/O operations rather than silently grant capabilities. Java/GraalVM scoped permissions remain on draft PR #1034 and require native execution evidence.

## Boundaries and invariants

1. Standalone CLI execution starts with no ambient `read`, `write`, `net`, `env`, `run`, `sys`, `ffi`, or `import` grants. Trusted embedders may carry explicit compatibility authority, **never** silently inherited by an ordinary CLI.
2. Host-provided **coarse capability** is an immutable ceiling. Scoped grants can only attenuate it; deny wins over allow, including wildcard grants.
3. Rules are checked at the **actual host I/O boundary**, not merely at parsing, syntax validation, module loading, or compile-time permission-check mode. Static and deferred checking must agree on runtime denial.
4. `net` requires a canonical and validated host/port. Normalize DNS case/trailing final dot and numeric ports; compare IPv6 address identities; reject ambiguous IPv4 aliases, malformed ports, credentials, implicit URL syntax, and unbracketed IPv6. Portless target cannot evade a same-host port-specific deny. Direct programmatic network allow/deny scopes reject surrounding whitespace rather than silently changing the authorized endpoint; CLI comma-separated list delimiters may be trimmed explicitly before validating each scope. Network hostname authorization alone does **not** authorize an unexpected DNS-resolved IP; resolved-address/connect-time checks remain required.
5. File scopes must preserve actual filename whitespace, segment boundaries, and path identity. Normalizing an ancestor is not a substitute for defending against symlink changes at the file-open boundary. A concrete host read/write/append adapter MUST NOT follow a final path component that was changed to a symlink after permission admission (e.g. open with NOFOLLOW_LINKS), and MUST test actual file opens against swapped links. This only narrows the terminal-entry race: parent-directory replacement still requires descriptor-relative, directory-handle-safe operations. Every platform must use its own safe handle/path strategy; unsupported host filesystem I/O MUST deny rather than simulate success.
6. `env`, `run`, and `sys` token identity is literal, not whitespace-trimmed or case-folded by default. `run` grants do not imply shell, subprocess, or FFI escape hatches.
7. Serialized guest policy must carry an unambiguous explicit-deny/default marker, preserve empty sets, reject duplicates/truncation, and never widen the coarse capability set. Treat malformed/unrecognized policy arguments as invalid.
8. Guest-facing host escape hatches require distinct audited authority: Java reflection/class access, .NET reflection/PInvoke, LLVM/native FFI and child-process syscalls, WASM/WASI imports, Forge native code paths. In experimental scalar backends, **deny unsupported capability requests**, never report them as executed allows.
9. The standalone CLI must use the project's approved `flags-2-env` flag parsing contract where integrated; no independent ad hoc parser should be considered permission parity.
10. An unsupported implementation slice MUST fail closed; it cannot report `allow` based on a mock evaluator or a contract-only test.

## Network port canonicality

All backends that parse scoped network endpoints MUST reject malformed or
unrepresentable numeric port spellings before arithmetic: use **1–5 ASCII
decimal digits** representing an integer from **1 through 65535**. In
particular, `4294967739` (2^32 + 443) MUST NOT wrap around and authorize
port 443; a valid spelling such as `0443` may canonicalize to port 443.
Apply this check to both permission rules and requested/selected endpoints,
including bracketed IPv6 syntax. Trusted socket adapters must independently
enforce port bounds before constructing an OS socket address. A backend
without scoped network guest I/O (currently WASM) must continue to deny
unsupported network authority; host-only tests are not runtime parity proof.

## Selected TCP peer identity

An unspecified IPv4 address (`0.0.0.0`) is a **bind** sentinel, not a safe
outbound peer identity. All trusted host socket adapters MUST reject it as the
requested numeric destination or DNS-selected numeric address, even under an
explicit wildcard `net` grant. On some Linux systems an outbound connect to
`0.0.0.0` can reach `127.0.0.1`, circumventing a loopback-specific deny if
policy checking assumes the unspecified address is the actual peer. Check
this condition before socket creation; preserve valid canonical IPv4 peers.
Unsupported guest socket surfaces (notably WASM's current zero-import slice)
continue to deny network access rather than claim host-I/O parity.

## Dynamic HTTP listener ports

Java `http.listen(host, 0, ...)` requests an OS-assigned port. Port 0 is an API
sentinel, not a valid `net` permission-scope port. Before binding, the runtime
requires a port-independent grant for the requested host and checks the
resolved numeric IPv4 address. While port selection and DNS aliases cannot be
proved disjoint from every denied endpoint, **any configured NET denial**
prevents a port-zero listener, even if the denial appears unrelated.
The all-interfaces address `0.0.0.0` is not one selected IP and is rejected
for dynamic ports. A fixed-port-only grant does not authorize a dynamic-port listener.

Unsupported listener address families remain denied until implemented.

## Canonical test-vector integrity

The checked-in reference data is pinned to SHA-256
`de3594482d10623241a94cf531fd9e4fe71c49769dd68b2098f4ed5363870ac5`.
The CLI verifier checks the **exact file bytes** before validating the schema
or accepting a runtime report. A modified allow/deny expectation, even one
with syntactically valid JSON, must fail instead of silently changing the oracle.
Any deliberate v1 vector revision requires independent review and a matching
pin update **in all five backends**; do not replace expected results to make
an implementation's failing runtime test appear green.

This digest check does not authenticate the code producing runtime reports.
It must be combined with an independently reviewed backend adapter,
immutable source commit/tree checks, and actual runner-executed host I/O tests.

## Canonical vectors and evidence

`scoped-permissions-v1.json` contains **52** authorization/serialization outcomes (45 authorization, 7 deserialization). `verify_scoped_permissions.py` checks the corpus and requires complete, non-skipped, exact-head results for the selected backend.

Backend adapter output must use:
```json
{
  "schema": "oreslang.scoped-permissions.report.v1",
  "backend": "llvm",
  "source_commit": "<actual 40-digit Git commit>",
  "source_tree": "<actual 40-digit Git tree>",
  "execution": {"runner": "a real isolated build runner", "command": "production-backend command", "url": "https://github.com/.../actions/runs/..."},
  "results": [{"id": "default-read-denied", "decision": "deny", "executed": true}]
}
```

The results array must contain **every** test vector exactly once; every element must be generated by the production backend, not fixture lookup. A report formatter cannot substitute for actually executed guest code or actual host-operation denial. Pass the immutable source commit and tree as independent CLI arguments to prevent stale-report reuse.

**Report format is closed at v1:** the report itself has exactly `schema`,
`backend`, `source_commit`, `source_tree`, `execution`, and `results`;
`execution` has exactly `runner`, `command`, and `url`. Unreviewed fields
such as top-level or execution-level `status: pending`, `skipped`, or `error`
are invalid even when individual result decisions match. Each result object has **exactly** `id`,
`decision`, and Boolean `executed`. Additional keys such as `status`,
`pending`, `skipped`, `synthetic`, or `error` are rejected even if
`executed=true` and `decision` matches; otherwise contradictory evidence
could be counted as a pass. Change the report schema version in all five
backends before adding fields. Both the CLI and direct verifier API reject
malformed or nonimmutable source commit/tree arguments (lowercase 40-hex
Git identifiers only). These **shape checks are not proof of real execution**:
an independent runner, source-tree identity, production adapter and genuine
guest/host tests are still required.

Run:
```sh
python3 contracts/v1/verify_scoped_permissions.py --validate-only
python3 contracts/v1/verify_scoped_permissions.py --backend llvm --report /tmp/llvm-permissions.json --source-commit <git-sha> --source-tree <tree-sha>
```

The first command proves only corpus integrity. The second is a **report shape/completeness cross-check**, not cryptographic attestation of the runtime; retain checked-in adapters, CI job logs, and actual guest I/O fixtures to establish behavioral parity.

## Required negative gates before release

- Guest without explicit grant cannot read/write host files, connect to network, read environment, spawn child processes, access system information, load native libraries, or load external code, including via alternative host APIs.
- Invalid/duplicate rule serialization fails closed and does not mutate a live prior policy.
- Positive scoped grants allow only their declared resource; deliberate denial has precedence; atomic builder normalization leaves no partial authority.
- Host identity changes, symlink races, DNS rebinding, callback/executor/worker escape, and native-memory quota bypasses need dedicated backend-specific integration tests beyond this portable dataset.
- For WASM's current no-import core profile, unconditional host-import rejection is valid **zero-capability slice evidence**, not full scoped allow-list parity.
- CI claims require compiling/running each backend's real compiler/runtime and fail if a required test was skipped, no runner was assigned, or source SHA/tree was not pinned.

## Backend capability ledger (audited main/default, 2026-10-15)

| Backend | Known implemented slice | Scoped I/O v1 complete? |
| --- | --- | --- |
| Java/GraalVM | RuntimePermissions and CLI scope handling (candidate PR #1034) | **NO**: pending JDK25/GraalVM/Native Image CI and review |
| LLVM | Experimental scalar compiler and control-plane primitives | **NO**: native I/O boundary checks missing |
| .NET | Scalar NativeAOT host | **NO**: permission policy and I/O boundary missing |
| WASM | Strict no-import bounded core WASM guest | **NO**: scoped host imports unsupported |
| Forge | Arithmetic bootstrap and bounded mailbox | **NO**: permission policy and I/O boundary missing |

Until every backend produces an actual signed-off, exact-head runtime report on the same corpus and backend-specific escape tests, never describe v1 as runtime parity.
