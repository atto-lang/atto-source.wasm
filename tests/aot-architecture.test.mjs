import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const runnerManifest=source("aot-host/run/Cargo.toml");
const builderManifest=source("aot-host/precompile/Cargo.toml");
const runner=source("aot-host/run/src/main.rs");
const builder=source("aot-host/precompile/src/main.rs");
const scanner=source("aot-host/precompile/src/wasm_admission.rs");
const smoke=source("aot-host/tests/smoke.sh");

test("native precompiler and runner use separate identically pinned Wasmtime graphs",()=>{
  for(const contents of [builderManifest,runnerManifest]){
    assert.match(contents,/wasmtime\s*=\s*\{[^\n]*version\s*=\s*"=49\.0\.3"/);
    assert.match(contents,/default-features\s*=\s*false/);
  }
  assert.match(builderManifest,/["']cranelift["']/);
  assert.doesNotMatch(runnerManifest,/"cranelift"|"winch"|"parallel-compilation"/);
  assert.match(builder,/Module::from_binary\(/);
  assert.match(builder,/module\.serialize\(/);
  assert.doesNotMatch(runner,/\bModule::new\b|\bModule::from_binary\b|\bModule::validate\b|precompile_module\(/);
  assert.match(runner,/Module::deserialize\(/);
  assert.match(runner,/Engine::detect_precompiled\(/);
});
test("native runner cannot execute without debug plus explicit unsafe development feature",()=>{
  assert.match(runnerManifest,/insecure-dev-caller-pin\s*=\s*\[\]/);
  const buildGuard=source("aot-host/run/build.rs");
  assert.ok(buildGuard.includes('cargo:rustc-check-cfg=cfg(oreslang_debug_cargo_profile)'));
  assert.ok(buildGuard.includes('std::env::var("PROFILE").as_deref() == Ok("debug")'));
  assert.ok(smoke.includes("profile.release.debug-assertions=true"));

  assert.match(runner,/#\[cfg\(all\(oreslang_debug_cargo_profile, debug_assertions, feature = "insecure-dev-caller-pin"\)\)\]/);
  assert.match(runner,/#\[cfg\(not\(all\(oreslang_debug_cargo_profile, debug_assertions, feature = "insecure-dev-caller-pin"\)\)\)\]/);
  assert.match(runner,/AOT execution is disabled unless/);
  assert.match(smoke,/cargo build --release[^\n]*--features insecure-dev-caller-pin/);
  assert.match(smoke,/release runner executed with caller-controlled approval/);
});
test("source checksum and native artifact checksum are verified before unsafe execution",()=>{
  assert.match(builder,/verified Wasm bytes do not match approved source SHA-256/);
  assert.match(builder,/Sha256::digest\(&wasm\)/);
  assert.match(runner,/AOT bytes do not match insecure development digest/);
  assert.match(runner,/Some\(Precompiled::Module\)/);
  assert.match(runner,/unsafe\s*\{\s*Module::deserialize\(/);
});
test("precompiler denies hidden Wasm capabilities",()=>{
  for(const variant of ["StartSection","TableSection","ImportSection","MemorySection","TagSection"]){
    assert.ok(scanner.includes(variant),variant+" must be examined");
  }
  assert.match(scanner,/memory\.shared/);
  assert.match(scanner,/memory\.memory64/);
  assert.match(scanner,/memory\.maximum\s*!=\s*Some\(2\)/);
});
test("native runtime has guest resource limits and finite fuel",()=>{
  assert.match(runner,/StoreLimitsBuilder::new\(/);
  assert.match(runner,/\.memory_size\(131072\)\.memories\(1\)\.tables\(0\)\.instances\(1\)/);
  assert.match(runner,/store\.limiter\(/);
  assert.match(runner,/store\.set_fuel\(fuel\)/);
  assert.match(runner,/100_000_000/);
  // A memory.grow denial must trap and reach the invoke retirement path,
  // not be silently delivered as a -1 sentinel to the guest.
  assert.match(runner,/\.trap_on_grow_failure\(true\)/);
  const tenant=source("aot-host/run/src/tenant_isolation.rs");
  assert.match(tenant,/\.trap_on_grow_failure\(true\)/);
  assert.match(tenant,/ResourceLimiter::memory_growing\(/);
  assert.match(tenant,/growth beyond tenant cap must fail by trap/);
  assert.match(smoke,/loop\.wasm/);
  assert.match(smoke,/loop_status/);
  assert.match(smoke,/invalid fuel budget was admitted/);
});

test("tenant lifetime hard fuel is not renewed by repeated Wasmtime dispatches",()=>{
  const tenant=source("aot-host/run/src/tenant_isolation.rs");
  const profile=source("aot-host/profile.rs");
  const runtime=runner;
  assert.match(profile,/config\.consume_fuel\(true\)/,
    "hard Wasmtime fuel must remain independent of cooperative polling");
  assert.match(tenant,/struct LifetimeFuelBudget/);
  assert.match(tenant,/let authorized = tenant\.lifetime_fuel\.grant\(fuel\)\?/);
  assert.match(tenant,/tenant\.store\.set_fuel\(authorized\)\?/);
  assert.match(tenant,/tenant\.lifetime_fuel\.charge\(authorized, tenant\.store\.get_fuel\(\)\?\)\?/);
  assert.match(tenant,/LifetimeFuelBudget::from_instantiated_store\(store\.get_fuel\(\)\?\)/);
  assert.match(tenant,/self\.tenants\.remove\(&handle\.id\)/,
    "failed actor invocation must terminally retire its Store");
  assert.doesNotMatch(tenant,/tenant\.store\.set_fuel\(fuel\)/,
    "an unchecked per-call set_fuel silently renews lifetime quotas");
  assert.match(tenant,/pub fn new_for_fuel_lifetime_smoke\(/);
  assert.match(runtime,/--tenant-lifetime-fuel-smoke/);
  assert.match(runtime,/successful_turns<5/);
  assert.match(runtime,/wasmtime_tenant_lifetime_fuel_nonrenewal=ok/);
  assert.match(smoke,/--tenant-lifetime-fuel-smoke/);
  assert.match(smoke,/timeout 15s/);
  assert.match(smoke,/lifetime fuel smoke accepted incorrect native AOT digest/);
  assert.match(smoke,/tenant-counter\.cwasm/,
    "smoke must execute a compiled guest artifact, not only a synthetic ledger");
});

test("committed independent Cargo locks pin Wasmtime without native runtime compiler",()=>{
  const precompileLock=source("aot-host/precompile/Cargo.lock");
  const runtimeLock=source("aot-host/run/Cargo.lock");
  for(const contents of [precompileLock,runtimeLock]){
    assert.match(contents,/name = "wasmtime"\nversion = "49\.0\.3"/);
    assert.match(contents,/version = 4/);
  }
  assert.match(precompileLock,/name = "wasmtime-internal-cranelift"/);
  assert.doesNotMatch(runtimeLock,/name = "wasmtime-internal-cranelift"/);
  assert.doesNotMatch(runtimeLock,/name = "wasmtime-winch"/);
  const workflow=source(".github/workflows/aot-host.yml");
  assert.match(workflow,/cargo test --locked/);
  assert.match(workflow,/cargo tree --locked/);
  assert.match(source("aot-host/tests/smoke.sh"),/cargo build --locked/);
});

test("AOT CI covers merged main, architecture changes, and the exact Rust toolchain",()=>{
  const workflow=source(".github/workflows/aot-host.yml");
  // A passing independent carrier run must never replace a missing source
  // repository check after a merge. Verify both trigger classes are present.
  assert.match(workflow,/on:\n  push:\n    branches: \[main\]/);
  assert.match(workflow,/pull_request:\n    paths:/);
  for(const path of [
    "aot-host/**", "scripts/**", "src/**", "contracts/**", "tests/**",
    "examples/**", "package.json", "rust-toolchain.toml",
    ".github/workflows/aot-host.yml"
  ]){
    assert.ok(workflow.includes('      - "'+path+'"'),"AOT CI must trigger for "+path);
  }
  assert.match(workflow,/permissions:\n  contents: read/);
  assert.match(workflow,/persist-credentials: false/);
  // PR checkout must match the reviewed head, not GitHub's merge ref.
  assert.match(workflow,/ref: .*github\.event\.pull_request\.head\.sha/);
  assert.match(workflow,/EXPECTED_HEAD: .*github\.event\.pull_request\.head\.sha/);
  assert.match(workflow,/git rev-parse HEAD/);
  assert.match(workflow,/WASM_AOT_SOURCE_TREE=/);
  assert.match(workflow,/node-version: '22'/);
  assert.match(workflow,/node --test tests\/aot-architecture\.test\.mjs tests\/real-aot-gate\.test\.mjs/);
  assert.match(workflow,/name: Run full WebAssembly scalar and shared-contract suite\n        run: npm test/);
  assert.ok(workflow.indexOf('name: Install LLVM wasm32 linker') <
    workflow.indexOf('name: Run full WebAssembly scalar and shared-contract suite'),
    'full Wasm scalar suite requires installed LLVM linker');
  assert.match(workflow,/cargo test --locked --manifest-path aot-host\/precompile\/Cargo\.toml/);
  assert.match(workflow,/cargo check --locked --manifest-path aot-host\/run\/Cargo\.toml/);
  assert.match(workflow,/cargo tree --locked --manifest-path aot-host\/run\/Cargo\.toml/);
  assert.match(workflow,/bash aot-host\/tests\/smoke\.sh/);
});


test("AOT negative corpus and tamper checks are generated by Rust, not Python",()=>{
  const fixtures=source("aot-host/precompile/src/bin/oreslang-aot-fixtures.rs");
  assert.match(fixtures,/fn fixtures\(\)/);
  assert.match(fixtures,/fn generate\(root: &Path\)/);
  assert.match(fixtures,/fn corrupt\(path: &Path\)/);
  assert.match(fixtures,/OpenOptions::new\(\)\.write\(true\)\.create_new\(true\)/);
  assert.match(fixtures,/fs::symlink_metadata\(path\)/);
  assert.match(smoke,/--bin oreslang-aot-fixtures/);
  assert.match(smoke,/\$fixtures" corrupt/);
  assert.match(smoke,/\$fixtures" generate/);
  assert.doesNotMatch(smoke,/\b(?:python|python3|pip|pytest)\b/);
  assert.doesNotMatch(smoke,/make-negative-wasm\.py/);
  assert.match(fixtures,/libc::O_NOFOLLOW \| libc::O_CLOEXEC/);
  // A racing FIFO/device replacement after metadata inspection must not
  // block indefinitely or acquire a controlling TTY on Unix.
  assert.match(fixtures,/libc::O_NONBLOCK \| libc::O_NOCTTY/);
  assert.match(fixtures,/opened\.ino\(\) != meta\.ino\(\)/);
  assert.match(fixtures,/symlinked_tamper_target_is_rejected_without_touching_referent/);
  assert.match(smoke,/Rust AOT corruption fixture followed a symlink/);
  assert.match(fixtures,/meta\.nlink\(\) != 1/);
  assert.match(fixtures,/opened\.nlink\(\) != 1/);
  assert.match(fixtures,/hardlinked_tamper_target_is_rejected_without_mutating_shared_inode/);
  assert.match(smoke,/Rust AOT corruption fixture admitted a multiply-linked inode/);
});
