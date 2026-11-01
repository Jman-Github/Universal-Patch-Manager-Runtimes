#!/usr/bin/env python3
"""Prepare one verified runtime release; never publish from this script."""
import argparse, hashlib, json, os, re, shutil, subprocess, zipfile
from pathlib import Path
from runtime_app_icon import export_app_icon
ROOT = Path(__file__).resolve().parents[2]
MODULES = {"revanced-v21":"revanced.v21-runtime-plugin", "revanced-v22":"revanced.v22-runtime-plugin", "morphe":"morphe-runtime", "reseam":"reseam-runtime", "shared-support":"shared-support"}

def prepare(runtime_id, tag, tools):
    item = next(x for x in json.loads((ROOT/"catalog.json").read_text())["plugins"] if x["id"] == runtime_id)
    module = ROOT/MODULES[runtime_id]
    version = dict(line.split("=",1) for line in (module/"version.properties").read_text().splitlines() if "=" in line)
    if tag != runtime_id+"-v"+version["versionName"]:
        raise ValueError("Tag must match version.properties")
    apk = module/"build/outputs/apk/release"/item["assetName"]
    ext = ".bat" if os.name == "nt" else ""
    output = subprocess.check_output([str(tools/("apksigner"+ext)), "verify", "--verbose", "--print-certs", str(apk)], text=True)
    actual = re.findall(r"Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]+)", output)
    expected = os.environ.get("RUNTIME_SIGNER_SHA256","").replace(":","").lower()
    if not re.fullmatch("[a-f0-9]{64}",expected) or len(actual)!=1 or actual[0].lower()!=expected:
        raise ValueError("Set RUNTIME_SIGNER_SHA256 to the manager release certificate; sign the plugin with that same key")
    aapt = str(tools/("aapt2.exe" if os.name=="nt" else "aapt2"))
    badging = subprocess.check_output([aapt,"dump","badging",str(apk)],text=True)
    pkg = re.search(r"package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'",badging)
    if not pkg or pkg.groups() != (item["packageName"],version["versionCode"],version["versionName"]):
        raise ValueError("APK package/version disagrees with catalog")
    xml = subprocess.check_output([aapt,"dump","xmltree",str(apk),"--file","AndroidManifest.xml"],text=True)
    upstream = re.search(r'app\.universal\.patch\.manager\.patcher\.runtime\.upstream.*?android:value[^\n]*="([^"]+)"',xml,re.S)
    if not upstream:
        raise ValueError("Missing upstream engine version metadata")
    abis=[]; modes=["art"]
    with zipfile.ZipFile(apk) as z:
        names=set(z.namelist())
        if runtime_id=="reseam":
            abis=sorted({x.split("/")[1] for x in names if x.startswith("lib/") and x.endswith("/libreseam-sdk-native.so")})
            if not abis: raise ValueError("Missing Reseam native SDK")
        elif runtime_id=="shared-support":
            modes=["support"]
            if not {"assets/jvm/modules.xz","assets/jvm/tools-patcher-core.jar"} <= names:
                raise ValueError("Missing support payload")
        else:
            modes+=["jvm"]
            host={"revanced-v21":"revanced21-patcher-core","revanced-v22":"revanced22-patcher-core","morphe":"upm-patcher-core"}[runtime_id]
            if "assets/jvm/"+host+".jar" not in names: raise ValueError("Missing JVM host")
    digest=hashlib.sha256(apk.read_bytes()).hexdigest()
    manifest=dict(schemaVersion=1,id=runtime_id,kind=item["kind"],packageName=item["packageName"],assetName=item["assetName"],version=version["versionName"],versionCode=int(version["versionCode"]),upstreamVersion=upstream.group(1),sha256=digest,size=apk.stat().st_size,minHostProtocol=1,maxHostProtocol=1,minSdk=26,abis=abis,executionModes=modes)
    dest=ROOT/"runtime-release-assets"/runtime_id
    dest.mkdir(parents=True,exist_ok=True)
    shutil.copy2(apk,dest/apk.name)
    (dest/"runtime-icon.svg").unlink(missing_ok=True)
    export_app_icon(module, dest/"runtime-icon.svg")
    (dest/"runtime-release.json").write_text(json.dumps(manifest,indent=2)+"\n")
    (dest/"SHA256SUMS").write_text(digest+"  "+apk.name+"\n")
    print("Prepared",tag,"at",dest)
    return dest
if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("runtime_id",choices=MODULES)
    p.add_argument("--tag",required=True)
    p.add_argument("--build-tools",type=Path,required=True)
    a=p.parse_args(); prepare(a.runtime_id,a.tag,a.build_tools)
