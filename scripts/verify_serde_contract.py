#!/usr/bin/env python3
"""Static cross-backend Sendable/Serializable contract pin; NOT runtime parity."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
contract = ROOT / "contracts" / "v1" / "serde_boundary_v1.json"
expected_sha256 = "0057fa040cd23857ee14b232472c5056a74e11c9528b8b06dbe348023d97106d"
raw = contract.read_bytes()
digest = hashlib.sha256(raw).hexdigest()
if digest != expected_sha256:
    raise SystemExit(f"serde v1 contract drift: {digest}; bump contract/version intentionally")
doc = json.loads(raw)
if doc.get("contract") != "oreslang.sendable-serializable.v1":
    raise SystemExit("unsupported serde contract revision")
boundaries = doc["boundaries"]
if set(boundaries) != {"actor_data", "network_data", "supervisor_control"}:
    raise SystemExit("serde boundary categories must be distinct")
if boundaries["actor_data"]["unimplemented_policy"] != "reject_before_enqueue":
    raise SystemExit("unsupported actor DATA must fail closed")
if boundaries["network_data"]["unimplemented_policy"] != "reject_before_io":
    raise SystemExit("unsupported network codec must fail closed")
if boundaries["supervisor_control"]["unimplemented_policy"] != "reject_without_data_fallback":
    raise SystemExit("supervisor CONTROL must not downgrade into actor DATA")
if set(boundaries["network_data"]["formats"]) != {"json", "messagepack_v2", "protobuf"}:
    raise SystemExit("unknown portable network format")
if any(x is not True for x in doc["invariants"].values()):
    raise SystemExit("all sealed ownership / codec / authority invariants required")
if doc["wire_profile"]["messagepack_wire_major"] != 2:
    raise SystemExit("unreviewed actor wire version")
if doc["wire_profile"]["messagepack_envelope_fields"] != [
    "wire_major", "schema_id", "shape_sha256", "payload"
]:
    raise SystemExit("unreviewed actor frame shape")
if "unproven_option_result" not in boundaries["actor_data"]["forbid"]:
    raise SystemExit("unproven tagged actor payload must reject")
if "actor_data_envelope" not in boundaries["supervisor_control"]["forbid"]:
    raise SystemExit("CONTROL cannot be serialized as DATA")
print(f"serde v1 STATIC contract pinned: {digest} (not executable transport parity)")
