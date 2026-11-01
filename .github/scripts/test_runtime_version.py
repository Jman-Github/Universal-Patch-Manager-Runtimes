import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("runtime_version", Path(__file__).with_name("runtime-version.py"))
version = importlib.util.module_from_spec(spec)
spec.loader.exec_module(version)

class RuntimeVersionTest(unittest.TestCase):
    def test_upm_version_ordering_including_stable_promotion(self):
        self.assertEqual(version.version_code("1.9.1"), 10901999)
        self.assertLess(version.version_code("1.9.1-dev.2"), version.version_code("1.9.1-dev.3"))
        self.assertLess(version.version_code("1.9.1-dev.998"), version.version_code("1.9.1"))
        self.assertLess(version.version_code("1.9.1"), version.version_code("1.9.2-dev.1"))

    def test_invalid_or_exhausted_versions_fail(self):
        for value in ("1.2", "1.2.3-dev.999", "210.0.0", "1.100.0", "1.0.100", "0.0.0-dev.0"):
            with self.subTest(version=value), self.assertRaises(ValueError):
                version.version_code(value)

    def test_update_does_not_touch_another_runtime(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for module in ("morphe-runtime", "reseam-runtime"):
                (root/module).mkdir()
                (root/module/"version.properties").write_text("versionName=1.0.0\nversionCode=2\n")
            version.update(root, "morphe", "1.0.1-dev.1")
            self.assertIn("versionName=1.0.1-dev.1", (root/"morphe-runtime/version.properties").read_text())
            self.assertEqual((root/"reseam-runtime/version.properties").read_text(), "versionName=1.0.0\nversionCode=2\n")
            with self.assertRaises(ValueError): version.update(root, "morphe", "0.1.0")
