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

    def run_failed_build(self, message, failures):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "gradlew").write_text(
                'count=0\n'
                '[[ ! -f attempts ]] || count="$(cat attempts)"\n'
                'count=$((count + 1))\n'
                'echo "$count" > attempts\n'
                f'if [[ "$count" -le {failures} ]]; then\n'
                f'  printf "%s\\n" "{message}" >&2\n'
                '  exit 7\n'
                'fi\n')
            result = subprocess.run([
                BASH, "-c",
                'python3() { printf "%s\\n" "$*" >> python-calls; }; '
                'sleep() { printf "%s\\n" "$*" >> sleeps; }; '
                'source "$1" revanced-v22 1.0.3 main',
                "_", SCRIPT.as_posix(),
            ], cwd=root, env=dict(os.environ, ANDROID_HOME="/test/android-sdk"),
                capture_output=True, text=True)
            return (result, int((root / "attempts").read_text()),
                    (root / "python-calls").read_text().splitlines(),
                    (root / "sleeps").read_text().splitlines()
                    if (root / "sleeps").exists() else [])

    def test_rate_limit_retries_before_packaging_once(self):
        result, attempts, calls, sleeps = self.run_failed_build(
            "Received status code 429 from server: Too Many Requests", 2)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(attempts, 3)
        self.assertEqual(sleeps, ["30", "60"])
        self.assertEqual(len(calls), 2)
        self.assertIn("prepare-runtime-release.py", calls[-1])

    def test_exhausted_download_retries_do_not_package(self):
        result, attempts, calls, sleeps = self.run_failed_build(
            "Received status code 503 from server", 10)
        self.assertEqual(result.returncode, 7, result.stdout + result.stderr)
        self.assertEqual(attempts, 3)
        self.assertEqual(sleeps, ["30", "60"])
        self.assertEqual(len(calls), 1)

    def test_compile_failure_is_not_retried_or_packaged(self):
        result, attempts, calls, sleeps = self.run_failed_build(
            "Compilation error: Unresolved reference", 10)
        self.assertEqual(result.returncode, 7, result.stdout + result.stderr)
        self.assertEqual(attempts, 1)
        self.assertEqual(sleeps, [])
        self.assertEqual(len(calls), 1)
