# UDP audit / test admission — 2026-11-22

## Verified local execution (separate from source Actions)

Every claim below explicitly names what was executed. **No imported `std.net.udp` Atto guest was compiled or run.** No full compiler or AOT parity is claimed.

- **LLVM Linux host-only C11:** copied exact GitHub blobs and checked `git hash-object` against header `5122cad485e9774aafdbdd8721fedd62bc53d99d`, source `264f871b7e26880464ce921d03d17f3a8c9eb0c3`, test `3a0cab57c9c54d5a7400d81862b33e2cf09c5764`. GCC and Clang both compiled with `-Wall -Wextra -Wconversion -Werror -pedantic -UNDEBUG -pthread` and ran the **real loopback** test successfully. GCC ASan+UBSan also ran successfully with leak detection enabled. Cases include empty datagrams, deny/revoke, truncation, no unauthorized buffer publication, and concurrent-destruction gate. This is host-only, not Atto guest code or actor physical retirement.
- **Java JDK 21 host-only:** copied exact `UdpDatagramKernel.java` blob `edd67eee2bf6835dc3f7501d93e61cdce2de2363` (hash checked) and compiled it with a separate local socket smoke fixture using `javac`. Actual IPv4 loopback send/receive, zero datagrams, truncation, recovery, local NET revocation and idempotent close passed. **Not** a full Java 25/Truffle/JUnit/Native Image result; the local standalone fixture is separate from the compiler.
- **JS Node 22 host-only:** exact blobs: `src/host-udp-node.mjs` `740948817a50d81ebe309b60f56ed72e6709351b`, `src/udp-byte-snapshot.node.mjs` `0d8c5db9201e4db8df8cda9b99f2bdce6e335822`, `tests/udp-host-node.test.mjs` `7f59816c946e3af6cf4c2ec7ede5bdc2c9bf93f2`. `node --test tests/udp-host-node.test.mjs` on physical loopback: **8/8 passing**.
- **Wasm Node-host mode only:** exact blobs: `src/host-udp-node.mjs` `0f4a3caf7dadc823c298747883fc08e9ead4ab27`, `src/snapshot-guest-bytes.mjs` `3d0a1ef533eead5e13cfff8212bcc5b083745691`, `tests/udp-host-node.test.mjs` `7f59816c946e3af6cf4c2ec7ede5bdc2c9bf93f2`. Physical Node socket loopback: **8/8 passing**. Browser raw UDP is **unsupported**.
- **Stateful Atto source-model only:** exact common blobs `stdlib/net/udp_stream_budget.atto` `2745b16a91adc1c842c0bb2cb6279b711235639e`, `tests/fixtures/udp-stream-budget-main.atto` `f9f8350c56ab665faede9ad2a0ac064906db2478`, and `tests/udp-stream-budget-source-model.test.mjs` `0793fd897858460206aef8bb5353f5bd189f95f0`. Node 22 **3/3 source-model suites passed**: 29 fixture decisions, 512 × 32 deterministic queue state operations, and a negative mutation gate. This translator is **NOT** an Atto parser or guest runtime.
- **Pure Atto policy source-model only:** two 41-case fixtures per backend and 2,048 × 5 BigInt oracle comparisons per backend were previously validated; no compiler/guest/AOT status implied. The pure-policy code is independent of hardware support.

## Hardening changes

1. Node queued packets now re-check source-port permission at dequeue (revocation after queue admission previously escaped), zeroize host queue buffer on handoff/error, and re-check permission when obtaining the bound port. New physical tests cover this race and unauthorized destination checks before inspecting guest buffers.
2. LLVM `atto_udp_loopback_destroy()` now returns a retryable `-EAGAIN` for an active operation instead of freeing a held mutex. Physical C test proves the race. Host lifecycle must still fence new entrants and await all active operations before freeing the object.
3. Java kernel re-checks local NET permission on local-port introspection.
4. Stateful budget `.atto` code replaces unverified syntax (`if ...; do`, `pub constructor`, `rt fail`) with accepted-looking class/if/constructor forms and fail-closed capacity validation; 29 stateful fixture cases have a runnable source model, **but real compiler parsing remains unverified**.
5. Every backend retains independent `.atto` source ownership; source-model parity does not force an imported canonical implementation.

## Alternate private GitHub Actions carrier

The operator authorized token-free private exact-tree mirroring into an alternate org **only if actual Actions capacity is demonstrated**. Source-org CI has failed or queued before executing steps. Checked private carrier `voxletra/voxletra-e2e` latest capacity admission run `44956207320`: **zero steps**. Created a **source-free**, private `agent-pontifex/agent-pontifex-docs` runner canary on `ci/atto-udp-capacity-probe-20261122`, run `45047659405`: **zero steps**. Recent `atto-poc/atto-nats-clone.atto` carrier run `44926712773` also had **zero steps**. Therefore no carrier is currently validated for this job. **No private Atto source/tree was exported or mirrored.** The canary is source-free.

## Remaining mandatory gates

- Compile and typecheck real Atto `.atto` library and negative fixtures on exact backend heads, including both stateful class code and imports.
- Connect `std.net.udp` to native capability/handle ownership and physical actor retirement; test cancel, close, truncation and backpressure under stress.
- Verify .NET native host test and native AOT on a real .NET toolchain, Java JDK 25 + Truffle, native LLVM AOT, and Wasm guest runtime separately.
- Re-test the **whole exact PR head/tree**, not only verified individual Git blobs, on a carrier with real runner jobs and nonzero steps.
- Keep PRs Draft and do not promote from a source-only, host-only or zero-step result.
