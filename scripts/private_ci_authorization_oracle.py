#!/usr/bin/env python3
"""Source-free private-CI authorization oracle shared by all Oreslang backends.

CLI output is intentionally only ALLOW or DENY. ALLOW means the synthetic policy
input satisfies the canonical authorization contract; it is never itself a
source-transfer authorization.
"""
import json
from pathlib import Path
import re
import sys

CONTRACT_PATH = Path(__file__).resolve().parents[1] / "contracts/private-ci-authority-v1.json"
HEX40 = re.compile(r"^[0-9a-f]{40}$")
REPO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$")

class Denied(RuntimeError):
    pass

def _unique_object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise Denied("duplicate JSON key")
        out[key] = value
    return out

def _loads(raw):
    try:
        return json.loads(raw, object_pairs_hook=_unique_object)
    except (json.JSONDecodeError, UnicodeError, RecursionError, ValueError) as exc:
        if isinstance(exc, Denied):
            raise
        raise Denied("invalid JSON") from exc

def load_contract(path=CONTRACT_PATH):
    doc = _loads(Path(path).read_text(encoding="utf-8"))
    required = {
        "schema","contract","incident_repository","incident_repository_id",
        "blocking_incidents","quarantined_destinations",
        "backend_transfer_capability","required_gates",
    }
    if (not isinstance(doc, dict) or set(doc) != required
            or doc.get("schema") != 1
            or doc.get("contract") != "ores-private-ci-authority-v1"
            or doc.get("incident_repository") != "ores-truffle-oreslang/oreslang-platform-conformance"
            or doc.get("incident_repository_id") != 1413795502):
        raise Denied("contract identity mismatch")
    expected_incidents = {
        22:5832921751,77:5904679716,127:5935338521,
        171:6042555082,172:6042602777,198:6070465058,
        200:6071264936,212:6087989978,222:6092501448,
    }
    incidents = doc["blocking_incidents"]
    if (not isinstance(incidents,list) or len(incidents) != len(expected_incidents)
            or {x.get("number"):x.get("issue_id") for x in incidents if isinstance(x,dict)} != expected_incidents
            or any(set(x) != {"number","issue_id"} for x in incidents if isinstance(x,dict))):
        raise Denied("incident set mismatch")
    expected_quarantine = {
        "zed-pkg-test/java-app":(1323575966,(22,)),
        "scintilla-run-test/gleam-runner-conformance":(1323598260,(77,)),
        "ores-dummy-org-oreslang-stack/ores-dummy-org-oreslang-stack-infra":(1412142815,(127,)),
        "agent-pontifex-test/agent-pontifex-e2e-tests":(1370782550,(171,)),
        "led-dynamo/leddy-e2e":(1324139596,(172,)),
        "ClaimGraph-test/claimgraph-e2e":(1350751074,(198,200)),
    }
    actual = {}
    ids = set()
    folded = set()
    for item in doc["quarantined_destinations"]:
        if not isinstance(item,dict) or set(item) != {"repository","repository_id","incidents"}:
            raise Denied("quarantine entry shape")
        name=item["repository"]; repo_id=item["repository_id"]; refs=item["incidents"]
        key=name.casefold() if isinstance(name,str) else None
        if (not isinstance(name,str) or REPO.fullmatch(name) is None
                or key in folded or type(repo_id) is not int or repo_id <= 0
                or repo_id in ids or not isinstance(refs,list)):
            raise Denied("quarantine identity invalid")
        folded.add(key); ids.add(repo_id); actual[name]=(repo_id,tuple(refs))
    if actual != expected_quarantine:
        raise Denied("quarantine set mismatch")
    capability=doc["backend_transfer_capability"]
    if capability != {"java":True,"llvm":True,"net":False,"wasm":False,"forge":False}:
        raise Denied("backend capability mismatch")
    gates=doc["required_gates"]
    if not isinstance(gates,list) or not gates or len(gates) != len(set(gates)):
        raise Denied("required gate set invalid")
    return doc

SCENARIO_KEYS = {
    "backend","destination_repository","destination_repository_id",
    "approved_destination_repository","approved_destination_repository_id",
    "private_destination","destination_fork","destination_archived",
    "destination_disabled","destination_default_branch",
    "source_head_sha","reviewed_source_head_sha",
    "source_root_tree_sha","reviewed_source_root_tree_sha",
    "source_main_protected","carrier_main_protected",
    "destination_allowlisted","snapshot_approved",
    "independent_security_approval_exact_head","all_incidents_resolved",
    "disposition_comments_verified","ownership_verified","visibility_verified",
    "permissions_verified","retention_verified","codeowner_review",
    "dismiss_stale_reviews","last_push_approval","conversation_resolution",
    "required_checks_app_bound","admins_enforced","no_review_bypass",
    "no_force_push","no_delete","source_write_reauthorization",
}

BOOL_KEYS = SCENARIO_KEYS - {
    "backend","destination_repository","destination_repository_id",
    "approved_destination_repository","approved_destination_repository_id",
    "destination_default_branch","source_head_sha","reviewed_source_head_sha",
    "source_root_tree_sha","reviewed_source_root_tree_sha",
}

def authorize(scenario, contract=None):
    contract = contract or load_contract()
    if not isinstance(scenario,dict) or set(scenario) != SCENARIO_KEYS:
        return False
    if scenario.get("backend") not in contract["backend_transfer_capability"]:
        return False
    if contract["backend_transfer_capability"][scenario["backend"]] is not True:
        return False
    for key in BOOL_KEYS:
        if type(scenario.get(key)) is not bool:
            return False
    repo=scenario["destination_repository"]
    approved=scenario["approved_destination_repository"]
    repo_id=scenario["destination_repository_id"]
    approved_id=scenario["approved_destination_repository_id"]
    if (not isinstance(repo,str) or REPO.fullmatch(repo) is None
            or not isinstance(approved,str) or REPO.fullmatch(approved) is None
            or type(repo_id) is not int or repo_id <= 0
            or type(approved_id) is not int or approved_id <= 0
            or repo.casefold() != approved.casefold() or repo_id != approved_id):
        return False
    quarantined_names={x["repository"].casefold() for x in contract["quarantined_destinations"]}
    quarantined_ids={x["repository_id"] for x in contract["quarantined_destinations"]}
    if repo.casefold() in quarantined_names or repo_id in quarantined_ids:
        return False
    if scenario["destination_default_branch"] != "main":
        return False
    for key in ("source_head_sha","reviewed_source_head_sha","source_root_tree_sha","reviewed_source_root_tree_sha"):
        if not isinstance(scenario.get(key),str) or HEX40.fullmatch(scenario[key]) is None:
            return False
    if scenario["source_head_sha"] != scenario["reviewed_source_head_sha"]:
        return False
    if scenario["source_root_tree_sha"] != scenario["reviewed_source_root_tree_sha"]:
        return False
    if not scenario["private_destination"] or scenario["destination_fork"]:
        return False
    if scenario["destination_archived"] or scenario["destination_disabled"]:
        return False
    required_true = [
        "source_main_protected","carrier_main_protected",
        "destination_allowlisted","snapshot_approved",
        "independent_security_approval_exact_head","all_incidents_resolved",
        "disposition_comments_verified","ownership_verified","visibility_verified",
        "permissions_verified","retention_verified","codeowner_review",
        "dismiss_stale_reviews","last_push_approval","conversation_resolution",
        "required_checks_app_bound","admins_enforced","no_review_bypass",
        "no_force_push","no_delete","source_write_reauthorization",
    ]
    return all(scenario[key] is True for key in required_true)

def main(argv):
    if len(argv) != 2:
        print("DENY")
        return 2
    try:
        scenario=_loads(Path(argv[1]).read_text(encoding="utf-8"))
        allowed=authorize(scenario)
    except Exception:
        allowed=False
    print("ALLOW" if allowed else "DENY")
    return 0 if allowed else 1

if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
