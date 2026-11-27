#!/usr/bin/env python3
"""Source-free unit tests for the WebAssembly private-CI v3 publisher."""
import base64
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("publish-private-ci-source-v3.py")
SPEC = importlib.util.spec_from_file_location("wasm_private_ci_v3", SCRIPT)
v3 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(v3)

SOURCE_TREE = "a" * 40
BASE_TREE = "b" * 40
CARRIER_COMMIT = "c" * 40
BASE = "d" * 40
WORKFLOW = "e" * 40
PLAN_BLOB = None
PROTECTED = "1" * 40
DATA = b"synthetic WebAssembly source\n"
BLOB = v3.git_blob_sha(DATA)
PLAN = (
    json.dumps(
        {
            "schema": "ores-private-ci-test-plan-v1",
            "source_repo": v3.SOURCE_REPO,
            "allowed_prs": [145],
            "commands": [
                {
                    "argv": ["python3", "-c", "print('ok')"],
                    "cwd": ".",
                    "timeout_seconds": 30,
                }
            ],
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    + "\n"
).encode()
PLAN_BLOB = v3.git_blob_sha(PLAN)
CARRIER_CODEOWNERS = (
    b"* @ORESoftware\n"
    b"/.github/ @ORESoftware\n"
    b"/.github/CODEOWNERS @ORESoftware\n"
)
CARRIER_CODEOWNERS_BLOB = v3.git_blob_sha(CARRIER_CODEOWNERS)


def carrier_contract(review_pr=None):
    value = {
        "repository_id": 1323598177,
        "base_sha": BASE,
        "workflow_path": ".github/workflows/oreslang-exact-tree-carrier.yml",
        "workflow_blob_sha": WORKFLOW,
        "test_plan_path": "ci/test-plans/wasm-pr145.json",
        "test_plan_blob_sha": PLAN_BLOB,
    }
    if review_pr is not None:
        value["review_pr"] = review_pr
    return value


class WasmPrivateCiV3Test(unittest.TestCase):
    def test_incident_gate_requires_exact_completed_identity(self):
        def issue(number, issue_id, state="closed", reason="completed", url=None):
            return {
                "id": issue_id,
                "number": number,
                "html_url": url or (
                    "https://github.com/ores-truffle-oreslang/"
                    f"oreslang-platform-conformance/issues/{number}"
                ),
                "state": state,
                "state_reason": reason,
            }

        good = {
            22: issue(22, 5832921751),
            77: issue(77, 5904679716),
            127: issue(127, 5935338521),
        }

        def api_for(values):
            def api(route, method="GET", payload=None):
                prefix = f"repos/{v3.INCIDENT_REPO}/issues/"
                if method == "GET" and route.startswith(prefix):
                    return values[int(route[len(prefix):])]
                raise AssertionError((method, route))
            return api

        with patch.object(v3, "gh_api", side_effect=api_for(good)):
            self.assertTrue(v3.require_incident_closure())

        cases = []
        opened = dict(good)
        opened[22] = issue(22, 5832921751, state="open", reason=None)
        cases.append(opened)
        wrong_reason = dict(good)
        wrong_reason[77] = issue(77, 5904679716, reason="not_planned")
        cases.append(wrong_reason)
        wrong_id = dict(good)
        wrong_id[127] = issue(127, 1)
        cases.append(wrong_id)
        wrong_url = dict(good)
        wrong_url[22] = issue(22, 5832921751, url="https://github.com/other/repo/issues/22")
        cases.append(wrong_url)
        pr_object = dict(good)
        pr_object[77] = {**issue(77, 5904679716), "pull_request": {}}
        cases.append(pr_object)

        for values in cases:
            with self.subTest(values=values):
                with patch.object(v3, "gh_api", side_effect=api_for(values)):
                    with self.assertRaisesRegex(v3.Denied, "not independently completed"):
                        v3.require_incident_closure()

    def test_allowlist_is_exact_and_fail_closed(self):
        self.assertEqual(
            v3.parse_allowlist(b"# x\ntrusted/ci 42\n", "trusted/ci"),
            42,
        )
        for raw in (
            b"# empty\n",
            b"trusted/* 42\n",
            b"trusted/ci\n",
            b"trusted/ci 0\n",
            b"trusted/ci 42 \n",
            b"trusted/ci 42\nTRUSTED/CI 43\n",
            b"trusted/ci 42\nother/ci 42\n",
        ):
            with self.subTest(raw=raw), self.assertRaises(v3.Denied):
                v3.parse_allowlist(raw, "trusted/ci")

    def test_contract_pins_repo_base_workflow_plan_and_pr(self):
        raw = json.dumps(
            {
                "schema": 1,
                "carriers": {
                    "trusted/ci": {
                        "repository_id": 42,
                        "base_sha": BASE,
                        "workflow_path": ".github/workflows/oreslang-exact-tree-carrier.yml",
                        "workflow_blob_sha": WORKFLOW,
                        "review_pr": 17,
                        "test_plans": {
                            "ci/test-plans/wasm-pr145.json": {
                                "blob_sha": PLAN_BLOB,
                                "allowed_prs": [145],
                            }
                        },
                    }
                },
            }
        ).encode()
        got = v3.parse_contract(
            raw, "trusted/ci", 145, "ci/test-plans/wasm-pr145.json"
        )
        self.assertEqual(got["repository_id"], 42)
        self.assertEqual(got["base_sha"], BASE)
        self.assertEqual(got["workflow_blob_sha"], WORKFLOW)
        self.assertEqual(got["review_pr"], 17)
        with self.assertRaisesRegex(v3.Denied, "not authorized"):
            v3.parse_contract(
                raw, "trusted/ci", 146, "ci/test-plans/wasm-pr145.json"
            )

    def test_strict_json_rejects_duplicate_and_nonfinite_values(self):
        with self.assertRaisesRegex(v3.Denied, "duplicate JSON key"):
            v3.strict_json_loads('{"x":1,"x":2}', "fixture")
        with self.assertRaisesRegex(v3.Denied, "nonfinite"):
            v3.strict_json_loads('{"x":NaN}', "fixture")
        with self.assertRaisesRegex(v3.Denied, "nonfinite"):
            v3.strict_json_loads('{"x":1e9999}', "fixture")

    def test_reviewed_plan_is_validated_before_source_tree_read(self):
        meta = v3.validate_test_plan(PLAN, 145)
        self.assertEqual(meta["sha256"], hashlib.sha256(PLAN).hexdigest())
        self.assertFalse(meta["uses_maven"])
        self.assertEqual(meta["required_source_blobs"], {})
        self.assertIsNone(meta["required_source_head_sha"])
        self.assertIsNone(meta["required_source_root_tree_sha"])

        malformed = json.loads(PLAN)
        malformed["commands"][0]["argv"] = ["bash", "-lc", "cat /etc/passwd"]
        raw = (json.dumps(malformed) + "\n").encode()
        with self.assertRaisesRegex(v3.Denied, "command invalid"):
            v3.validate_test_plan(raw, 145)

    def test_reviewed_plan_snapshot_pins_are_paired_and_exact(self):
        doc = json.loads(PLAN)
        doc["required_source_head_sha"] = "9" * 40
        doc["required_source_root_tree_sha"] = SOURCE_TREE
        raw = (json.dumps(doc) + "\n").encode()
        meta = v3.validate_test_plan(raw, 145)
        self.assertEqual(meta["required_source_head_sha"], "9" * 40)
        self.assertEqual(meta["required_source_root_tree_sha"], SOURCE_TREE)
        v3.verify_required_source_snapshot(meta, "9" * 40)
        v3.verify_required_source_snapshot(meta, "9" * 40, SOURCE_TREE)

        with self.assertRaisesRegex(v3.Denied, "source head differs"):
            v3.verify_required_source_snapshot(meta, "8" * 40)
        with self.assertRaisesRegex(v3.Denied, "source root tree differs"):
            v3.verify_required_source_snapshot(meta, "9" * 40, "8" * 40)

        for missing in ("required_source_head_sha", "required_source_root_tree_sha"):
            bad = json.loads(json.dumps(doc))
            del bad[missing]
            with self.subTest(missing=missing), self.assertRaisesRegex(
                    v3.Denied, "snapshot pins must be paired"):
                v3.validate_test_plan((json.dumps(bad) + "\n").encode(), 145)

        for field in ("required_source_head_sha", "required_source_root_tree_sha"):
            bad = json.loads(json.dumps(doc))
            bad[field] = "not-a-git-sha"
            with self.subTest(field=field), self.assertRaises(v3.Denied):
                v3.validate_test_plan((json.dumps(bad) + "\n").encode(), 145)

    def test_publish_rejects_reviewed_head_drift_before_source_tree_read(self):
        doc = json.loads(PLAN)
        doc["required_source_head_sha"] = "8" * 40
        doc["required_source_root_tree_sha"] = SOURCE_TREE
        raw = (json.dumps(doc) + "\n").encode()
        with (
            patch.object(v3, "protected_authority",
                         return_value=(PROTECTED, carrier_contract())),
            patch.object(v3, "checked_destination",
                         return_value=(BASE_TREE, raw)),
            patch.object(v3, "exact_source_tree") as source_tree,
        ):
            with self.assertRaisesRegex(v3.Denied, "source head differs"):
                v3.publish(
                    "trusted/ci", 145, "9" * 40,
                    "ci/test-plans/wasm-pr145.json",
                )
            source_tree.assert_not_called()

    def test_publish_rejects_reviewed_root_tree_drift_before_writes(self):
        doc = json.loads(PLAN)
        doc["required_source_head_sha"] = "9" * 40
        doc["required_source_root_tree_sha"] = "8" * 40
        raw = (json.dumps(doc) + "\n").encode()
        rows = [["src/synthetic.cpp", "100644", BLOB, len(DATA)]]
        manifest = hashlib.sha256(v3.canonical_bytes(rows)).hexdigest()
        with (
            patch.object(v3, "protected_authority",
                         return_value=(PROTECTED, carrier_contract())),
            patch.object(v3, "checked_destination",
                         return_value=(BASE_TREE, raw)),
            patch.object(
                v3, "exact_source_tree",
                return_value=(
                    SOURCE_TREE,
                    [("src/synthetic.cpp", "100644", BLOB, DATA)],
                    rows,
                    manifest,
                ),
            ),
            patch.object(v3, "gh_api") as api,
        ):
            with self.assertRaisesRegex(v3.Denied, "source root tree differs"):
                v3.publish(
                    "trusted/ci", 145, "9" * 40,
                    "ci/test-plans/wasm-pr145.json",
                )
            api.assert_not_called()

    def test_reviewed_plan_allows_exact_cpp_compiler_executables(self):
        for executable in ("g++", "clang++"):
            with self.subTest(executable=executable):
                doc = json.loads(PLAN)
                doc["commands"][0]["argv"] = [executable, "--version"]
                raw = (json.dumps(doc) + "\n").encode()
                meta = v3.validate_test_plan(raw, 145)
                self.assertEqual(meta["sha256"], hashlib.sha256(raw).hexdigest())

        for executable in ("g+", "clang+", "g++-14", "/usr/bin/g++"):
            with self.subTest(executable=executable):
                doc = json.loads(PLAN)
                doc["commands"][0]["argv"] = [executable, "--version"]
                with self.assertRaisesRegex(v3.Denied, "command invalid"):
                    v3.validate_test_plan(
                        (json.dumps(doc) + "\n").encode(), 145
                    )

    def test_reviewed_plan_rejects_wrong_pr_unexpected_fields_and_unsafe_commands(self):
        with self.assertRaisesRegex(v3.Denied, "authorize source PR"):
            v3.validate_test_plan(PLAN, 146)

        doc = json.loads(PLAN)
        doc["network"] = "allow"
        with self.assertRaisesRegex(v3.Denied, "unexpected fields"):
            v3.validate_test_plan((json.dumps(doc) + "\n").encode(), 145)

        for argv in (
            ["sh", "-c", "true"],
            ["bash", "-lc", "true"],
            ["git", "status"],
            ["curl", "https://example.invalid"],
        ):
            with self.subTest(argv=argv):
                doc = json.loads(PLAN)
                doc["commands"][0]["argv"] = argv
                with self.assertRaisesRegex(v3.Denied, "command invalid"):
                    v3.validate_test_plan(
                        (json.dumps(doc) + "\n").encode(), 145
                    )

        doc = json.loads(PLAN)
        doc["commands"][0]["cwd"] = "../escape"
        with self.assertRaisesRegex(v3.Denied, "command invalid"):
            v3.validate_test_plan((json.dumps(doc) + "\n").encode(), 145)

    def test_reviewed_plan_required_source_blob_is_exact(self):
        required_sha = v3.git_blob_sha(DATA)
        doc = json.loads(PLAN)
        doc["required_source_blobs"] = {"src/synthetic.cpp": required_sha}
        meta = v3.validate_test_plan((json.dumps(doc) + "\n").encode(), 145)
        v3.verify_required_source_blobs(
            [("src/synthetic.cpp", "100644", required_sha, DATA)],
            meta["required_source_blobs"],
        )
        with self.assertRaisesRegex(v3.Denied, "required blob"):
            v3.verify_required_source_blobs(
                [("src/synthetic.cpp", "100644", "0" * 40, DATA)],
                meta["required_source_blobs"],
            )

    def test_reviewed_plan_maven_fields_are_fail_closed_and_bounded(self):
        pom = v3.git_blob_sha(b"<project/>\n")
        doc = json.loads(PLAN)
        doc["commands"] = [{
            "argv": ["mvn", "-o", "-C", "-B", "test"],
            "cwd": ".",
            "timeout_seconds": 300,
        }]
        with self.assertRaisesRegex(v3.Denied, "bind exact pom.xml"):
            v3.validate_test_plan((json.dumps(doc) + "\n").encode(), 145)

        no_checksum = json.loads(json.dumps(doc))
        no_checksum["commands"][0]["argv"] = ["mvn", "-o", "-B", "test"]
        with self.assertRaisesRegex(v3.Denied, "strict checksums"):
            v3.validate_test_plan(
                (json.dumps(no_checksum) + "\n").encode(), 145
            )

        doc["maven_pom_blob_sha"] = pom
        doc["maven_prefetch_artifacts"] = [
            "org.apache.maven.surefire:surefire-junit-platform:3.5.2",
        ]
        meta = v3.validate_test_plan((json.dumps(doc) + "\n").encode(), 145)
        self.assertEqual(meta["maven_pom_blob_sha"], pom)

        for arg in (
            "-s/tmp/settings.xml",
            "--settings=/tmp/settings.xml",
            "-Dmaven.repo.local=/tmp/m2",
            "-DskipTests",
        ):
            with self.subTest(arg=arg):
                bad = json.loads(json.dumps(doc))
                bad["commands"][0]["argv"].insert(2, arg)
                with self.assertRaisesRegex(v3.Denied, "trusted build controls"):
                    v3.validate_test_plan(
                        (json.dumps(bad) + "\n").encode(), 145
                    )

        for extras in (
            ["bad"],
            ["g:a:v", "g:a:v"],
            ["g:a:v"] * (v3.MAX_MAVEN_PREFETCH_ARTIFACTS + 1),
        ):
            with self.subTest(extras=extras):
                bad = json.loads(json.dumps(doc))
                bad["maven_prefetch_artifacts"] = extras
                with self.assertRaisesRegex(v3.Denied, "prefetch artifacts"):
                    v3.validate_test_plan(
                        (json.dumps(bad) + "\n").encode(), 145
                    )

    def test_publish_rejects_bad_plan_before_exact_source_tree(self):
        bad = json.loads(PLAN)
        bad["commands"][0]["argv"] = ["bash", "-lc", "true"]
        raw = (json.dumps(bad) + "\n").encode()
        with (
            patch.object(v3, "protected_authority",
                         return_value=(PROTECTED, carrier_contract())),
            patch.object(v3, "checked_destination",
                         return_value=(BASE_TREE, raw)),
            patch.object(v3, "exact_source_tree") as source_tree,
        ):
            with self.assertRaisesRegex(v3.Denied, "command invalid"):
                v3.publish(
                    "trusted/ci", 145, "9" * 40,
                    "ci/test-plans/wasm-pr145.json",
                )
            source_tree.assert_not_called()

    def test_safe_path_requires_canonical_ascii_route(self):
        self.assertEqual(
            v3.safe_path(
                "ci/test-plans/wasm-pr145.json",
                "ci/test-plans/",
                ".json",
            ),
            "ci/test-plans/wasm-pr145.json",
        )
        for value in (
            "ci/test-plans/../x.json",
            "ci/test-plans/x%2fescape.json",
            "ci/test-plans/x.json?ref=other",
            "ci/test-plans//x.json",
            "ci/test-plans/.git/x.json",
        ):
            with self.subTest(value=value), self.assertRaises(v3.Denied):
                v3.safe_path(value, "ci/test-plans/", ".json")

    def test_github_api_environment_requires_exactly_one_explicit_token(self):
        with patch.dict(v3.os.environ, {}, clear=True):
            with self.assertRaisesRegex(v3.Denied, "exactly one"):
                v3.github_api_environment()
        with patch.dict(
            v3.os.environ,
            {"GH_TOKEN": "one", "GITHUB_TOKEN": "two"},
            clear=True,
        ):
            with self.assertRaisesRegex(v3.Denied, "exactly one"):
                v3.github_api_environment()
        with patch.dict(v3.os.environ, {"GH_TOKEN": "one"}, clear=True):
            env = v3.github_api_environment()
        self.assertEqual(env["GH_TOKEN"], "one")
        self.assertEqual(env["PATH"], "/usr/bin:/bin")
        self.assertEqual(env["HOME"], "/")
        self.assertEqual(
            set(env),
            {
                "GH_TOKEN", "GH_HOST", "GH_PROMPT_DISABLED",
                "PATH", "HOME", "XDG_CONFIG_HOME", "LC_ALL",
            },
        )

    def test_carrier_codeowners_require_exact_security_ownership(self):
        v3.require_carrier_security_codeowners(CARRIER_CODEOWNERS)
        with self.assertRaisesRegex(v3.Denied, "fully security-owned"):
            v3.require_carrier_security_codeowners(
                b"* @the1mills\n/.github/ @the1mills\n"
                b"/.github/CODEOWNERS @the1mills\n"
            )

    def test_source_codeowners_require_security_owned_boundaries(self):
        source_codeowners = (
            b"/.github/workflows/ @ORESoftware\n"
            b"/.github/CODEOWNERS @ORESoftware\n"
            b"/.github/private-ci-approved-repositories.txt @ORESoftware\n"
            b"/scripts/ @ORESoftware\n"
        )
        v3.require_source_security_codeowners(source_codeowners)
        with self.assertRaisesRegex(v3.Denied, "security-owner boundaries"):
            v3.require_source_security_codeowners(
                source_codeowners.replace(
                    b"/scripts/ @ORESoftware\n", b"/scripts/ @the1mills\n"
                )
            )

    def test_decode_contents_authenticates_blob_digest(self):
        raw = b"reviewed bytes\n"
        good = {
            "path": "x",
            "type": "file",
            "encoding": "base64",
            "content": base64.b64encode(raw).decode(),
            "sha": v3.git_blob_sha(raw),
        }
        self.assertEqual(v3.decode_contents(good, "x", 1024), raw)
        bad = dict(good, sha="0" * 40)
        with self.assertRaisesRegex(v3.Denied, "blob digest"):
            v3.decode_contents(bad, "x", 1024)

    def test_published_git_objects_are_read_back_exactly(self):
        receipt = "4" * 40
        root = "5" * 40
        source = "6" * 40
        commit = "7" * 40

        def api(route, method="GET", payload=None):
            if route == "repos/trusted/ci/git/commits/" + commit:
                return {
                    "sha": commit,
                    "tree": {"sha": root},
                    "parents": [{"sha": BASE}],
                }
            if route == "repos/trusted/ci/git/trees/" + root + "?recursive=1":
                return {
                    "sha": root,
                    "truncated": False,
                    "tree": [
                        {
                            "path": v3.PREFIX,
                            "mode": "040000",
                            "type": "tree",
                            "sha": source,
                        },
                        {
                            "path": v3.RECEIPT_PATH,
                            "mode": "100644",
                            "type": "blob",
                            "sha": receipt,
                        },
                    ],
                }
            raise AssertionError(route)

        with patch.object(v3, "gh_api", side_effect=api):
            v3.verify_published_root_and_commit(
                "trusted/ci", BASE, source, receipt, root, commit
            )

    def test_handoff_requires_both_refs_absent(self):
        with patch.object(v3, "live_ref_sha", side_effect=[None, None]):
            v3.require_handoff_refs_absent(
                "trusted/ci",
                "ci/oreslang-" + SOURCE_TREE,
                "ci/authorized-" + CARRIER_COMMIT,
                1323598177,
            )
        with patch.object(v3, "live_ref_sha", return_value=CARRIER_COMMIT):
            with self.assertRaisesRegex(v3.Denied, "already exists"):
                v3.require_handoff_refs_absent(
                    "trusted/ci",
                    "ci/oreslang-" + SOURCE_TREE,
                    "ci/authorized-" + CARRIER_COMMIT,
                    1323598177,
                )

    def test_http_status_match_is_first_line_and_exact(self):
        self.assertTrue(v3._is_http_status("gh: Not Found (HTTP 404)\nbody", 404))
        self.assertFalse(v3._is_http_status("body mentions HTTP 404", 404))
        self.assertFalse(v3._is_http_status("gh: Not Found (HTTP 403)", 404))

    def test_bounded_gh_rejects_output_at_limit(self):
        def fake_run(argv, **kwargs):
            kwargs["stdout"].write(b"x" * 8)
            kwargs["stderr"].write(b"")
            return v3.subprocess.CompletedProcess(argv, 0)

        with (
            patch.object(v3, "MAX_GH_API_RESPONSE_BYTES", 8),
            patch.object(v3.subprocess, "run", side_effect=fake_run),
        ):
            with self.assertRaisesRegex(v3.Denied, "exceeds size limit"):
                v3.run_bounded_gh(["/usr/bin/gh"], env={}, timeout=1)

    def test_contract_rejects_invalid_carrier_review_pr(self):
        raw = json.dumps(
            {
                "schema": 1,
                "carriers": {
                    "trusted/ci": {
                        "repository_id": 42,
                        "base_sha": BASE,
                        "workflow_path": ".github/workflows/oreslang-exact-tree-carrier.yml",
                        "workflow_blob_sha": WORKFLOW,
                        "review_pr": 0,
                        "test_plans": {
                            "ci/test-plans/wasm-pr145.json": {
                                "blob_sha": PLAN_BLOB,
                                "allowed_prs": [145],
                            }
                        },
                    }
                },
            }
        ).encode()
        with self.assertRaisesRegex(v3.Denied, "review PR"):
            v3.parse_contract(
                raw, "trusted/ci", 145, "ci/test-plans/wasm-pr145.json"
            )

    def test_authorized_source_main_rejects_unprotected_main(self):
        def api(route, method="GET", payload=None):
            if route == f"repos/{v3.SOURCE_REPO}/branches/{v3.SOURCE_BRANCH}":
                return {
                    "name": v3.SOURCE_BRANCH,
                    "protected": False,
                    "commit": {"sha": "2" * 40},
                }
            raise AssertionError(route)
        with (
            patch.object(v3, "gh_api", side_effect=api),
            patch.object(v3, "source_protection") as protected,
        ):
            with self.assertRaisesRegex(v3.Denied, "not protected"):
                v3.authorized_source_main_sha()
        protected.assert_not_called()

    def test_authorized_source_main_uses_protected_origin_only(self):
        def api(route, method="GET", payload=None):
            if route == f"repos/{v3.SOURCE_REPO}/branches/{v3.SOURCE_BRANCH}":
                return {
                    "name": v3.SOURCE_BRANCH,
                    "protected": True,
                    "commit": {"sha": "2" * 40},
                }
            raise AssertionError(route)
        with (
            patch.object(v3, "gh_api", side_effect=api),
            patch.object(v3, "source_protection",
                         return_value="2" * 40) as protected,
        ):
            self.assertEqual(v3.authorized_source_main_sha(), "2" * 40)
        protected.assert_called_once_with()

    def _carrier_review_fixture(self, *, author_id=424242,
                                state="APPROVED", review_commit=None):
        contract = carrier_contract(review_pr=17)
        head_sha = "7" * 40
        review_commit = head_sha if review_commit is None else review_commit
        branch = {
            "name": "main",
            "protected": False,
            "commit": {"sha": BASE},
        }

        def api(route, method="GET", payload=None):
            if route == "repos/trusted/ci/branches/main":
                return branch
            if route == "repos/trusted/ci/pulls/17":
                return {
                    "number": 17,
                    "state": "closed",
                    "merged_at": "2026-10-25T15:00:00Z",
                    "user": {"id": author_id, "login": "carrier-author"},
                    "head": {
                        "sha": head_sha,
                        "repo": {
                            "full_name": "trusted/ci",
                            "id": contract["repository_id"],
                        },
                    },
                    "base": {
                        "ref": "main",
                        "repo": {
                            "full_name": "trusted/ci",
                            "id": contract["repository_id"],
                        },
                    },
                }
            if route == "repos/trusted/ci/contents/.github/CODEOWNERS?ref=" + BASE:
                return {
                    "path": ".github/CODEOWNERS",
                    "type": "file",
                    "encoding": "base64",
                    "content": base64.b64encode(CARRIER_CODEOWNERS).decode(),
                    "sha": CARRIER_CODEOWNERS_BLOB,
                }
            raise AssertionError((method, route))

        review = {
            "id": 92,
            "state": state,
            "commit_id": review_commit,
            "submitted_at": "2026-10-25T14:59:00Z",
            "user": {
                "id": v3.CARRIER_REVIEW_USER_ID,
                "login": v3.CARRIER_REVIEW_LOGIN,
            },
        }
        return contract, branch, api, review, head_sha

    def test_unprotected_carrier_accepts_exact_tree_independent_review(self):
        contract, _branch, api, review, _head = self._carrier_review_fixture()
        with (
            patch.object(v3, "gh_api", side_effect=api),
            patch.object(v3, "_latest_review", return_value=review),
            patch.object(v3, "carrier_commit_tree", side_effect=["8" * 40, "8" * 40]),
        ):
            self.assertEqual(v3.checked_carrier_main("trusted/ci", contract), BASE)

    def test_unprotected_carrier_rejects_stale_author_or_tree_drift(self):
        cases = (
            ({"state": "CHANGES_REQUESTED"}, ["8" * 40, "8" * 40], "stale, late, or not approved"),
            ({"author_id": v3.CARRIER_REVIEW_USER_ID}, ["8" * 40, "8" * 40], "independent merged"),
            ({"author_id": 0}, ["8" * 40, "8" * 40], "independent merged"),
            ({}, ["8" * 40, "9" * 40], "tree differs"),
        )
        for kwargs, trees, message in cases:
            with self.subTest(kwargs=kwargs, trees=trees):
                contract, _branch, api, review, _head = self._carrier_review_fixture(**kwargs)
                with (
                    patch.object(v3, "gh_api", side_effect=api),
                    patch.object(v3, "_latest_review", return_value=review),
                    patch.object(v3, "carrier_commit_tree", side_effect=trees),
                ):
                    with self.assertRaisesRegex(v3.Denied, message):
                        v3.checked_carrier_main("trusted/ci", contract)

    def test_recheck_destination_identity_rejects_carrier_main_movement(self):
        contract = carrier_contract(review_pr=17)
        eligible = {
            "id": contract["repository_id"],
            "full_name": "trusted/ci",
            "private": True,
            "visibility": "private",
        }
        with patch.object(v3, "gh_api", side_effect=[
            eligible,
            {"name": "main", "commit": {"sha": contract["base_sha"]}},
        ]):
            v3.recheck_destination_identity("trusted/ci", contract)
        with patch.object(v3, "gh_api", side_effect=[
            eligible,
            {"name": "main", "commit": {"sha": "9" * 40}},
        ]):
            with self.assertRaisesRegex(v3.Denied, "main changed"):
                v3.recheck_destination_identity("trusted/ci", contract)

    def test_carrier_main_requires_protection_and_codeowner_review(self):
        good_protection = {
            "required_pull_request_reviews": {
                "require_code_owner_reviews": True,
                "dismiss_stale_reviews": True,
                "required_approving_review_count": 1,
                "bypass_pull_request_allowances": {
                    "users": [], "teams": [], "apps": []
                },
            },
            "enforce_admins": {"enabled": True},
            "allow_force_pushes": {"enabled": False},
            "allow_deletions": {"enabled": False},
        }

        def good_api(route, method="GET", payload=None):
            if route == "repos/trusted/ci/branches/main":
                return {
                    "name": "main",
                    "protected": True,
                    "commit": {"sha": BASE},
                }
            if route == "repos/trusted/ci/branches/main/protection":
                return good_protection
            if route == (
                    "repos/trusted/ci/contents/.github/CODEOWNERS?ref=" + BASE):
                return {
                    "path": ".github/CODEOWNERS",
                    "type": "file",
                    "encoding": "base64",
                    "content": base64.b64encode(CARRIER_CODEOWNERS).decode(),
                    "sha": CARRIER_CODEOWNERS_BLOB,
                }
            raise AssertionError(route)

        with patch.object(v3, "gh_api", side_effect=good_api):
            self.assertEqual(v3.checked_carrier_main("trusted/ci", carrier_contract()), BASE)

        def unprotected_api(route, method="GET", payload=None):
            if route == "repos/trusted/ci/branches/main":
                return {
                    "name": "main",
                    "protected": False,
                    "commit": {"sha": BASE},
                }
            raise AssertionError(route)

        with patch.object(v3, "gh_api", side_effect=unprotected_api):
            with self.assertRaisesRegex(v3.Denied, "requires reviewed carrier PR"):
                v3.checked_carrier_main("trusted/ci", carrier_contract())

        weak = json.loads(json.dumps(good_protection))
        weak["required_pull_request_reviews"]["require_code_owner_reviews"] = False

        def weak_api(route, method="GET", payload=None):
            if route == "repos/trusted/ci/branches/main":
                return {
                    "name": "main",
                    "protected": True,
                    "commit": {"sha": BASE},
                }
            if route == "repos/trusted/ci/branches/main/protection":
                return weak
            raise AssertionError(route)

        with patch.object(v3, "gh_api", side_effect=weak_api):
            with self.assertRaisesRegex(v3.Denied, "CODEOWNER"):
                v3.checked_carrier_main("trusted/ci", carrier_contract())

    def test_carrier_main_rejects_bypass_or_base_drift(self):
        def api(route, method="GET", payload=None):
            if route == "repos/trusted/ci/branches/main":
                return {
                    "name": "main",
                    "protected": True,
                    "commit": {"sha": BASE},
                }
            if route == "repos/trusted/ci/branches/main/protection":
                return {
                    "required_pull_request_reviews": {
                        "require_code_owner_reviews": True,
                        "dismiss_stale_reviews": True,
                        "required_approving_review_count": 1,
                        "bypass_pull_request_allowances": {
                            "users": [{"login": "bypass"}],
                            "teams": [],
                            "apps": [],
                        },
                    },
                    "enforce_admins": {"enabled": True},
                    "allow_force_pushes": {"enabled": False},
                    "allow_deletions": {"enabled": False},
                }
            raise AssertionError(route)

        with patch.object(v3, "gh_api", side_effect=api):
            with self.assertRaisesRegex(v3.Denied, "bypasses"):
                v3.checked_carrier_main("trusted/ci", carrier_contract())

        def drift_api(route, method="GET", payload=None):
            if route == "repos/trusted/ci/branches/main":
                return {
                    "name": "main",
                    "protected": True,
                    "commit": {"sha": "2" * 40},
                }
            raise AssertionError(route)

        with patch.object(v3, "gh_api", side_effect=drift_api):
            with self.assertRaisesRegex(v3.Denied, "advanced beyond reviewed base"):
                v3.checked_carrier_main("trusted/ci", carrier_contract())

    def test_exact_source_tree_reads_only_pinned_git_blobs(self):
        def api(route, method="GET", payload=None):
            if route == f"repos/{v3.SOURCE_REPO}/pulls/145":
                return {
                    "number": 145,
                    "state": "open",
                    "head": {
                        "sha": "9" * 40,
                        "repo": {"full_name": v3.SOURCE_REPO},
                    },
                    "base": {"ref": "main"},
                }
            if route == f"repos/{v3.SOURCE_REPO}/git/commits/" + "9" * 40:
                return {"sha": "9" * 40, "tree": {"sha": SOURCE_TREE}}
            if route == f"repos/{v3.SOURCE_REPO}/git/trees/{SOURCE_TREE}?recursive=1":
                return {
                    "sha": SOURCE_TREE,
                    "truncated": False,
                    "tree": [
                        {
                            "path": "src/synthetic.cpp",
                            "type": "blob",
                            "mode": "100644",
                            "sha": BLOB,
                            "size": len(DATA),
                        }
                    ],
                }
            if route == f"repos/{v3.SOURCE_REPO}/git/blobs/{BLOB}":
                return {
                    "sha": BLOB,
                    "encoding": "base64",
                    "content": base64.b64encode(DATA).decode(),
                }
            raise AssertionError(route)

        with patch.object(v3, "gh_api", side_effect=api):
            tree, files, rows, digest = v3.exact_source_tree(145, "9" * 40)
        self.assertEqual(tree, SOURCE_TREE)
        self.assertEqual(files, [("src/synthetic.cpp", "100644", BLOB, DATA)])
        self.assertEqual(rows[0][:3], ["src/synthetic.cpp", "100644", BLOB])
        self.assertEqual(
            digest, hashlib.sha256(v3.canonical_bytes(rows)).hexdigest()
        )

    def test_source_tree_rejects_oversized_declared_blob_before_blob_read(self):
        seen = []
        def api(route, method="GET", payload=None):
            seen.append(route)
            if route.endswith("/pulls/145"):
                return {
                    "number": 145,
                    "state": "open",
                    "head": {
                        "sha": "9" * 40,
                        "repo": {"full_name": v3.SOURCE_REPO},
                    },
                    "base": {"ref": "main"},
                }
            if "/git/commits/" in route:
                return {"sha": "9" * 40, "tree": {"sha": SOURCE_TREE}}
            if "/git/trees/" in route:
                return {
                    "sha": SOURCE_TREE,
                    "truncated": False,
                    "tree": [{
                        "path": "huge.bin",
                        "type": "blob",
                        "mode": "100644",
                        "sha": "2" * 40,
                        "size": v3.MAX_FILE + 1,
                    }],
                }
            raise AssertionError(route)
        with patch.object(v3, "gh_api", side_effect=api):
            with self.assertRaisesRegex(v3.Denied, "file exceeds mirror limit"):
                v3.exact_source_tree(145, "9" * 40)
        self.assertFalse(any("/git/blobs/" in route for route in seen))

    def test_source_tree_rejects_blob_size_mismatch(self):
        def api(route, method="GET", payload=None):
            if route.endswith("/pulls/145"):
                return {
                    "number": 145,
                    "state": "open",
                    "head": {
                        "sha": "9" * 40,
                        "repo": {"full_name": v3.SOURCE_REPO},
                    },
                    "base": {"ref": "main"},
                }
            if "/git/commits/" in route:
                return {"sha": "9" * 40, "tree": {"sha": SOURCE_TREE}}
            if "/git/trees/" in route:
                return {
                    "sha": SOURCE_TREE,
                    "truncated": False,
                    "tree": [{
                        "path": "src/synthetic.cpp",
                        "type": "blob",
                        "mode": "100644",
                        "sha": BLOB,
                        "size": len(DATA) + 1,
                    }],
                }
            if route.endswith("/git/blobs/" + BLOB):
                return {
                    "sha": BLOB,
                    "encoding": "base64",
                    "content": base64.b64encode(DATA).decode(),
                }
            raise AssertionError(route)
        with patch.object(v3, "gh_api", side_effect=api):
            with self.assertRaisesRegex(v3.Denied, "size differs"):
                v3.exact_source_tree(145, "9" * 40)

    def test_source_tree_rejects_symlink_mode_before_blob_read(self):
        seen = []
        def api(route, method="GET", payload=None):
            seen.append(route)
            if route.endswith("/pulls/145"):
                return {
                    "number": 145,
                    "state": "open",
                    "head": {
                        "sha": "9" * 40,
                        "repo": {"full_name": v3.SOURCE_REPO},
                    },
                    "base": {"ref": "main"},
                }
            if "/git/commits/" in route:
                return {"sha": "9" * 40, "tree": {"sha": SOURCE_TREE}}
            if "/git/trees/" in route:
                return {
                    "sha": SOURCE_TREE,
                    "truncated": False,
                    "tree": [
                        {
                            "path": "link",
                            "type": "blob",
                            "mode": "120000",
                            "sha": "2" * 40,
                        }
                    ],
                }
            raise AssertionError(route)
        with patch.object(v3, "gh_api", side_effect=api):
            with self.assertRaisesRegex(v3.Denied, "symlink"):
                v3.exact_source_tree(145, "9" * 40)
        self.assertFalse(any("/git/blobs/" in route for route in seen))

    def test_publish_binds_receipt_tree_branch_and_authorization(self):
        contract = carrier_contract()
        rows = [["src/synthetic.cpp", "100644", BLOB, len(DATA)]]
        manifest = hashlib.sha256(v3.canonical_bytes(rows)).hexdigest()
        writes = []
        blob_bytes = []
        commit_payload = {}

        def api(route, method="GET", payload=None):
            writes.append((method, route, payload))
            if method == "POST" and route.endswith("/git/blobs"):
                data = base64.b64decode(payload["content"], validate=True)
                blob_bytes.append(data)
                return {"sha": v3.git_blob_sha(data)}
            if method == "POST" and route.endswith("/git/trees"):
                if payload.get("base_tree") is None:
                    return {"sha": SOURCE_TREE}
                return {"sha": "3" * 40}
            if method == "POST" and route.endswith("/git/commits"):
                commit_payload.update(payload)
                return {"sha": CARRIER_COMMIT}
            if method == "POST" and route.endswith("/git/refs"):
                return {"ref": payload["ref"], "object": {"sha": payload["sha"]}}
            raise AssertionError((method, route))

        with (
            patch.object(v3, "protected_authority", return_value=(PROTECTED, contract)),
            patch.object(v3, "checked_destination", return_value=(BASE_TREE, PLAN)),
            patch.object(
                v3,
                "exact_source_tree",
                return_value=(
                    SOURCE_TREE,
                    [("src/synthetic.cpp", "100644", BLOB, DATA)],
                    rows,
                    manifest,
                ),
            ),
            patch.object(v3, "recheck_destination_identity"),
            patch.object(v3, "verify_source_pr", return_value=v3.SOURCE_REPO_ID),
            patch.object(v3, "verify_published_root_and_commit"),
            patch.object(v3, "require_handoff_refs_absent"),
            patch.object(v3, "require_exact_ref"),
            patch.object(v3, "gh_api", side_effect=api),
        ):
            result = v3.publish(
                "trusted/ci",
                145,
                "9" * 40,
                "ci/test-plans/wasm-pr145.json",
                now=dt.datetime(2026, 10, 20, tzinfo=dt.timezone.utc),
            )

        self.assertEqual(result["branch"], "ci/oreslang-" + SOURCE_TREE)
        self.assertEqual(
            result["authorization_ref"], "ci/authorized-" + CARRIER_COMMIT
        )
        receipt_raw = next(
            data for data in blob_bytes
            if b'"schema":"ores-private-ci-receipt-v3"' in data
        )
        receipt = json.loads(receipt_raw)
        self.assertEqual(receipt["expires_at"], "2026-10-21T00:00:00Z")
        self.assertEqual(receipt["source"]["repo_id"], v3.SOURCE_REPO_ID)
        self.assertEqual(receipt["source"]["pr"], 145)
        self.assertEqual(receipt["source"]["head_sha"], "9" * 40)
        self.assertEqual(receipt["source"]["root_tree_sha"], SOURCE_TREE)
        self.assertEqual(receipt["source"]["manifest_sha256"], manifest)
        self.assertEqual(receipt["destination"]["repo_id"], 1323598177)
        self.assertEqual(receipt["test_plan"]["path"], contract["test_plan_path"])
        self.assertEqual(
            receipt["test_plan"]["sha256"], hashlib.sha256(PLAN).hexdigest()
        )
        digest = v3.canonical_digest(receipt)
        self.assertIn(
            "Oreslang-CI-Receipt-SHA256: " + digest,
            commit_payload["message"].splitlines(),
        )
        refs = [
            payload["ref"]
            for method, route, payload in writes
            if method == "POST" and route.endswith("/git/refs")
        ]
        self.assertEqual(
            refs,
            [
                "refs/heads/ci/oreslang-" + SOURCE_TREE,
                "refs/heads/ci/authorized-" + CARRIER_COMMIT,
            ],
        )


    def test_ref_request_uses_narrow_handoff_routes(self):
        response = type(
            "Result", (), {"returncode": 0, "stderr": "", "stdout": "{}"}
        )()
        ref_name = "ci/authorized-" + CARRIER_COMMIT
        with (
            patch.object(v3, "trusted_github_cli", return_value="/usr/bin/gh"),
            patch.object(v3, "github_api_environment", return_value={"GH_TOKEN": "x"}),
            patch.object(v3, "run_bounded_gh", return_value=response) as run,
        ):
            self.assertIs(v3._gh_ref_request("trusted/ci", ref_name, "GET"), response)
        self.assertIn(
            "repos/trusted/ci/git/ref/heads/ci%2Fauthorized-" + CARRIER_COMMIT,
            run.call_args.args[0],
        )
        self.assertEqual(run.call_args.kwargs["env"], {"GH_TOKEN": "x"})
        with self.assertRaisesRegex(v3.Denied, "target is invalid"):
            v3._gh_ref_request("trusted/ci", "ci/unrelated", "GET")

    def test_live_ref_rejects_repository_identity_replacement(self):
        response = type(
            "Result", (), {"returncode": 0, "stderr": "", "stdout": "{}"}
        )()
        with (
            patch.object(
                v3, "gh_api",
                return_value={
                    "id": 999,
                    "full_name": "trusted/ci",
                    "private": True,
                    "visibility": "private",
                    "archived": False,
                    "disabled": False,
                },
            ),
            patch.object(v3, "_gh_ref_request", return_value=response),
        ):
            with self.assertRaisesRegex(v3.Denied, "identity changed"):
                v3.live_ref_sha(
                    "trusted/ci", "ci/authorized-" + CARRIER_COMMIT, 1323598177
                )

    def test_delete_exact_ref_refuses_moved_ref(self):
        with patch.object(v3, "live_ref_sha", return_value="9" * 40):
            with self.assertRaisesRegex(v3.Denied, "moved"):
                v3.delete_exact_ref(
                    "trusted/ci",
                    "ci/oreslang-" + SOURCE_TREE,
                    CARRIER_COMMIT,
                    1323598177,
                )

    def _publish_fixture(self, api, verify_source_pr=None, require_exact_ref=None,
                         delete_exact_ref=None):
        contract = carrier_contract()
        rows = [["src/synthetic.cpp", "100644", BLOB, len(DATA)]]
        manifest = hashlib.sha256(v3.canonical_bytes(rows)).hexdigest()
        patches = [
            patch.object(v3, "protected_authority", return_value=(PROTECTED, contract)),
            patch.object(v3, "checked_destination", return_value=(BASE_TREE, PLAN)),
            patch.object(
                v3, "exact_source_tree",
                return_value=(
                    SOURCE_TREE,
                    [("src/synthetic.cpp", "100644", BLOB, DATA)],
                    rows,
                    manifest,
                ),
            ),
            patch.object(v3, "recheck_destination_identity"),
            patch.object(v3, "verify_published_root_and_commit"),
            patch.object(v3, "require_handoff_refs_absent"),
            patch.object(v3, "gh_api", side_effect=api),
        ]
        if verify_source_pr is not None:
            patches.append(patch.object(v3, "verify_source_pr", side_effect=verify_source_pr))
        else:
            patches.append(
                patch.object(v3, "verify_source_pr", return_value=v3.SOURCE_REPO_ID)
            )
        if require_exact_ref is not None:
            patches.append(patch.object(v3, "require_exact_ref", side_effect=require_exact_ref))
        else:
            patches.append(patch.object(v3, "require_exact_ref"))
        if delete_exact_ref is not None:
            patches.append(patch.object(v3, "delete_exact_ref", side_effect=delete_exact_ref))
        return contract, patches

    def test_publish_rolls_back_payload_if_pr_head_moves_before_authorization(self):
        writes = []
        def api(route, method="GET", payload=None):
            writes.append((method, route, payload))
            if method == "POST" and route.endswith("/git/blobs"):
                data = base64.b64decode(payload["content"], validate=True)
                return {"sha": v3.git_blob_sha(data)}
            if method == "POST" and route.endswith("/git/trees"):
                return {"sha": SOURCE_TREE if payload.get("base_tree") is None else "3" * 40}
            if method == "POST" and route.endswith("/git/commits"):
                return {"sha": CARRIER_COMMIT}
            if method == "POST" and route.endswith("/git/refs"):
                return {"ref": payload["ref"], "object": {"sha": payload["sha"]}}
            raise AssertionError((method, route))

        deleted = []
        contract, patches = self._publish_fixture(
            api,
            verify_source_pr=[
                v3.SOURCE_REPO_ID,
                v3.Denied("PR head moved"),
            ],
            delete_exact_ref=lambda *args: deleted.append(args) or True,
        )
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], patches[8], patches[9]:
            with self.assertRaisesRegex(v3.Denied, "PR head moved"):
                v3.publish(
                    "trusted/ci", 145, "9" * 40,
                    "ci/test-plans/wasm-pr145.json",
                    now=dt.datetime(2026, 10, 20, tzinfo=dt.timezone.utc),
                )
        self.assertEqual(
            deleted,
            [(
                "trusted/ci", "ci/oreslang-" + SOURCE_TREE,
                CARRIER_COMMIT, contract["repository_id"],
            )],
        )

    def test_publish_rolls_back_payload_on_ambiguous_create_failure(self):
        def api(route, method="GET", payload=None):
            if method == "POST" and route.endswith("/git/blobs"):
                data = base64.b64decode(payload["content"], validate=True)
                return {"sha": v3.git_blob_sha(data)}
            if method == "POST" and route.endswith("/git/trees"):
                return {"sha": SOURCE_TREE if payload.get("base_tree") is None else "3" * 40}
            if method == "POST" and route.endswith("/git/commits"):
                return {"sha": CARRIER_COMMIT}
            if method == "POST" and route.endswith("/git/refs"):
                raise v3.Denied("ambiguous ref transport failure")
            raise AssertionError((method, route))

        deleted = []
        contract, patches = self._publish_fixture(
            api,
            delete_exact_ref=lambda *args: deleted.append(args) or False,
        )
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], patches[8], patches[9]:
            with self.assertRaisesRegex(v3.Denied, "ambiguous ref transport failure"):
                v3.publish(
                    "trusted/ci", 145, "9" * 40,
                    "ci/test-plans/wasm-pr145.json",
                    now=dt.datetime(2026, 10, 20, tzinfo=dt.timezone.utc),
                )
        self.assertEqual(
            deleted,
            [(
                "trusted/ci", "ci/oreslang-" + SOURCE_TREE,
                CARRIER_COMMIT, contract["repository_id"],
            )],
        )

    def test_publish_rolls_back_both_refs_on_authorization_mismatch(self):
        def api(route, method="GET", payload=None):
            if method == "POST" and route.endswith("/git/blobs"):
                data = base64.b64decode(payload["content"], validate=True)
                return {"sha": v3.git_blob_sha(data)}
            if method == "POST" and route.endswith("/git/trees"):
                return {"sha": SOURCE_TREE if payload.get("base_tree") is None else "3" * 40}
            if method == "POST" and route.endswith("/git/commits"):
                return {"sha": CARRIER_COMMIT}
            if method == "POST" and route.endswith("/git/refs"):
                if payload["ref"].startswith("refs/heads/ci/authorized-"):
                    return {"ref": payload["ref"], "object": {"sha": "9" * 40}}
                return {"ref": payload["ref"], "object": {"sha": payload["sha"]}}
            raise AssertionError((method, route))

        deleted = []
        contract, patches = self._publish_fixture(
            api,
            delete_exact_ref=lambda *args: deleted.append(args) or True,
        )
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], patches[8], patches[9]:
            with self.assertRaisesRegex(v3.Denied, "authorization ref"):
                v3.publish(
                    "trusted/ci", 145, "9" * 40,
                    "ci/test-plans/wasm-pr145.json",
                    now=dt.datetime(2026, 10, 20, tzinfo=dt.timezone.utc),
                )
        self.assertEqual(
            deleted,
            [
                (
                    "trusted/ci", "ci/authorized-" + CARRIER_COMMIT,
                    CARRIER_COMMIT, contract["repository_id"],
                ),
                (
                    "trusted/ci", "ci/oreslang-" + SOURCE_TREE,
                    CARRIER_COMMIT, contract["repository_id"],
                ),
            ],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
