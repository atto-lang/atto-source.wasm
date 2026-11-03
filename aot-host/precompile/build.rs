// Never allow the intentionally insecure Wasmtime JIT development entry to
// execute in release builds, including release with debug_assertions=true.
fn main() {
    println!("cargo:rustc-check-cfg=cfg(oreslang_debug_cargo_profile)");
    println!("cargo:rerun-if-env-changed=PROFILE");
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        println!("cargo:rustc-cfg=oreslang_debug_cargo_profile");
    }
}
