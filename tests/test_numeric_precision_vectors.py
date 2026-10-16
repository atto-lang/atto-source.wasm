"""Independent reference checks for numeric-precision golden vectors.

This validates the *reference data*, not Oreslang guest execution. Java/LLVM
runners must later feed the same cases into compiled Oreslang and compare outputs.
"""
import json
import math
import struct
import unittest
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

CASES = Path(__file__).resolve().parents[1] / "contracts/v1/numeric-precision/cases.json"


def numeric_operand(descriptor):
    if descriptor["kind"] == "int64":
        number = int(descriptor["decimal"])
        if not -(1 << 63) <= number < (1 << 63):
            raise ValueError("int64 out of range")
        return Fraction(number)
    if descriptor["kind"] == "bits":
        raw = bytes.fromhex(descriptor["hex"])
        if len(raw) != 8:
            raise ValueError("binary64 bits must be 8 bytes")
        return struct.unpack(">d", raw)[0]
    raise ValueError("unknown numeric operand kind")


def numeric_compare(left, right):
    if any(isinstance(x, float) and math.isnan(x) for x in (left, right)):
        return {"eq": False, "lt": False, "le": False, "gt": False, "ge": False}
    # Before comparison, convert finite binary64 values to exact fractions,
    # rather than accidentally converting a large int64 to a rounded float.
    def exact(x):
        return Fraction.from_float(x) if isinstance(x, float) and math.isfinite(x) else x

    a, b = exact(left), exact(right)
    return {"eq": a == b, "lt": a < b, "le": a <= b, "gt": a > b, "ge": a >= b}


def matrix_shape(rows, explicit=None):
    m = len(rows)
    n = len(rows[0]) if m else (explicit[1] if explicit is not None else 0)
    if any(len(row) != n for row in rows):
        raise ValueError("ragged matrix")
    if explicit is not None and [m, n] != explicit:
        raise ValueError("declared shape differs from data")
    return m, n


def exact_matrix_product(case):
    left, right = case["lhs"], case["rhs"]
    m, k = matrix_shape(left, case.get("lhs_shape"))
    n_rows, n = matrix_shape(right, case.get("rhs_shape"))
    if k != n_rows:
        raise ValueError("shape_mismatch")
    product = [
        [
            sum((Fraction(Decimal(left[i][p])) * Fraction(Decimal(right[p][j]))
                 for p in range(k)), Fraction(0))
            for j in range(n)
        ]
        for i in range(m)
    ]
    return product, [m, n]


class NumericalReferenceVectorsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract = json.loads(CASES.read_text(encoding="utf-8"))
        assert cls.contract["schema_version"] == "1.0.0"
        assert cls.contract["status"] == "reference-only-not-guest-execution"

    def test_binary64_ordering(self):
        for case in self.contract["binary64_comparisons"]:
            with self.subTest(case=case["id"]):
                actual = numeric_compare(numeric_operand(case["lhs"]), numeric_operand(case["rhs"]))
                expected = {key: case[key] for key in ("eq", "lt", "le", "gt", "ge")}
                self.assertEqual(expected, actual)

    def test_exact_decimal_matrices(self):
        for case in self.contract["decimal_matrices"]:
            with self.subTest(case=case["id"]):
                if case.get("error") == "shape_mismatch":
                    with self.assertRaisesRegex(ValueError, "shape_mismatch"):
                        exact_matrix_product(case)
                    continue
                actual, shape = exact_matrix_product(case)
                exp_shape = list(matrix_shape(case["expected"], case.get("expected_shape")))
                self.assertEqual(shape, exp_shape)
                self.assertEqual(actual, [
                    [Fraction(Decimal(value)) for value in row]
                    for row in case["expected"]
                ])


if __name__ == "__main__":
    unittest.main()
