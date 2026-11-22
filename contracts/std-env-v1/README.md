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

## Controlled positive guest fixture

`positive_get.atto` requires a deterministic trusted host injection of `ATTO_ENV_EMPTY=""` and `ATTO_ENV_FLAG="true"`, with `ATTO_ENV_ABSENT` explicitly unset. Grant only scoped `ATTO_ENV_*` keys and explicitly deny `ATTO_ENV_SECRET_KEY`. The target is exit code 42, checking present-empty versus missing, nonempty filtering, required-key errors, strict boolean parsing and fallback. Do not use ambient process environment to synthesize a passing result; the compiler must execute the actual .atto guest. **NOT_EXECUTED.**

## Hardening update (2026-11-22)

`create_scoped_env_host` now accepts an independent **authenticated host-supplied** `environmentCapability` flag (default false). A scoped allow rule cannot elevate a missing coarse isolate grant. `revoke()` retires access and clears the retained copy; the owning host must call it on actor/isolate teardown. Neither flag nor the returned host object may become an untrusted guest-controlled options bag. No guest bridge is implied.

**Exact-blob local host-model evidence (Node.js 22.16.0):** `src/std-env-host.mjs` SHA `b3fedb17d2d0ac17c715f6193951a0245096c4d7` and `tests/std-env-host.test.mjs` SHA `5180631e876bf79364d418922f574eb27a09a8e1`; verified with `git hash-object`; `node --test tests/std-env-host.test.mjs`: **6/6 PASS**. This local host-model evidence is *not* compiler-backed guest/NativeAOT parity or source-org CI admission.

## New narrow intrinsic dispatch v1

- `src/std-env-guest-dispatch-v1.mjs` stages the host-owned `env.get` / `env.has` operation boundary. It accepts only a two-field, structured-clone/JSON-like request `{operation: "get"|"has", name: "<ASCII key>"}`; arbitrary access, host policy or values supplied in the request are forbidden.
- Replies are bounded, deterministic tagged data: `{tag:"some",value:string}`, `{tag:"none"}`, `{tag:"bool",value:bool}`, or sanitized `{tag:"error",code:"ENV_*"}`. The compiler must map replies into native guest `Option<String>` / `bool` and propagate denied/invalid operations as errors. The dispatcher itself **does not mint guest Option/Result objects**.
- `is_scoped_env_host` uses a private WeakSet brand: only real snapshots created by the trusted host can be used with this dispatcher. Revocation remains host-owned; no `revoke` guest opcode.
- Only portable ASCII keys are admitted; snapshot values must be well-formed UTF-8 and at most 16384 bytes, with embedded NUL rejected. Existing allow/deny rules plus a separate coarse ENV capability are mandatory.
- `tests/std-env-guest-dispatch-v1.test.mjs` covers no arbitrary opcodes, forged hosts, invalid key, getter payload, secret-safe denial, empty-vs-absent, revocation.

**Local exact-source evidence:** The two new dispatch files plus the updated `std-env-host.mjs` and host test files have verified Git blob identity. `node --test tests/std-env-host.test.mjs tests/std-env-guest-dispatch-v1.test.mjs`: **11/11 PASS** on Node v22.16.0. This is a *host-wire and admission* result, **not** guest compilation, actor sandbox or browser Wasm guest execution. Upstream runner admission remains unverified.
