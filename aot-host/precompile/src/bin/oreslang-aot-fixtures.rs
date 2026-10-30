//! Offline, std-only AOT negative-fixture generator. No Python in native CI.
//! All generated modules are VALID WebAssembly. The precompiler must reject
//! the named negative cases due to its Oreslang admission policy, not parsing.

use std::env;
use std::error::Error;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

type Failure = Box<dyn Error>;
const HEADER: &[u8] = b"\0asm\x01\0\0\0";
const MAX_AOT_BYTES: u64 = 128 * 1024 * 1024;

fn section(kind: u8, contents: &[u8]) -> Vec<u8> {
    assert!(contents.len() < 128, "fixture sections must use one-byte lengths");
    let mut out = vec![kind, contents.len() as u8];
    out.extend_from_slice(contents);
    out
}

fn module(sections: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes = HEADER.to_vec();
    for part in sections {
        bytes.extend_from_slice(part);
    }
    bytes
}

fn fixtures() -> [(&'static str, Vec<u8>); 6] {
    let sig = section(1, &[1, 0x60, 0, 1, 0x7e]); // () -> i64
    let func = section(3, &[1, 0]);
    let memory = section(5, &[1, 1, 1, 2]); // 1..2 private pages
    let exports = section(7, &[2, 4, b'm', b'a', b'i', b'n', 0, 0,
                               6, b'm', b'e', b'm', b'o', b'r', b'y', 2, 0]);
    let code = section(10, &[1, 4, 0, 0x42, 42, 0x0b]);
    let start_sig = section(1, &[2, 0x60, 0, 1, 0x7e, 0x60, 0, 0]);
    let start_functions = section(3, &[2, 0, 1]);
    let start_code = section(10, &[2, 4, 0, 0x42, 42, 0x0b, 2, 0, 0x0b]);
    let imports = section(2, &[1, 3, b'e', b'n', b'v', 1, b'f', 0, 0]);
    let shifted_exports = section(7, &[2, 4, b'm', b'a', b'i', b'n', 0, 1,
                                       6, b'm', b'e', b'm', b'o', b'r', b'y', 2, 0]);
    [
        ("valid", module(&[sig.clone(), func.clone(), memory.clone(),
                           exports.clone(), code.clone()])),
        ("element", module(&[sig.clone(), func.clone(), memory.clone(),
                             exports.clone(), section(9, &[0]), code.clone()])),
        ("table", module(&[sig.clone(), func.clone(), section(4, &[1, 0x70, 0, 1]),
                           memory.clone(), exports.clone(), code.clone()])),
        ("extra-memory", module(&[sig.clone(), func.clone(),
                                  section(5, &[2, 1, 1, 2, 1, 1, 2]),
                                  exports.clone(), code.clone()])),
        ("start", module(&[start_sig, start_functions, memory.clone(), exports,
                           section(8, &[1]), start_code])),
        ("import", module(&[sig, imports, func, memory, shifted_exports, code])),
    ]
}

fn generate(root: &Path) -> Result<(), Failure> {
    if !fs::symlink_metadata(root)?.file_type().is_dir() {
        return Err("fixture destination must be an existing directory".into());
    }
    for (name, bytes) in fixtures() {
        let destination = root.join(format!("{name}.wasm"));
        // Never overwrite a prior fixture or follow a destination symlink.
        let mut file = OpenOptions::new().write(true).create_new(true).open(destination)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    Ok(())
}

fn corrupt(path: &Path) -> Result<(), Failure> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.file_type().is_file() || meta.len() == 0 || meta.len() > MAX_AOT_BYTES {
        return Err("corruption test input must be bounded nonempty regular file".into());
    }
    // This is an intentionally destructive mutation of the caller's private
    // temporary fixture, not an artifact publication or deployment operation.
    let mut file = OpenOptions::new().read(true).write(true).open(path)?;
    let middle = meta.len() / 2;
    file.seek(SeekFrom::Start(middle))?;
    let mut byte = [0];
    file.read_exact(&mut byte)?;
    file.seek(SeekFrom::Start(middle))?;
    file.write_all(&[byte[0] ^ 1])?;
    file.sync_all()?;
    Ok(())
}

fn main() -> Result<(), Failure> {
    let mut args = env::args_os().skip(1);
    let mode = args.next().and_then(|arg| arg.into_string().ok())
        .ok_or("usage: oreslang-aot-fixtures generate DIRECTORY | corrupt FILE")?;
    let path = args.next().ok_or("missing fixture path")?;
    if args.next().is_some() {
        return Err("unexpected extra fixture arguments".into());
    }
    match mode.as_str() {
        "generate" => generate(Path::new(&path)),
        "corrupt" => corrupt(Path::new(&path)),
        _ => Err("unknown fixture command".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_six_fixtures_have_wasm_magic_and_distinct_bodies() {
        let cases = fixtures();
        assert_eq!(cases.len(), 6);
        for (name, bytes) in &cases {
            assert!(bytes.starts_with(HEADER), "{name}");
            assert!(bytes.len() > HEADER.len(), "{name}");
        }
        for i in 0..cases.len() {
            for j in (i + 1)..cases.len() {
                assert_ne!(cases[i].0, cases[j].0);
                assert_ne!(cases[i].1, cases[j].1);
            }
        }
    }

    #[test]
    fn generated_fixture_is_not_overwritten() {
        let dir = tempfile::tempdir().expect("private test directory");
        generate(dir.path()).expect("first fixture generation");
        assert!(generate(dir.path()).is_err(), "second generation must fail");
    }

    #[test]
    fn one_byte_mutation_preserves_length_and_changes_digest_input() {
        let dir = tempfile::tempdir().expect("private test directory");
        generate(dir.path()).expect("fixtures");
        let path = dir.path().join("valid.wasm");
        let before = fs::read(&path).expect("before");
        corrupt(&path).expect("mutation");
        let after = fs::read(&path).expect("after");
        assert_eq!(before.len(), after.len());
        assert_eq!(before.iter().zip(&after).filter(|(a, b)| a != b).count(), 1);
    }
}
