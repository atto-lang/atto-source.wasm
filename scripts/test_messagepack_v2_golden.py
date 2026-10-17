#!/usr/bin/env python3
"""Executable source-free negative tests for the shared strict wire oracle."""
import copy
import importlib.util
import json
import unittest
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "ores_wire_golden", ROOT / "scripts/check_messagepack_v2_golden.py")
wire = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wire)

class StrictGoldenOracleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original = (ROOT / "contracts/v1/messagepack_collection_vectors.json").read_text(
            encoding="utf-8")
        cls.vectors = wire.load_canonical_json(cls.original)

    def test_all_six_real_golden_vectors(self):
        self.assertTrue(wire.verify(copy.deepcopy(self.vectors)))

    def test_rejects_trailing_comma_shape(self):
        for shape in ("L[S,]", "A[I,]", "T[B,S,]", "FA[I,]", "FL[L[S],B,]"):
            with self.subTest(shape=shape), self.assertRaises(ValueError):
                wire.parse_shape(shape)

    def test_rejects_empty_variable_element_shape(self):
        for shape in ("A[]", "L[]", "A[S,I]", "L[S,B]"):
            with self.subTest(shape=shape), self.assertRaises(ValueError):
                wire.parse_shape(shape)

    def test_rejects_malformed_shape_bounds(self):
        for shape in ("Q", "L[", "T[B", "Sextra", "B,",
                      "L[" * 65 + "S" + "]" * 65):
            with self.subTest(shape=shape), self.assertRaises(ValueError):
                wire.parse_shape(shape)

    def test_rejects_duplicate_json_keys_at_every_level(self):
        payloads = (
            '{"schema":"x","schema":"y"}',
            '{"vectors":[{"schema_id":"a","schema_id":"b"}]}',
            '{"vectors":[{"meta":{"x":1,"x":2}}]}',
        )
        for payload in payloads:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                wire.load_canonical_json(payload)

    def test_rejects_nonfinite_json_tokens(self):
        for value in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                wire.load_canonical_json('{"input":' + value + '}')

    def test_rejects_noncanonical_hex_case_or_whitespace(self):
        for hex_str in ("AA", "aabb cc", "aabb\ncc", "aabb0", "0x80"):
            mutated = copy.deepcopy(self.vectors)
            mutated["vectors"][0]["hex"] = hex_str
            with self.subTest(hex=repr(hex_str)), self.assertRaises(ValueError):
                wire.verify(mutated)

    def test_declared_kind_and_shape_are_cryptographically_bound(self):
        for i in range(6):
            for field in ("kind", "shape"):
                tampered = copy.deepcopy(self.vectors)
                vec = tampered["vectors"][i]
                if field == "kind":
                    vec[field] = "List" if vec[field] != "List" else "Tuple"
                else:
                    vec[field] = "bool" if vec[field] != "bool" else "string"
                with self.subTest(vector=i, field=field), self.assertRaises(
                    (ValueError, TypeError, KeyError)
                ):
                    wire.verify(tampered)

    def test_rejects_mutated_fixtures(self):
        for i in range(6):
            for field in ("kind", "shape", "schema_id", "shape_descriptor", "input", "hex"):
                mutated = copy.deepcopy(self.vectors)
                vec = mutated["vectors"][i]
                if field == "kind":
                    vec[field] = "List" if vec[field] != "List" else "Tuple"
                elif field == "shape":
                    vec[field] = "bool" if vec[field] != "bool" else "string"
                elif field == "schema_id":
                    vec[field] += ".forged"
                elif field == "shape_descriptor":
                    vec[field] = "I" if vec[field] == "S" else "S"
                elif field == "input":
                    vec[field] = None
                else:
                    vec[field] = "00" + vec[field][2:]
                with self.subTest(vector=i, field=field), self.assertRaises(
                    (ValueError, TypeError, KeyError, UnicodeError)
                ):
                    wire.verify(mutated)

    def test_integer_boundaries(self):
        for n in (-(1 << 63), -32769, -129, -33, -32, -1, 0,
                  127, 128, 255, 256, (1 << 63) - 1):
            self.assertTrue(wire.pack_integer(n))
        for invalid in (True, False, 1.0, -(1 << 63) - 1, (1 << 63)):
            with self.assertRaises(ValueError):
                wire.pack_integer(invalid)

    def test_array_bounds(self):
        for n in (-1, 100001):
            with self.assertRaises(ValueError):
                wire.pack_array(n)
        self.assertTrue(wire.pack_array(100000))

    def test_pinned_exact_bytes_are_accepted(self):
        self.assertTrue(wire.verify(wire.load_pinned_fixture(
            ROOT / "contracts/v1/messagepack_collection_vectors.json")))

    def test_rejects_reformatted_or_changed_golden_file(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "golden.json"
            # Still valid JSON but not the independently reviewed byte pin.
            path.write_bytes(self.original.encode("utf-8") + b"\n")
            with self.assertRaisesRegex(ValueError, "fixture bytes changed"):
                wire.load_pinned_fixture(path)

    def test_rejects_oversized_fixture_read(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "giant.json"
            with path.open("wb") as stream:
                stream.truncate(wire.MAX_FIXTURE_BYTES + 1)
            with self.assertRaisesRegex(ValueError, "oversized"):
                wire.load_pinned_fixture(path)

    def test_rejects_symlinked_golden_file(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "actual.json"
            target.write_text(self.original, encoding="utf-8")
            link = Path(root) / "alias.json"
            link.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "regular file"):
                wire.load_pinned_fixture(link)

    def test_rejects_utf8_overflow_before_encoding(self):
        for invalid in ("x" * 1_048_577, "é" * 524_289,
                        "🌍" * 262_145, "\ud800", "\udc00"):
            with self.subTest(length=len(invalid)), self.assertRaises(ValueError):
                wire.pack_string(invalid)


if __name__ == "__main__":
    expected = 16
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(StrictGoldenOracleTest)
    if suite.countTestCases() != expected:
        raise SystemExit(f"FAIL golden oracle suite: expected {expected} tests, "
                         f"found {suite.countTestCases()}")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if (result.testsRun != expected or not result.wasSuccessful() or
            result.skipped or result.expectedFailures or result.unexpectedSuccesses):
        raise SystemExit("FAIL golden oracle suite incomplete or skipped")
