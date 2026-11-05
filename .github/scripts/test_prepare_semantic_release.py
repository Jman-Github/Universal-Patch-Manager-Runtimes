import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("prepare-semantic-release.sh").resolve()
BASH = shutil.which("bash")
if os.name == "nt":
    git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
    BASH = str(git_bash) if git_bash.is_file() else None


@unittest.skipUnless(BASH, "Bash is required")
class PrepareSemanticReleaseTest(unittest.TestCase):
    def test_consecutive_runtimes_with_non_executable_wrapper(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            wrapper = root / "gradlew"
            wrapper.write_text('printf "%s\\n" "$*" >> gradle-calls\n')
            for runtime in ("revanced-v21", "revanced-v22", "morphe",
                            "reseam", "shared-support"):
                for branch, version in (("main", "1.0.2"),
                                        ("dev", "1.0.3-dev.1")):
                    with self.subTest(runtime=runtime, branch=branch):
                        # Model the permission reset after each runtime's backmerge.
                        wrapper.chmod(0o644)
                        env = dict(os.environ, ANDROID_HOME="/test/android-sdk")
                        result = subprocess.run([
                            BASH, "-c",
                            'python3() { printf "%s\\n" "$*" >> python-calls; }; '
                            'source "$1" "$2" "$3" "$4"',
                            "_", SCRIPT.as_posix(), runtime, version, branch,
                        ], cwd=root, env=env, capture_output=True, text=True)
                        self.assertEqual(result.returncode, 0,
                                         result.stdout + result.stderr)
                        self.assertEqual(
                            (root / "gradle-calls").read_text().splitlines()[-1],
                            f"assembleRelease -PruntimeId={runtime}")
                        self.assertEqual(
                            (root / "python-calls").read_text().splitlines()[-2:],
                            [f".github/scripts/runtime-version.py {runtime} {version}",
                             f".github/scripts/prepare-runtime-release.py {runtime} "
                             f"--tag {runtime}-v{version} --build-tools "
                             "/test/android-sdk/build-tools/36.0.0"])
