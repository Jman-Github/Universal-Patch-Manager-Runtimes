"""Inspect standalone plugin archives after a release build."""
from pathlib import Path
import io,json,zipfile
ROOT=Path(__file__).resolve().parents[2]
modules={"revanced-v21":"revanced.v21-runtime-plugin","revanced-v22":"revanced.v22-runtime-plugin","morphe":"morphe-runtime","reseam":"reseam-runtime","shared-support":"shared-support"}
for item in json.loads((ROOT/"catalog.json").read_text())["plugins"]:
    apk=ROOT/modules[item["id"]]/"build/outputs/apk/release"/item["assetName"]
    with zipfile.ZipFile(apk) as archive:
        names=set(archive.namelist())
        if item["id"]=="shared-support":
            assert "assets/jvm/modules.xz" in names
            assert "assets/jvm/tools-patcher-core.jar" in names
        else:
            assert "classes.dex" in names
        for name in names:
            if name.startswith("assets/jvm/") and name.endswith(".jar"):
                with zipfile.ZipFile(io.BytesIO(archive.read(name))) as host:
                    assert any(x.startswith("frameworks/") for x in host.namelist()),(apk,name)
    print("PASS:",item["id"])
