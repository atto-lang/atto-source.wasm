//! Ownership-bang immutable source-contract tests (SOURCE_ONLY).
//!
//! Run with:
//! rustc --edition=2021 --test tests/ownership_bang_fixture_contract.rs \
//!   -o /tmp/ownership-bang-fixture-tests
//! /tmp/ownership-bang-fixture-tests
//!
//! This does not execute the LLVM compiler, Wasm guest, or ownership checker.
use std::io::Write;
use std::process::{Command, Stdio};

const CANONICAL: &str =
    include_str!("fixtures/ownership-bang-v1/borrow-mut-canonical.atto");
const COMPATIBLE: &str =
    include_str!("fixtures/ownership-bang-v1/borrow-mut-compatible.atto");
const GUEST_TEST: &str = include_str!("ownership-bang-wasm32-guest.test.mjs");
const STRICT_READER: &str = include_str!("strict-atto-fixture.mjs");

fn git_blob_id(source: &[u8]) -> String {
    // Use Git's own byte framing and SHA-1 calculation; no crate downloads.
    let mut child = Command::new("git")
        .args(["hash-object", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("git must be installed for fixture contract tests");
    child
        .stdin
        .take()
        .expect("git stdin")
        .write_all(source)
        .expect("write bytes to git");
    let result = child.wait_with_output().expect("read git hash-object");
    assert!(result.status.success(), "git hash-object failed");
    String::from_utf8(result.stdout)
        .expect("git object ID is ASCII")
        .trim()
        .to_string()
}

#[test]
fn canonical_loan_fixture_is_exact_and_has_correct_oracle() {
    assert_eq!(
        CANONICAL,
        concat!(
            "fnc inspect_mut(borrow mut int x): int { return x + 2; }\n",
            "fnc wrapper(int x): int { return inspect_mut(borrow! mut x) + take! x; }\n",
            "pub fnc main(): int { return wrapper(20); }\n",
        )
    );
    assert_eq!(20 + 2 + 20, 42);
    assert_eq!(
        git_blob_id(CANONICAL.as_bytes()),
        "398c533b3758a7ec35cc7f5cdb8bffb40f1c8baa"
    );
}

#[test]
fn compatible_loan_fixture_is_exact_and_has_correct_oracle() {
    assert_eq!(
        COMPATIBLE,
        concat!(
            "fnc inspect_mut(borrow mut int x): int { return x + 2; }\n",
            "fnc wrapper(int x): int { return inspect_mut(mut borrow! x) + rt take x; }\n",
            "pub fnc main(): int { return wrapper(20); }\n",
        )
    );
    assert_eq!(
        git_blob_id(COMPATIBLE.as_bytes()),
        "7c551be97b88204296f0c00000018dcd4798bd3a"
    );
}

#[test]
fn arithmetic_mutation_invalidates_fixture_blob_identity() {
    let mutation = CANONICAL.replace("wrapper(20)", "wrapper(19)");
    assert_ne!(
        git_blob_id(mutation.as_bytes()),
        "398c533b3758a7ec35cc7f5cdb8bffb40f1c8baa"
    );
    assert_ne!(mutation, CANONICAL);
}

#[test]
fn guest_test_pins_exact_llvm_producer_and_real_execution_requirements() {
    assert!(GUEST_TEST.contains(
        "const EXPECTED_LLVM_HEAD = '3512a0be998688fe50d685cc038d29e7fe2a5e70';"
    ));
    assert!(GUEST_TEST.contains(
        "const EXPECTED_LLVM_TREE = '13bd97a544bfe7f479bbb39837e7ced3a30877c8';"
    ));
    assert!(GUEST_TEST.contains("readStrictAttoFixture(entry(name))"));
    assert!(GUEST_TEST.contains("assert.equal(executed,5)"));
    assert!(GUEST_TEST.contains("assert.equal(rejected,1)"));
    assert!(GUEST_TEST.contains("ATTO_WASM_OWNERSHIP_BANG_REQUIRED"));
    assert!(!GUEST_TEST.contains("return wrapper(19);"));
}

#[test]
fn fixture_reader_checks_ancestor_symlinks_and_snapshot_identity() {
    assert!(STRICT_READER.contains("inspectDirectoryChain(directory)"));
    assert!(STRICT_READER.contains("sameDirectoryChain(ancestorsBefore, ancestorsAfter)"));
    assert!(STRICT_READER.contains("constants.O_NOFOLLOW"));
    assert!(STRICT_READER.contains("fixture mutated during snapshot"));
}
