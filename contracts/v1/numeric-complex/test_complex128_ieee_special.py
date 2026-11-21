#!/usr/bin/env python3
"""Source-free complex128 IEEE-special oracle. Never certifies a backend."""
import copy
from fractions import Fraction
import json
import math
from pathlib import Path
import re
import struct
import unittest

CASES = Path(__file__).with_name("complex128-ieee-special-v1.json")
BACKENDS = ("java", "llvm", "net", "wasm", "forge")
REQUIRED = frozenset((
    "div-finite-pos-inf-real", "div-finite-neg-inf-real",
    "div-finite-pos-inf-imag", "div-real-by-zero", "div-imag-by-zero",
    "mul-infinite-cross", "div-inf-by-inf", "div-zero-rotate-signed",
    "div-negzero-identity", "div-nan-subnormal",
    "mul-half-min-subnormal", "mul-one-half-min-subnormal",
    "div-min-normal-half", "mul-max-next1-overflow",
))
HEX64 = re.compile(r"[0-9a-f]{16}")

def from_bits(raw):
    if not isinstance(raw, str) or not HEX64.fullmatch(raw):
        raise ValueError("component must be 16 lowercase hex digits")
    return struct.unpack(">d", bytes.fromhex(raw))[0]

def raw_bits(value):
    return struct.pack(">d", value).hex()

def signbit(value):
    return int.from_bytes(struct.pack(">d", value), "big") >> 63

def signed_zero(negative):
    return -0.0 if negative else 0.0

def round_fraction(value, zero_hint):
    if value == 0:
        return signed_zero(signbit(zero_hint) != 0)
    try:
        return float(value)
    except OverflowError:
        return math.copysign(math.inf, 1.0 if value > 0 else -1.0)

def exact_finite_multiply(ar, ai, br, bi):
    a, b, c, d = map(Fraction.from_float, (ar, ai, br, bi))
    return (
        round_fraction(a*c - b*d, ar*br - ai*bi),
        round_fraction(a*d + b*c, ar*bi + ai*br),
    )

def exact_finite_divide(ar, ai, br, bi):
    a, b, c, d = map(Fraction.from_float, (ar, ai, br, bi))
    denominator = c*c + d*d
    if denominator == 0:
        raise ValueError("finite exact divide requires nonzero divisor")
    return (
        round_fraction((a*c + b*d) / denominator, ar*br + ai*bi),
        round_fraction((b*c - a*d) / denominator, ai*br - ar*bi),
    )

def ieee_divide(numerator, denominator):
    if math.isnan(numerator) or math.isnan(denominator):
        return math.nan
    if denominator == 0.0:
        if numerator == 0.0:
            return math.nan
        return -math.inf if signbit(numerator) ^ signbit(denominator) else math.inf
    if math.isinf(numerator) and math.isinf(denominator):
        return math.nan
    return numerator / denominator

def scalb(value, exponent):
    try:
        return math.ldexp(value, exponent)
    except OverflowError:
        return math.copysign(math.inf, value)

def java_exponent(value):
    raw = int.from_bytes(struct.pack(">d", abs(value)), "big")
    exponent = (raw >> 52) & 0x7ff
    if exponent == 0:
        return -1023
    if exponent == 0x7ff:
        return 1024
    return exponent - 1023

def exceptional_multiply(ar, ai, br, bi):
    ac, bd, ad, bc = ar*br, ai*bi, ar*bi, ai*br
    real, imag = ac - bd, ad + bc
    if not (math.isnan(real) and math.isnan(imag)):
        return real, imag
    recalculate = False
    if math.isinf(ar) or math.isinf(ai):
        ar = math.copysign(1.0 if math.isinf(ar) else 0.0, ar)
        ai = math.copysign(1.0 if math.isinf(ai) else 0.0, ai)
        if math.isnan(br): br = math.copysign(0.0, br)
        if math.isnan(bi): bi = math.copysign(0.0, bi)
        recalculate = True
    if math.isinf(br) or math.isinf(bi):
        br = math.copysign(1.0 if math.isinf(br) else 0.0, br)
        bi = math.copysign(1.0 if math.isinf(bi) else 0.0, bi)
        if math.isnan(ar): ar = math.copysign(0.0, ar)
        if math.isnan(ai): ai = math.copysign(0.0, ai)
        recalculate = True
    if not recalculate and any(map(math.isinf, (ac, bd, ad, bc))):
        if math.isnan(ar): ar = math.copysign(0.0, ar)
        if math.isnan(ai): ai = math.copysign(0.0, ai)
        if math.isnan(br): br = math.copysign(0.0, br)
        if math.isnan(bi): bi = math.copysign(0.0, bi)
        recalculate = True
    if recalculate:
        real = math.inf * (ar*br - ai*bi)
        imag = math.inf * (ar*bi + ai*br)
    return real, imag

def exceptional_divide(ar, ai, br, bi):
    scale = math.nan if math.isnan(br) or math.isnan(bi) else max(abs(br), abs(bi))
    exponent = 0
    if scale > 0.0 and math.isfinite(scale):
        exponent = java_exponent(scale)
        br, bi = scalb(br, -exponent), scalb(bi, -exponent)
    denominator = br*br + bi*bi
    real = scalb(ieee_divide(ar*br + ai*bi, denominator), -exponent)
    imag = scalb(ieee_divide(ai*br - ar*bi, denominator), -exponent)
    if math.isnan(real) and math.isnan(imag):
        if denominator == 0.0 and (not math.isnan(ar) or not math.isnan(ai)):
            infinity = math.copysign(math.inf, br)
            real, imag = infinity*ar, infinity*ai
        elif (math.isinf(ar) or math.isinf(ai)) and math.isfinite(br) and math.isfinite(bi):
            a = math.copysign(1.0 if math.isinf(ar) else 0.0, ar)
            b = math.copysign(1.0 if math.isinf(ai) else 0.0, ai)
            real = math.inf * (a*br + b*bi)
            imag = math.inf * (b*br - a*bi)
        elif (math.isinf(br) or math.isinf(bi)) and math.isfinite(ar) and math.isfinite(ai):
            c = math.copysign(1.0 if math.isinf(br) else 0.0, br)
            d = math.copysign(1.0 if math.isinf(bi) else 0.0, bi)
            real = 0.0 * (ar*c + ai*d)
            imag = 0.0 * (ai*c - ar*d)
    return real, imag

def evaluate(case):
    ar, ai = map(from_bits, case["a"])
    br, bi = map(from_bits, case["b"])
    finite = all(map(math.isfinite, (ar, ai, br, bi)))
    if case["op"] == "multiply":
        return exact_finite_multiply(ar, ai, br, bi) if finite else exceptional_multiply(ar, ai, br, bi)
    if case["op"] == "divide":
        if finite and (br != 0.0 or bi != 0.0):
            return exact_finite_divide(ar, ai, br, bi)
        return exceptional_divide(ar, ai, br, bi)
    raise ValueError("unsupported operation")

def component_matches(expected, actual):
    if set(expected) == {"class"}:
        return expected["class"] == "nan" and math.isnan(actual)
    if set(expected) == {"bits"} and HEX64.fullmatch(expected["bits"]):
        if math.isnan(from_bits(expected["bits"])):
            raise ValueError("NaN payload must not be pinned")
        return raw_bits(actual) == expected["bits"]
    raise ValueError("invalid expected component")

def validate(data):
    if not isinstance(data, dict) or set(data) != {
        "schema_version", "classification", "backend_guest_execution",
        "semantics", "cases"
    }:
        raise ValueError("invalid special-value manifest shape")
    if data["schema_version"] != "1.0.0":
        raise ValueError("unexpected schema")
    if data["classification"] != "SOURCE_FREE_COMPLEX128_IEEE_SPECIAL_REFERENCE_ONLY_NOT_GUEST_PARITY":
        raise ValueError("manifest must remain non-certifying")
    if data["backend_guest_execution"] != dict.fromkeys(BACKENDS, "unverified"):
        raise ValueError("backend execution status must remain unverified")
    if not isinstance(data["semantics"], dict) or set(data["semantics"]) != {
        "component_format", "nan_expected", "finite_multiply_divide",
        "exceptional_multiply_divide"
    }:
        raise ValueError("invalid semantics block")
    cases = data["cases"]
    if not isinstance(cases, list) or len(cases) != len(REQUIRED):
        raise ValueError("unexpected special-value vector count")
    ids = [c.get("id") for c in cases if isinstance(c, dict)]
    if len(ids) != len(cases) or set(ids) != REQUIRED or len(set(ids)) != len(ids):
        raise ValueError("missing, duplicate or unknown special-value vector")
    for case in cases:
        if set(case) != {"id", "op", "a", "b", "expected"}:
            raise ValueError("invalid vector shape")
        if case["op"] not in ("multiply", "divide"):
            raise ValueError("unsupported operation")
        if len(case["a"]) != 2 or len(case["b"]) != 2 or len(case["expected"]) != 2:
            raise ValueError("complex component count mismatch")
        for raw in case["a"] + case["b"]: from_bits(raw)
        actual = evaluate(case)
        if not all(component_matches(e, a) for e, a in zip(case["expected"], actual)):
            raise ValueError("special-value reference mismatch: " + case["id"])

class ComplexIeeeSpecialContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = json.loads(CASES.read_text(encoding="utf-8"))

    def test_schema_and_all_vectors(self):
        validate(self.doc)

    def test_all_five_backends_remain_unverified(self):
        self.assertEqual(self.doc["backend_guest_execution"], dict.fromkeys(BACKENDS, "unverified"))

    def test_signed_zero_quadrants_are_bit_exact(self):
        ids = ("div-finite-neg-inf-real", "div-finite-pos-inf-imag",
               "div-zero-rotate-signed", "div-negzero-identity")
        for case_id in ids:
            case = next(c for c in self.doc["cases"] if c["id"] == case_id)
            actual = evaluate(case)
            with self.subTest(case_id=case_id):
                self.assertTrue(all(component_matches(e, a) for e, a in zip(case["expected"], actual)))

    def test_nan_payload_is_classification_only(self):
        cases = [c for c in self.doc["cases"] if any(x.get("class") == "nan" for x in c["expected"])]
        self.assertGreaterEqual(len(cases), 4)
        for case in cases:
            for expected, actual in zip(case["expected"], evaluate(case)):
                if expected.get("class") == "nan": self.assertTrue(math.isnan(actual))

    def test_subnormal_ties_round_nearest_even(self):
        by_id = {c["id"]: c for c in self.doc["cases"]}
        self.assertEqual(raw_bits(evaluate(by_id["mul-half-min-subnormal"])[0]), "0000000000000000")
        self.assertEqual(raw_bits(evaluate(by_id["mul-one-half-min-subnormal"])[0]), "0000000000000002")
        self.assertEqual(raw_bits(evaluate(by_id["div-min-normal-half"])[0]), "0008000000000000")

    def test_subnormal_divisor_is_not_misclassified_as_zero(self):
        case = next(c for c in self.doc["cases"] if c["id"] == "div-nan-subnormal")
        result = evaluate(case)
        self.assertTrue(math.isnan(result[0]) and math.isnan(result[1]))

    def test_corruption_missing_duplicate_and_fake_backend_pass_are_denied(self):
        mutations = []
        x = copy.deepcopy(self.doc); x["cases"].pop(); mutations.append(x)
        x = copy.deepcopy(self.doc); x["cases"][-1] = copy.deepcopy(x["cases"][0]); mutations.append(x)
        x = copy.deepcopy(self.doc); x["backend_guest_execution"]["llvm"] = "passed"; mutations.append(x)
        x = copy.deepcopy(self.doc); x["cases"][0]["expected"][0] = {"bits":"8000000000000000"}; mutations.append(x)
        for mutation in mutations:
            with self.assertRaises(ValueError): validate(mutation)

    def test_invalid_bits_and_pinned_nan_payload_are_denied(self):
        x = copy.deepcopy(self.doc); x["cases"][0]["a"][0] = "XYZ"
        with self.assertRaises(ValueError): validate(x)
        x = copy.deepcopy(self.doc)
        next(c for c in x["cases"] if c["id"] == "div-inf-by-inf")["expected"][0] = {"bits":"7ff8000000000000"}
        with self.assertRaises(ValueError): validate(x)

if __name__ == "__main__":
    unittest.main(verbosity=2)
