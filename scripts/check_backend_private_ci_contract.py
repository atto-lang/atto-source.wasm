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



_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*\Z")
_SIMPLE = re.compile(r"[A-Za-z0-9_.@/(), *-]+\Z")
CHECKOUT = "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683"
EXPECTED_WORKFLOW = {
    "name": "Backend private CI contract",
    "on": {"push": {"branches": ["main"]}, "pull_request": None,
           "workflow_dispatch": None},
    "permissions": {"contents": "read"},
    "jobs": {"policy-parity": {
        "runs-on": "ubuntu-24.04", "timeout-minutes": 5,
        "steps": [
            {"name": "Checkout same private repository without credentials",
             "uses": CHECKOUT, "with": {"persist-credentials": False}},
            {"name": "Adversarial policy and workflow regression tests",
             "run": "python3 -m unittest discover -s tests -p test_backend_private_ci_contract.py -v"},
            {"name": "Exercise compiler-admission harness controls (mock-only, no native proof)",
             "run": "python3 -m unittest discover -s tests -p test_guest_capability_admission.py -v"},
            {"name": "Validate immutable repository identity and shared deny-by-default contract",
             "run": "python3 scripts/check_backend_private_ci_contract.py --backend \"${GITHUB_REPOSITORY##*.}\"\n"},
        ],
    }},
}

def parse_strict_workflow_yaml(raw):
    """Parse only the reviewed safe YAML subset into mappings, lists and scalars.

    Reject anchors, tags, merges, duplicate keys, quoted keys, directives,
    flow mappings, tabs, nested block scalars and unexpected indentation.
    No third-party packages are needed on the runner.
    """
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > 32 * 1024:
        raise ValueError("workflow integrity: unsupported YAML size")
    if "\t" in raw or "\r" in raw or "\x00" in raw or "\ufeff" in raw:
        raise ValueError("workflow integrity: unsupported YAML encoding")
    tokens = []
    for lineno, source in enumerate(raw.splitlines(), 1):
        if any(ord(c) < 32 for c in source):
            raise ValueError("workflow integrity: control character")
        if not source.strip() or source.lstrip().startswith("#"):
            continue
        indent = len(source) - len(source.lstrip(" "))
        if indent % 2:
            raise ValueError("workflow integrity: bad indentation")
        line = re.split(r"\s+#", source[indent:], maxsplit=1)[0].rstrip()
        if not line:
            continue
        if line in ("---", "...") or line.startswith(("%", "<<:", "&", "*", "!")):
            raise ValueError("workflow integrity: unsupported YAML feature")
        tokens.append((indent, line, lineno))
    if not tokens or tokens[0][0] != 0:
        raise ValueError("workflow integrity: missing root mapping")

    def scalar(value):
        if value == "":
            return None
        if value == "true":
            return True
        if value == "false":
            return False
        if value.isdecimal():
            return int(value)
        if value == "[main]":
            return ["main"]
        if value in ("|", ">"):
            raise ValueError("workflow integrity: unexpected block scalar")
        if not _SIMPLE.fullmatch(value) or any(c in value for c in
            ("&", "*", "!", "{", "}", "[", "]", "\x60", "\\", "'", '"')):
            raise ValueError("workflow integrity: unsupported YAML scalar")
        return value

    def header(value):
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?", value)
        if not match or not _KEY.fullmatch(match.group(1)):
            raise ValueError("workflow integrity: invalid mapping key")
        return match.group(1), match.group(2) or ""

    def block(index, parent_indent):
        if index >= len(tokens) or tokens[index][0] <= parent_indent:
            raise ValueError("workflow integrity: empty block scalar")
        content_indent = tokens[index][0]
        chunks = []
        while index < len(tokens) and tokens[index][0] > parent_indent:
            if tokens[index][0] != content_indent:
                raise ValueError("workflow integrity: nested block scalar")
            chunks.append(tokens[index][1])
            index += 1
        return "\n".join(chunks) + "\n", index

    def node(index, indent):
        if index >= len(tokens) or tokens[index][0] != indent:
            raise ValueError("workflow integrity: illegal nesting")
        if tokens[index][1].startswith("- "):
            result = []
            while index < len(tokens) and tokens[index][0] == indent:
                line = tokens[index][1]
                if not line.startswith("- "):
                    raise ValueError("workflow integrity: mixed list/map")
                key, value = header(line[2:])
                entry = {key: scalar(value)}
                index += 1
                if index < len(tokens) and tokens[index][0] > indent:
                    if tokens[index][0] != indent + 2:
                        raise ValueError("workflow integrity: bad list indentation")
                    rest, index = node(index, indent + 2)
                    if type(rest) is not dict or any(k in entry for k in rest):
                        raise ValueError("workflow integrity: duplicate list entry key")
                    entry.update(rest)
                result.append(entry)
            return result, index
        result = {}
        while index < len(tokens) and tokens[index][0] == indent:
            key, value = header(tokens[index][1])
            if key in result:
                raise ValueError("workflow integrity: duplicate YAML key " + key)
            index += 1
            if value == "|":
                item, index = block(index, indent)
            elif value:
                item = scalar(value)
                if index < len(tokens) and tokens[index][0] > indent:
                    raise ValueError("workflow integrity: child of scalar")
            elif index < len(tokens) and tokens[index][0] > indent:
                if tokens[index][0] != indent + 2:
                    raise ValueError("workflow integrity: bad map indentation")
                item, index = node(index, indent + 2)
            else:
                item = None
            result[key] = item
        return result, index

    result, index = node(0, 0)
    if type(result) is not dict or index != len(tokens):
        raise ValueError("workflow integrity: invalid trailing YAML")
    return result


def validate_workflow(raw):
    if parse_strict_workflow_yaml(raw) != EXPECTED_WORKFLOW:
        raise ValueError("workflow integrity: unsafe YAML AST")
    if hashlib.sha256(raw.encode("utf-8")).hexdigest() != WORKFLOW_SHA256:
        raise ValueError("workflow integrity: reviewed SHA-256 mismatch")
    return True



def strict_json_document(path, *, limit=2 * 1024 * 1024):
    """Load bounded JSON while rejecting ambiguous keys and nonstandard constants."""
    with open(path, "rb") as source:
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ValueError("security JSON exceeds size limit")

    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate security JSON key: " + key)
            result[key] = value
        return result

    def deny_constant(value):
        raise ValueError("nonstandard security JSON number: " + value)

    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=unique_pairs,
                          parse_constant=deny_constant)
    except UnicodeDecodeError as error:
        raise ValueError("invalid security JSON encoding") from error



def strict_contract_equal(actual, expected):
    """Compare security policy values without bool/int equivalence."""
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, dict):
        return (actual.keys() == expected.keys() and
                all(strict_contract_equal(actual[k], value)
                    for k, value in expected.items()))
    if isinstance(expected, list):
        return (len(actual) == len(expected) and
                all(strict_contract_equal(a, b) for a, b in zip(actual, expected)))
    return actual == expected


def verify(backend):
    if backend not in IDS:
        raise ValueError("unknown Oreslang backend")
    doc = strict_json_document(MANIFEST)
    if (type(doc) is not dict or type(doc.get("schema_version")) is not int
            or doc.get("schema_version") != 1
            or doc.get("contract") != CONTRACT
            or doc.get("organization") != "ores-truffle-oreslang"
            or not strict_contract_equal(doc.get("repository_ids"), IDS)):
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
    if any(not strict_contract_equal(doc.get(section), content)
           for section, content in expected.items()):
        raise ValueError("critical deny-by-default/evidence invariants changed")
    if set(doc) != {"schema_version", "contract", "organization",
                    "repository_ids", *expected}:
        raise ValueError("unknown top-level contract fields")

    validate_workflow(WORKFLOW.read_text(encoding="utf-8"))
    if os.getenv("GITHUB_ACTIONS") == "true":
        name = "ores-truffle-oreslang/oreslang-source." + backend
        if os.getenv("GITHUB_REPOSITORY") != name:
            raise ValueError("untrusted repository slug")
        if os.getenv("GITHUB_REPOSITORY_ID") != str(IDS[backend]):
            raise ValueError("untrusted immutable repository ID")
        event_path = os.getenv("GITHUB_EVENT_PATH")
        if not event_path:
            raise ValueError("GitHub repository event identity unavailable")
        event = strict_json_document(Path(event_path))
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
