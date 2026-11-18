#!/usr/bin/env python3
"""Negative mutation tests for the portable source-identity gate."""
import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest

DIR = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("atto_gate", DIR / "check_atto_core_snapshot.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

class SnapshotGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.snap = self.root / gate.SNAPSHOT
        shutil.copytree(DIR.parent / gate.SNAPSHOT, self.snap)

    def test_original(self):
        self.assertEqual(gate.check(self.root), gate.MODULES)

    def test_changed_byte_rejected(self):
        f = self.snap / "numeric.atto"
        f.write_bytes(f.read_bytes() + b" ")
        with self.assertRaises(gate.Rejected): gate.check(self.root)

    def test_missing_source_rejected(self):
        (self.snap / "numeric.atto").unlink()
        with self.assertRaises(gate.Rejected): gate.check(self.root)

    def test_duplicate_legacy_source_rejected(self):
        shutil.copyfile(self.snap / "core.atto", self.snap / "core.ores")
        with self.assertRaises(gate.Rejected): gate.check(self.root)

    def test_extra_file_rejected(self):
        (self.snap / "MALICIOUS.atto").write_text("guest", encoding="utf-8")
        with self.assertRaises(gate.Rejected): gate.check(self.root)

    def test_oversize_rejected(self):
        (self.snap / "core.atto").write_bytes(b"A" * (gate.MAX_BYTES + 1))
        with self.assertRaises(gate.Rejected): gate.check(self.root)

    def test_bad_utf8_rejected(self):
        (self.snap / "core.atto").write_bytes(b"\xff")
        with self.assertRaises(gate.Rejected): gate.check(self.root)

    def test_bom_rejected(self):
        f = self.snap / "core.atto"
        f.write_bytes(b"\xef\xbb\xbf" + f.read_bytes())
        with self.assertRaises(gate.Rejected): gate.check(self.root)

    def test_nul_rejected(self):
        f = self.snap / "core.atto"
        f.write_bytes(f.read_bytes() + b"\x00")
        with self.assertRaises(gate.Rejected): gate.check(self.root)

    def test_symlink_module_rejected(self):
        (self.snap / "core.atto").unlink()
        (self.snap / "core.atto").symlink_to(self.snap / "numeric.atto")
        with self.assertRaises(gate.Rejected): gate.check(self.root)

    def test_symlink_directory_rejected(self):
        shadow = self.root / "other"
        self.snap.rename(shadow)
        self.snap.symlink_to(shadow, target_is_directory=True)
        with self.assertRaises(gate.Rejected): gate.check(self.root)

    def test_directory_substitution_rejected(self):
        (self.snap / "numeric.atto").unlink()
        (self.snap / "numeric.atto").mkdir()
        with self.assertRaises(gate.Rejected): gate.check(self.root)

if __name__ == "__main__":
    unittest.main(verbosity=2)
