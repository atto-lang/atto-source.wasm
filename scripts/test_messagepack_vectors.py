#!/usr/bin/env python3
"""Mutation regression tests for the stdlib-only wire-v2 reference manifest."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
import verify_messagepack_vectors as wire

class ReferenceVectorSecurity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = json.loads(wire.VECTORS.read_text(encoding="utf-8"))

    def reject(self, change):
        document = copy.deepcopy(self.original)
        change(document)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "vectors.json"
            path.write_text(json.dumps(document, ensure_ascii=True), encoding="utf-8")
            with self.assertRaises((ValueError, UnicodeError)):
                wire.validate(path)

    def test_valid_corpus(self):
        self.assertEqual(wire.validate(), 10)

    def test_corrupted_payload_bytes(self):
        self.reject(lambda d: d["vectors"][0].update(hex="00"))

    def test_duplicate_schema_id(self):
        self.reject(lambda d: d["vectors"][4].update(schema_id=d["vectors"][0]["schema_id"]))

    def test_extra_vector(self):
        self.reject(lambda d: d["vectors"].append(copy.deepcopy(d["vectors"][0])))

    def test_extra_vector_field(self):
        self.reject(lambda d: d["vectors"][0].update(permit_supervisor_control=True))

    def test_false_runtime_support_claim(self):
        self.reject(lambda d: d.update(status="Fully implemented on all backends"))

    def test_i64_alias(self):
        self.reject(lambda d: d["vectors"][6]["input"].__setitem__(0, "-00"))

    def test_i64_overflow(self):
        self.reject(lambda d: d["vectors"][6]["input"].__setitem__(0, "-9223372036854775809"))

    def test_signed_zero_changed(self):
        self.reject(lambda d: d["vectors"][8].update(input="0.0"))

    def test_non_scalar_unicode(self):
        self.reject(lambda d: d["vectors"][7].update(input=chr(0xd800)))

    def test_unknown_encoding(self):
        self.reject(lambda d: d["vectors"][1].update(input_encoding="unverified_double"))

    def test_downgrade(self):
        self.reject(lambda d: d["vectors"][3].update(hex="9401" + d["vectors"][3]["hex"][4:]))

    def test_wrong_kind(self):
        self.reject(lambda d: d["vectors"][3].update(kind="List"))

    def test_wrong_descriptor(self):
        self.reject(lambda d: d["vectors"][1].update(shape_descriptor="T[I,I,I]"))

    def test_wrong_member(self):
        self.reject(lambda d: d["vectors"][2]["shape"].__setitem__(1, "string"))

if __name__ == "__main__":
    expected = 15
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ReferenceVectorSecurity)
    if suite.countTestCases() != expected:
        raise SystemExit("FAIL expected exactly 15 reference-vector security tests")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.testsRun != expected or not result.wasSuccessful() or result.skipped:
        raise SystemExit("FAIL reference-vector regression suite incomplete")
