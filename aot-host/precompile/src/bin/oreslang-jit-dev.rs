//! Experimental Wasmtime JIT CLI, deliberately fail-closed in any release build.
//! Caller-controlled source SHA-256 is not independently authenticated.
//! This binary MUST run under an external OS sandbox and supervisor for any
//! hostile tenant; this dev executable alone provides neither one.
#[path = "../../../profile.rs"] mod profile;
#[path = "../../../io.rs"] mod io;
#[path = "../wasm_admission.rs"] mod wasm_admission;
use std::error::Error;
use wasmtime::{Instance,Module,Store,StoreLimitsBuilder};
use sha2::{Digest,Sha256};
const MAX_WASM: u64 = 16 * 1024 * 1024;

#[cfg(not(all(oreslang_debug_cargo_profile, debug_assertions, feature = "insecure-dev-jit")))]
fn main() -> Result<(), Box<dyn Error>> {
    Err("Wasmtime JIT execution disabled: only Cargo debug profile + insecure-dev-jit may execute; production sandbox and signed image approval are not implemented".into())
}

#[cfg(all(oreslang_debug_cargo_profile, debug_assertions, feature = "insecure-dev-jit"))]
fn main() -> Result<(), Box<dyn Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if !(2..=3).contains(&args.len()) {
        return Err("usage (unsafe development only): oreslang-jit-dev VERIFIED.wasm SHA256 [FUEL]".into());
    }
    let pin = &args[1];
    if pin.len() != 64 || !pin.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("invalid lower-case SHA-256 pin".into());
    }
    let fuel = match args.get(2) {
        Some(n) => n.parse::<u64>()?,
        None => 1_000_000,
    };
    if !(1..=100_000_000).contains(&fuel) {
        return Err("fuel must be between 1 and 100000000".into());
    }
    // Open with O_NOFOLLOW/O_NONBLOCK and check file identity around the read.
    let wasm = io::bounded_regular_file(&args[0], MAX_WASM)?;
    if format!("{:x}", Sha256::digest(&wasm)) != *pin {
        return Err("Wasm bytes do not match development SHA-256 pin".into());
    }
    // Admit byte-level sections before engine compilation; reject start,
    // import, tables, memory64, shared memory and unbounded memory.
    wasm_admission::validate_scalar_module(&wasm)?;
    let engine = profile::engine()?;
    // This is genuine Wasmtime JIT compilation of verified raw Wasm, NOT
    // Module::deserialize, precompiled native artifacts or a security sandbox.
    let module = Module::from_binary(&engine, &wasm)?;
    profile::check_abi(&module)?;
    let limits = StoreLimitsBuilder::new()
        .memory_size(131072).memories(1).tables(0).instances(1).build();
    let mut store = Store::new(&engine, limits);
    store.limiter(|limits| limits);
    store.set_fuel(fuel)?;
    let instance = Instance::new(&mut store, &module, &[])?;
    let entry = instance.get_typed_func::<(), i64>(&mut store, "main")?;
    let value = entry.call(&mut store, ())?;
    println!("{value}");
    Ok(())
}
