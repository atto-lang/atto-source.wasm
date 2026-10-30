#!/usr/bin/env python3
"""Fail-closed verifier for callback execution-context parity v1."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "contracts/v1/CALLBACK_DISPATCH_AND_PREEMPTION_V1.md"
VECTORS = ROOT / "contracts/v1/execution-context-callbacks-v1.json"

EXPECTED_CONTRACT_BLOB = "58394012ae6c0c22c3a321443d8045ccc741c3e0"
EXPECTED_VECTOR_BLOB = "249ef4d1e098f48c48dd1dfe05c662bee7ff53f8"

EXPECTED_IDS = (
    "sync_resolve_registration",
    "cross_carrier_resolve",
    "nested_scope_restore",
    "callback_throw_cleanup",
    "duplicate_resolve",
    "cancel_vs_resolve",
    "terminal_waiter_race",
    "stale_generation",
    "late_after_retire",
    "provenance_not_authority",
    "trace_boundary",
    "await_boundary",
    "scope_cleanup",
    "bounded_retention",
)


def git_blob_id(data: bytes) -> str:
    header = f"blob {len(data)}\0".encode()
    # Git blob identity is SHA-1 by protocol; this is not a security digest.
    return hashlib.sha1(header + data, usedforsecurity=False).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"execution-context callback parity FAILED: {message}")


def main() -> None:
    contract = CONTRACT.read_bytes()
    vectors_raw = VECTORS.read_bytes()

    require(
        git_blob_id(contract) == EXPECTED_CONTRACT_BLOB,
        "normative contract blob drift",
    )
    require(
        git_blob_id(vectors_raw) == EXPECTED_VECTOR_BLOB,
        "adversarial vector blob drift",
    )

    vectors = json.loads(vectors_raw)
    require(vectors.get("version") == 1, "vector version must be 1")
    require(
        vectors.get("contract") == "CALLBACK_DISPATCH_AND_PREEMPTION_V1",
        "wrong contract identifier",
    )

    cases = vectors.get("cases")
    require(isinstance(cases, list), "cases must be a list")
    ids = tuple(case.get("id") for case in cases)
    require(ids == EXPECTED_IDS, "case set/order drift")
    require(len(set(ids)) == len(ids), "duplicate case id")

    by_id = {case["id"]: case for case in cases}
    require(
        by_id["sync_resolve_registration"].get("guest_inline") is False
        and by_id["sync_resolve_registration"].get("fresh_resume_dispatch") is True,
        "synchronous resolution must remain no-Zalgo with fresh resume",
    )
    require(
        by_id["cross_carrier_resolve"].get("producer_ambient_ignored") is True
        and by_id["cross_carrier_resolve"].get("guest_inline") is False,
        "foreign producer ambient context must remain non-authoritative",
    )
    require(
        by_id["nested_scope_restore"].get("restore_lifo") is True,
        "nested callback scope must restore LIFO",
    )
    require(
        by_id["callback_throw_cleanup"].get("scope_cleared") is True
        and by_id["callback_throw_cleanup"].get("accounting_released") is True,
        "throw path must clear scope and release accounting",
    )
    require(
        by_id["duplicate_resolve"].get("one_shot") is True
        and by_id["duplicate_resolve"].get("first_wins") is True,
        "callback settlement must remain one-shot",
    )
    require(
        by_id["cancel_vs_resolve"].get("terminal_outcomes") == 1
        and by_id["cancel_vs_resolve"].get("no_resurrection") is True,
        "cancel/resolve race must have one terminal winner",
    )
    require(
        by_id["terminal_waiter_race"].get("resumes") == 1
        and by_id["terminal_waiter_race"].get("lost_wakeup") is False,
        "terminal/waiter race must not lose or duplicate resume",
    )
    require(
        by_id["stale_generation"].get("result") == "reject",
        "stale generations must fail closed",
    )
    require(
        by_id["late_after_retire"].get("may_resume_guest") is False,
        "late callback must not resurrect guest work",
    )
    require(
        by_id["provenance_not_authority"].get("active_execution_authority") is False,
        "callback provenance must not grant active execution authority",
    )
    require(
        by_id["trace_boundary"].get("boundary") == "HOST_CALLBACK"
        and by_id["trace_boundary"].get("preserve_lineage") is True
        and by_id["trace_boundary"].get("producer_is_guest_owner") is False,
        "callback trace boundary semantics drift",
    )
    require(
        by_id["await_boundary"].get("boundary") == "AWAIT"
        and by_id["await_boundary"].get("fresh_resume_dispatch") is True,
        "await boundary must preserve fresh dispatch semantics",
    )
    require(
        by_id["scope_cleanup"].get("after_callback_current_context")
        == "previous_or_none",
        "callback scope cleanup semantics drift",
    )
    require(
        by_id["bounded_retention"].get("waiter_detached") is True
        and by_id["bounded_retention"].get("unbounded_growth") is False,
        "callback retention must remain bounded",
    )

    print(
        "EXECUTION_CONTEXT_CALLBACK_PARITY_V1_PASS "
        f"cases={len(cases)} contract={EXPECTED_CONTRACT_BLOB} "
        f"vectors={EXPECTED_VECTOR_BLOB}"
    )


if __name__ == "__main__":
    main()
