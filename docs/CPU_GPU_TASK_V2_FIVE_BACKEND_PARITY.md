# CPU/GPU task v2 — five-toolchain contract parity

This Wasm-side draft aligns the shared \`cpu-gpu-task-unsupported-v2.json\`
fixture with the **same exact Git blob** already present at pinned Java,
LLVM, .NET, and Forge \`main\` commits (2026-11-11). The one mismatch
was the nested case ID:

- Before Wasm: \`gpu-cpu-gpu-v2-nested\`
- Canonical five-backend key: \`gpu-cpu-gpu-nested\`

The nested source snippet itself was identical. The source-local
\`check_cpu_gpu_task_v2_contract.py --self-test\` checks all ten keys,
exact Git blob identity, and several negative mutations.

This is **contract-data parity only**, not evidence of a Wasm-native
source frontend, implemented GPU lowering, scheduling, guest compilation,
or full-AOT execution. The v2 contract explicitly allows fail-closed
backends pending real positive guest support.

No private source transfer, cross-org checkout, token, or external
carrier is needed to execute this local workflow. Cross-backend main
parity is incomplete until this PR is merged; prior to merge the
reference manifest still shows Wasm divergence.
