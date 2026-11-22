//! Data-only numeric capability claims gate. This cannot certify guest parity.
//! Replacement for stale Python capability assertions; preserve actual source
//! and compiled guest execution as separate, independently evidenced gates.
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use std::{collections::BTreeSet, env, fmt, fs, path::Path, process::{self, Command}};

const FEATURES: &[&str] = &[
    "source_i64", "checked_i64_overflow", "binary64_ordering",
    "binary32_arithmetic", "bigint_exact", "decimal_exact",
    "complex_binary64", "decimal_matrix", "source_division_to_float",
    "math_i64_unary", "binary64_unary", "bigint_unary", "decimal_unary",
    "bigint_div_rem", "bigint_to_i64_checked", "bigint_to_f64_exact",
    "bigint_to_f64_nearest", "decimal_round_context", "decimal_to_f64_exact",
    "decimal_to_f64_nearest", "binary64_strict_profile", "binary64_next_after",
    "binary64_ulp", "binary64_approx_eq", "binary64_fma", "binary64_sqrt",
    "binary64_transcendentals",
];
const STATUSES: &[&str] = &[
    "unsupported_explicit", "delegated_unverified", "implemented_unverified",
    "reference_only", "blocked_unsound", "needs_audit",
];
const NUMERIC_CASES: &str = "contracts/v1/numeric-precision/cases.json";
const MANIFEST: &str = "contracts/v1/numeric-parity/backend.json";
const CASES_BLOB: &str = "cb28b5678d380f02c5e4e43bd763da04bdb996fe";
const SOURCE_BLOB: &str = "bbc319c19ecd007109d33592e210091eb267e5a2";
const OVERFLOW_BLOB: &str = "2ce0b0ff5c52e54a788280fd64d67fa8dc32614a";

/// Serde's ordinary Value map decoder can overwrite duplicate JSON keys.
/// Accept JSON only with unique member names, at every nested object depth.
struct UniqueJson(Value);

impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct UniqueVisitor;
        impl<'de> Visitor<'de> for UniqueVisitor {
            type Value = UniqueJson;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("strict finite JSON without duplicate object keys")
            }
            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Bool(value)))
            }
            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Number(value.into())))
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Number(value.into())))
            }
            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
                let number = serde_json::Number::from_f64(value)
                    .ok_or_else(|| de::Error::custom("nonfinite JSON number"))?;
                Ok(UniqueJson(Value::Number(number)))
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::String(value.to_owned())))
            }
            fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::String(value)))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Null))
            }
            fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element::<UniqueJson>()? {
                    items.push(item.0);
                }
                Ok(UniqueJson(Value::Array(items)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some((key, item)) = map.next_entry::<String, UniqueJson>()? {
                    if values.contains_key(&key) {
                        return Err(de::Error::custom(format!("duplicate JSON key: {key}")));
                    }
                    values.insert(key, item.0);
                }
                Ok(UniqueJson(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(UniqueVisitor)
    }
}

fn strict_json(bytes: &[u8]) -> Result<Value, String> {
    let doc: UniqueJson = serde_json::from_slice(bytes)
        .map_err(|e| format!("invalid or ambiguous strict JSON: {e}"))?;
    Ok(doc.0)
}

fn bounded_json(root: &Path, name: &str) -> Result<Value, String> {
    let file = root.join(name);
    let meta = fs::symlink_metadata(&file).map_err(|e| format!("{name}: {e}"))?;
    if !meta.file_type().is_file() || meta.len() == 0 || meta.len() > 256 * 1024 {
        return Err(format!("{name}: expected bounded regular JSON file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err(format!("{name}: shared/hardlinked JSON refused"));
        }
    }
    let bytes = fs::read(&file).map_err(|e| format!("{name}: {e}"))?;
    if bytes.len() as u64 != meta.len() {
        return Err(format!("{name}: changed during read"));
    }
    strict_json(&bytes).map_err(|e| format!("{name}: {e}"))
}

fn pinned_blob(root: &Path, file: &str, expected: &str) -> Result<(), String> {
    // Git's hash-object is the authoritative Git-blob SHA-1 format; this
    // checks fixture identity only, not compiler execution or authorship.
    let output = Command::new("git").current_dir(root)
        .args(["hash-object", "--", file])
        .output().map_err(|e| format!("{file}: git invocation failed: {e}"))?;
    let actual = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || actual.trim() != expected {
        return Err(format!("{file}: canonical Git blob differs from pinned contract"));
    }
    Ok(())
}

fn check_manifest(d: &Value) -> Result<(), String> {
    if d["schema_version"] != "1.0.0" || d["backend"] != "wasm" {
        return Err("manifest schema/backend identity mismatch".into());
    }
    if d["reference_fixture_git_blob_sha"] != CASES_BLOB
        || d["source_i64_fixture_git_blob_sha"] != SOURCE_BLOB
        || d["source_i64_overflow_fixture_git_blob_sha"] != OVERFLOW_BLOB
    {
        return Err("numeric fixture source pins changed".into());
    }
    let capabilities = d["capabilities"].as_object()
        .ok_or("capabilities must be an object")?;
    let evidence = d["evidence"].as_object().ok_or("evidence must be an object")?;
    let expected: BTreeSet<_> = FEATURES.iter().copied().collect();
    let names: BTreeSet<_> = capabilities.keys().map(String::as_str).collect();
    let proof_names: BTreeSet<_> = evidence.keys().map(String::as_str).collect();
    if names != expected || proof_names != expected {
        return Err("numeric feature/evidence matrix is incomplete or widened".into());
    }
    for name in FEATURES {
        let status = capabilities[*name].as_str().ok_or("non-string capability")?;
        if !STATUSES.contains(&status) {
            return Err(format!("{name}: unverified backend cannot claim compiled parity"));
        }
        let proof = evidence[*name].as_object().ok_or("evidence must be an object")?;
        // Allow an explanatory non-evidentiary scope note, never a SHA, URL,
        // executed case count or other self-attested proof.
        if !proof.is_empty() {
            if proof.len() != 1 {
                return Err(format!("{name}: self-attested evidence is forbidden"));
            }
            let note = proof.get("scope").and_then(Value::as_str)
                .ok_or("only scope notes are allowed before independent receipts")?;
            if note.len() > 256 || !note.contains("guest")
                || !note.contains("no ") && !note.contains("absent")
            {
                return Err(format!("{name}: invalid unsupported-feature scope note"));
            }
        }
    }
    if capabilities["source_i64"] != "delegated_unverified"
        || capabilities.values().any(|v| v.as_str() == Some("verified_compiled"))
    {
        return Err("Wasm scalar compiler delegation is not guest parity".into());
    }
    Ok(())
}

fn verify(root: &Path) -> Result<(), String> {
    let cases = bounded_json(root, NUMERIC_CASES)?;
    if cases["schema_version"] != "1.0.0"
        || cases["status"] != "reference-only-not-guest-execution"
    {
        return Err("numerical golden fixture misclassified as guest evidence".into());
    }
    pinned_blob(root, NUMERIC_CASES, CASES_BLOB)?;
    pinned_blob(root, "contracts/v1/numeric-parity/source-i64-cases.json", SOURCE_BLOB)?;
    pinned_blob(
        root,
        "contracts/v1/numeric-parity/source-i64-overflow-cases.json",
        OVERFLOW_BLOB,
    )?;
    let manifest = bounded_json(root, MANIFEST)?;
    check_manifest(&manifest)
}

fn main() {
    let root = env::args().nth(1).unwrap_or_else(|| ".".to_owned());
    match verify(Path::new(&root)) {
        Ok(()) => println!("ORES_NUMERIC_CAPABILITY_DATA_ONLY_PASS"),
        Err(e) => {
            eprintln!("ORES_NUMERIC_CAPABILITY_DATA_ONLY_FAIL: {e}");
            process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn example() -> Value {
        serde_json::json!({
            "schema_version":"1.0.0", "backend":"wasm",
            "reference_fixture_git_blob_sha":CASES_BLOB,
            "source_i64_fixture_git_blob_sha":SOURCE_BLOB,
            "source_i64_overflow_fixture_git_blob_sha":OVERFLOW_BLOB,
            "capabilities": FEATURES.iter()
                .map(|x| (x.to_string(), Value::String("unsupported_explicit".to_owned())))
                .collect::<serde_json::Map<String, Value>>(),
            "evidence": FEATURES.iter()
                .map(|x| (x.to_string(), Value::Object(serde_json::Map::new())))
                .collect::<serde_json::Map<String, Value>>()
        })
    }
    #[test]
    fn canonical_data_admission() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        verify(&root).expect("source-only numeric capability contract");
    }
    #[test]
    fn self_attested_compiled_proofs_are_rejected() {
        let mut d = example();
        d["capabilities"]["source_i64"] = "delegated_unverified".into();
        check_manifest(&d).unwrap();
        d["evidence"]["source_i64"]["workflow_url"] = "https://example.org/fake".into();
        assert!(check_manifest(&d).is_err());
        d["evidence"]["source_i64"] = serde_json::json!({});
        d["capabilities"]["source_i64"] = "verified_compiled".into();
        assert!(check_manifest(&d).is_err());
    }
    #[test]
    fn missing_or_extra_feature_and_forged_backend_rejected() {
        let mut d = example();
        d["capabilities"]["source_i64"] = "delegated_unverified".into();
        d["capabilities"].as_object_mut().unwrap().remove("decimal_matrix");
        assert!(check_manifest(&d).is_err());
        d["capabilities"]["decimal_matrix"] = "unsupported_explicit".into();
        d["capabilities"]["surprise"] = "implemented_unverified".into();
        assert!(check_manifest(&d).is_err());
        d["capabilities"].as_object_mut().unwrap().remove("surprise");
        d["backend"] = "llvm".into();
        assert!(check_manifest(&d).is_err());
    }
    #[test]
    fn rejects_duplicate_members_and_nonfinite_values_before_validation() {
        assert!(strict_json(br#"{"backend":"wasm","backend":"llvm"}"#).is_err());
        assert!(strict_json(br#"{"capabilities":{"a":1,"a":2}}"#).is_err());
        assert!(strict_json(br#"{"scope":"ok","scope":"forged"}"#).is_err());
        assert!(strict_json(br#"{"value":NaN}"#).is_err());
        assert!(strict_json(br#"{"value":1e999}"#).is_err());
        assert!(strict_json(br#"{"value":2} trailing"#).is_err());
        assert!(strict_json(br#"{"payload":["okay",null,true,42]}"#).is_ok());
    }

}
