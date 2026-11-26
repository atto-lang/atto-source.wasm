# Field lifetime guest integration v1

Run with an explicitly reviewed trusted compiler Wasm artifact, supplied SHA-256, the exact central conformance profile JSON from atto-platform-conformance #604 (blob 700b115960724cf09e598569d24ea5bfe217e96e), and its pinned source checkout. The 19 files must retain their Git blob identities. Use the snapshot-field compiler profile (#476), not #477 which intentionally extends mutable field projection support. Run with an external timeout in an isolated process. This proves the narrow scalar-field guest ABI only, not independent compiler, actor Worker isolation, or publication readiness. Existing trap harness ABI and print imports are reused; all output and input sizes are bounded. No network fetch or distribution performed by verifier.

`timeout 60s node scripts/verify-field-lifetime-wasm.mjs /path/compiler.wasm SHA256 /path/profile.json /path/source`
