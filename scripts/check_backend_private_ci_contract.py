#!/usr/bin/env python3
"""Read-only contract drift check shared verbatim by five Oreslang backends.

This checks repository/CI policy metadata; it does not grant permissions,
copy private source, or prove a missing runtime feature has been implemented.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys

IDS = {"java": 1400792274, "llvm": 1410897874,
       "net": 1419704375, "wasm": 1419858954, "forge": 1419703674}
CONTRACT = "oreslang-backend-private-ci-security"
WORKFLOW = Path(".github/workflows/backend-private-ci-contract.yml")
WORKFLOW_SHA256 = "e93fe9d4c65d3d7afd5550fa63cacc44f33c498ce3d951c5f9eb07d85d50d083"
MANIFEST = Path("contracts/private-ci-security.v1.json")


def verify(backend):
    if backend not in IDS:
        raise ValueError("unknown Oreslang backend")
    doc = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if (type(doc) is not dict or doc.get("schema_version") != 1
            or doc.get("contract") != CONTRACT
            or doc.get("organization") != "ores-truffle-oreslang"
            or doc.get("repository_ids") != IDS):
        raise ValueError("security contract identity or schema drift")
    expected = {
        "source_transfer": {
            "default_deny": True,
            "private_destination_only": True,
            "require_destination_approval_on_protected_source_main": True,
            "require_independent_security_code_owner_review": True,
            "require_pinned_numeric_repo_ids": True,
            "require_exact_source_commit_and_complete_git_tree": True,
            "require_destination_blob_tree_commit_ref_attestation": True,
            "never_infer_approval_from_actions_minutes": True,
        },
        "runtime_gate": {
            "ambient_file_network_process_env_and_ffi_authority":
                "denied_without_explicit_capability",
            "unsupported_features": "reject_before_guest_execution",
            "actor_messages": "must_preserve_owned_sendable_boundary_where_implemented",
            "no_claim_of_os_sandbox_without_os_enforcement": True,
        },
        "validation_evidence": {
            "exact_tested_commit_and_tree_required": True,
            "runner_executed_steps_required": True,
            "offline_structural_checks_not_equivalent_to_native_backend_tests": True,
            "cross_backend_feature_parity_not_assumed": True,
        },
    }
    if any(doc.get(section) != content for section, content in expected.items()):
        raise ValueError("critical deny-by-default/evidence invariants changed")
    if set(doc) != {"schema_version", "contract", "organization",
                    "repository_ids", *expected}:
        raise ValueError("unknown top-level contract fields")

    wf = WORKFLOW.read_text(encoding="utf-8")
    # Substring checks alone can be satisfied by comments or dead shell text.
    # Pin the entire reviewed workflow, including test execution and triggers.
    if hashlib.sha256(wf.encode("utf-8")).hexdigest() != WORKFLOW_SHA256:
        raise ValueError("workflow integrity differs from reviewed policy")
    if "pull_request_target:" in wf or "workflow_run:" in wf:
        raise ValueError("privileged PR or upstream event not allowed")
    if "permissions:\n  contents: read\n" not in wf:
        raise ValueError("token must be explicitly read-only")
    if len(re.findall(r"(?m)^\s*permissions:", wf)) != 1:
        raise ValueError("workflow permissions overrides are forbidden")
    checkout = re.findall(r"(?m)^\s+- uses: actions/checkout@([a-f0-9]{40})", wf)
    if checkout != ["11bd71901bbe5b1630ceea73d27597364c9af683"]:
        raise ValueError("require one SHA-pinned own-repo checkout")
    if wf.count("persist-credentials: false") != 1:
        raise ValueError("checkout must never retain credentials")
    if "python3 scripts/check_backend_private_ci_contract.py" not in wf:
        raise ValueError("workflow must actually execute contract check")
    if "uses: ./" in wf or "repository:" in wf:
        raise ValueError("unexpected reusable workflow or cross-repo checkout")

    if os.getenv("GITHUB_ACTIONS") == "true":
        name = "ores-truffle-oreslang/oreslang-source." + backend
        if os.getenv("GITHUB_REPOSITORY") != name:
            raise ValueError("untrusted repository slug")
        if os.getenv("GITHUB_REPOSITORY_ID") != str(IDS[backend]):
            raise ValueError("untrusted immutable repository ID")
        event_path = os.getenv("GITHUB_EVENT_PATH")
        if not event_path:
            raise ValueError("GitHub repository event identity unavailable")
        event = json.loads(Path(event_path).read_text(encoding="utf-8"))
        repo = event.get("repository")
        if (not isinstance(repo, dict) or repo.get("private") is not True
                or type(repo.get("id")) is not int
                or repo.get("id") != IDS[backend]
                or repo.get("full_name") != name):
            raise ValueError("GitHub event identifies the wrong/private-status repository")
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", required=True, choices=sorted(IDS))
    args = parser.parse_args()
    try:
        verify(args.backend)
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print("BACKEND_PRIVATE_CI_CONTRACT_FAILED: " + str(error), file=sys.stderr)
        return 1
    print("BACKEND_PRIVATE_CI_CONTRACT_OK: " + args.backend)
    return 0


if __name__ == "__main__":
    sys.exit(main())
