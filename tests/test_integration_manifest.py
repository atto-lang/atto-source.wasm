"""Adversarial tests for the cross-backend declaration-only manifest gate."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

MODULE_FILE = Path(__file__).resolve().parent.parent / 'scripts' / 'verify_integration_manifest.py'
spec = importlib.util.spec_from_file_location('manifest_gate', MODULE_FILE)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

REPO_NAME = 'oreslang-source.java'


def valid_manifest(repo=REPO_NAME):
    return {
        'schemaVersion': 1,
        'protocol': module.PROTOCOL,
        'repository': 'ores-truffle-oreslang/' + repo,
        'role': 'compiler',
        'upstreams': list(module.UPSTREAMS[repo]),
        'evidence': 'not-attested',
        'note': module.NOTE,
    }


def encode(payload):
    return json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


class IntegrationManifestGateTests(unittest.TestCase):
    def test_all_seven_source_backends(self):
        self.assertEqual(len(module.UPSTREAMS), 7)
        for repo in module.UPSTREAMS:
            with self.subTest(repo=repo):
                self.assertEqual(module.verify_bytes(encode(valid_manifest(repo)), repo)['evidence'], 'not-attested')

    def test_real_local_manifest(self):
        root = Path(__file__).resolve().parent.parent
        self.assertEqual(module.verify_bytes((root / '.oreslang/integration.json').read_bytes(), root.name)['role'], 'compiler')

    def assert_reject(self, raw, repo=REPO_NAME):
        with self.assertRaises(module.InvalidManifest):
            module.verify_bytes(raw, repo)

    def test_duplicate_key(self):
        self.assert_reject(encode(valid_manifest())[:-1] + b',"evidence":"not-attested"}')

    def test_unsupported_repo(self):
        self.assert_reject(encode(valid_manifest()), 'oreslang-source.invented')

    def test_repository_mismatch(self):
        self.assert_reject(encode(valid_manifest('oreslang-source.llvm')))

    def test_evidence_claim_rejected(self):
        value = valid_manifest()
        for claim in ['passed', 'attested', 'verified', None, 1]:
            with self.subTest(claim=claim):
                value['evidence'] = claim
                self.assert_reject(encode(value))

    def test_upstream_injection_and_reordering(self):
        value = valid_manifest()
        for dependencies in [[], ['oreslang-target-profiles', 'oreslang-common-source'],
                             ['oreslang-common-source', 'oreslang-common-source'],
                             ['../oreslang-target-profiles'], ['oreslang-common-source', 'oreslang-target-profiles', 'other']]:
            with self.subTest(dependencies=dependencies):
                value['upstreams'] = dependencies
                self.assert_reject(encode(value))

    def test_unknown_field(self):
        value = valid_manifest()
        value['runtimeParity'] = True
        self.assert_reject(encode(value))

    def test_missing_field(self):
        value = valid_manifest()
        value.pop('note')
        self.assert_reject(encode(value))

    def test_schema_bool_is_not_int(self):
        value = valid_manifest()
        value['schemaVersion'] = True
        self.assert_reject(encode(value))

    def test_invalid_json_constants(self):
        self.assert_reject(encode(valid_manifest()).replace(b'"schemaVersion":1', b'"schemaVersion":NaN'))

    def test_oversize(self):
        self.assert_reject(b' ' * (module.MAX_BYTES + 1))

    def test_invalid_utf8(self):
        self.assert_reject(b'\xff' + encode(valid_manifest()))

    def test_utf8_bom(self):
        self.assert_reject(b'\xef\xbb\xbf' + encode(valid_manifest()))

    def test_noncanonical_note(self):
        value = valid_manifest()
        value['note'] = 'CI parity is asserted.'
        self.assert_reject(encode(value))

    def test_cli_rejects_symlinked_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / REPO_NAME
            (root / '.oreslang').mkdir(parents=True)
            external = Path(temp) / 'external.json'
            external.write_bytes(encode(valid_manifest()))
            (root / '.oreslang/integration.json').symlink_to(external)
            self.assertEqual(module.main(['--repository-root', str(root)]), 1)


if __name__ == '__main__':
    unittest.main()
