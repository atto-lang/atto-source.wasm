#!/usr/bin/env python3
"""Source-free regression matrix for five-backend GitHub run proof."""
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("runcheck", Path(__file__).with_name("verify_ci_run.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RunContract(unittest.TestCase):
    def setUp(self):
        self.backend = "java"
        self.repo, self.repo_id = module.REPOS[self.backend]
        self.commit = "a" * 40
        self.tree = "b" * 40
        self.run_id = 17
        self.prefix = "repos/" + self.repo
        self.values = {
            self.prefix: {"id": self.repo_id, "full_name": self.repo,
                          "private": True, "archived": False, "disabled": False},
            self.prefix + "/git/commits/" + self.commit: {
                "sha": self.commit, "tree": {"sha": self.tree}},
            self.prefix + "/actions/runs/17": {
                "id": 17, "repository": {"id": self.repo_id},
                "head_repository": {"id": self.repo_id},
                "head_sha": self.commit, "path": ".github/workflows/ci.yml",
                "status": "completed",
                "conclusion": "success", "run_attempt": 2, "workflow_id": 991},
            self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1": {
                "total_count": 1, "jobs": [
                    {"id": 31, "name": "unit", "run_id": 17, "run_attempt": 2,
                     "status": "completed", "conclusion": "success",
                     "runner_id": 1000002089, "runner_name": "GitHub Actions 1",
                     "started_at": "2026-10-16T10:00:00Z",
                     "completed_at": "2026-10-16T10:03:00Z",
                     "steps": [
                         {"name": "Set up job", "status": "completed", "conclusion": "success",
                          "number": 1, "started_at": "2026-10-16T10:00:00Z",
                          "completed_at": "2026-10-16T10:00:59Z"},
                         {"name": "Execute test suite", "status": "completed", "conclusion": "success",
                          "number": 2, "started_at": "2026-10-16T10:01:00Z",
                          "completed_at": "2026-10-16T10:01:59Z"},
                         {"name": "Complete job", "status": "completed", "conclusion": "success",
                          "number": 3, "started_at": "2026-10-16T10:02:00Z",
                          "completed_at": "2026-10-16T10:03:00Z"}]}
                ]}
        }

    def verify(self, *args, **kwargs):
        kwargs.setdefault("workflow_id", 991)
        return module.verify(*args, workflow_path=".github/workflows/ci.yml", **kwargs)

    def fetch(self, path):
        return copy.deepcopy(self.values[path])

    def validate(self):
        return self.verify(self.fetch, self.backend, self.commit, self.tree,
                             self.run_id, ["unit"], ["Execute test suite"])

    def rejected(self):
        with self.assertRaises(module.Denied):
            self.validate()


    def test_workflow_id_pin_is_mandatory(self):
        with self.assertRaisesRegex(module.Denied, "independently pinned workflow id"):
            self.verify(self.fetch, self.backend, self.commit, self.tree,
                        self.run_id, ["unit"], ["Execute test suite"], workflow_id=None)

    def test_wrong_workflow_identity_denied(self):
        self.values[self.prefix + "/actions/runs/17"]["workflow_id"] = 992
        self.rejected()

    def test_missing_or_malformed_run_workflow_id_denied(self):
        run = self.values[self.prefix + "/actions/runs/17"]
        for value in (None, False, True, "991", 0, -1):
            with self.subTest(value=value):
                run["workflow_id"] = value
                self.rejected()

    def test_invalid_independent_workflow_id_denied(self):
        for value in (None, False, True, "991", 0, -1):
            with self.subTest(value=value):
                with self.assertRaises(module.Denied):
                    self.verify(self.fetch, self.backend, self.commit, self.tree,
                                self.run_id, ["unit"], ["Execute test suite"],
                                workflow_id=value)

    def test_duplicate_step_names_within_job_denied(self):
        page = self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1"
        steps = self.values[page]["jobs"][0]["steps"]
        steps[0]["name"] = steps[1]["name"]
        self.rejected()

    def test_malformed_required_name_containers_denied(self):
        for jobs, steps in (("unit", ["Execute test suite"]),
                            (["unit"], "Execute test suite"),
                            ({"unit"}, ["Execute test suite"]),
                            (["unit"], {"Execute test suite"})):
            with self.subTest(jobs=jobs, steps=steps):
                with self.assertRaises(module.Denied):
                    self.verify(self.fetch, self.backend, self.commit, self.tree,
                                self.run_id, jobs, steps)

    def test_success_is_explicitly_not_guest_certification(self):
        self.assertIn("NOT_GUEST", self.validate()["statement"])
        self.assertEqual(self.validate()["successful_non_housekeeping_steps"], 1)
        self.assertEqual(self.validate()["workflow_path"], ".github/workflows/ci.yml")

    def test_inventory_has_all_five_distinct_pinned_repositories(self):
        self.assertEqual(set(module.REPOS), {"java", "llvm", "net", "wasm", "forge"})
        self.assertEqual(len({v[1] for v in module.REPOS.values()}), 5)

    def test_wrong_repo_id(self):
        self.values[self.prefix]["id"] += 1
        self.rejected()

    def test_wrong_slug(self):
        self.values[self.prefix]["full_name"] = "forged/repo"
        self.rejected()

    def test_public_or_archived_rejected(self):
        for k,v in (("private", False), ("archived", True), ("disabled", True)):
            with self.subTest(k=k):
                self.setUp()
                self.values[self.prefix][k] = v
                self.rejected()

    def test_wrong_commit_tree(self):
        self.values[self.prefix+"/git/commits/"+self.commit]["tree"]["sha"] = "c"*40
        self.rejected()

    def test_forged_commit_sha(self):
        self.values[self.prefix+"/git/commits/"+self.commit]["sha"] = "c"*40
        self.rejected()

    def test_wrong_run_head(self):
        self.values[self.prefix+"/actions/runs/17"]["head_sha"] = "c"*40
        self.rejected()

    def test_workflow_path_missing_or_wrong_in_actual_run(self):
        key = self.prefix + "/actions/runs/17"
        for value in (None, "", ".github/workflows/other.yml",
                      ".github/workflows/ci.yaml@main", 7):
            with self.subTest(value=value):
                self.setUp()
                self.values[key]["path"] = value
                self.rejected()

    def test_qualified_workflow_ref_preserves_exact_file(self):
        key = self.prefix + "/actions/runs/17"
        for value in (".github/workflows/ci.yml",
                      ".github/workflows/ci.yml@main",
                      ".github/workflows/ci.yml@refs/heads/main",
                      ".github/workflows/ci.yml@refs/pull/123/merge"):
            with self.subTest(value=value):
                self.values[key]["path"] = value
                self.assertEqual(self.validate()["verified_jobs"], 1)
        for value in (".github/workflows/ci.yml@", 
                      ".github/workflows/ci.yml@../main",
                      ".github/workflows/ci.yml@main@wrong",
                      ".github/workflows/ci.yml@refs//heads/main",
                      ".github/workflows/ci.yml.bak@main",
                      ".github/workflows/ci.yml@/refs/heads/main"):
            with self.subTest(value=value):
                self.values[key]["path"] = value
                self.rejected()

    def test_trusted_workflow_path_is_mandatory(self):
        with self.assertRaisesRegex(module.Denied, "trusted workflow path"):
            module.verify(self.fetch, self.backend, self.commit, self.tree,
                          self.run_id, ["unit"], ["Execute test suite"])

    def test_untrusted_or_traversing_workflow_paths_denied(self):
        for value in ("", "ci.yml", ".github/workflows/../ci.yml",
                      ".github/workflows//ci.yml", ".github/workflows/ci.yml@main",
                      ".github/workflows/ci.txt", None, False):
            with self.subTest(value=value):
                with self.assertRaisesRegex(module.Denied, "trusted workflow path"):
                    module.verify(self.fetch, self.backend, self.commit, self.tree,
                                  self.run_id, ["unit"], ["Execute test suite"],
                                  workflow_path=value)

    def test_wrong_run_repository(self):
        self.values[self.prefix+"/actions/runs/17"]["repository"]["id"] += 1
        self.rejected()

    def test_wrong_head_repository(self):
        self.values[self.prefix+"/actions/runs/17"]["head_repository"]["id"] += 1
        self.rejected()

    def test_in_progress_run(self):
        self.values[self.prefix+"/actions/runs/17"]["status"] = "in_progress"
        self.rejected()

    def test_failed_run(self):
        self.values[self.prefix+"/actions/runs/17"]["conclusion"] = "failure"
        self.rejected()

    def test_missing_runner_identity(self):
        page = self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1"
        job = self.values[page]["jobs"][0]
        for field in ("runner_id", "runner_name"):
            with self.subTest(field=field):
                saved = job.pop(field)
                self.rejected()
                job[field] = saved

    def test_zero_or_forged_runner_id(self):
        page = self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1"
        job = self.values[page]["jobs"][0]
        for value in (0, -1, True, False, None, "1000002089"):
            with self.subTest(value=value):
                job["runner_id"] = value
                self.rejected()

    def test_blank_or_wrong_type_runner_name(self):
        page = self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1"
        job = self.values[page]["jobs"][0]
        for value in ("", "  ", None, False, 123):
            with self.subTest(value=value):
                job["runner_name"] = value
                self.rejected()

    def test_zero_step_jobs(self):
        self.values[self.prefix+"/actions/runs/17/jobs?filter=latest&per_page=100&page=1"]["jobs"][0]["steps"] = []
        self.rejected()

    def test_skipped_job(self):
        self.values[self.prefix+"/actions/runs/17/jobs?filter=latest&per_page=100&page=1"]["jobs"][0]["conclusion"] = "skipped"
        self.rejected()

    def test_skipped_step(self):
        self.values[self.prefix+"/actions/runs/17/jobs?filter=latest&per_page=100&page=1"]["jobs"][0]["steps"][1]["conclusion"] = "skipped"
        self.rejected()

    def test_housekeeping_only(self):
        self.values[self.prefix+"/actions/runs/17/jobs?filter=latest&per_page=100&page=1"]["jobs"][0]["steps"].pop(1)
        self.rejected()

    def test_required_proof_step_cannot_be_runner_housekeeping(self):
        # This job also ran "Execute test suite": older verification would
        # accept "Set up job" as the required step and let the unrelated
        # executable step launder that proof.
        for name in ("Set up job", "Complete job", "Post actions/checkout",
                     "Pre actions/checkout", "Initialize containers",
                     "Start containers", "Stop containers"):
            with self.subTest(name=name):
                with self.assertRaisesRegex(module.Denied, "runner housekeeping"):
                    self.verify(self.fetch, self.backend, self.commit,
                                  self.tree, self.run_id, ["unit"], [name])
                with self.assertRaisesRegex(module.Denied, "runner housekeeping"):
                    self.verify(self.fetch, self.backend, self.commit,
                                  self.tree, self.run_id, ["unit"], [name],
                                  job_step_pairs=[("unit", name)])

    def test_actual_executable_proof_still_passes(self):
        self.assertEqual(self.validate()["successful_non_housekeeping_steps"], 1)

    def test_job_execution_timestamps_required(self):
        page = self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1"
        job = self.values[page]["jobs"][0]
        original = copy.deepcopy(job)
        for field, value in (
                ("started_at", None),
                ("completed_at", "not-a-time"),
                ("completed_at", "2026-10-16T09:59:59Z")):
            with self.subTest(field=field, value=value):
                job.clear()
                job.update(copy.deepcopy(original))
                job[field] = value
                self.rejected()

    def test_step_execution_numbers_and_timestamps_required(self):
        page = self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1"
        job = self.values[page]["jobs"][0]
        original = copy.deepcopy(job)
        def mutate(field, value):
            job.clear()
            job.update(copy.deepcopy(original))
            job["steps"][1][field] = value
        for field, value in (
                ("number", 1),
                ("number", 0),
                ("number", True),
                ("started_at", None),
                ("started_at", "2026-10-16T09:59:59Z"),
                ("completed_at", "2026-10-16T10:00:00Z"),
                ("completed_at", "2026-10-16T10:04:00Z")):
            with self.subTest(field=field, value=value):
                mutate(field, value)
                self.rejected()

    def test_wrong_attempt(self):
        self.values[self.prefix+"/actions/runs/17/jobs?filter=latest&per_page=100&page=1"]["jobs"][0]["run_attempt"] = 1
        self.rejected()

    def test_missing_required_job(self):
        self.values[self.prefix+"/actions/runs/17/jobs?filter=latest&per_page=100&page=1"]["jobs"][0]["name"] = "not-unit"
        self.rejected()

    def test_missing_required_step(self):
        self.values[self.prefix+"/actions/runs/17/jobs?filter=latest&per_page=100&page=1"]["jobs"][0]["steps"][1]["name"] = "not-the-tests"
        self.rejected()

    def test_unrelated_job_cannot_satisfy_required_test_step(self):
        p = self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1"
        base = self.values[p]["jobs"][0]
        other = copy.deepcopy(base)
        other["id"] = 32
        other["name"] = "unrelated-smoke"
        base["steps"][1]["name"] = "Not the required tests"
        self.values[p]["jobs"].append(other)
        self.values[p]["total_count"] = 2
        self.rejected()

    def test_missing_job_attempt_is_not_execution_evidence(self):
        page = self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1"
        del self.values[page]["jobs"][0]["run_attempt"]
        self.rejected()

    def test_multi_job_requires_explicit_step_bindings(self):
        page = self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1"
        original = self.values[page]["jobs"][0]
        other = copy.deepcopy(original)
        other["id"] = 32
        other["name"] = "native"
        original["steps"][1]["name"] = "Execute unit suite"
        other["steps"][1]["name"] = "Execute native suite"
        self.values[page]["jobs"].append(other)
        self.values[page]["total_count"] = 2
        with self.assertRaisesRegex(module.Denied, "explicit job-step"):
            self.verify(self.fetch, self.backend, self.commit, self.tree,
                          self.run_id, ["unit", "native"],
                          ["Execute unit suite", "Execute native suite"])
        result = self.verify(
            self.fetch, self.backend, self.commit, self.tree,
            self.run_id, ["unit", "native"],
            ["Execute unit suite", "Execute native suite"],
            [("unit", "Execute unit suite"), ("native", "Execute native suite")])
        self.assertEqual(result["verified_jobs"], 2)
        with self.assertRaisesRegex(module.Denied, "bound CI job"):
            self.verify(
                self.fetch, self.backend, self.commit, self.tree,
                self.run_id, ["unit", "native"],
                ["Execute unit suite", "Execute native suite"],
                [("unit", "Execute native suite"),
                 ("native", "Execute unit suite")])

    def test_duplicate_job_names_are_ambiguous(self):
        page = self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1"
        other = copy.deepcopy(self.values[page]["jobs"][0])
        other["id"] = 32
        self.values[page]["jobs"].append(other)
        self.values[page]["total_count"] = 2
        self.rejected()

    def test_malformed_job_step_bindings_rejected(self):
        for pairs in ([ ("unit", "Other step") ],
                      [ ("missing-job", "Execute test suite") ],
                      [ ("unit", "Execute test suite"),
                        ("unit", "Execute test suite") ],
                      [("unit",)], [("unit", 0)], "wrong-type"):
            with self.subTest(pairs=pairs):
                with self.assertRaises(module.Denied):
                    self.verify(self.fetch, self.backend, self.commit,
                                  self.tree, self.run_id, ["unit"],
                                  ["Execute test suite"], job_step_pairs=pairs)

    def test_success_for_all_five_pinned_backend_ids(self):
        for backend, (repo, numeric_id) in module.REPOS.items():
            with self.subTest(backend=backend):
                self.setUp()
                new_prefix = "repos/" + repo
                values = {}
                for k,v in self.values.items():
                    values[k.replace(self.prefix, new_prefix)] = copy.deepcopy(v)
                values[new_prefix]["id"] = numeric_id
                values[new_prefix]["full_name"] = repo
                values[new_prefix + "/actions/runs/17"]["repository"]["id"] = numeric_id
                values[new_prefix + "/actions/runs/17"]["head_repository"]["id"] = numeric_id
                self.backend = backend
                self.repo, self.repo_id, self.prefix, self.values = repo, numeric_id, new_prefix, values
                self.assertEqual(self.validate()["backend"], backend)

    def test_missing_execution_requirement(self):
        with self.assertRaises(module.Denied):
            self.verify(self.fetch,self.backend,self.commit,self.tree,self.run_id,[],[])

    def test_duplicate_job_names_request(self):
        with self.assertRaises(module.Denied):
            self.verify(self.fetch,self.backend,self.commit,self.tree,self.run_id,["unit","unit"],["Execute test suite"])

    def test_incomplete_paginated_jobs(self):
        self.values[self.prefix+"/actions/runs/17/jobs?filter=latest&per_page=100&page=1"]["total_count"] = 2
        self.rejected()

    def test_duplicate_job_id(self):
        j=self.values[self.prefix+"/actions/runs/17/jobs?filter=latest&per_page=100&page=1"]
        j["jobs"].append(copy.deepcopy(j["jobs"][0]))
        j["total_count"] = 2
        self.rejected()

    def test_malformed_response(self):
        self.values[self.prefix+"/actions/runs/17"] = []
        self.rejected()

    def test_boolean_run_id_is_not_integer(self):
        with self.assertRaises(module.Denied):
            self.verify(self.fetch,self.backend,self.commit,self.tree,True,["unit"],["Execute test suite"])

    def test_negative_or_uppercase_sha(self):
        for sha in ("A"*40,"zz"*20,"a"*39):
            with self.subTest(sha=sha):
                with self.assertRaises(module.Denied):
                    self.verify(self.fetch,self.backend,sha,self.tree,self.run_id,["unit"],["Execute test suite"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
