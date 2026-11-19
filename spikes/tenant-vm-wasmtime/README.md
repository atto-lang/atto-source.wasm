# Tenant VMs under Wasmtime

One OS process, up to 1000 tenants: one `Engine`, one `Store` and `Instance` per tenant, and a fixed
thread pool. This is the Wasm backend of the design in `oreslang-source.llvm`,
`docs/TENANT_VM_IN_PROCESS_V1.md`. It is a spike, not yet wired into this repository's host.

```sh
cargo run --release
```

What it shows, on macOS arm64 with Wasmtime 49.0.5, 2026-11-03: 200,000 turns across 1000 Stores on
8 threads; hostile reads that land in the tenant's own memory or trap; trap, spin, stack overflow and
a memory bomb each ending one tenant; and a targeted kill.

**Targeted kill.** Epochs are per `Engine`, so advancing one reaches every `Store`. Each `Store` has
a flag instead, read by its epoch callback, so only the flagged `Store` traps. The test spins six
tenants and ends them one at a time, checking that the others are still running each time.

**A limit to keep in mind.** A `Store` runs on one thread at a time, so with one `Store` per tenant,
a tenant's actors do not run in parallel.

This has not run on Linux or x86_64, or in CI: the source organization's Actions jobs cannot start
at the moment.
