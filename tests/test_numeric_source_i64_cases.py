"""Independent arithmetic reference for the common source i64 corpus.

A pass checks the vectors, never the Oreslang parser, IR or guest.
"""
import ast
import hashlib
import json
from pathlib import Path
import unittest

FILE = Path(__file__).resolve().parents[1] / "contracts/v1/numeric-parity/source-i64-cases.json"
BLOB = "bbc319c19ecd007109d33592e210091eb267e5a2"
OVERFLOW_FILE = FILE.with_name("source-i64-overflow-cases.json")
OVERFLOW_BLOB = "2ce0b0ff5c52e54a788280fd64d67fa8dc32614a"
LO = -(1 << 63)
HI = (1 << 63) - 1


def interpret(node):
    if isinstance(node, ast.Constant) and type(node.value) is int:
        # +2^63 is NOT an i64 expression result or valid intermediate.
        # Its sole permitted occurrence is the magnitude of unary -.
        if not 0 <= node.value <= HI:
            raise ValueError("out of literal bounds")
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        operand = node.operand
        if (isinstance(operand, ast.Constant) and type(operand.value) is int
                and operand.value == (1 << 63)):
            return LO
        result = -interpret(operand)
    elif isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult)):
        a, b = interpret(node.left), interpret(node.right)
        result = a + b if isinstance(node.op, ast.Add) else (
            a - b if isinstance(node.op, ast.Sub) else a * b)
    else:
        raise ValueError("unsupported source numeric expression")
    if not LO <= result <= HI:
        raise ValueError("i64 intermediate overflow")
    return result


class PortableI64ReferenceTest(unittest.TestCase):
    def test_exact_source_corpus_and_integer_oracle(self):
        raw = FILE.read_bytes()
        digest = hashlib.sha1(b"blob " + str(len(raw)).encode() + bytes((0,)) + raw).hexdigest()
        self.assertEqual(digest, BLOB)
        data = json.loads(raw)
        self.assertEqual(data["schema_version"], "1.0.0")
        self.assertEqual(data["status"], "reference-only-not-compiled-execution")
        self.assertEqual(len(data["cases"]), 7)
        ids = [case["id"] for case in data["cases"]]
        self.assertEqual(len(ids), len(set(ids)))
        for case in data["cases"]:
            with self.subTest(case=case["id"]):
                expression = case["expression"]
                self.assertEqual(interpret(ast.parse(expression, mode="eval").body),
                                 int(case["expected"]))
                self.assertTrue(LO <= int(case["expected"]) <= HI)



    def test_pinned_shared_overflow_corpus_rejects_all_four_cases(self):
        """A data-only oracle: failure at any i64 intermediate is mandatory.

        Never count this as native compilation or source-guest evidence.
        """
        raw = OVERFLOW_FILE.read_bytes()
        digest = hashlib.sha1(b"blob " + str(len(raw)).encode("ascii") +
                              bytes((0,)) + raw).hexdigest()
        self.assertEqual(digest, OVERFLOW_BLOB,
                         "shared overflow corpus drifted across backends")
        doc = json.loads(raw)
        self.assertEqual(doc["schema_version"], "1.0.0")
        self.assertEqual(doc["status"], "requires-executable-negative-tests")
        self.assertEqual(doc["policy"], "no-wrapping-i64")
        cases = doc["cases"]
        self.assertEqual(len(cases), 4)
        self.assertEqual([case["id"] for case in cases], [
            "positive-add-overflow", "negative-sub-overflow",
            "positive-multiply-overflow", "negative-unary-overflow"])
        for case in cases:
            with self.subTest(case=case["id"]):
                self.assertEqual(case["expected"], "reject-or-runtime-error")
                expression = case["source"]
                self.assertIsInstance(expression, str)
                self.assertLessEqual(len(expression), 128)
                with self.assertRaises(ValueError):
                    interpret(ast.parse(expression, mode="eval").body)

    def test_i64_minimum_has_no_positive_out_of_range_intermediate(self):
        for expression, expected in (
            ("-9223372036854775808", LO),
            ("-9223372036854775808+1", LO + 1),
            ("-9223372036854775807-1", LO),
        ):
            with self.subTest(expression=expression):
                self.assertEqual(interpret(ast.parse(expression, mode="eval").body),
                                 expected)

    def test_out_of_range_literals_and_intermediates_fail_closed(self):
        for expression in (
            "9223372036854775808",
            "9223372036854775808-1",
            "(9223372036854775808)-1",
            "0-9223372036854775808",
            "9223372036854775807+1",
            "-9223372036854775808-1",
            "-(-9223372036854775808)",
            "--9223372036854775808",
            "-9223372036854775808*-1",
            "3037000500*3037000500",
            "+1",  # portable source subset does not admit unary plus
            "1/2",
            "True",
            "1.0",
        ):
            with self.subTest(expression=expression):
                with self.assertRaises(ValueError):
                    interpret(ast.parse(expression, mode="eval").body)

if __name__ == "__main__":
    unittest.main()
