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
  assert.match(smoke,/loop\.wasm/);
  assert.match(smoke,/loop_status/);
  assert.match(smoke,/invalid fuel budget was admitted/);
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
  assert.match(workflow,/name: Require real Oreslang source actor execution[\s\S]*npm run test:real-pooled-actors/);
  assert.match(workflow,/name: Mutation-test pinned LLVM compiler receipt consumer[\s\S]*node --test tests\/llvm-compiler-handoff\.test\.mjs/);
  assert.match(workflow,/name: Require approved LLVM build handoff before expensive AOT work[\s\S]*node scripts\/verify-llvm-compiler-handoff\.mjs/);
  assert.ok(workflow.indexOf('name: Require approved LLVM build handoff before expensive AOT work') <
    workflow.indexOf('name: Build trusted AOT precompiler'),
    'compiler handoff must fail closed before costly Rust builds');
  assert.ok(workflow.indexOf('name: Require approved LLVM build handoff before expensive AOT work') <
    workflow.indexOf('name: Require real Oreslang source actor execution'),
    'real source execution cannot bypass compiler handoff');
  const mandatory = source('scripts/verify-real-source-pooled-actor.mjs');
  assert.match(mandatory,/verifyLlvmCompilerHandoff\(/);
  assert.match(mandatory,/ORESLANG_LLVM_COMPILER_RECEIPT/);
  assert.match(workflow,/name: Prove LLVM build source pin and transfer policy fail closed[\s\S]*node --test tests\/pinned-llvm-build-policy\.test\.mjs/);
  assert.match(workflow,/name: Build pinned LLVM compiler from preapproved local source[\s\S]*bash scripts\/build-pinned-llvm-compiler\.sh/);
  assert.ok(workflow.indexOf('name: Prove LLVM build source pin and transfer policy fail closed') <
    workflow.indexOf('name: Build pinned LLVM compiler from preapproved local source'),
    'builder policy tests must precede construction');
  assert.ok(workflow.indexOf('name: Build pinned LLVM compiler from preapproved local source') <
    workflow.indexOf('name: Require approved LLVM build handoff before expensive AOT work'),
    'local source build must produce receipt before handoff check');
  assert.ok(workflow.indexOf('name: Install LLVM wasm32 linker') <
    workflow.indexOf('name: Run full WebAssembly scalar and shared-contract suite'),
    'full Wasm scalar suite requires installed LLVM linker');
  assert.ok(workflow.indexOf('name: Run full WebAssembly scalar and shared-contract suite') <
    workflow.indexOf('name: Require real Oreslang source actor execution'),
    'real source actor gate must run after the ordinary suite');
  assert.ok(workflow.indexOf('name: Require real Oreslang source actor execution') <
    workflow.indexOf('name: Run strict AOT scalar smoke and tamper rejection'),
    'AOT smoke must not mask a missing real-source compiler gate');
  assert.match(workflow,/cargo test --locked --manifest-path aot-host\/precompile\/Cargo\.toml/);
  assert.match(workflow,/cargo check --locked --manifest-path aot-host\/run\/Cargo\.toml/);
  assert.match(workflow,/cargo tree --locked --manifest-path aot-host\/run\/Cargo\.toml/);
  assert.match(workflow,/bash aot-host\/tests\/smoke\.sh/);
});
