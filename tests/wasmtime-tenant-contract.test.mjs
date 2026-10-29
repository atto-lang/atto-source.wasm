import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

// Contract checks catch accidental weakening before a full native Wasmtime
// smoke can execute. They are NOT a substitute for Rust compilation or
// actual cross-Store/guest-fault execution.
const source = path => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const tenant = source("aot-host/run/src/tenant_isolation.rs");
const main = source("aot-host/run/src/main.rs");
const smoke = source("aot-host/tests/smoke.sh");

test("tenants own separate Wasmtime Stores with bounded memories and no host imports", () => {
  assert.match(tenant, /Store::new\(&self\.engine, limits\)/);
  assert.match(tenant, /Instance::new\(&mut store, &self\.module, &\[\]\)/);
  assert.match(tenant, /\.memory_size\(GUEST_MEMORY_BYTES\)/);
  assert.match(tenant, /\.memories\(1\)/);
  assert.match(tenant, /\.tables\(0\)/);
  assert.match(tenant, /\.instances\(1\)/);
  assert.match(tenant, /store\.limiter\(\|limits\| limits\)/);
  assert.match(tenant, /crate::profile::check_abi\(&module\)\?/);
  assert.match(tenant, /const MAX_TENANTS: usize = 32/);
});

test("tenant handles require private identity and generation fencing", () => {
  assert.match(tenant, /identity: Arc<\(\)>/);
  assert.match(tenant, /tenant\.generation != handle\.generation/);
  assert.match(tenant, /Arc::ptr_eq\(&tenant\.identity, &handle\.identity\)/);
  assert.match(tenant, /checked_add\(1\)/);
  assert.match(tenant, /Phase::Quiescing/);
  assert.match(tenant, /tenant\.phase != Phase::Quiescing/);
});

test("all post-admission execution errors reach Store retirement", () => {
  const start = tenant.indexOf("pub fn invoke(");
  const end = tenant.indexOf("pub fn begin_shutdown(", start);
  assert.ok(start >= 0 && end > start);
  const invoke = tenant.slice(start, end);
  assert.match(invoke, /let outcome = \(\|\| -> Result<i64, Failure> \{/);
  assert.match(invoke, /tenant\.store\.set_fuel\(fuel\)\?;/);
  assert.match(invoke, /\.get_typed_func::<\(\), i64>/);
  assert.match(invoke, /Ok\(main\.call\(&mut tenant\.store, \(\)\)\?\)/);
  assert.match(invoke, /if outcome\.is_err\(\)\s*\{\s*self\.tenants\.remove\(&handle\.id\)/);
  assert.ok(invoke.indexOf("let outcome =") < invoke.indexOf("if outcome.is_err()"));
  assert.match(invoke, /\n        outcome\n/);
});

test("native AOT smoke covers independent memory, trap reincarnation and pin rejection", () => {
  assert.match(main, /--tenant-isolation-smoke/);
  assert.match(main, /observed != \[1,1,2,2\]/);
  assert.match(main, /registry\.invoke\(&b,1\)\.is_ok\(\)/);
  assert.match(main, /registry\.invoke\(&b,fuel\)\.is_ok\(\)/);
  assert.match(main, /registry\.admit\("tenant-b"\)\?/);
  assert.match(main, /registry\.invoke\(&fresh_b,fuel\)\?!=1/);
  assert.match(smoke, /tenant-counter\.wasm/);
  assert.match(smoke, /--tenant-isolation-smoke/);
  assert.match(smoke, /tenant smoke bypassed AOT digest check/);
  assert.match(main, /#\[cfg\(not\(all\(oreslang_debug_cargo_profile, debug_assertions, feature = "insecure-dev-caller-pin"\)\)\)\]/);
  assert.match(main, /AOT execution is disabled unless/);
});
