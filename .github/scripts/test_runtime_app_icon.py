from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
from runtime_app_icon import export_app_icon, SVG

ROOT = Path(__file__).resolve().parents[2]

class AppIconTest(unittest.TestCase):
    def test_all_engine_previews_keep_app_paths_gradients_and_groups(self):
        for name in ("morphe-runtime", "reseam-runtime", "revanced.v21-runtime-plugin", "revanced.v22-runtime-plugin"):
            with self.subTest(module=name), tempfile.TemporaryDirectory() as folder:
                output = Path(folder)/"runtime-icon.svg"
                self.assertTrue(export_app_icon(ROOT/name, output))
                source = ET.parse(ROOT/name/"src/main/res/drawable/ic_runtime_plugin.xml").getroot()
                svg = ET.parse(output).getroot()
                self.assertEqual([p.get("{http://schemas.android.com/apk/res/android}pathData") for p in source.iter("path")],
                                 [p.get("d") for p in svg.iter("{"+SVG+"}path")])
                self.assertEqual(len(list(source.iter("gradient"))),
                                 len(list(svg.iter("{"+SVG+"}linearGradient")))+len(list(svg.iter("{"+SVG+"}radialGradient"))))
                self.assertTrue(list(svg.iter("{"+SVG+"}g")))
                self.assertTrue(any(float(stop.get("stop-opacity")) < 1 for stop in svg.iter("{"+SVG+"}stop")))

    def test_support_pack_has_no_app_icon(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)/"runtime-icon.svg"
            self.assertFalse(export_app_icon(ROOT/"shared-support", output))
            self.assertFalse(output.exists())
