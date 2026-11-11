# Exact CI run evidence: anti-spoofed labels and clean source tree

This is a **source-free GitHub job-execution evidence** control, not certification of AttoLang native guest results.

## Display-label admission
- Refuse leading/trailing whitespace in untrusted runner, job, and step labels.
- Refuse Unicode space separators other than ordinary internal ASCII spaces, plus all previously forbidden controls, bidi format controls, zero-width formatting, surrogates and line separators.
- Normalize repeated whitespace for comparisons with runner-generated housekeeping names. No spelling of `Set up job`, `Complete job`, or a `pre`/`post` step may count as meaningful test execution.
- Keep strict exact requirements for named jobs and steps, actual runner allocation, nonzero useful steps, exact run attempt, reviewed workflow blob and source tree.

## Checkout admission
- Require a pinned PR head and no staged/unstaged differences **or** untracked files **or** ignored untracked files, before producing source evidence.
- Run adversarial regression tests under isolated `python3 -I`, including a fresh temporary Git repository to prove both untracked and ignored shadow files are detected.
- `steps=[]` or missing runner allocation remains `NOT_EXECUTED`; even a successful source-free workflow remains **not native compiler/guest parity**.

Do not copy private compiler source to another organization without separately reviewed source-tree/destination authorization. Do not merge compiler feature changes on the strength of this source-free gate alone.
