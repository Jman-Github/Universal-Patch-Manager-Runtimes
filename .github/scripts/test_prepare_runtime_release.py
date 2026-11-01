import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("prepare-runtime-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class ReleasePreparationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.module = self.root/"morphe-runtime"
        self.module.mkdir()
        (self.module/"src/main").mkdir(parents=True)
        (self.module/"src/main/AndroidManifest.xml").write_text("<manifest><application/></manifest>")
        self.item = dict(id="morphe", kind="morphe", packageName="app.universal.patch.manager.morphe.runtime", assetName="morphe-plugin.apk")
        (self.root/"catalog.json").write_text(json.dumps(dict(plugins=[self.item])))
        (self.module/"version.properties").write_text("versionName=1.0.0\nversionCode=2\n")
        self.apk = self.module/"build/outputs/apk/release/morphe-plugin.apk"
        self.apk.parent.mkdir(parents=True)
        with zipfile.ZipFile(self.apk,"w") as apk:
            apk.writestr("assets/jvm/upm-patcher-core.jar",b"fixture")
        self.signer = "a"*64
        self.package = self.item["packageName"]

    def tearDown(self):
        self.temp.cleanup()

    def command(self, command, **kwargs):
        if "verify" in command:
            return "Signer #1 certificate SHA-256 digest: "+self.signer
        if "badging" in command:
            return "package: name='"+self.package+"' versionCode='2' versionName='1.0.0'"
        return 'android:name(0x01010003)="app.universal.patch.manager.patcher.runtime.upstream"\n android:value(0x01010024)="2.1.0" (Raw: "2.1.0")'

    def prepare(self, tag="morphe-v1.0.0"):
        with patch.object(release,"ROOT",self.root), patch.object(release.subprocess,"check_output",side_effect=self.command), patch.dict(os.environ,{"RUNTIME_SIGNER_SHA256":"a"*64}):
            return release.prepare("morphe",tag,Path("tools"))

    def test_generates_metadata_from_the_verified_apk(self):
        destination = self.prepare()
        metadata = json.loads((destination/"runtime-release.json").read_text())
        self.assertEqual(metadata["sha256"],hashlib.sha256(self.apk.read_bytes()).hexdigest())
        self.assertEqual(metadata["size"],self.apk.stat().st_size)
        self.assertEqual(metadata["upstreamVersion"],"2.1.0")
        self.assertEqual(metadata["versionCode"],2)

    def test_publishes_the_app_icon_preview(self):
        main = self.module/"src/main"
        (main/"res/drawable").mkdir(parents=True)
        (main/"AndroidManifest.xml").write_text('<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:icon="@drawable/app_icon"/></manifest>')
        (main/"res/drawable/app_icon.xml").write_text('<vector xmlns:android="http://schemas.android.com/apk/res/android" android:viewportWidth="24" android:viewportHeight="24"><path android:pathData="M0,0L24,24" android:fillColor="#FF112233"/></vector>')
        destination = self.prepare()
        self.assertIn("M0,0L24,24", (destination/"runtime-icon.svg").read_text())

    def test_rejects_a_different_signing_key(self):
        self.signer="b"*64
        with self.assertRaises(ValueError): self.prepare()

    def test_rejects_wrong_package(self):
        self.package="other.package"
        with self.assertRaises(ValueError): self.prepare()

    def test_rejects_tag_version_mismatch(self):
        with self.assertRaises(ValueError): self.prepare("morphe-v2.0.0")

    def test_rejects_missing_jvm_host(self):
        with zipfile.ZipFile(self.apk,"w") as apk: apk.writestr("classes.dex",b"fixture")
        with self.assertRaises(ValueError): self.prepare()

if __name__=="__main__": unittest.main()
