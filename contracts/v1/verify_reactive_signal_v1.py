#!/usr/bin/env python3
"""Fail-closed validator for Oreslang reactive signal backend profile."""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parent
doc = json.loads((ROOT / "reactive-signal-v1.json").read_text())
if doc.get("contract") != "oreslang.reactive-signal.v1":
    raise SystemExit("wrong reactive contract id")
if doc.get("consumer_signal") != "Result<Option<T>, Option<E>>":
    raise SystemExit("consumer signal ABI drift")
if doc.get("producer_frame") != "Result<Option<T>, E>":
    raise SystemExit("producer frame ABI drift")
want={"NEXT":"Ok(Some(T))","COMPLETE":"Ok(None)","CANCELLED":"Err(None)","ERROR":"Err(Some(E))"}
if doc.get("consumer_variants") != want:
    raise SystemExit("four-way consumer variant mapping drift")
features=doc.get("features",{})
required={"canonical_consumer_signal","producer_frame","channel_source","future_source","mixed_channel_future_select","observable","credit_pipe"}
if set(features) != required:
    raise SystemExit("reactive feature inventory drift")
if any(v not in {"implemented","syntax_only","unsupported"} for v in features.values()):
    raise SystemExit("invalid feature status")
if doc.get("unsupported_policy") != "reject_before_lowering":
    raise SystemExit("unsupported reactive source must fail closed before lowering")
evidence=doc.get("executed_evidence",{})
for name,status in features.items():
    if status=="implemented" and not evidence.get(name):
        raise SystemExit(f"implemented feature lacks executable evidence: {name}")
if features["mixed_channel_future_select"]=="implemented" and (features["channel_source"]!="implemented" or features["future_source"]!="implemented"):
    raise SystemExit("mixed select cannot outrun Channel/Future implementation")
if features["credit_pipe"]=="implemented":
    for dep in ("canonical_consumer_signal","producer_frame","channel_source","mixed_channel_future_select"):
        if features[dep]!="implemented":
            raise SystemExit("CreditPipe implementation missing prerequisite")
print("REACTIVE_SIGNAL_V1_PROFILE_OK",doc["backend"])
