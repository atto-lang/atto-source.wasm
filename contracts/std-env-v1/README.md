# std/env v1 — Wasm32/Workers

This repository independently owns `stdlib/env.atto`. The source candidate deliberately uses native AttoLang declarations and is **not runtime parity evidence**.

## API contract

`get(name): Option<String>`; `has(name): bool`; `get_or(name, fallback): String`; `get_required(name): Result<String,String>`; `get_nonempty(name): Option<String>`; `get_required_nonempty(name): Result<String,String>`; `parse_bool(raw): Result<bool,String>`; `get_bool(name): Result<bool,String>`; `get_bool_or(name, fallback): Result<bool,String>`.

Absent and empty are distinct for `get` and `get_or`. Only explicit nonempty helpers treat an empty value as absent. Boolean grammar is exactly `true`, `false`, `1`, `0`; malformed values are errors even if a fallback exists. Errors must not embed key *values* or secrets. `get_required` makes absence a Result error; denied access is never converted to None or a fallback. No mutation, enumeration, or ambient environment access.

## Backend admission blocker

Browser and worker guests must receive a filtered immutable host-supplied environment map. Never implicitly map Node process.env, browser globals or worker options to guest permissions.

A trusted host interface must validate key names, check both coarse isolate ENV capability and scoped grants including explicit denies **before** reading any key, bound memory/UTF-8 inputs, and use deterministic error conversion. Host-only emulation is not .atto execution. AOT/native runs must prove import binding, guest results, denial-before-read, no unauthorized effect or secret exfiltration, and target-specific UTF-8/OS casing behavior.

## Tests

- `pure_bool.atto`: target exit 42 after actual compiler import/link/run; it makes no environment call.
- `denied_fallback.atto`: with an explicit denial of `ATTO_ENV_SECRET_KEY`, the guest must fail before returning any value, including `fallback`.

**Evidence: NOT_EXECUTED.** Fixtures are source-level contract targets until exact-head compiler-backed material CI runs. Never represent these files as implemented host access or full parity.

## Host-side preflight adapter (added in this draft)

`src/std-env-host.mjs` provides `create_scoped_env_host`, accepting **trusted** explicitly supplied snapshot values and scoped allow/deny rules; it rejects invalid keys, bounds entry/value sizes, and checks grants before lookup. This is deliberately **not** exported to untrusted guest code and does not call `process.env`. `tests/std-env-host.test.mjs` exercises deny-overrides-allow, absence versus empty, snapshot copy, invalid inputs, and denial-before-reading restricted getters. These are **host-model tests only**, and remain NOT_EXECUTED until a stepful test run occurs. Native guest import resolution, compiler binding, ABI and AOT evidence remain pending.
