#!/usr/bin/env python3
"""Source-free GitHub run proof regressions for five backends and three Rx variants."""
import copy
import json
import os
import subprocess
import sys
import tempfile
import textwrap
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
            self.prefix + "/contents/.github/workflows/ci.yml?ref=" + self.commit: {
                "type": "file", "path": ".github/workflows/ci.yml", "sha": "c" * 40},
            self.prefix + "/actions/runs/17": {
                "id": 17, "repository": {"id": self.repo_id},
                "head_repository": {"id": self.repo_id},
                "head_sha": self.commit, "path": ".github/workflows/ci.yml",
                "event": "push",
                "status": "completed",
                "conclusion": "success", "run_attempt": 2, "workflow_id": 991},
            self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1": {
                "total_count": 1, "jobs": [
                    {"id": 31, "name": "unit", "run_id": 17, "run_attempt": 2,
                     "head_sha": self.commit,
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
        kwargs.setdefault("expected_run_attempt", 2)
        kwargs.setdefault("expected_run_path", ".github/workflows/ci.yml")
        kwargs.setdefault("expected_event", "push")
        kwargs.setdefault("workflow_blob_sha", "c" * 40)
        return module.verify(*args, workflow_path=".github/workflows/ci.yml", **kwargs)

    def fetch(self, path):
        return copy.deepcopy(self.values[path])

    def validate(self):
        return self.verify(self.fetch, self.backend, self.commit, self.tree,
                             self.run_id, ["unit"], ["Execute test suite"])

    def rejected(self):
        with self.assertRaises(module.Denied):
            self.validate()


    def _switch_fixture_to_run_id_one(self):
        old = self.prefix + "/actions/runs/17"
        new = self.prefix + "/actions/runs/1"
        self.values[new] = self.values.pop(old)
        self.values[new]["id"] = 1
        old_jobs = old + "/jobs?filter=latest&per_page=100&page=1"
        new_jobs = new + "/jobs?filter=latest&per_page=100&page=1"
        self.values[new_jobs] = self.values.pop(old_jobs)
        self.values[new_jobs]["jobs"][0]["run_id"] = 1
        self.run_id = 1

    def test_boolean_job_run_id_cannot_impersonate_run_one(self):
        self._switch_fixture_to_run_id_one()
        path = self.prefix + "/actions/runs/1/jobs?filter=latest&per_page=100&page=1"
        self.values[path]["jobs"][0]["run_id"] = True
        self.rejected()

    def test_boolean_final_run_id_cannot_impersonate_run_one(self):
        self._switch_fixture_to_run_id_one()
        run_path = self.prefix + "/actions/runs/1"
        calls = [0]
        def mutate_second_read(path):
            data = copy.deepcopy(self.values[path])
            if path == run_path:
                calls[0] += 1
                if calls[0] == 2:
                    data["id"] = True
            return data
        with self.assertRaises(module.Denied):
            self.verify(mutate_second_read, self.backend, self.commit, self.tree,
                        self.run_id, ["unit"], ["Execute test suite"])
        self.assertEqual(calls[0], 2)

    def test_boolean_final_attempt_cannot_impersonate_attempt_one(self):
        self.values[self.prefix + "/actions/runs/17"]["run_attempt"] = 1
        job_path = self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1"
        self.values[job_path]["jobs"][0]["run_attempt"] = 1
        run_path = self.prefix + "/actions/runs/17"
        calls = [0]
        def mutate_second_read(path):
            data = copy.deepcopy(self.values[path])
            if path == run_path:
                calls[0] += 1
                if calls[0] == 2:
                    data["run_attempt"] = True
            return data
        with self.assertRaises(module.Denied):
            self.verify(mutate_second_read, self.backend, self.commit, self.tree,
                        self.run_id, ["unit"], ["Execute test suite"],
                        expected_run_attempt=1)
        self.assertEqual(calls[0], 2)

    def test_final_repository_metadata_must_remain_private_and_identical(self):
        path = self.prefix
        baseline = copy.deepcopy(self.values[path])
        for field, value in (("id", self.repo_id + 1),
                             ("full_name", "rebound/foreign"),
                             ("private", False),
                             ("archived", True),
                             ("disabled", True),
                             ("id", True)):
            with self.subTest(field=field, value=value):
                seen = [0]
                def mutate_on_second_metadata_read(resource):
                    data = copy.deepcopy(self.values[resource])
                    if resource == path:
                        seen[0] += 1
                        if seen[0] == 2:
                            data[field] = value
                    return data
                with self.assertRaisesRegex(
                        module.Denied, "changed identity or privacy"):
                    self.verify(mutate_on_second_metadata_read, self.backend,
                                self.commit, self.tree, self.run_id,
                                ["unit"], ["Execute test suite"])
                self.assertEqual(seen[0], 2)
        self.values[path] = baseline

    def test_final_workflow_id_must_have_exact_integer_type(self):
        # True == 1 in Python: without a strict type check the old final
        # reread could mistake a boolean for reviewed numeric workflow ID 1.
        run_path = self.prefix + "/actions/runs/17"
        self.values[run_path]["workflow_id"] = 1
        seen = [0]
        def change_final_run_id(resource):
            data = copy.deepcopy(self.values[resource])
            if resource == run_path:
                seen[0] += 1
                if seen[0] == 2:
                    data["workflow_id"] = True
            return data
        with self.assertRaisesRegex(module.Denied, "changed during evidence"):
            self.verify(change_final_run_id, self.backend, self.commit,
                        self.tree, self.run_id, ["unit"],
                        ["Execute test suite"], workflow_id=1)
        self.assertEqual(seen[0], 2)

    def test_final_run_repository_id_denies_float_equivalent(self):
        run_path = self.prefix + "/actions/runs/17"
        reads = [0]
        def tamper_final(resource):
            data = copy.deepcopy(self.values[resource])
            if resource == run_path:
                reads[0] += 1
                if reads[0] == 2:
                    data["repository"]["id"] = float(self.repo_id)
            return data
        with self.assertRaisesRegex(module.Denied, "changed during evidence"):
            self.verify(tamper_final, self.backend, self.commit, self.tree,
                        self.run_id, ["unit"], ["Execute test suite"])
        self.assertEqual(reads[0], 2)

    def test_final_head_repository_id_denies_float_equivalent(self):
        run_path = self.prefix + "/actions/runs/17"
        reads = [0]
        def tamper_final(resource):
            data = copy.deepcopy(self.values[resource])
            if resource == run_path:
                reads[0] += 1
                if reads[0] == 2:
                    data["head_repository"]["id"] = float(self.repo_id)
            return data
        with self.assertRaisesRegex(module.Denied, "changed during evidence"):
            self.verify(tamper_final, self.backend, self.commit, self.tree,
                        self.run_id, ["unit"], ["Execute test suite"])
        self.assertEqual(reads[0], 2)

    def test_run_changed_during_collection_denied(self):
        run_path = self.prefix + "/actions/runs/17"
        original = copy.deepcopy(self.values[run_path])
        for key, value in (("run_attempt", 3), ("conclusion", "failure"),
                           ("head_sha", "d" * 40), ("workflow_id", 992),
                           ("event", "workflow_dispatch"),
                           ("path", ".github/workflows/other.yml"),
                           ("status", "in_progress")):
            with self.subTest(key=key):
                calls = [0]
                def changing_fetch(path):
                    data = copy.deepcopy(self.values[path])
                    if path == run_path:
                        calls[0] += 1
                        if calls[0] == 2:
                            data[key] = value
                    return data
                with self.assertRaisesRegex(module.Denied, "changed during evidence collection"):
                    self.verify(changing_fetch, self.backend, self.commit,
                                self.tree, self.run_id, ["unit"], ["Execute test suite"])
                self.assertEqual(calls[0], 2)
        self.values[run_path] = original

    def test_independently_pinned_run_attempt_required(self):
        for attempt in (None, False, True, 0, -1, "2"):
            with self.subTest(attempt=attempt):
                with self.assertRaises(module.Denied):
                    self.verify(self.fetch, self.backend, self.commit, self.tree,
                                self.run_id, ["unit"], ["Execute test suite"],
                                expected_run_attempt=attempt)

    def test_independently_pinned_run_attempt_mismatch_denied(self):
        with self.assertRaisesRegex(module.Denied, "independently pinned attempt"):
            self.verify(self.fetch, self.backend, self.commit, self.tree,
                        self.run_id, ["unit"], ["Execute test suite"],
                        expected_run_attempt=1)
        self.assertEqual(self.validate()["run_attempt"], 2)

    def test_workflow_blob_pin_required(self):
        with self.assertRaises(module.Denied):
            self.verify(self.fetch, self.backend, self.commit, self.tree,
                        self.run_id, ["unit"], ["Execute test suite"],
                        workflow_blob_sha=None)

    def test_workflow_blob_mutation_denied(self):
        p = self.prefix + "/contents/.github/workflows/ci.yml?ref=" + self.commit
        self.values[p]["sha"] = "d" * 40
        self.rejected()

    def test_malformed_workflow_blob_metadata_denied(self):
        p = self.prefix + "/contents/.github/workflows/ci.yml?ref=" + self.commit
        original = copy.deepcopy(self.values[p])
        for key, value in (("type", "dir"), ("path", ".github/workflows/other.yml"),
                           ("sha", False), ("sha", None)):
            with self.subTest(key=key, value=value):
                self.values[p] = copy.deepcopy(original)
                self.values[p][key] = value
                self.rejected()

    def test_wrong_job_head_sha_denied(self):
        p = self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1"
        self.values[p]["jobs"][0]["head_sha"] = "d" * 40
        self.rejected()

    def test_missing_job_head_sha_denied(self):
        p = self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1"
        del self.values[p]["jobs"][0]["head_sha"]
        self.rejected()

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
        self.assertEqual(self.validate()["workflow_run_path"], ".github/workflows/ci.yml")
        self.assertEqual(self.validate()["event"], "push")

    def test_inventory_has_all_eight_distinct_pinned_repositories(self):
        self.assertEqual(set(module.REPOS), {"java", "llvm", "net", "wasm", "forge",
                                                     "rx_pull", "rx_callbacks", "rx_channels"})
        self.assertEqual(len({v[1] for v in module.REPOS.values()}), 8)

    def test_rx_models_use_exact_pinned_private_repository_ids(self):
        expected = {
            "rx_pull": ("ores-truffle-oreslang/rx-ores", 1407870560),
            "rx_callbacks": ("ores-truffle-oreslang/rx-ores-callbacks", 1407871059),
            "rx_channels": ("ores-truffle-oreslang/rx-oreslang-channels", 1407757001),
        }
        self.assertEqual({key: module.REPOS[key] for key in expected}, expected)
        self.assertEqual(len(set(expected.values())), 3)

    def test_rx_repository_denies_foreign_numeric_identity(self):
        for backend in ("rx_pull", "rx_callbacks", "rx_channels"):
            with self.subTest(backend=backend):
                self.setUp()
                rx_repo, _ = module.REPOS[backend]
                next_prefix = "repos/" + rx_repo
                self.values = {key.replace(self.prefix, next_prefix): copy.deepcopy(value)
                               for key, value in self.values.items()}
                self.backend = backend
                self.prefix = next_prefix
                # Old Java ID deliberately remains in the RX metadata.
                with self.assertRaisesRegex(module.Denied, "identity/visibility"):
                    self.validate()

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

    def test_run_event_rejects_dispatch_and_untrusted_triggers(self):
        run = self.prefix + "/actions/runs/17"
        for event in ("workflow_dispatch", "workflow_run", "pull_request_target",
                      "repository_dispatch", "schedule", "merge_group",
                      "", None, False, 7):
            with self.subTest(event=event):
                self.values[run]["event"] = event
                self.rejected()

    def test_expected_event_must_be_independently_pinned(self):
        for event in ("workflow_dispatch", "workflow_run", "pull_request_target",
                      "schedule", "merge_group", "", None, False, 123):
            with self.subTest(event=event):
                with self.assertRaisesRegex(module.Denied, "independently selected"):
                    self.verify(self.fetch, self.backend, self.commit, self.tree,
                                self.run_id, ["unit"], ["Execute test suite"],
                                expected_event=event)

    def test_exact_pull_request_event_is_admitted(self):
        self.values[self.prefix + "/actions/runs/17"]["event"] = "pull_request"
        result = self.verify(self.fetch, self.backend, self.commit, self.tree,
                             self.run_id, ["unit"], ["Execute test suite"],
                             expected_event="pull_request")
        self.assertEqual(result["event"], "pull_request")
        with self.assertRaises(module.Denied):
            self.validate()

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
                result = self.verify(self.fetch, self.backend, self.commit,
                                     self.tree, self.run_id, ["unit"],
                                     ["Execute test suite"], expected_run_path=value)
                self.assertEqual(result["workflow_run_path"], value)
        for value in (".github/workflows/ci.yml@",
                      ".github/workflows/ci.yml@../main",
                      ".github/workflows/ci.yml@main@wrong",
                      ".github/workflows/ci.yml@refs//heads/main",
                      ".github/workflows/ci.yml.bak@main",
                      ".github/workflows/ci.yml@/refs/heads/main"):
            with self.subTest(value=value):
                self.values[key]["path"] = value
                with self.assertRaises(module.Denied):
                    self.verify(self.fetch, self.backend, self.commit,
                                self.tree, self.run_id, ["unit"],
                                ["Execute test suite"], expected_run_path=value)

    def test_independently_pinned_run_ref_cannot_be_substituted(self):
        run = self.prefix + "/actions/runs/17"
        approved = ".github/workflows/ci.yml@refs/heads/main"
        self.values[run]["path"] = approved
        self.assertEqual(
            self.verify(self.fetch, self.backend, self.commit, self.tree,
                        self.run_id, ["unit"], ["Execute test suite"],
                        expected_run_path=approved)["workflow_run_path"], approved)
        for actual in (".github/workflows/ci.yml",
                       ".github/workflows/ci.yml@refs/heads/feature",
                       ".github/workflows/ci.yml@refs/pull/123/merge"):
            with self.subTest(actual=actual):
                self.values[run]["path"] = actual
                with self.assertRaises(module.Denied):
                    self.verify(self.fetch, self.backend, self.commit, self.tree,
                                self.run_id, ["unit"], ["Execute test suite"],
                                expected_run_path=approved)

    def test_workflow_run_path_required_and_cannot_traverse(self):
        for expected in (None, "", False, 2, ".github/workflows/ci.yml@",
                         ".github/workflows/ci.yml@../main",
                         ".github/workflows/ci.yml@refs//heads/main",
                         ".github/workflows/ci.yml.bak@main"):
            with self.subTest(expected=expected):
                with self.assertRaisesRegex(module.Denied, "independently pinned exact"):
                    self.verify(self.fetch, self.backend, self.commit, self.tree,
                                self.run_id, ["unit"], ["Execute test suite"],
                                expected_run_path=expected)

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

    def test_success_for_all_eight_pinned_repository_ids(self):
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

    def test_overlapping_step_timestamps_cannot_prove_execution(self):
        page = self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1"
        steps = self.values[page]["jobs"][0]["steps"]
        for index, bad_start in ((1, "2026-10-16T10:00:30Z"),
                                 (2, "2026-10-16T10:01:30Z")):
            with self.subTest(step=index):
                original = steps[index]["started_at"]
                steps[index]["started_at"] = bad_start
                try:
                    with self.assertRaisesRegex(module.Denied, "overlap|execution order"):
                        self.validate()
                finally:
                    steps[index]["started_at"] = original

    def test_adjacent_equal_step_timestamps_allowed(self):
        page = self.prefix + "/actions/runs/17/jobs?filter=latest&per_page=100&page=1"
        steps = self.values[page]["jobs"][0]["steps"]
        steps[1]["started_at"] = steps[0]["completed_at"]
        steps[2]["started_at"] = steps[1]["completed_at"]
        self.assertEqual(self.validate()["verified_jobs"], 1)

    def test_negative_or_uppercase_sha(self):
        for sha in ("A"*40,"zz"*20,"a"*39):
            with self.subTest(sha=sha):
                with self.assertRaises(module.Denied):
                    self.verify(self.fetch,self.backend,sha,self.tree,self.run_id,["unit"],["Execute test suite"])



class StrictApiJSONContract(unittest.TestCase):
    """API transport must not silently reinterpret ambiguous run metadata."""

    def test_canonical_github_object_is_accepted(self):
        data = module._strict_api_json(
            b'{"id":17,"repository":{"id":1400792274},"ok":true}')
        self.assertEqual(data["repository"]["id"], 1400792274)
        self.assertIs(data["ok"], True)

    def test_duplicate_keys_rejected_even_in_nested_metadata(self):
        for raw in (
            b'{"id":17,"id":18}',
            b'{"repository":{"id":1,"id":2}}',
            b'{"repository":{"owner":{"login":"a","login":"b"}}}',
        ):
            with self.subTest(raw=raw):
                with self.assertRaisesRegex(module.Denied, "duplicate"):
                    module._strict_api_json(raw)

    def test_nonstandard_and_nonfinite_json_denied(self):
        for raw in (
            b'{"id":NaN}', b'{"id":Infinity}', b'{"id":-Infinity}',
            b'{"id":1e999}', b'{"id":-1e999}',
            b'{"id":' + b"9" * 65 + b"}",
            b'{"id":1.' + b"1" * 130 + b"}",
            b'{"id":+1}', b'{"id":01}', b'{"id":1} trailing',
        ):
            with self.subTest(raw=raw[:80]):
                with self.assertRaises(module.Denied):
                    module._strict_api_json(raw)

    def test_input_shape_encoding_and_size_denied(self):
        for raw in (b'[]', b'null', b'2', b'""', b'{not-json}',
                    b'{"id":"\\xff"}', b'{"bad":' + b"x" * 20 + b"}",
                    b'{"id":1}\xff', "{}", None,
                    b' ' * (module.MAX_API_JSON_BYTES + 1)):
            with self.subTest(sample=str(raw)[:65]):
                with self.assertRaises(module.Denied):
                    module._strict_api_json(raw)

    def test_authenticated_fetch_applies_strict_parser(self):
        class Response:
            status = 200
            def __init__(self, body):
                self.body = body
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self, length):
                return self.body[:length]

        with patch.dict("os.environ", {"GH_TOKEN": "synthetic-only"}, clear=True):
            with patch.object(module.urllib.request, "urlopen",
                              return_value=Response(b'{"id":17,"id":18}')):
                with self.assertRaisesRegex(module.Denied, "duplicate"):
                    module._api_get("repos/example/repo")
            with patch.object(module.urllib.request, "urlopen",
                              return_value=Response(b'{"id":17}')):
                self.assertEqual(module._api_get("repos/example/repo"), {"id":17})


class WorkflowIsolationContract(unittest.TestCase):
    """Prevent candidate import-path shadowing in CI report generation."""

    @staticmethod
    def workflow_text():
        return (Path(__file__).resolve().parents[1]
                / ".github" / "workflows" / "ci-run-evidence-contract.yml").read_text(encoding="utf-8")

    def test_report_writer_uses_isolated_python(self):
        workflow = self.workflow_text()
        marker = "      - name: Write minimal run evidence (not compiled guest parity)"
        writer = workflow.split(marker, 1)[1].split(
            "      - name: Upload minimal source-free CI evidence", 1)[0]
        self.assertIn("python3 -I - <<'PY'", writer)
        self.assertNotIn("python3 - <<'PY'", writer)

    def test_all_inline_python_heredocs_use_isolated_mode(self):
        inline_python = [line.strip() for line in self.workflow_text().splitlines()
                         if "python3" in line and "<<'PY'" in line]
        self.assertEqual(len(inline_python), 2)
        self.assertTrue(all(line == "python3 -I - <<'PY'" for line in inline_python))


    def test_report_pins_distinct_trigger_and_checkout_metadata(self):
        workflow = self.workflow_text()
        self.assertIn("RUN_TRIGGER_SHA: ${{ github.sha }}", workflow)
        self.assertIn("RUN_TRIGGER_EVENT: ${{ github.event_name }}", workflow)
        self.assertIn('"workflow_trigger_sha": os.environ["RUN_TRIGGER_SHA"]', workflow)
        self.assertIn('"workflow_trigger_event": os.environ["RUN_TRIGGER_EVENT"]', workflow)
        self.assertIn('os.environ["RUN_TRIGGER_SHA"] == os.environ["OBSERVED_HEAD"]', workflow)
        self.assertIn('os.environ["SOURCE_OUTCOME"] == "success"', workflow)
        self.assertIn('"verified_execution_claim": False', workflow)

    def test_isolated_report_writer_exercises_source_vs_trigger_sha(self):
        workflow = self.workflow_text()
        section = workflow.split(
            "      - name: Write minimal run evidence (not compiled guest parity)", 1
        )[1].split("      - name: Upload minimal source-free CI evidence", 1)[0]
        body = section.split("          python3 -I - <<\'PY\'\n", 1)[1].split(
            "\n          PY\n", 1)[0]
        script = textwrap.dedent(body)
        for label, trigger, checkout, outcome, expected in (
                ("PR synthetic-merge SHA differs", "a"*40, "b"*40, "success", False),
                ("matching exact SHA", "b"*40, "b"*40, "success", True),
                ("unverified checkout outcome", "b"*40, "b"*40, "failure", False)):
            with self.subTest(case=label), tempfile.TemporaryDirectory() as temp:
                env = dict(os.environ)
                env.update({
                    "RUN_TRIGGER_SHA": trigger, "RUN_TRIGGER_EVENT": "pull_request",
                    "OBSERVED_HEAD": checkout, "EXPECTED_HEAD": "b"*40,
                    "OBSERVED_TREE": "c"*40, "SOURCE_OUTCOME": outcome,
                    "REGRESSION_OUTCOME": "success", "REPOSITORY_ID": "1400792274",
                    "GITHUB_REPOSITORY": "ores-truffle-oreslang/oreslang-source.java",
                    "GITHUB_RUN_ID": "101", "GITHUB_RUN_ATTEMPT": "1",
                    "RUNNER_TEMP": temp,
                })
                proc = subprocess.run([sys.executable, "-I", "-"], input=script,
                                      text=True, env=env, capture_output=True,
                                      timeout=10, check=False)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                with open(os.path.join(temp, "source-free-ci-evidence.json"),
                          encoding="utf-8") as handle:
                    report = json.load(handle)
                self.assertEqual(report["workflow_trigger_sha"], trigger)
                self.assertEqual(report["workflow_trigger_event"], "pull_request")
                self.assertIs(report["trigger_sha_matches_reported_checkout"], expected)
                self.assertIs(report["verified_execution_claim"], False)



if __name__ == "__main__":
    unittest.main(verbosity=2)
