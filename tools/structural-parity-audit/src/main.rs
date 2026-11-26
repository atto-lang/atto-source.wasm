use oreslang_structural_parity_audit::{check, require_parity, self_test};
use std::env;
use std::path::PathBuf;

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let mode = args
        .next()
        .ok_or_else(|| String::from("expected --check, --self-test, or --require-parity"))?;
    if args.next().is_some() {
        return Err(String::from("unexpected extra arguments"));
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    match mode.as_str() {
        "--self-test" => {
            let count = self_test(&root)?;
            println!("OK: {count} adversarial parity-inventory mutations rejected");
        }
        "--check" => {
            let count = check(&root)?;
            println!("OK: {count} mandatory cases, 5 backends and Git-blob pin intact");
            println!("STATUS: inventory-only; all five backends NOT AT PARITY");
        }
        "--require-parity" => {
            check(&root)?;
            return require_parity();
        }
        _ => return Err(format!("unsupported audit mode: {mode}")),
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("STRUCTURAL PARITY AUDIT FAILED: {error}");
        std::process::exit(1);
    }
}
