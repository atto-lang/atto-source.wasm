//! Fail-closed, inventory-only structural parity audit.
//! An intact inventory is never evidence that a guest compiled or executed.

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Map, Number, Value};
use sha1::{Digest, Sha1};
use std::collections::BTreeSet;
use std::fmt;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

const CONTRACT: &str = "contracts/v1/STRUCTURAL_MATCH_V1.md";
const INVENTORY: &str = "contracts/v1/structural-parity-audit.v1.json";
const SCHEMA: &str = "oreslang.structural.parity.audit.v1";
const CONTRACT_BLOB_SHA1: &str = "17f4da4a2cd3e55a968f9daf09395b000d79fc0b";
const NOTICE: &str = "Conformance inventory only. A green audit is NOT compiled-guest structural parity. A release gate must fail until native evidence is independently checked.";
const MAX_INVENTORY_BYTES: u64 = 64 * 1024;
const MAX_CONTRACT_BYTES: u64 = 1024 * 1024;

const CASES: [(&str, &[&str]); 14] = [
    ("extra-public-members", &["typecheck", "execute"]),
    ("nominal-not-implicit-structural", &["typecheck"]),
    ("missing-private-or-wrong-field", &["typecheck"]),
    ("method-signature-mode-effects", &["typecheck"]),
    ("function-routine-instance-static", &["typecheck", "execute"]),
    ("declaration-metadata-orthogonal", &["parse", "typecheck"]),
    ("named-inline-tuple-patterns", &["typecheck", "execute"]),
    ("ordered-first-success-guard", &["typecheck", "execute"]),
    ("unreachable-broad-before-narrow", &["typecheck"]),
    ("readonly-and-owner-reuse", &["ownership", "execute"]),
    ("no-escape-await-or-actor-erasure", &["ownership"]),
    ("runtime-shape-fallback", &["execute"]),
    ("contextual-structural-identifier", &["parse", "execute"]),
    ("real-guest-artifact-evidence", &["artifact", "execute"]),
];

const BACKENDS: [(&str, &str); 5] = [
    ("java", "reference-partial"),
    ("llvm", "reject-only"),
    ("wasm", "conditional-reject-only"),
    ("net", "reject-only"),
    ("forge", "reject-only"),
];

fn denied(message: &str) -> String {
    message.to_owned()
}

/// Recursive JSON deserialization that rejects duplicate keys at every depth.
/// Default serde_json Value deserialization would overwrite duplicate keys.
struct StrictValue(Value);

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = StrictValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("strict JSON without duplicate object keys")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Bool(value)))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Number(Number::from(value))))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Number(Number::from(value))))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
        Number::from_f64(value)
            .map(|number| StrictValue(Value::Number(number)))
            .ok_or_else(|| E::custom("nonfinite JSON number"))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::String(value.to_owned())))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::String(value)))
    }

    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Null))
    }

    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Null))
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        StrictValue::deserialize(deserializer)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut values = Vec::new();
        while let Some(StrictValue(value)) = seq.next_element::<StrictValue>()? {
            values.push(value);
        }
        Ok(StrictValue(Value::Array(values)))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut values = Map::new();
        while let Some((key, StrictValue(value))) = map.next_entry::<String, StrictValue>()? {
            if values.contains_key(&key) {
                return Err(de::Error::custom(format!("duplicate JSON key: {key}")));
            }
            values.insert(key, value);
        }
        Ok(StrictValue(Value::Object(values)))
    }
}

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor)
    }
}

pub fn read_inventory(raw: &[u8]) -> Result<Value, String> {
    if raw.is_empty() || raw.len() as u64 > MAX_INVENTORY_BYTES {
        return Err(denied("inventory is empty or oversized"));
    }
    let mut decoder = serde_json::Deserializer::from_slice(raw);
    let StrictValue(value) = StrictValue::deserialize(&mut decoder)
        .map_err(|error| format!("malformed inventory JSON: {error}"))?;
    decoder
        .end()
        .map_err(|error| format!("trailing inventory JSON: {error}"))?;
    if !value.is_object() {
        return Err(denied("inventory must be an object"));
    }
    Ok(value)
}

fn git_blob_sha1(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub fn verify(data: &Value, contract_bytes: &[u8]) -> Result<usize, String> {
    let root = data
        .as_object()
        .ok_or_else(|| denied("inventory must be an object"))?;
    let required: BTreeSet<&str> = [
        "schema",
        "contract_git_blob_sha1",
        "cases",
        "backends",
        "notice",
    ]
    .into_iter()
    .collect();
    let observed: BTreeSet<&str> = root.keys().map(String::as_str).collect();
    if observed != required {
        return Err(denied("unexpected inventory root keys"));
    }
    if data["schema"].as_str() != Some(SCHEMA) {
        return Err(denied("invalid contract schema"));
    }
    if data["notice"].as_str() != Some(NOTICE) {
        return Err(denied("missing non-parity disclaimer"));
    }
    if data["contract_git_blob_sha1"].as_str() != Some(CONTRACT_BLOB_SHA1) {
        return Err(denied("contract pin changed without audited update"));
    }
    if git_blob_sha1(contract_bytes) != CONTRACT_BLOB_SHA1 {
        return Err(denied("shared Markdown contract differs from pinned Git blob"));
    }

    let expected_cases = Value::Array(
        CASES
            .iter()
            .map(|(name, stages)| json!({"id": name, "stages": stages}))
            .collect(),
    );
    if data["cases"] != expected_cases {
        return Err(denied("required case IDs, order or proof stages changed/omitted"));
    }

    let backends = data["backends"]
        .as_object()
        .ok_or_else(|| denied("backend scope drift"))?;
    if backends.len() != BACKENDS.len() {
        return Err(denied("backend scope drift"));
    }
    for (name, capability) in BACKENDS {
        if backends.get(name)
            != Some(&json!({"capability": capability, "runtime_evidence": "unverified"}))
        {
            return Err(format!("{name}: invented or silently promoted runtime evidence"));
        }
    }
    Ok(CASES.len())
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|error| format!("missing audit input {}: {error}", path.display()))?;
    if !meta.file_type().is_file() || meta.len() > limit {
        return Err(format!("not a bounded regular audit input: {}", path.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err(format!("hardlinked audit input refused: {}", path.display()));
        }
    }
    let mut file = File::open(path).map_err(|error| format!("cannot open {}: {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if bytes.len() as u64 > limit || bytes.len() as u64 != meta.len() {
        return Err(format!("audit input changed during read: {}", path.display()));
    }
    Ok(bytes)
}

pub fn check(root: &Path) -> Result<usize, String> {
    let contract = read_bounded(&root.join(CONTRACT), MAX_CONTRACT_BYTES)?;
    let inventory = read_bounded(&root.join(INVENTORY), MAX_INVENTORY_BYTES)?;
    let data = read_inventory(&inventory)?;
    verify(&data, &contract)
}

/// Inventory-only success must never grant runtime-parity authorization.
pub fn require_parity() -> Result<(), String> {
    Err(denied(
        "NOT AT PARITY: no independent verified guest runtime evidence",
    ))
}

pub fn self_test(root: &Path) -> Result<usize, String> {
    let contract = read_bounded(&root.join(CONTRACT), MAX_CONTRACT_BYTES)?;
    let inventory = read_bounded(&root.join(INVENTORY), MAX_INVENTORY_BYTES)?;
    let clean = read_inventory(&inventory)?;
    verify(&clean, &contract)?;

    let mut attacks: Vec<(Value, Vec<u8>)> = Vec::new();
    let mut change = clean.clone();
    change["cases"].as_array_mut().expect("verified cases").pop();
    attacks.push((change, contract.clone()));

    let mut change = clean.clone();
    let first = change["cases"][0].clone();
    change["cases"].as_array_mut().expect("verified cases").push(first);
    attacks.push((change, contract.clone()));

    let mut change = clean.clone();
    change["cases"][0]["stages"].as_array_mut().expect("verified stages").pop();
    attacks.push((change, contract.clone()));

    let mut change = clean.clone();
    change["cases"].as_array_mut().expect("verified cases").reverse();
    attacks.push((change, contract.clone()));

    let mut change = clean.clone();
    change["backends"].as_object_mut().expect("verified backends").remove("wasm");
    attacks.push((change, contract.clone()));

    let mut change = clean.clone();
    change["backends"]["java"]["runtime_evidence"] = json!("verified");
    attacks.push((change, contract.clone()));

    let mut change = clean.clone();
    change["backends"]["llvm"]["capability"] = json!("complete");
    attacks.push((change, contract.clone()));

    let mut change = clean.clone();
    change["contract_git_blob_sha1"] = json!("0000000000000000000000000000000000000000");
    attacks.push((change, contract.clone()));

    let mut change = clean.clone();
    change["extra"] = json!("unreviewed");
    attacks.push((change, contract.clone()));

    let mut altered_contract = contract.clone();
    altered_contract.push(b'\n');
    attacks.push((clean, altered_contract));

    for (index, (candidate, source)) in attacks.iter().enumerate() {
        if verify(candidate, source).is_ok() {
            return Err(format!("tampered inventory passed mutation {index}"));
        }
    }

    let malformed = [
        r#"{"a":1,"a":2}"#,
        r#"{"outer":{"x":1,"x":2}}"#,
        r#"{"cases":[{"id":"a","id":"b"}]}"#,
        "NaN",
        "[]",
        r#"{"x":Infinity}"#,
    ];
    for raw in malformed {
        if let Ok(parsed) = read_inventory(raw.as_bytes()) {
            if verify(&parsed, &contract).is_ok() {
                return Err(format!("malformed JSON passed: {raw}"));
            }
        }
    }
    Ok(attacks.len() + malformed.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize()
            .expect("repository root").leak()
    }

    #[test]
    fn pinned_checkout_inventory_is_only_an_inventory_witness() {
        assert_eq!(check(root()).unwrap(), 14);
        assert!(require_parity().is_err());
    }

    #[test]
    fn mutation_suite_denies_missing_cases_forged_evidence_and_contract_drift() {
        assert_eq!(self_test(root()).unwrap(), 16);
    }

    #[test]
    fn recursive_duplicate_keys_and_json_extensions_are_denied() {
        for raw in [
            r#"{"x":1,"x":2}"#,
            r#"{"nested":{"x":1,"x":2}}"#,
            r#"{"nested":[{"x":1,"x":2}]}"#,
            "NaN",
            r#"{"x":Infinity}"#,
            "true",
            "[]",
            r#"{} garbage"#,
        ] {
            assert!(read_inventory(raw.as_bytes()).is_err(), "accepted {raw}");
        }
    }

    #[test]
    fn failed_runtime_evidence_and_case_forgery_never_promote_parity() {
        let clean = read_inventory(include_bytes!("../../../contracts/v1/structural-parity-audit.v1.json"))
            .unwrap();
        let contract = include_bytes!("../../../contracts/v1/STRUCTURAL_MATCH_V1.md");
        let mut wrong = clean.clone();
        wrong["backends"]["wasm"]["runtime_evidence"] = json!("success");
        assert!(verify(&wrong, contract).is_err());
        let mut wrong = clean.clone();
        wrong["cases"][0]["stages"] = json!(["execute"]);
        assert!(verify(&wrong, contract).is_err());
        let mut wrong = clean;
        wrong["backends"]["wasm"]["runtime_evidence"] = json!(true);
        assert!(verify(&wrong, contract).is_err());
    }

    #[test]
    fn git_blob_hash_matches_pinned_contract() {
        let contract = include_bytes!("../../../contracts/v1/STRUCTURAL_MATCH_V1.md");
        assert_eq!(git_blob_sha1(contract), CONTRACT_BLOB_SHA1);
        assert_eq!(git_blob_sha1(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    }

    #[test]
    fn oversized_inventory_and_invalid_utf8_are_denied() {
        assert!(read_inventory(&vec![b' '; MAX_INVENTORY_BYTES as usize + 1]).is_err());
        assert!(read_inventory(&[0xff, 0xfe]).is_err());
    }
}
