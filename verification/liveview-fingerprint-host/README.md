# Oreslang LiveView replay fingerprint — cross-toolchain HOST proof

**Status:** test-only reference verification, not an Oreslang `.ores` guest execution or a WebSocket/LiveView server implementation. Do not use test output as a backend guest capability receipt.

This isolated harness checks canonical UTF-8 JSON-array envelope encoding and SHA-256 equality for the eight shared LiveView event-replay vectors. Source of truth is `contracts/v1/ores-liveview-event-fingerprint-v1.json`, Git blob `e9fc97d87dee2670c56ff3abf9e86befbc0f2ff8`. `fingerprint-v1.tsv` is a pinned, base64-encoded transport for the same vector fields. `verify_tsv_against_fixture.py` fails closed on fixture or TSV drift and rechecks every digest.

- **Java / GraalVM**: standalone `javac` + `java` host test; no reflection or guest compiler dependency. Tests strict UTF-8 and Unicode/revision rejection.
- **LLVM / Forge-Cranelift**: standalone C++20 test with ASan/UBSan. OpenSSL libcrypto is a *host test-only* SHA-256 oracle; no requirement or runtime dependency is added to the language compiler. Malformed UTF-8, base64 and unsafe revision cases must fail closed.
- **Wasm**: WebCrypto adapter simulation using Node.js test runner; not a Wasm module or actual browser-worker binding.
- **.NET**: `net8.0` standalone test project with SHA256.HashData and strict UTF-8; **source-authored only** until .NET SDK 8 and exact-head Windows/Linux AOT jobs execute.

No new guest/network powers are enabled. This does not override the private-source export hold, CI-review gates, authenticated guest receipt requirements, or the need for a real actor-owned `CounterLive` E2E suite. It is not sufficient to assert five-backend LiveView parity.
