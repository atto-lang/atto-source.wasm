<!-- org-merge-review-policy:begin -->
> **Agent/PR governance:** Read [atto-lang's canonical AGENTS.md](https://github.com/atto-lang/.github/blob/main/AGENTS.md). **Drafts:** at 72h of the CURRENT Draft cycle (creation if opened Draft, otherwise latest genuine Ready→Draft), automatically mark Ready if material CI passes on the exact current head and no `keep-as-draft`, `not-ready`, or legacy `keep-draft` label exists; recheck labels and CI before promotion. **The Ready review clock starts at zero upon promotion.** Ready age <72h: Codex/ChatGPT + Claude/Opus + `ORESoftware` + `the1mills` approvals. Ready age 72–240h: one verified independent approval, green CI, no conflicts, and a **mandatory competing/overlapping PR audit**; update current/competing PRs before merging when needed. Ready age ≥240h: fresh post-boundary reviews from all four. A genuine return to Draft ends/resets the Ready cycle. Respect GitHub protections, never manipulate draft state to game age, and inspect [legacy Oreslang counterpart PRs](https://github.com/ores-truffle-oreslang/.github/blob/main/governance/atto-migration-map.json) before duplicating features.
<!-- org-merge-review-policy:end -->

<!-- org-zero-step-ci-recovery:begin -->
> **MANDATORY ZERO-STEP CI RECOVERY (every PR and agent run):** Failed/cancelled Actions with zero actual steps, `steps=null`/`[]`, or no runner admission are **NOT_EXECUTED**, not compiler failures or passes. If the source org is out of Actions minutes, immediately look for a **different org with an authorized private carrier and available Actions capacity**; prove capacity using a source-free, stepful run. Private source **cannot** be checked out by the carrier's cross-org `GITHUB_TOKEN`: never provide PATs/tokens or secrets. **Only after authenticated independent authorization of exact source head/tree and destination owner/repo ID, readers, retention, and effective source export guard**, copy the Git tree through the GitHub connector to a temporary branch within that private carrier. Verify **every blob SHA, path, mode and complete root tree SHA** before stepful tests; carrier uses its **own local token and minutes**. **Explicit export DENIED/unapproved overrides this workflow: NO MIRROR, escalate.** Record source/carrier SHA, actual runner steps/results, and remaining `NOT_VERIFIED` coverage; never bypass reviews, protected main, or source policy. See [canonical mandatory zero-step runbook](https://github.com/atto-lang/.github/blob/main/governance/ci-zero-step-recovery.md).
<!-- org-zero-step-ci-recovery:end -->

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
