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
  assert.match(buildGuard,/cargo:rustc-check-cfg=cfg\\(oreslang_debug_cargo_profile\\)/);
  assert.match(buildGuard,/std::env::var\\("PROFILE"\\).+Ok\\("debug"\\)/);
  assert.match(smoke,/profile\\.release\\.debug-assertions=true/);

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
