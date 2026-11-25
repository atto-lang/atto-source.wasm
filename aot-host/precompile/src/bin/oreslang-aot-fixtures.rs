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

fn fixtures() -> [(&'static str, Vec<u8>); 8] {
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
    // Both modules are valid under ordinary Wasm validation, but the
    // sealed scalar profile forbids the optional SIMD and tail-call proposals.
    let mut simd_body = vec![1, 23, 0, 0xfd, 0x0c]; // 1 body, 23 bytes, local count 0
    simd_body.extend_from_slice(&[0; 16]); // v128.const immediate
    simd_body.extend_from_slice(&[0x1a, 0x42, 42, 0x0b]); // drop; 42; end
    let simd_code = section(10, &simd_body);
    let tail_functions = section(3, &[2, 0, 0]); // main + private helper
    let tail_code = section(10, &[
        2, 4, 0, 0x12, 1, 0x0b, // main: return_call helper
        4, 0, 0x42, 42, 0x0b    // helper: i64.const 42
    ]);
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
        ("start", module(&[start_sig, start_functions, memory.clone(), exports.clone(),
                           section(8, &[1]), start_code])),
        ("simd", module(&[sig.clone(), func.clone(), memory.clone(),
                            exports.clone(), simd_code])),
        ("tail-call", module(&[sig.clone(), tail_functions, memory.clone(),
                                 exports.clone(), tail_code])),
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
    // This fixture deliberately mutates a PRIVATE temporary artifact.
    // The path must not allow symlink replacement between metadata inspection
    // and opening the file; Linux/macOS CI supports O_NOFOLLOW. A racing
    // FIFO/device replacement must also not block or attach a controlling TTY
    // before the opened file descriptor is checked for regular-file identity.
    #[cfg(not(unix))]
    {
        let _ = path;
        return Err("AOT tamper fixture requires Unix no-follow file admission".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let meta = fs::symlink_metadata(path)?;
        if !meta.file_type().is_file() || meta.nlink() != 1 ||
            meta.len() == 0 || meta.len() > MAX_AOT_BYTES {
            return Err("corruption test input must be bounded nonempty regular file".into());
        }
        let mut file = OpenOptions::new().read(true).write(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC |
                libc::O_NONBLOCK | libc::O_NOCTTY).open(path)?;
        let opened = file.metadata()?;
        if !opened.file_type().is_file() ||
            opened.nlink() != 1 ||
            opened.dev() != meta.dev() ||
            opened.ino() != meta.ino() ||
            opened.len() != meta.len() {
            return Err("AOT tamper fixture identity changed during open".into());
        }
        let middle = opened.len() / 2;
        file.seek(SeekFrom::Start(middle))?;
        let mut byte = [0];
        file.read_exact(&mut byte)?;
        file.seek(SeekFrom::Start(middle))?;
        file.write_all(&[byte[0] ^ 1])?;
        file.sync_all()?;
        Ok(())
    }
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
    fn all_eight_fixtures_have_wasm_magic_and_distinct_bodies() {
        let cases = fixtures();
        assert_eq!(cases.len(), 8);
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

    #[cfg(unix)]
    #[test]
    fn symlinked_tamper_target_is_rejected_without_touching_referent() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().expect("private directory");
        generate(dir.path()).expect("fixtures");
        let real = dir.path().join("valid.wasm");
        let linked = dir.path().join("linked.wasm");
        let original = fs::read(&real).expect("original fixture");
        symlink(&real, &linked).expect("create symlink");
        assert!(corrupt(&linked).is_err(), "symlink was followed");
        assert_eq!(fs::read(&real).expect("retained fixture"), original);
    }

    #[cfg(unix)]
    #[test]
    fn hardlinked_tamper_target_is_rejected_without_mutating_shared_inode() {
        let dir = tempfile::tempdir().expect("private directory");
        generate(dir.path()).expect("fixtures");
        let real = dir.path().join("valid.wasm");
        let alias = dir.path().join("same-inode.wasm");
        let original = fs::read(&real).expect("original fixture");
        fs::hard_link(&real, &alias).expect("create hard link");
        assert!(corrupt(&alias).is_err(), "multiply linked inode was mutated");
        assert_eq!(fs::read(&real).expect("retained fixture"), original);
        assert_eq!(fs::read(&alias).expect("alias fixture"), original);
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
