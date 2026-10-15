// Extra build-profile gate for the deliberately insecure AOT development runner.
// debug_assertions is not sufficient: Rust permits it in --release builds.
fn main() {
    println!("cargo:rustc-check-cfg=cfg(oreslang_debug_cargo_profile)");
    println!("cargo:rerun-if-env-changed=PROFILE");
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        println!("cargo:rustc-cfg=oreslang_debug_cargo_profile");
    }
}
