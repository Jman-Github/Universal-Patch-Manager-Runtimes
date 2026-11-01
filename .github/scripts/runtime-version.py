"""UPM's Android versionCode policy, applied to an individual runtime."""
from pathlib import Path
import re
import sys

MODULES = {"revanced-v21":"revanced.v21-runtime-plugin", "revanced-v22":"revanced.v22-runtime-plugin",
           "morphe":"morphe-runtime", "reseam":"reseam-runtime", "shared-support":"shared-support"}

def version_code(version):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?", version)
    if not match:
        raise ValueError("Expected a stable version or dev.N prerelease")
    major, minor, patch = map(int, match.groups()[:3])
    ordinal = int(match[4]) if match[4] is not None else 999
    if not (0 <= major <= 209 and 0 <= minor <= 99 and 0 <= patch <= 99 and 0 <= ordinal <= 999):
        raise ValueError("Version exceeds UPM Android versionCode limits")
    if match[4] is not None and ordinal > 998:
        raise ValueError("999 is reserved for stable releases")
    code = major * 10_000_000 + minor * 100_000 + patch * 1_000 + ordinal
    if not 1 <= code <= 2_100_000_000:
        raise ValueError("Android versionCode is outside the supported range")
    return code

def update(root, runtime, version):
    path = root / MODULES[runtime] / "version.properties"
    previous = dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)
    code = version_code(version)
    if code < int(previous["versionCode"]):
        raise ValueError("Refusing to lower a published Android versionCode")
    path.write_text(f"versionName={version}\nversionCode={code}\n")

if __name__ == "__main__":
    update(Path(__file__).resolve().parents[2], sys.argv[1], sys.argv[2])
