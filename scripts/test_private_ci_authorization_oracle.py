#!/usr/bin/env python3
import copy
import importlib.util
from pathlib import Path
import unittest

SCRIPT=Path(__file__).with_name("private_ci_authorization_oracle.py")
SPEC=importlib.util.spec_from_file_location("private_ci_authorization_oracle",SCRIPT)
oracle=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(oracle)

def good(backend="java"):
    return {
        "backend":backend,
        "destination_repository":"trusted-org/private-ci",
        "destination_repository_id":424242,
        "approved_destination_repository":"TRUSTED-ORG/PRIVATE-CI",
        "approved_destination_repository_id":424242,
        "private_destination":True,
        "destination_fork":False,
        "destination_archived":False,
        "destination_disabled":False,
        "destination_default_branch":"main",
        "source_head_sha":"1"*40,
        "reviewed_source_head_sha":"1"*40,
        "source_root_tree_sha":"2"*40,
        "reviewed_source_root_tree_sha":"2"*40,
        "source_main_protected":True,
        "carrier_main_protected":True,
        "destination_allowlisted":True,
        "snapshot_approved":True,
        "independent_security_approval_exact_head":True,
        "all_incidents_resolved":True,
        "disposition_comments_verified":True,
        "ownership_verified":True,
        "visibility_verified":True,
        "permissions_verified":True,
        "retention_verified":True,
        "codeowner_review":True,
        "dismiss_stale_reviews":True,
        "last_push_approval":True,
        "conversation_resolution":True,
        "required_checks_app_bound":True,
        "admins_enforced":True,
        "no_review_bypass":True,
        "no_force_push":True,
        "no_delete":True,
        "source_write_reauthorization":True,
    }

class AuthorityOracleTest(unittest.TestCase):
    def test_java_and_llvm_can_only_allow_complete_synthetic_authority(self):
        self.assertTrue(oracle.authorize(good("java")))
        self.assertTrue(oracle.authorize(good("llvm")))

    def test_policy_only_backends_remain_export_disabled(self):
        for backend in ("net","wasm","forge"):
            with self.subTest(backend=backend):
                self.assertFalse(oracle.authorize(good(backend)))

    def test_every_boolean_authority_gate_fails_closed(self):
        sample=good()
        for key in sorted(oracle.BOOL_KEYS):
            if key in {"private_destination","destination_fork","destination_archived","destination_disabled"}:
                continue
            case=copy.deepcopy(sample); case[key]=False
            with self.subTest(key=key):
                self.assertFalse(oracle.authorize(case))
        for key,value in (
            ("private_destination",False),
            ("destination_fork",True),
            ("destination_archived",True),
            ("destination_disabled",True),
        ):
            case=copy.deepcopy(sample); case[key]=value
            with self.subTest(key=key):
                self.assertFalse(oracle.authorize(case))

    def test_quarantine_is_case_insensitive_and_id_immutable(self):
        case=good()
        case["destination_repository"]="ZED-PKG-TEST/JAVA-APP"
        case["approved_destination_repository"]="zed-pkg-test/java-app"
        self.assertFalse(oracle.authorize(case))
        case=good()
        case["destination_repository"]="renamed-safe-looking-org/carrier"
        case["approved_destination_repository"]=case["destination_repository"]
        case["destination_repository_id"]=1323575966
        case["approved_destination_repository_id"]=1323575966
        self.assertFalse(oracle.authorize(case))

    def test_destination_identity_must_match_approved_slug_and_id(self):
        case=good(); case["approved_destination_repository_id"]=424243
        self.assertFalse(oracle.authorize(case))
        case=good(); case["approved_destination_repository"]="other/private-ci"
        self.assertFalse(oracle.authorize(case))

    def test_exact_head_and_tree_are_paired(self):
        case=good(); case["reviewed_source_head_sha"]="3"*40
        self.assertFalse(oracle.authorize(case))
        case=good(); case["reviewed_source_root_tree_sha"]="4"*40
        self.assertFalse(oracle.authorize(case))

    def test_main_is_the_only_destination_default_branch(self):
        case=good(); case["destination_default_branch"]="release"
        self.assertFalse(oracle.authorize(case))

    def test_malformed_or_extra_fields_deny(self):
        case=good(); case["unexpected"]=True
        self.assertFalse(oracle.authorize(case))
        case=good(); del case["retention_verified"]
        self.assertFalse(oracle.authorize(case))

    def test_contract_is_exact(self):
        contract=oracle.load_contract()
        self.assertEqual(
            {x["number"] for x in contract["blocking_incidents"]},
            {22,77,127,171,172,198,200,212,222},
        )
        self.assertEqual(len(contract["quarantined_destinations"]),6)

if __name__=="__main__":
    unittest.main(verbosity=2)
