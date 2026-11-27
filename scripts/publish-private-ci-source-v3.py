#!/usr/bin/env python3
"""Fail-closed exact-tree publisher for private WebAssembly CI.

Reads only the exact open PR Git tree from the official private source API,
uploads that tree to one reviewed private carrier, emits a v3 receipt, and
creates the carrier's exact-tree branch plus dispatcher authorization ref.
No cross-org checkout, caller-provided API routes, or arbitrary commands.
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import resource
import stat
import subprocess
import sys
import tempfile

SOURCE_REPO = "ores-truffle-oreslang/oreslang-source.wasm"
SOURCE_REPO_ID = 1419858954
SOURCE_BRANCH = "main"
INCIDENT_REPO = "ores-truffle-oreslang/oreslang-platform-conformance"
INCIDENT_GATES = (
    (22, 5832921751,
     "https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/issues/22"),
    (77, 5904679716,
     "https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/issues/77"),
    (127, 5935338521,
     "https://github.com/ores-truffle-oreslang/oreslang-platform-conformance/issues/127"),
)
SELF_PATH = "scripts/publish-private-ci-source-v3.py"
POLICY_PATH = ".github/private-ci-approved-repositories.txt"
CONTRACT_PATH = "scripts/private-ci-carrier-contracts.json"
CODEOWNERS_PATH = ".github/CODEOWNERS"
PREFIX = "private-oreslang-source"
RECEIPT_PATH = "ci/oreslang-receipt.json"

NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$")
HANDOFF_REF = re.compile(
    r"^ci/(?:oreslang-[0-9a-f]{40}|authorized-[0-9a-f]{40})$"
)
HEX40 = re.compile(r"^[0-9a-f]{40}$")
MAVEN_ARTIFACT = re.compile(
    r"^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+"
    r"(?::[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?)?$"
)
SAFE_EXECUTABLE = re.compile(
    r"^(?:python3|mvn|cmake|ctest|cargo|node|dotnet|g\+\+|clang\+\+|/tmp/ores-[A-Za-z0-9_.-]+)$"
)
MAX_MAVEN_PREFETCH_ARTIFACTS = 16
CARRIER_REVIEW_LOGIN = "ORESoftware"
CARRIER_REVIEW_USER_ID = 11139560
MAX_GOVERNANCE_FILE = 1024 * 1024
MAX_FILES = 1024
MAX_TREE_ENTRIES = 4096
MAX_TOTAL = 40 * 1024 * 1024
MAX_FILE = 10 * 1024 * 1024
MAX_POLICY = 64 * 1024
MAX_PLAN = 64 * 1024
MAX_CODEOWNERS = 64 * 1024
MAX_GH_API_RESPONSE_BYTES = 24 * 1024 * 1024
TTL = dt.timedelta(hours=24)


class Denied(RuntimeError):
    pass


def valid_sha(value, label="invalid SHA"):
    if not isinstance(value, str) or not HEX40.fullmatch(value):
        raise Denied(label)
    return value


def git_blob_sha(data):
    return hashlib.sha1(
        b"blob " + str(len(data)).encode("ascii") + bytes([0]) + data
    ).hexdigest()


def canonical_bytes(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("ascii")


def canonical_digest(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def unique_object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise Denied("duplicate JSON key: " + key)
        out[key] = value
    return out


def strict_json_loads(text, label):
    def reject_constant(_value):
        raise Denied(label + " contains nonfinite JSON constant")

    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            raise Denied(label + " contains nonfinite JSON number")
        return number

    try:
        return json.loads(
            text,
            object_pairs_hook=unique_object,
            parse_constant=reject_constant,
            parse_float=finite_float,
        )
    except (json.JSONDecodeError, RecursionError, OverflowError) as exc:
        raise Denied(label) from exc


def canonical_security_lines(contents, label):
    """Accept only printable ASCII records separated by LF."""
    if (not isinstance(contents, bytes)
            or any(byte != 10 and not 32 <= byte <= 126 for byte in contents)):
        raise Denied(label + " contains noncanonical ASCII LF bytes")
    return contents.decode("ascii").split("\n")


def require_source_security_codeowners(contents):
    rules = {
        line.strip() for line in canonical_security_lines(
            contents, "protected source CODEOWNERS"
        )
        if line.strip() and not line.lstrip().startswith("#")
    }
    required = {
        "/.github/workflows/ @ORESoftware",
        "/.github/CODEOWNERS @ORESoftware",
        "/.github/private-ci-approved-repositories.txt @ORESoftware",
        "/scripts/ @ORESoftware",
    }
    if not required.issubset(rules):
        raise Denied("protected source CODEOWNERS lacks security-owner boundaries")


def require_carrier_security_codeowners(contents):
    rules = [
        line.strip() for line in canonical_security_lines(
            contents, "carrier CODEOWNERS"
        )
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if rules != [
        "* @ORESoftware",
        "/.github/ @ORESoftware",
        "/.github/CODEOWNERS @ORESoftware",
    ]:
        raise Denied("carrier CODEOWNERS must be fully security-owned")


def trusted_github_cli():
    """Resolve GitHub API access only through a root-controlled OS binary."""
    target = "/usr/bin/gh"
    for directory in ("/", "/usr", "/usr/bin"):
        try:
            info = os.lstat(directory)
        except OSError as exc:
            raise Denied("trusted GitHub CLI directory is unavailable") from exc
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0
                or info.st_mode & 0o022):
            raise Denied("trusted GitHub CLI directory is not root-controlled")
    try:
        info = os.lstat(target)
    except OSError as exc:
        raise Denied("trusted GitHub CLI is unavailable") from exc
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
            or info.st_mode & 0o6022 or not info.st_mode & 0o111):
        raise Denied("trusted GitHub CLI executable is not root-controlled")
    return target


def github_api_environment():
    """Use only one explicit token and a minimal deterministic environment."""
    provided = [
        name for name in ("GH_TOKEN", "GITHUB_TOKEN")
        if os.environ.get(name)
    ]
    if len(provided) != 1:
        raise Denied("exactly one explicit GitHub API token is required")
    return {
        provided[0]: os.environ[provided[0]],
        "GH_HOST": "github.com",
        "GH_PROMPT_DISABLED": "1",
        "PATH": "/usr/bin:/bin",
        "HOME": "/",
        "XDG_CONFIG_HOME": "/nonexistent",
        "LC_ALL": "C.UTF-8",
    }


def run_bounded_gh(argv, *, input=None, env=None, timeout=60):
    """Run gh with an OS-enforced per-stream byte cap."""
    limit = MAX_GH_API_RESPONSE_BYTES
    if (not hasattr(resource, "RLIMIT_FSIZE")
            or type(limit) is not int or limit < 2):
        raise Denied("OS cannot safely bound GitHub CLI output")

    def limit_child_files():
        resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))

    try:
        with tempfile.TemporaryFile(mode="w+b") as stdout_file, \
                tempfile.TemporaryFile(mode="w+b") as stderr_file:
            proc = subprocess.run(
                argv,
                input=input,
                stdout=stdout_file,
                stderr=stderr_file,
                text=True,
                env=env,
                timeout=timeout,
                check=False,
                start_new_session=True,
                preexec_fn=limit_child_files,
            )
            stdout_file.seek(0)
            stderr_file.seek(0)
            stdout_bytes = stdout_file.read(limit + 1)
            stderr_bytes = stderr_file.read(limit + 1)
    except (OSError, subprocess.SubprocessError) as exc:
        raise Denied("authenticated GitHub CLI bounded execution unavailable") from exc
    if len(stdout_bytes) >= limit or len(stderr_bytes) >= limit:
        raise Denied("authenticated GitHub API response exceeds size limit")
    try:
        stdout = stdout_bytes.decode("utf-8")
        stderr = stderr_bytes.decode("utf-8")
    except UnicodeError as exc:
        raise Denied("authenticated GitHub API response is not UTF-8") from exc
    return subprocess.CompletedProcess(argv, proc.returncode, stdout, stderr)


def gh_api(route, method="GET", payload=None):
    argv = [
        trusted_github_cli(), "api", "--method", method, route,
        "--header", "Accept: application/vnd.github+json",
    ]
    if payload is not None:
        argv.extend(["--input", "-"])
    proc = run_bounded_gh(
        argv,
        input=json.dumps(payload) if payload is not None else None,
        env=github_api_environment(),
        timeout=60,
    )
    if proc.returncode != 0:
        # Never echo stderr: API failures can include private context.
        raise Denied("authenticated GitHub API request failed")
    result = strict_json_loads(proc.stdout, "invalid GitHub API response")
    if not isinstance(result, dict):
        raise Denied("unexpected GitHub API response shape")
    return result


def decode_contents(item, path, max_bytes):
    if (item.get("path") != path or item.get("type") != "file"
            or item.get("encoding") != "base64"):
        raise Denied("protected file metadata mismatch: " + path)
    encoded = item.get("content")
    if not isinstance(encoded, str):
        raise Denied("protected file content missing: " + path)
    try:
        data = base64.b64decode("".join(encoded.split()), validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise Denied("invalid base64 for protected file: " + path) from exc
    if not data or len(data) > max_bytes:
        raise Denied("protected file missing or oversized: " + path)
    blob_sha = valid_sha(item.get("sha"), "protected file blob SHA invalid")
    if git_blob_sha(data) != blob_sha:
        raise Denied("protected file blob digest mismatch: " + path)
    return data


def safe_descriptor_flags_available():
    flags = tuple(
        getattr(os, name, None)
        for name in ("O_DIRECTORY", "O_NOFOLLOW", "O_NONBLOCK")
    )
    if not all(type(value) is int and value > 0 for value in flags):
        return False
    return all(
        (left & right) == 0
        for index, left in enumerate(flags)
        for right in flags[index + 1:]
    )


def read_local_regular(path, max_bytes):
    """Read one protected file without following any path-component symlink."""
    if (not isinstance(path, (str, Path))
            or not isinstance(max_bytes, int) or isinstance(max_bytes, bool)
            or max_bytes <= 0 or not safe_descriptor_flags_available()):
        raise Denied("local protected file request is unsafe")
    text_path = str(path)
    if "\\" in text_path:
        raise Denied("local protected file path is unsafe")
    pure = PurePosixPath(text_path)
    absolute = pure.is_absolute()
    parts = pure.parts[1:] if absolute else pure.parts
    if (not parts
            or any(part in ("", ".", "..") for part in parts)
            or any(part.casefold() == ".git" for part in parts)):
        raise Denied("local protected file path is unsafe")

    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    file_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    opened = []
    try:
        current = os.open("/" if absolute else ".", directory_flags)
        opened.append(current)
        for component in parts[:-1]:
            current = os.open(component, directory_flags, dir_fd=current)
            opened.append(current)
        file_fd = os.open(parts[-1], file_flags, dir_fd=current)
        try:
            stream = os.fdopen(file_fd, "rb")
        except BaseException:
            os.close(file_fd)
            raise
        with stream:
            meta = os.fstat(stream.fileno())
            if (not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1
                    or meta.st_size <= 0 or meta.st_size > max_bytes):
                raise Denied("local protected file unsafe: " + text_path)
            data = stream.read(max_bytes + 1)
    except OSError as exc:
        raise Denied("local protected file unavailable: " + text_path) from exc
    finally:
        for fd in reversed(opened):
            os.close(fd)
    if len(data) != meta.st_size or len(data) > max_bytes:
        raise Denied("local protected file changed while reading: " + text_path)
    return data


def gh_api_list(route):
    """Bounded authenticated GET for GitHub list endpoints."""
    argv = [
        trusted_github_cli(), "api", "--method", "GET", route,
        "--header", "Accept: application/vnd.github+json",
    ]
    completed = run_bounded_gh(
        argv, env=github_api_environment(), timeout=45
    )
    if completed.returncode != 0:
        raise Denied("authenticated GitHub list request failed")
    data = strict_json_loads(
        completed.stdout, "invalid GitHub list JSON response"
    )
    if not isinstance(data, list):
        raise Denied("unexpected GitHub list response shape")
    return data


def github_timestamp(value, label):
    if not isinstance(value, str):
        raise Denied(label)
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise Denied(label) from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise Denied(label)
    return parsed.astimezone(dt.timezone.utc)


def _latest_review(repository, review_pr, reviewer_id, reviewer_login, label):
    reviews = gh_api_list(
        f"repos/{repository}/pulls/{review_pr}/reviews?per_page=100"
    )
    if len(reviews) >= 100:
        raise Denied(label + " review history exceeds bounded page")
    matching = []
    seen_ids = set()
    for review in reviews:
        if not isinstance(review, dict):
            raise Denied(label + " review history is malformed")
        review_id = review.get("id")
        if (not isinstance(review_id, int) or isinstance(review_id, bool)
                or review_id <= 0 or review_id in seen_ids):
            raise Denied(label + " review history has invalid IDs")
        seen_ids.add(review_id)
        user = review.get("user")
        if (isinstance(user, dict)
                and user.get("id") == reviewer_id
                and isinstance(user.get("login"), str)
                and user["login"].casefold() == reviewer_login.casefold()):
            valid_sha(review.get("commit_id"), label + " review commit SHA invalid")
            submitted = github_timestamp(
                review.get("submitted_at"), label + " review timestamp invalid"
            )
            if not isinstance(review.get("state"), str):
                raise Denied(label + " review state invalid")
            matching.append((submitted, review_id, review))
    if not matching:
        raise Denied("independent " + label + " review is missing")
    matching.sort(key=lambda item: (item[0], item[1]))
    return matching[-1][2]


def authorized_source_main_sha():
    """Require enforced protected source main for every private-source export."""
    branch = gh_api(f"repos/{SOURCE_REPO}/branches/{SOURCE_BRANCH}")
    if branch.get("name") != SOURCE_BRANCH:
        raise Denied("source main branch identity changed")
    if branch.get("protected") is not True:
        raise Denied("source main is not protected; private export denied")
    return source_protection()


def source_protection():
    repo = gh_api(f"repos/{SOURCE_REPO}")
    if (repo.get("id") != SOURCE_REPO_ID
            or repo.get("full_name") != SOURCE_REPO
            or repo.get("private") is not True):
        raise Denied("source repository identity/privacy mismatch")
    branch = gh_api(f"repos/{SOURCE_REPO}/branches/{SOURCE_BRANCH}")
    if (branch.get("name") != SOURCE_BRANCH
            or branch.get("protected") is not True):
        raise Denied("source main is not protected")
    protection = gh_api(f"repos/{SOURCE_REPO}/branches/{SOURCE_BRANCH}/protection")
    reviews = protection.get("required_pull_request_reviews")
    if (not isinstance(reviews, dict)
            or reviews.get("require_code_owner_reviews") is not True
            or reviews.get("dismiss_stale_reviews") is not True
            or not isinstance(reviews.get("required_approving_review_count"), int)
            or isinstance(reviews.get("required_approving_review_count"), bool)
            or reviews.get("required_approving_review_count", 0) < 1):
        raise Denied("source main does not enforce independent CODEOWNER review")
    admins = protection.get("enforce_admins")
    force = protection.get("allow_force_pushes")
    delete = protection.get("allow_deletions")
    if (not isinstance(admins, dict) or admins.get("enabled") is not True
            or not isinstance(force, dict) or force.get("enabled") is not False
            or not isinstance(delete, dict) or delete.get("enabled") is not False):
        raise Denied("source main admin/force/delete protection incomplete")
    bypasses = reviews.get("bypass_pull_request_allowances")
    if bypasses is not None:
        if (not isinstance(bypasses, dict)
                or any(not isinstance(bypasses.get(k, []), list)
                       or bypasses.get(k) for k in ("users", "teams", "apps"))):
            raise Denied("source main has pull-request review bypasses")
    return valid_sha(branch.get("commit", {}).get("sha"),
                     "source protected-main SHA invalid")


def remote_source_file(path, main_sha, max_bytes):
    item = gh_api(f"repos/{SOURCE_REPO}/contents/{path}?ref={main_sha}")
    data = decode_contents(item, path, max_bytes)
    return data, valid_sha(item.get("sha"), "protected file blob SHA invalid")


def parse_allowlist(raw, repository):
    lines = canonical_security_lines(raw, "allowlist")
    seen_names = set()
    seen_ids = set()
    selected = None
    pattern = re.compile(
        r"^([A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*) "
        r"([1-9][0-9]{0,19})$"
    )
    for line in lines:
        if not line or line.startswith("#"):
            continue
        match = pattern.fullmatch(line)
        if match is None:
            raise Denied("allowlist contains invalid entry")
        name, repo_id_text = match.groups()
        folded = name.casefold()
        repo_id = int(repo_id_text)
        if folded in seen_names or repo_id in seen_ids:
            raise Denied("allowlist contains duplicate destination")
        seen_names.add(folded)
        seen_ids.add(repo_id)
        if folded == repository.casefold():
            selected = repo_id
    if selected is None:
        raise Denied("destination absent from protected allowlist")
    return selected


def safe_path(value, prefix, suffix):
    if not isinstance(value, str):
        raise Denied("invalid protected carrier path")
    parts = PurePosixPath(value).parts
    if (not re.fullmatch(r"[A-Za-z0-9._/-]+", value)
            or PurePosixPath(value).as_posix() != value
            or not value.startswith(prefix) or not value.endswith(suffix)
            or not parts or value.startswith("/")
            or any(part in (".", "..") for part in parts)
            or any(part.casefold() == ".git" for part in parts)):
        raise Denied("invalid protected carrier path")
    return value


def parse_contract(raw, repository, source_pr, test_plan):
    try:
        doc = strict_json_loads(raw.decode("utf-8"), "invalid carrier contract JSON")
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise Denied("invalid carrier contract JSON") from exc
    if not isinstance(doc, dict) or doc.get("schema") != 1:
        raise Denied("carrier contract schema")
    carriers = doc.get("carriers")
    carrier = carriers.get(repository) if isinstance(carriers, dict) else None
    if not isinstance(carrier, dict):
        raise Denied("destination absent from protected carrier contract")
    required_carrier_fields = {
        "repository_id", "base_sha", "workflow_path",
        "workflow_blob_sha", "test_plans"
    }
    allowed_carrier_fields = required_carrier_fields | {"review_pr"}
    if (not required_carrier_fields.issubset(carrier)
            or not set(carrier).issubset(allowed_carrier_fields)):
        raise Denied("carrier contract fields")
    repo_id = carrier.get("repository_id")
    if not isinstance(repo_id, int) or isinstance(repo_id, bool) or repo_id <= 0:
        raise Denied("carrier repository id")
    base_sha = valid_sha(carrier.get("base_sha"), "carrier base SHA")
    review_pr = carrier.get("review_pr")
    if (review_pr is not None
            and (not isinstance(review_pr, int) or isinstance(review_pr, bool)
                 or review_pr <= 0)):
        raise Denied("carrier review PR invalid")
    workflow_path = safe_path(
        carrier.get("workflow_path"), ".github/workflows/", ".yml"
    )
    workflow_blob = valid_sha(
        carrier.get("workflow_blob_sha"), "carrier workflow blob"
    )
    plans = carrier.get("test_plans")
    plan_path = safe_path(test_plan, "ci/test-plans/", ".json")
    plan = plans.get(plan_path) if isinstance(plans, dict) else None
    if not isinstance(plan, dict) or set(plan) != {"blob_sha", "allowed_prs"}:
        raise Denied("test plan absent from protected carrier contract")
    blob_sha = valid_sha(plan.get("blob_sha"), "test plan blob")
    allowed = plan.get("allowed_prs")
    if (not isinstance(allowed, list) or not allowed
            or len(set(allowed)) != len(allowed)
            or any(not isinstance(x, int) or isinstance(x, bool) or x <= 0
                   for x in allowed)
            or source_pr not in allowed):
        raise Denied("source PR not authorized by protected test plan")
    return {
        "repository_id": repo_id,
        "base_sha": base_sha,
        "workflow_path": workflow_path,
        "workflow_blob_sha": workflow_blob,
        "test_plan_path": plan_path,
        "test_plan_blob_sha": blob_sha,
        "review_pr": review_pr,
    }


def _validate_maven_prefetch_artifacts(plan, uses_maven):
    extras = plan.get("maven_prefetch_artifacts", [])
    if extras is None:
        extras = []
    if (not isinstance(extras, list)
            or len(extras) > MAX_MAVEN_PREFETCH_ARTIFACTS
            or any(not isinstance(value, str)
                   or len(value) > 256
                   or not MAVEN_ARTIFACT.fullmatch(value)
                   for value in extras)
            or len(set(extras)) != len(extras)):
        raise Denied("reviewed test plan Maven prefetch artifacts invalid")
    if not uses_maven and extras:
        raise Denied("non-Maven test plan cannot prefetch Maven artifacts")
    return list(extras)


def _validate_maven_argv(argv):
    if "-o" not in argv and "--offline" not in argv:
        raise Denied("Maven carrier commands must run offline")
    if "-C" not in argv and "--strict-checksums" not in argv:
        raise Denied("Maven carrier commands must require strict checksums")
    short_with_values = ("-s", "-gs", "-f")
    long_with_values = ("--settings", "--global-settings", "--file")
    dangerous_props = (
        "-Dmaven.repo.local", "-DskipTests", "-Dmaven.test.skip", "-DskipITs",
    )
    for arg in argv[1:]:
        if (any(arg == flag or (arg.startswith(flag) and arg != flag)
                for flag in short_with_values)
                or any(arg == flag or arg.startswith(flag + "=")
                       for flag in long_with_values)
                or any(arg == prop or arg.startswith(prop + "=")
                       for prop in dangerous_props)):
            raise Denied("Maven carrier command overrides trusted build controls")


def validate_test_plan(plan_bytes, source_pr):
    try:
        plan = strict_json_loads(
            plan_bytes.decode("utf-8"), "invalid reviewed carrier test plan"
        )
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise Denied("invalid reviewed carrier test plan") from exc
    if (not isinstance(plan, dict)
            or plan.get("schema") != "ores-private-ci-test-plan-v1"
            or plan.get("source_repo") != SOURCE_REPO):
        raise Denied("reviewed test plan source/schema mismatch")

    allowed_fields = {
        "schema", "source_repo", "allowed_prs", "commands",
        "required_source_blobs", "required_source_head_sha",
        "required_source_root_tree_sha", "maven_pom_blob_sha",
        "maven_prefetch_artifacts",
    }
    if not set(plan).issubset(allowed_fields):
        raise Denied("reviewed test plan has unexpected fields")

    allowed = plan.get("allowed_prs")
    if (not isinstance(allowed, list) or not allowed
            or source_pr not in allowed
            or any(not isinstance(value, int) or isinstance(value, bool)
                   or value <= 0 for value in allowed)
            or len(set(allowed)) != len(allowed)):
        raise Denied("reviewed test plan does not authorize source PR")

    required_head = plan.get("required_source_head_sha")
    required_tree = plan.get("required_source_root_tree_sha")
    if (required_head is None) != (required_tree is None):
        raise Denied("reviewed test plan source snapshot pins must be paired")
    if required_head is not None:
        required_head = valid_sha(
            required_head, "reviewed test plan source head pin invalid"
        )
        required_tree = valid_sha(
            required_tree, "reviewed test plan source root tree pin invalid"
        )

    required = plan.get("required_source_blobs", {})
    if not isinstance(required, dict):
        raise Denied("reviewed test plan required source blobs invalid")
    checked_required = {}
    for path, sha in required.items():
        if (not isinstance(path, str) or not path
                or path.startswith("/") or "\\" in path
                or ".." in PurePosixPath(path).parts
                or ".git" in PurePosixPath(path).parts):
            raise Denied("reviewed test plan has unsafe required source path")
        checked_required[path] = valid_sha(
            sha, "reviewed test plan required source blob invalid"
        )

    commands = plan.get("commands")
    if not isinstance(commands, list) or not 1 <= len(commands) <= 16:
        raise Denied("reviewed test plan commands missing or excessive")
    uses_maven = False
    for command in commands:
        if not isinstance(command, dict):
            raise Denied("reviewed test plan command shape invalid")
        if (not {"argv", "cwd", "timeout_seconds"}.issubset(command)
                or not set(command).issubset({
                    "argv", "cwd", "timeout_seconds", "stdout_contains",
                })):
            raise Denied("reviewed test plan command shape invalid")
        argv = command.get("argv")
        cwd = command.get("cwd")
        timeout = command.get("timeout_seconds")
        expected = command.get("stdout_contains")
        if (not isinstance(argv, list) or not argv or len(argv) > 64
                or any(not isinstance(arg, str) or not arg or len(arg) > 4096
                       or "\x00" in arg for arg in argv)
                or not SAFE_EXECUTABLE.fullmatch(argv[0])
                or not isinstance(cwd, str) or not cwd
                or cwd.startswith("/") or "\\" in cwd
                or ".." in PurePosixPath(cwd).parts
                or ".git" in PurePosixPath(cwd).parts
                or not isinstance(timeout, int) or isinstance(timeout, bool)
                or not 1 <= timeout <= 1800
                or (expected is not None
                    and (not isinstance(expected, str)
                         or not expected or len(expected) > 4096))):
            raise Denied("reviewed test plan command invalid")
        if argv[0] == "mvn":
            uses_maven = True
            _validate_maven_argv(argv)

    pom_pin = plan.get("maven_pom_blob_sha")
    if pom_pin is not None:
        pom_pin = valid_sha(pom_pin, "reviewed Maven pom blob invalid")
        old_pin = checked_required.get("pom.xml")
        if old_pin is not None and old_pin != pom_pin:
            raise Denied("reviewed Maven pom pins disagree")
        checked_required["pom.xml"] = pom_pin

    extras = _validate_maven_prefetch_artifacts(plan, uses_maven)
    if uses_maven and "pom.xml" not in checked_required:
        raise Denied("Maven test plan must bind exact pom.xml blob")
    if not uses_maven and pom_pin is not None:
        raise Denied("non-Maven test plan cannot bind Maven pom")

    return {
        "sha256": hashlib.sha256(plan_bytes).hexdigest(),
        "required_source_blobs": checked_required,
        "required_source_head_sha": required_head,
        "required_source_root_tree_sha": required_tree,
        "uses_maven": uses_maven,
        "maven_pom_blob_sha": checked_required.get("pom.xml"),
        "maven_prefetch_artifacts": extras,
    }


def verify_required_source_snapshot(plan_meta, source_commit, source_tree=None):
    required_head = plan_meta.get("required_source_head_sha")
    required_tree = plan_meta.get("required_source_root_tree_sha")
    if required_head is None and required_tree is None:
        return
    if required_head is None or required_tree is None:
        raise Denied("reviewed test plan source snapshot pins are incomplete")
    if source_commit != required_head:
        raise Denied("source head differs from reviewed test plan")
    if source_tree is not None and source_tree != required_tree:
        raise Denied("source root tree differs from reviewed test plan")


def verify_required_source_blobs(files, required):
    if not isinstance(required, dict):
        raise Denied("required source blob contract invalid")
    actual = {path: sha for path, _mode, sha, _data in files}
    for path, expected in required.items():
        if actual.get(path) != expected:
            raise Denied(
                "exact source tree differs from reviewed required blob: " + path
            )


def require_incident_closure():
    """Require independent completion of every pinned private-CI P0 incident."""
    for number, issue_id, html_url in INCIDENT_GATES:
        issue = gh_api(f"repos/{INCIDENT_REPO}/issues/{number}")
        if (not isinstance(issue, dict)
                or issue.get("id") != issue_id
                or issue.get("number") != number
                or issue.get("html_url") != html_url
                or issue.get("state") != "closed"
                or issue.get("state_reason") != "completed"
                or "pull_request" in issue):
            raise Denied(
                f"platform-conformance incident #{number} is not independently completed"
            )
    return True


def protected_authority(repository, source_pr, test_plan):
    """Attest incidents, this exact script, and local policies to enforced protected source main."""
    require_incident_closure()
    main_sha = authorized_source_main_sha()
    remote_self, remote_self_sha = remote_source_file(
        SELF_PATH, main_sha, 512 * 1024
    )
    local_self = read_local_regular(__file__, 512 * 1024)
    if local_self != remote_self or git_blob_sha(local_self) != remote_self_sha:
        raise Denied("publisher bytes differ from protected source main")

    remote_codeowners, _ = remote_source_file(
        CODEOWNERS_PATH, main_sha, MAX_CODEOWNERS
    )
    local_codeowners = read_local_regular(CODEOWNERS_PATH, MAX_CODEOWNERS)
    if local_codeowners != remote_codeowners:
        raise Denied("local CODEOWNERS differs from protected source main")
    require_source_security_codeowners(remote_codeowners)

    remote_allow, _ = remote_source_file(POLICY_PATH, main_sha, MAX_POLICY)
    local_allow = read_local_regular(POLICY_PATH, MAX_POLICY)
    if local_allow != remote_allow:
        raise Denied("local allowlist differs from protected source main")
    allowlisted_repository_id = parse_allowlist(remote_allow, repository)

    remote_contract, _ = remote_source_file(CONTRACT_PATH, main_sha, MAX_POLICY)
    local_contract = read_local_regular(CONTRACT_PATH, MAX_POLICY)
    if local_contract != remote_contract:
        raise Denied("local carrier contract differs from protected source main")
    contract = parse_contract(
        remote_contract, repository, source_pr, test_plan
    )
    if contract["repository_id"] != allowlisted_repository_id:
        raise Denied("allowlist repository id differs from carrier contract")
    return main_sha, contract


def carrier_commit_tree(repository, commit_sha):
    commit_sha = valid_sha(commit_sha, "carrier commit SHA invalid")
    commit = gh_api(f"repos/{repository}/git/commits/{commit_sha}")
    if commit.get("sha") != commit_sha:
        raise Denied("carrier commit identity mismatch")
    return valid_sha(
        commit.get("tree", {}).get("sha"), "carrier root tree SHA invalid"
    )


def review_attested_carrier_main(repository, contract, branch):
    review_pr = contract.get("review_pr")
    if not isinstance(review_pr, int) or isinstance(review_pr, bool) or review_pr <= 0:
        raise Denied("unprotected carrier requires reviewed carrier PR")
    base_sha = valid_sha(
        branch.get("commit", {}).get("sha"), "carrier main SHA"
    )
    if base_sha != contract["base_sha"]:
        raise Denied("carrier main advanced beyond reviewed base")

    pr = gh_api(f"repos/{repository}/pulls/{review_pr}")
    head = pr.get("head")
    base = pr.get("base")
    author = pr.get("user")
    if (pr.get("number") != review_pr
            or pr.get("state") != "closed"
            or pr.get("merged_at") is None
            or not isinstance(author, dict)
            or not isinstance(author.get("id"), int)
            or isinstance(author.get("id"), bool)
            or author.get("id") <= 0
            or author.get("id") == CARRIER_REVIEW_USER_ID
            or not isinstance(head, dict)
            or not isinstance(head.get("repo"), dict)
            or head["repo"].get("full_name") != repository
            or head["repo"].get("id") != contract["repository_id"]
            or not isinstance(base, dict)
            or base.get("ref") != "main"
            or not isinstance(base.get("repo"), dict)
            or base["repo"].get("full_name") != repository
            or base["repo"].get("id") != contract["repository_id"]):
        raise Denied(
            "carrier review PR is not an independent merged same-repo main review"
        )

    reviewed_head = valid_sha(
        head.get("sha"), "carrier review PR head SHA invalid"
    )
    review = _latest_review(
        repository, review_pr,
        CARRIER_REVIEW_USER_ID, CARRIER_REVIEW_LOGIN,
        "carrier",
    )
    submitted_at = github_timestamp(
        review.get("submitted_at"), "carrier review timestamp invalid"
    )
    merged_at = github_timestamp(
        pr.get("merged_at"), "carrier merge timestamp invalid"
    )
    if (review.get("state") != "APPROVED"
            or review.get("commit_id") != reviewed_head
            or submitted_at > merged_at):
        raise Denied("independent carrier review is stale, late, or not approved")

    reviewed_tree = carrier_commit_tree(repository, reviewed_head)
    main_tree = carrier_commit_tree(repository, base_sha)
    if reviewed_tree != main_tree:
        raise Denied("carrier main tree differs from independently reviewed PR head")

    codeowners = gh_api(
        f"repos/{repository}/contents/{CODEOWNERS_PATH}?ref={base_sha}"
    )
    carrier_codeowners = decode_contents(
        codeowners, CODEOWNERS_PATH, MAX_GOVERNANCE_FILE
    )
    require_carrier_security_codeowners(carrier_codeowners)
    return base_sha


def checked_carrier_main(repository, contract):
    branch = gh_api(f"repos/{repository}/branches/main")
    if branch.get("name") != "main":
        raise Denied("carrier main branch identity changed")
    base_sha = valid_sha(
        branch.get("commit", {}).get("sha"), "carrier main SHA"
    )
    if base_sha != contract["base_sha"]:
        raise Denied("carrier main advanced beyond reviewed base")

    if branch.get("protected") is not True:
        return review_attested_carrier_main(repository, contract, branch)

    protection = gh_api(f"repos/{repository}/branches/main/protection")
    reviews = protection.get("required_pull_request_reviews")
    if (not isinstance(reviews, dict)
            or reviews.get("require_code_owner_reviews") is not True
            or reviews.get("dismiss_stale_reviews") is not True
            or not isinstance(reviews.get("required_approving_review_count"), int)
            or isinstance(reviews.get("required_approving_review_count"), bool)
            or reviews.get("required_approving_review_count", 0) < 1):
        raise Denied("carrier main does not enforce independent CODEOWNER review")
    admins = protection.get("enforce_admins")
    force = protection.get("allow_force_pushes")
    delete = protection.get("allow_deletions")
    if (not isinstance(admins, dict) or admins.get("enabled") is not True
            or not isinstance(force, dict) or force.get("enabled") is not False
            or not isinstance(delete, dict) or delete.get("enabled") is not False):
        raise Denied("carrier main admin/force/delete protection incomplete")
    bypasses = reviews.get("bypass_pull_request_allowances")
    if bypasses is not None:
        if (not isinstance(bypasses, dict)
                or any(not isinstance(bypasses.get(k, []), list)
                       or bypasses.get(k) for k in ("users", "teams", "apps"))):
            raise Denied("carrier main has pull-request review bypasses")
    codeowners = gh_api(
        f"repos/{repository}/contents/{CODEOWNERS_PATH}?ref={base_sha}"
    )
    carrier_codeowners = decode_contents(
        codeowners, CODEOWNERS_PATH, MAX_GOVERNANCE_FILE
    )
    require_carrier_security_codeowners(carrier_codeowners)
    return base_sha


def checked_destination(repository, contract):
    repo = gh_api(f"repos/{repository}")
    if (repo.get("id") != contract["repository_id"]
            or repo.get("full_name") != repository
            or repo.get("private") is not True
            or repo.get("visibility") != "private"
            or repo.get("default_branch") != "main"
            or repo.get("archived") is not False
            or repo.get("disabled") is not False
            or repo.get("fork") is not False):
        raise Denied("carrier identity/state differs from protected contract")
    base_sha = checked_carrier_main(repository, contract)
    commit = gh_api(f"repos/{repository}/git/commits/{base_sha}")
    base_tree = valid_sha(commit.get("tree", {}).get("sha"), "carrier base tree")
    listing = gh_api(f"repos/{repository}/git/trees/{base_tree}?recursive=1")
    if (listing.get("sha") != base_tree
            or listing.get("truncated") is not False
            or not isinstance(listing.get("tree"), list)):
        raise Denied("carrier base tree listing incomplete")
    for entry in listing["tree"]:
        path = entry.get("path") if isinstance(entry, dict) else None
        if (path == PREFIX
                or isinstance(path, str) and path.startswith(PREFIX + "/")
                or path == RECEIPT_PATH):
            raise Denied("reviewed carrier base is not source-free")

    workflow = gh_api(
        f"repos/{repository}/contents/{contract['workflow_path']}?ref={base_sha}"
    )
    if (workflow.get("path") != contract["workflow_path"]
            or workflow.get("type") != "file"
            or workflow.get("sha") != contract["workflow_blob_sha"]):
        raise Denied("carrier workflow differs from protected contract")

    plan = gh_api(
        f"repos/{repository}/contents/{contract['test_plan_path']}?ref={base_sha}"
    )
    if (plan.get("path") != contract["test_plan_path"]
            or plan.get("type") != "file"
            or plan.get("encoding") != "base64"
            or plan.get("sha") != contract["test_plan_blob_sha"]):
        raise Denied("carrier test plan differs from protected contract")
    plan_bytes = decode_contents(plan, contract["test_plan_path"], MAX_PLAN)
    if git_blob_sha(plan_bytes) != contract["test_plan_blob_sha"]:
        raise Denied("carrier test plan blob digest mismatch")
    try:
        plan_doc = strict_json_loads(
            plan_bytes.decode("utf-8"), "invalid reviewed carrier test plan"
        )
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise Denied("invalid reviewed carrier test plan") from exc
    if (not isinstance(plan_doc, dict)
            or plan_doc.get("schema") != "ores-private-ci-test-plan-v1"
            or plan_doc.get("source_repo") != SOURCE_REPO):
        raise Denied("carrier test plan source/schema mismatch")
    return base_tree, plan_bytes


def verify_source_pr(source_pr, source_commit):
    pr = gh_api(f"repos/{SOURCE_REPO}/pulls/{source_pr}")
    head = pr.get("head")
    base = pr.get("base")
    if (pr.get("number") != source_pr
            or pr.get("state") != "open"
            or not isinstance(head, dict)
            or head.get("sha") != source_commit
            or not isinstance(head.get("repo"), dict)
            or head["repo"].get("full_name") != SOURCE_REPO
            or not isinstance(base, dict)
            or base.get("ref") != SOURCE_BRANCH):
        raise Denied("source commit is not exact open PR head against main")
    return SOURCE_REPO_ID


def exact_source_tree(source_pr, source_commit):
    verify_source_pr(source_pr, source_commit)

    commit = gh_api(f"repos/{SOURCE_REPO}/git/commits/{source_commit}")
    if commit.get("sha") != source_commit:
        raise Denied("source commit identity mismatch")
    root_tree = valid_sha(commit.get("tree", {}).get("sha"), "source root tree")
    tree = gh_api(f"repos/{SOURCE_REPO}/git/trees/{root_tree}?recursive=1")
    entries = tree.get("tree")
    if (tree.get("sha") != root_tree or tree.get("truncated") is not False
            or not isinstance(entries, list) or len(entries) > MAX_TREE_ENTRIES):
        raise Denied("source tree incomplete or exceeds safety limit")

    # Validate all paths, modes, SHAs and declared blob sizes before fetching
    # any blob bytes. GitHub's tree metadata gives us enough information to
    # enforce the mirror budget without first allocating a potentially huge
    # base64 blob response.
    declared = []
    declared_total = 0
    for entry in entries:
        if not isinstance(entry, dict):
            raise Denied("malformed source tree entry")
        kind = entry.get("type")
        if kind == "tree":
            continue
        mode = entry.get("mode")
        path = entry.get("path")
        if kind != "blob" or mode not in ("100644", "100755"):
            raise Denied("source tree contains symlink/submodule/unsupported mode")
        if not isinstance(path, str) or not path:
            raise Denied("source tree path invalid")
        parts = PurePosixPath(path).parts
        if (path.startswith("/") or ".." in parts or ".git" in parts
                or "\\" in path or any(ord(c) < 32 or ord(c) == 127 for c in path)):
            raise Denied("source tree path unsafe")
        sha = valid_sha(entry.get("sha"), "source blob SHA")
        size = entry.get("size")
        if (not isinstance(size, int) or isinstance(size, bool)
                or size < 0 or size > MAX_FILE):
            raise Denied("source file exceeds mirror limit")
        declared_total += size
        if declared_total > MAX_TOTAL or len(declared) >= MAX_FILES:
            raise Denied("source mirror exceeds bounded capacity")
        declared.append((path, mode, sha, size))

    if not declared:
        raise Denied("source tree is empty")

    files = []
    for path, mode, sha, declared_size in declared:
        blob = gh_api(f"repos/{SOURCE_REPO}/git/blobs/{sha}")
        if (blob.get("sha") != sha or blob.get("encoding") != "base64"):
            raise Denied("source blob metadata mismatch")
        encoded = blob.get("content")
        if not isinstance(encoded, str):
            raise Denied("source blob content missing")
        try:
            data = base64.b64decode("".join(encoded.split()), validate=True)
        except (ValueError, base64.binascii.Error) as exc:
            raise Denied("source blob base64 invalid") from exc
        if len(data) != declared_size:
            raise Denied("source blob size differs from tree metadata")
        if git_blob_sha(data) != sha:
            raise Denied("source blob bytes do not match Git SHA")
        files.append((path, mode, sha, data))

    files.sort(key=lambda item: item[0])
    rows = [[path, mode, sha, len(data)] for path, mode, sha, data in files]
    return root_tree, files, rows, hashlib.sha256(canonical_bytes(rows)).hexdigest()


def verify_published_root_and_commit(
        repository, base_sha, source_tree, receipt_blob_sha,
        root_tree_sha, commit_sha):
    """Read back the exact carrier object graph before exposing any ref."""
    commit = gh_api(f"repos/{repository}/git/commits/{commit_sha}")
    parents = commit.get("parents")
    if (commit.get("sha") != commit_sha
            or commit.get("tree", {}).get("sha") != root_tree_sha
            or not isinstance(parents, list)
            or len(parents) != 1
            or not isinstance(parents[0], dict)
            or parents[0].get("sha") != base_sha):
        raise Denied("published carrier commit differs from requested object graph")

    listing = gh_api(
        f"repos/{repository}/git/trees/{root_tree_sha}?recursive=1"
    )
    if (listing.get("sha") != root_tree_sha
            or listing.get("truncated") is not False
            or not isinstance(listing.get("tree"), list)):
        raise Denied("published carrier root tree listing is incomplete")

    expected = {
        PREFIX: ("040000", "tree", source_tree),
        RECEIPT_PATH: ("100644", "blob", receipt_blob_sha),
    }
    found = {}
    for entry in listing["tree"]:
        if not isinstance(entry, dict):
            raise Denied("published carrier tree entry is malformed")
        path = entry.get("path")
        if path not in expected:
            continue
        if path in found:
            raise Denied("published carrier tree contains duplicate protected path")
        found[path] = (
            entry.get("mode"),
            entry.get("type"),
            valid_sha(entry.get("sha"), "published carrier tree SHA invalid"),
        )
    if found != expected:
        raise Denied("published carrier tree differs from exact source/receipt binding")


def require_handoff_refs_absent(
        repository, branch, authorization, expected_repository_id):
    if live_ref_sha(repository, branch, expected_repository_id) is not None:
        raise Denied("exact-tree carrier branch already exists")
    if live_ref_sha(repository, authorization, expected_repository_id) is not None:
        raise Denied("exact-tree authorization ref already exists")


def recheck_destination_identity(repository, contract):
    repo = gh_api(f"repos/{repository}")
    if (repo.get("id") != contract["repository_id"]
            or repo.get("full_name") != repository
            or repo.get("private") is not True
            or repo.get("visibility") != "private"):
        raise Denied("carrier identity/privacy changed during transfer")
    branch = gh_api(f"repos/{repository}/branches/main")
    if (branch.get("name") != "main"
            or branch.get("commit", {}).get("sha") != contract["base_sha"]):
        raise Denied("carrier main changed during transfer")


def _gh_ref_request(repository, ref_name, method):
    if not isinstance(ref_name, str) or not HANDOFF_REF.fullmatch(ref_name):
        raise Denied("ref cleanup target is invalid")
    if method not in ("GET", "DELETE"):
        raise Denied("ref cleanup method is invalid")
    encoded = ref_name.replace("/", "%2F")
    family = "ref" if method == "GET" else "refs"
    argv = [
        trusted_github_cli(), "api", "--method", method,
        f"repos/{repository}/git/{family}/heads/{encoded}",
        "--header", "Accept: application/vnd.github+json",
    ]
    return run_bounded_gh(
        argv,
        env=github_api_environment(),
        timeout=30,
    )


def _is_http_status(stderr, status):
    if not isinstance(stderr, str):
        return False
    first_line = stderr.split("\n", 1)[0]
    return re.fullmatch(
        rf"gh: [^\r\n]{{1,4096}} \(HTTP {status}\)", first_line
    ) is not None


def live_ref_sha(repository, ref_name, expected_repository_id):
    repo = gh_api(f"repos/{repository}")
    if (repo.get("id") != expected_repository_id
            or repo.get("full_name") != repository
            or repo.get("private") is not True
            or repo.get("visibility") != "private"
            or repo.get("archived") is not False
            or repo.get("disabled") is not False):
        raise Denied("carrier repository identity changed during ref verification")
    result = _gh_ref_request(repository, ref_name, "GET")
    if result.returncode != 0:
        if _is_http_status(result.stderr, 404):
            return None
        raise Denied("carrier ref lookup failed")
    try:
        payload = strict_json_loads(
            result.stdout, "carrier ref lookup returned invalid JSON"
        )
    except json.JSONDecodeError as exc:
        raise Denied("carrier ref lookup returned invalid JSON") from exc
    if (not isinstance(payload, dict)
            or payload.get("ref") != "refs/heads/" + ref_name
            or payload.get("object", {}).get("type") != "commit"):
        raise Denied("carrier ref lookup returned unexpected identity")
    return valid_sha(
        payload.get("object", {}).get("sha"),
        "carrier ref lookup returned invalid SHA",
    )


def require_exact_ref(repository, ref_name, expected_sha, expected_repository_id):
    actual = live_ref_sha(repository, ref_name, expected_repository_id)
    if actual != expected_sha:
        raise Denied("carrier ref does not point to exact handoff commit")


def delete_exact_ref(repository, ref_name, expected_sha, expected_repository_id):
    expected_sha = valid_sha(expected_sha, "invalid rollback commit SHA")
    actual = live_ref_sha(repository, ref_name, expected_repository_id)
    if actual is None:
        return False
    if actual != expected_sha:
        raise Denied("carrier ref moved; refusing rollback")
    result = _gh_ref_request(repository, ref_name, "DELETE")
    if result.returncode != 0 and not _is_http_status(result.stderr, 404):
        raise Denied("carrier ref rollback failed")
    if live_ref_sha(repository, ref_name, expected_repository_id) is not None:
        raise Denied("carrier ref still exists after rollback")
    return True


def publish(repository, source_pr, source_commit, test_plan, now=None):
    if not NAME.fullmatch(repository):
        raise Denied("invalid destination repository")
    if not isinstance(source_pr, int) or isinstance(source_pr, bool) or source_pr <= 0:
        raise Denied("invalid source PR number")
    source_commit = valid_sha(source_commit, "invalid source commit")

    protected_sha, contract = protected_authority(
        repository, source_pr, test_plan
    )
    base_tree, plan_bytes = checked_destination(repository, contract)
    plan_meta = validate_test_plan(plan_bytes, source_pr)
    verify_required_source_snapshot(plan_meta, source_commit)
    source_tree, files, rows, manifest_sha256 = exact_source_tree(
        source_pr, source_commit
    )
    verify_required_source_snapshot(plan_meta, source_commit, source_tree)
    verify_required_source_blobs(files, plan_meta["required_source_blobs"])
    branch = "ci/oreslang-" + source_tree
    plan_sha256 = plan_meta["sha256"]

    elements = []
    for path, mode, sha, data in files:
        recheck_destination_identity(repository, contract)
        result = gh_api(
            f"repos/{repository}/git/blobs",
            method="POST",
            payload={
                "content": base64.b64encode(data).decode("ascii"),
                "encoding": "base64",
            },
        )
        uploaded = valid_sha(result.get("sha"), "uploaded blob SHA")
        if uploaded != sha:
            raise Denied("uploaded blob differs from exact source blob")
        elements.append({
            "path": path, "mode": mode, "type": "blob", "sha": uploaded
        })

    recheck_destination_identity(repository, contract)
    isolated = gh_api(
        f"repos/{repository}/git/trees",
        method="POST",
        payload={"tree": elements},
    )
    isolated_sha = valid_sha(isolated.get("sha"), "uploaded source tree SHA")
    if isolated_sha != source_tree:
        raise Denied("uploaded source tree differs from source PR root tree")

    now = now or dt.datetime.now(dt.timezone.utc)
    if now.tzinfo is None or now.utcoffset() is None:
        raise Denied("publisher clock must be timezone-aware")
    expires = (now.astimezone(dt.timezone.utc) + TTL).replace(microsecond=0)
    receipt = {
        "schema": "ores-private-ci-receipt-v3",
        "expires_at": expires.isoformat().replace("+00:00", "Z"),
        "carrier": {"workflow_blob_sha": contract["workflow_blob_sha"]},
        "destination": {
            "repo": repository,
            "repo_id": contract["repository_id"],
            "base_sha": contract["base_sha"],
        },
        "mirror": {"root_tree_sha": source_tree},
        "source": {
            "repo": SOURCE_REPO,
            "repo_id": SOURCE_REPO_ID,
            "pr": source_pr,
            "head_sha": source_commit,
            "root_tree_sha": source_tree,
            "manifest_sha256": manifest_sha256,
        },
        "test_plan": {
            "path": contract["test_plan_path"],
            "sha256": plan_sha256,
        },
    }
    receipt_bytes = canonical_bytes(receipt) + b"\n"
    receipt_digest = canonical_digest(receipt)

    recheck_destination_identity(repository, contract)
    rb = gh_api(
        f"repos/{repository}/git/blobs",
        method="POST",
        payload={
            "content": base64.b64encode(receipt_bytes).decode("ascii"),
            "encoding": "base64",
        },
    )
    receipt_blob = valid_sha(rb.get("sha"), "receipt blob SHA")
    if receipt_blob != git_blob_sha(receipt_bytes):
        raise Denied("receipt blob digest mismatch")

    recheck_destination_identity(repository, contract)
    root = gh_api(
        f"repos/{repository}/git/trees",
        method="POST",
        payload={
            "base_tree": base_tree,
            "tree": [
                {"path": PREFIX, "mode": "040000", "type": "tree", "sha": source_tree},
                {"path": RECEIPT_PATH, "mode": "100644", "type": "blob", "sha": receipt_blob},
            ],
        },
    )
    root_sha = valid_sha(root.get("sha"), "carrier root tree SHA")

    recheck_destination_identity(repository, contract)
    commit = gh_api(
        f"repos/{repository}/git/commits",
        method="POST",
        payload={
            "message": (
                "ci: exact private LLVM PR tree\n\n"
                "Oreslang-CI-Receipt-SHA256: " + receipt_digest
            ),
            "tree": root_sha,
            "parents": [contract["base_sha"]],
        },
    )
    carrier_commit = valid_sha(commit.get("sha"), "carrier commit SHA")
    verify_published_root_and_commit(
        repository,
        contract["base_sha"],
        source_tree,
        receipt_blob,
        root_sha,
        carrier_commit,
    )

    # Full protected-source + immutable-carrier recheck before executable refs.
    again_sha, again_contract = protected_authority(
        repository, source_pr, test_plan
    )
    if again_sha != protected_sha or again_contract != contract:
        raise Denied("protected source authority changed during transfer")
    checked_destination(repository, contract)
    verify_source_pr(source_pr, source_commit)

    # Create the inert source-bearing ref first. The carrier workflow refuses
    # to execute without the exact authorization ref. Treat every POST as
    # potentially successful before it returns so transport ambiguity cannot
    # strand private source indefinitely.
    authorization = "ci/authorized-" + carrier_commit
    require_handoff_refs_absent(
        repository, branch, authorization, contract["repository_id"]
    )
    payload_attempted = False
    authorization_attempted = False
    try:
        payload_attempted = True
        branch_ref = gh_api(
            f"repos/{repository}/git/refs",
            method="POST",
            payload={
                "ref": "refs/heads/" + branch,
                "sha": carrier_commit,
            },
        )
        if (branch_ref.get("ref") != "refs/heads/" + branch
                or branch_ref.get("object", {}).get("sha")
                   not in (None, carrier_commit)):
            raise Denied("carrier did not confirm exact-tree branch")
        require_exact_ref(
            repository, branch, carrier_commit, contract["repository_id"]
        )

        # Re-run mutable governance checks while the payload is still inert.
        again_sha, again_contract = protected_authority(
            repository, source_pr, test_plan
        )
        if again_sha != protected_sha or again_contract != contract:
            raise Denied("protected source authority changed before authorization")
        checked_destination(repository, contract)

        # The exact open PR head is the last source-side fact checked before
        # the carrier becomes executable.
        verify_source_pr(source_pr, source_commit)

        authorization_attempted = True
        auth_ref = gh_api(
            f"repos/{repository}/git/refs",
            method="POST",
            payload={
                "ref": "refs/heads/" + authorization,
                "sha": carrier_commit,
            },
        )
        if (auth_ref.get("ref") != "refs/heads/" + authorization
                or auth_ref.get("object", {}).get("sha")
                   not in (None, carrier_commit)):
            raise Denied("carrier did not confirm dispatcher authorization ref")

        # Never trust create responses alone. Re-read both refs before success.
        require_exact_ref(
            repository, branch, carrier_commit, contract["repository_id"]
        )
        require_exact_ref(
            repository, authorization, carrier_commit, contract["repository_id"]
        )
    except BaseException:
        rollback_error = None
        if authorization_attempted:
            try:
                delete_exact_ref(
                    repository, authorization, carrier_commit,
                    contract["repository_id"],
                )
            except BaseException as rollback_exc:
                rollback_error = rollback_exc
        if payload_attempted:
            try:
                delete_exact_ref(
                    repository, branch, carrier_commit,
                    contract["repository_id"],
                )
            except BaseException as rollback_exc:
                rollback_error = rollback_error or rollback_exc
        if rollback_error is not None:
            raise Denied(
                "private CI handoff failed and carrier ref rollback was incomplete"
            ) from rollback_error
        raise

    return {
        "commit": carrier_commit,
        "branch": branch,
        "authorization_ref": authorization,
        "source_tree": source_tree,
        "manifest_sha256": manifest_sha256,
        "receipt_sha256": receipt_digest,
        "files": len(files),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository")
    parser.add_argument("--source-pr", required=True, type=int)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--test-plan", required=True)
    args = parser.parse_args(argv)
    try:
        result = publish(
            args.repository,
            args.source_pr,
            args.source_commit,
            args.test_plan,
        )
    except (Denied, OSError, ValueError) as exc:
        print("PRIVATE_CI_DESTINATION_REJECTED: " + str(exc), file=sys.stderr)
        return 1
    print(
        "PRIVATE_CI_V3_CREATED: "
        + " ".join(f"{key}={value}" for key, value in result.items())
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
