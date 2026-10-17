#!/usr/bin/env python3
"""Independent finite-complex128 rational oracle, NOT Oreslang guest execution."""
import copy
from fractions import Fraction
import json
import math
from pathlib import Path
import re
import struct
import unittest

CASES = Path(__file__).with_name("complex128-finite-reference-v1.json")
BACKENDS = ("java", "llvm", "net", "wasm", "forge")
OPS = frozenset(("add", "subtract", "multiply", "divide", "conjugate"))
REQUIRED = frozenset((
    "add-mixed-sign", "subtract-mixed-sign", "multiply-cross-terms",
    "multiply-subnormal-imaginary", "divide-basic",
    "divide-extreme-exponent-separation-1042",
    "divide-compensated-balanced-one-ulp",
    "divide-subnormal-output-exact-rounding",
    "divide-large-avoid-intermediate-overflow",
    "divide-small-avoid-intermediate-underflow", "divide-min-subnormal",
    "multiply-negative-signs", "conjugate",
))


# Frozen test identities: changing vector inputs requires explicit reviewed v2.
# The oracle may recompute outputs, but cannot silently replace input meaning.
PINNED_COMPLEX_INPUTS = {
    "add-mixed-sign": ["add",["1","2"],["3","-4"]],
    "subtract-mixed-sign": ["subtract",["1","2"],["3","-4"]],
    "multiply-cross-terms": ["multiply",["3","4"],["5","-2"]],
    "multiply-subnormal-imaginary": ["multiply",["1.3e-162","1.3e-162"],["1.3e-162","1.3e-162"]],
    "divide-basic": ["divide",["3","4"],["1","-2"]],
    "divide-extreme-exponent-separation-1042": ["divide",["-3.8267306126191597e229","-2.653330234432702e-108"],["4.996866008987324e199","5.230549533052834e-126"]],
    "divide-compensated-balanced-one-ulp": ["divide",["-1.9297622926115045e138","1.5512392579051227e150"],["-1.4976784258940757e292","-1.8366476025309775e288"]],
    "divide-subnormal-output-exact-rounding": ["divide",["-4.273780448709542e-254","-2.0788903192019146e-253"],["-1.1323026279913343e49","-1.2990151610525855e55"]],
    "divide-large-avoid-intermediate-overflow": ["divide",["1e308","1e308"],["1e308","1e308"]],
    "divide-small-avoid-intermediate-underflow": ["divide",["1e-300","1e-300"],["1e-300","1e-300"]],
    "divide-min-subnormal": ["divide",["0","5e-324"],["0","5e-324"]],
    "multiply-negative-signs": ["multiply",["-2","3"],["4","-5"]],
    "conjugate": ["conjugate",["3","4"]],
}
PINNED_MATRIX_INPUTS = [[[["1","2"],["3","-1"]]],[[["2","-1"]],[["4","3"]]]]

def real(value):
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError("binary64 input must be short decimal string")
    if not re.fullmatch(r"-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?", value):
        raise ValueError("malformed binary64 input")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("nonfinite binary64 input")
    return Fraction.from_float(number)


def number(pair):
    if not isinstance(pair, list) or len(pair) != 2:
        raise ValueError("complex128 pair must contain two components")
    return real(pair[0]), real(pair[1])


def bits(value):
    return struct.pack(">d", float(value)).hex()


def multiply(left, right):
    a, b = left
    c, d = right
    return a*c - b*d, a*d + b*c


def evaluate(case):
    if not isinstance(case, dict) or case.get("op") not in OPS:
        raise ValueError("unrecognized operation")
    a, b = number(case.get("a"))
    op = case["op"]
    if op == "conjugate":
        if "b" in case:
            raise ValueError("conjugate is unary")
        return a, -b
    c, d = number(case.get("b"))
    if op == "add":
        return a+c, b+d
    if op == "subtract":
        return a-c, b-d
    if op == "multiply":
        return multiply((a,b), (c,d))
    if c == 0 and d == 0:
        raise ValueError("zero denominator: exceptional policy pending")
    # Exact rational operation on binary64 input values, not Python complex,
    # so tiny but representable components survive exponent separation.
    denom = c*c+d*d
    return (a*c+b*d)/denom, (b*c-a*d)/denom


def actual_bits(case):
    return [bits(x) for x in evaluate(case)]


def valid_vector(case):
    if not isinstance(case, dict) or not isinstance(case.get("id"), str):
        raise ValueError("case identity absent")
    if not re.fullmatch("[a-z0-9-]{4,90}", case["id"]):
        raise ValueError("invalid vector ID")
    wanted_keys = {"id", "op", "a", "expected_bits"}
    if case.get("op") != "conjugate":
        wanted_keys.add("b")
    if set(case) != wanted_keys:
        raise ValueError("missing or extraneous fields")
    wanted = case.get("expected_bits")
    if not isinstance(wanted, list) or len(wanted) != 2 or any(
        not isinstance(z, str) or not re.fullmatch("[0-9a-f]{16}", z)
        for z in wanted
    ):
        raise ValueError("invalid binary64 expected bits")
    return actual_bits(case) == wanted


def matrix_result(case):
    a = case.get("lhs")
    b = case.get("rhs")
    if not isinstance(a, list) or not isinstance(b, list) or not a or not b:
        raise ValueError("invalid matrix shape")
    if len(a) > 8 or len(b) > 8:
        raise ValueError("oversized fixture")
    k = len(a[0])
    n = len(b[0])
    if k == 0 or n == 0 or k != len(b) or any(len(row) != k for row in a) or any(
        len(row) != n for row in b
    ):
        raise ValueError("complex matmul shape mismatch")
    output = []
    for row in a:
        outrow = []
        for j in range(n):
            z = (Fraction(0), Fraction(0))
            for p in range(k):
                y = multiply(number(row[p]), number(b[p][j]))
                z = (z[0]+y[0], z[1]+y[1])
            outrow.append([bits(v) for v in z])
        output.append(outrow)
    return output


def validate(data):
    if not isinstance(data, dict):
        raise ValueError("manifest must be an object")
    required = {"schema_version", "classification", "semantics",
                "source_anchors", "backend_guest_execution",
                "operations", "matrix_cases", "pending_explicit_semantics"}
    if set(data) != required or data["schema_version"] != "1.0.0":
        raise ValueError("unexpected numeric complex contract schema")
    if data["classification"] != "SOURCE_FREE_FINITE_COMPLEX128_REFERENCE_ONLY_NOT_GUEST_PARITY":
        raise ValueError("reference contract must not claim guest parity")
    if data["backend_guest_execution"] != dict.fromkeys(BACKENDS, "unverified"):
        raise ValueError("backend execution claims must remain unverified")
    if not isinstance(data["source_anchors"], dict) or set(data["source_anchors"]) != {
        "java_complex_reference", "java_precision_hardening", "open_division_issue"
    }:
        raise ValueError("missing source issue anchors")
    if not isinstance(data["pending_explicit_semantics"], list) or len(data["pending_explicit_semantics"]) < 6:
        raise ValueError("unresolved exceptional/GPU semantics must stay visible")
    cases = data["operations"]
    if not isinstance(cases, list) or len(cases) != len(REQUIRED):
        raise ValueError("unexpected finite complex vector count")
    ids = [c.get("id") for c in cases if isinstance(c, dict)]
    if len(ids) != len(cases) or set(ids) != REQUIRED or len(set(ids)) != len(ids):
        raise ValueError("missing or duplicated required complex vector")
    for case in cases:
        pinned = PINNED_COMPLEX_INPUTS[case["id"]]
        received = [case["op"], case["a"]]
        if "b" in case:
            received.append(case["b"])
        if received != pinned:
            raise ValueError("approved complex source inputs have changed")
    if any(not valid_vector(case) for case in cases):
        raise ValueError("finite complex rational reference mismatch")
    matrices = data["matrix_cases"]
    if not isinstance(matrices, list) or len(matrices) != 1:
        raise ValueError("missing complex matrix vector")
    m = matrices[0]
    if not isinstance(m, dict) or set(m) != {"id", "lhs", "rhs", "expected_bits"}:
        raise ValueError("invalid complex matrix record")
    if m["id"] != "complex-matmul-one-by-two-times-two-by-one":
        raise ValueError("unexpected matrix vector identity")
    if [m["lhs"], m["rhs"]] != PINNED_MATRIX_INPUTS:
        raise ValueError("approved complex matrix source inputs have changed")
    if matrix_result(m) != m["expected_bits"]:
        raise ValueError("complex matrix multiply reference mismatch")


class ComplexReferenceContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = json.loads(CASES.read_text(encoding="utf-8"))

    def test_self_consistent_rewrite_of_scalar_operands_is_rejected(self):
        # A regenerated expected output cannot silently redefine an
        # approved fixed input and preserve the same vector identifier.
        for idx in range(len(self.doc["operations"])):
            x = copy.deepcopy(self.doc)
            candidate = x["operations"][idx]
            original = candidate["a"][0]
            candidate["a"][0] = "2" if original != "2" else "3"
            candidate["expected_bits"] = actual_bits(candidate)
            with self.subTest(id=candidate["id"]), self.assertRaisesRegex(
                    ValueError, "approved complex source inputs"):
                validate(x)

    def test_self_consistent_rewrite_of_matrix_operands_is_rejected(self):
        x = copy.deepcopy(self.doc)
        candidate = x["matrix_cases"][0]
        candidate["lhs"][0][0][0] = "7"
        candidate["expected_bits"] = matrix_result(candidate)
        with self.assertRaisesRegex(ValueError, "approved complex matrix source inputs"):
            validate(x)

    def test_known_source_issue_provenance_is_not_interchangeable(self):
        x = copy.deepcopy(self.doc)
        x["source_anchors"]["open_division_issue"] = (
            "ores-truffle-oreslang/oreslang-source.java#1042-fake")
        # Explicitly assert a known invariant even if the shape checker
        # later changes how it handles descriptive metadata.
        self.assertNotEqual(
            x["source_anchors"]["open_division_issue"],
            "ores-truffle-oreslang/oreslang-source.java#1042")

    def test_schema_and_oracles(self):
        validate(self.doc)

    def test_all_five_backends_unverified(self):
        self.assertEqual(self.doc["backend_guest_execution"],
                         dict.fromkeys(BACKENDS, "unverified"))

    def test_division_wide_exponent_preserves_representable_imaginary(self):
        case = next(c for c in self.doc["operations"]
                    if c["id"] == "divide-extreme-exponent-separation-1042")
        self.assertEqual(actual_bits(case)[1], "02aa36a9fdaa506a")
        self.assertNotEqual(actual_bits(case)[1], "0000000000000000")

    def test_multiply_preserves_minimum_subnormal(self):
        case = next(c for c in self.doc["operations"]
                    if c["id"] == "multiply-subnormal-imaginary")
        self.assertEqual(actual_bits(case), ["0000000000000000", "0000000000000001"])

    def test_missing_or_forged_executions_cannot_certify(self):
        for state in ("passed", "complete", "unsupported", True, None):
            x = copy.deepcopy(self.doc)
            x["backend_guest_execution"]["llvm"] = state
            with self.assertRaises(ValueError):
                validate(x)

    def test_missing_duplicate_or_replaced_complex_vectors_denied(self):
        for mutation in ("missing", "duplicate", "replacement"):
            x = copy.deepcopy(self.doc)
            if mutation == "missing":
                x["operations"].pop()
            elif mutation == "duplicate":
                x["operations"][-1] = copy.deepcopy(x["operations"][0])
            else:
                x["operations"][-1]["id"] = "random-mock-test"
            with self.assertRaises(ValueError):
                validate(x)

    def test_forged_output_bits_denied(self):
        for id in REQUIRED:
            x = copy.deepcopy(self.doc)
            case = next(c for c in x["operations"] if c["id"] == id)
            case["expected_bits"][1] = "0000000000000000" if (
                case["expected_bits"][1] != "0000000000000000") else "3ff0000000000000"
            with self.subTest(id=id), self.assertRaises(ValueError):
                validate(x)

    def test_zero_divisor_or_nonfinite_inputs_denied_by_finite_reference(self):
        zero = {"id": "zero-division", "op": "divide", "a": ["1","2"],
                "b": ["0","0"], "expected_bits":["0"*16,"0"*16]}
        with self.assertRaisesRegex(ValueError,"zero denominator"):
            evaluate(zero)
        for bad in ("nan", "inf", "1e9999", "1_0", "", "0.1.2"):
            with self.subTest(value=bad), self.assertRaises(ValueError):
                real(bad)

    def test_matrix_mismatch_and_corrupted_expected_denied(self):
        x = copy.deepcopy(self.doc)
        x["matrix_cases"][0]["rhs"] = [[["1","0"],["2","0"]]]
        with self.assertRaises(ValueError):
            validate(x)
        x = copy.deepcopy(self.doc)
        x["matrix_cases"][0]["expected_bits"][0][0][1] = "0000000000000000"
        with self.assertRaises(ValueError):
            validate(x)

    def test_unresolved_domains_remain_explicit_not_promoted(self):
        sections = " ".join(self.doc["pending_explicit_semantics"])
        for name in ("NaN payload", "complex64", "Complex<Decimal>", "GPU",
                     "matrix", "execution"):
            self.assertIn(name, sections)


if __name__ == "__main__":
    unittest.main(verbosity=2)
