<!-- org-merge-review-policy:begin -->
> **Mandatory agent policy:** Read [atto-lang/.github/AGENTS.md](https://github.com/atto-lang/.github/blob/main/AGENTS.md) before editing, reviewing, or merging. **0–72h:** Codex/ChatGPT + Claude/Opus + `ORESoftware` + `the1mills` reviews. **72h–<240h:** one verified independent human/AI approval permits merging with passing tests and no conflicts. **240h+:** fresh post-240h reviews from all four again. Every phase requires green verified CI, current-head evidence, no holds/critical risks, and compliance with GitHub rules. Merge eligible PRs immediately; never reset age or bypass protections. More restrictive local safety rules remain effective.
<!-- org-merge-review-policy:end -->

# AttoLang source-first implementation guidance

These instructions apply to this repository's code changes, examples, fixtures, and AI coding agents. They supplement, and never override, repository security rules or review requirements.

## Source placement

- New AttoLang guest source, standard-library algorithms, sample programs, and guest-language regression fixtures use **`.atto`**. The `.ores` suffix is for legacy compatibility or explicit migration tests only; do not create new `.ores` features.
- Implement portable guest-visible behavior in AttoLang wherever it is expressible. Add only the smallest necessary host/compiler primitive when the language cannot safely implement that behavior itself. Do not disguise host-language emulation as actual AttoLang guest execution.
- Keep functions and methods in `snake_case`. Preserve actor ownership, sealed state, capability boundaries, deterministic errors, and full-AOT compatibility.
- If a necessary host-language implementation remains, document why guest code is not yet possible, which capability it supplies, and how it can be replaced. Do not mass-rename host compiler/runtime files to `.atto`.

## Evidence and security

- Separate source-only fixtures, host-model tests, compiler parse/typecheck, executable guest tests, and native AOT evidence. A zero-step workflow, synthetic receipt, or host-only test means **NOT_EXECUTED** for guest parity.
- Record exact fixture/compiler Git blobs and source heads when making parity claims; do not mark another backend as passing without its own executed result.
- Do not copy private Git objects to another organization simply because its runner has capacity. Respect source-side authorization, independent security review, approved private destination, and protected-branch requirements.

## Wasm-specific responsibilities

- Write reusable language semantics in `.atto`; JavaScript/TypeScript should provide worker/isolate bridging, capability admission, host I/O and Wasm loading, not a shadow interpreter that impersonates guest execution.
- Verify generated wasm32 modules from an authenticated compiler and unchanged `.atto` fixtures; distinguish JS host simulations and source-only checks from exported guest-value assertions.
- Keep worker memory and message boundary ownership explicit; untrusted guest code cannot gain host capabilities through option bags or backing-store aliases.

## AOT / zero-GC controlled-dynamism review gate

Follow [organization policy PR #38](https://github.com/ores-truffle-oreslang/.github/pull/38), [language-spec amendment PR #18](https://github.com/ores-truffle-oreslang/attolang-language-spec.md/pull/18), and [local checklist](docs/AOT_ZERO_GC_DYNAMISM.md). These are proposed design requirements, not evidence of implementation. Every compiler/runtime PR must declare the AOT mode and GC scope; reject uncontrolled runtime dynamism in sealed guest AOT before IR; generate proxy/virtual dispatch metadata ahead of time; prove allocation/closure/actor/task ownership, cycle management, bounded queues, cancellation and exactly-once cleanup.

Require positive and negative compiler-backed `.atto` cases plus actual exact-head guest execution and target-artifact/GC proof. Tests that run only the host, simulate a guest, or show zero executed steps are **NOT_EXECUTED** for guest semantics. Preserve current source-first, security, Rust-only tooling and review rules.
