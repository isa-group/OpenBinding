"""Verify a release end to end and print one JSON summary with the hashes.

    python tools/verify_release.py [--skip-corpus] [--artifacts-out DIR] [--keep]

What it does, in this order (it stops being "ok" at the first thing that fails, but runs every step it can):

0. puts the five OMG BPMN XSDs in place if they are not (they are not versioned in Git: verified download, which needs
   network only when a file is missing);
1. builds the wheels and sdists of the three distributions **twice**, in two different directories (a copy of the
   sources each time) with a fixed ``SOURCE_DATE_EPOCH``, and compares the SHA-256 of every artifact: a build that is
   not reproducible is a failure, reported member by member;
   and checks that each wheel and sdist carries ``LICENSE`` and ``NOTICE.md`` equal to the ones at the root, and that the
   wheel and the sdist of ``bim-core`` carry the five XSDs with the bytes ``licenses.json`` declares;
2. makes a clean virtual environment, installs the wheels of the first build and runs ``python -I
   tools/smoke_installed.py`` with an empty environment (it imports ``bim_core``, ``bim_service`` and ``bim_client``);
3. compares ``compilerDigest`` of the wheel, of the source tree, of the unpacked sdist, of the installed distribution and
   of the service;
4. ``dump_service_openapi.py --check`` and ``consumer_fixtures.py --check``;
5. ``baseline_core.py --check`` against the corpus of 82 packages (``BIM_CORPUS_ROOT``; ``--skip-corpus`` says so
   explicitly in the summary when the tree has no corpus);
6. ``toolchain_json.py`` run by the installed wheels (``evidence/toolchain.json``): it must check against itself and agree
   with the source tree on everything but the versions of the runtime.

The summary goes to standard output, the progress to standard error.  The exit status is 0 only when everything that
ran passed.  It needs ``uv`` and, for steps 3-6, the interpreter that runs it must have the dependencies of the
packages (it is the interpreter of the test environment).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import Any

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import packaging_support as ps  # noqa: E402

ROOT = ps.ROOT
SOURCE_PATH = os.pathsep.join(str(ROOT / "packages" / name / "src") for name in ps.PACKAGES)
CORE_ONLY_PATH = str(ROOT / "packages" / "bim-core" / "src")
DIGEST_CODE = (
    "import sys, zipfile\n"
    "from pathlib import Path\n"
    "from bim_core.toolchain import bundle_digest\n"
    "kind, target = sys.argv[1], sys.argv[2]\n"
    "if kind == 'wheel':\n"
    "    with zipfile.ZipFile(target) as archive:\n"
    "        print(bundle_digest(zipfile.Path(archive, 'bim_core/')))\n"
    "else:\n"
    "    print(bundle_digest(Path(target)))\n"
)


def progress(message: str) -> None:
    print(f"[verify_release] {message}", file=sys.stderr, flush=True)


class Report:
    """The checks that ran: each is ``{"ok": bool, ...details}``; the release is ok when there is one and all are."""

    def __init__(self) -> None:
        self.checks: dict[str, dict[str, Any]] = {}

    def add(self, name: str, ok: bool, **details: Any) -> bool:
        self.checks[name] = {"ok": bool(ok), **details}
        progress(f"{name}: {'ok' if ok else 'FAILED'}")
        return bool(ok)

    @property
    def ok(self) -> bool:
        return bool(self.checks) and all(check["ok"] for check in self.checks.values())


# --- reproducibility ----------------------------------------------------------------------------------


def _zip_differences(left: Path, right: Path) -> list[str]:
    found: list[str] = []
    with zipfile.ZipFile(left) as one, zipfile.ZipFile(right) as other:
        first, second = one.namelist(), other.namelist()
        if first != second:
            found.append(
                f"members differ: only in the first {sorted(set(first) - set(second))}, "
                f"only in the second {sorted(set(second) - set(first))}, same set in another order: {sorted(first) == sorted(second)}"
            )
        for name in sorted(set(first) & set(second)):
            a, b = one.getinfo(name), other.getinfo(name)
            for attribute in ("CRC", "file_size", "date_time", "external_attr", "compress_type", "create_system"):
                if getattr(a, attribute) != getattr(b, attribute):
                    found.append(f"{name}: {attribute} {getattr(a, attribute)} != {getattr(b, attribute)}")
    return found


def _tar_differences(left: Path, right: Path) -> list[str]:
    found: list[str] = []

    def members(path: Path) -> dict[str, tuple[Any, ...]]:
        with tarfile.open(path) as archive:
            result = {}
            for member in archive.getmembers():
                content = archive.extractfile(member).read() if member.isfile() else b""  # type: ignore[union-attr]
                result[member.name] = (
                    member.size, member.mtime, member.mode, member.uid, member.gid, member.uname, member.gname,
                    hashlib.sha256(content).hexdigest(),
                )
            return result

    first, second = members(left), members(right)
    if list(first) != list(second):
        found.append(f"members differ: only in the first {sorted(set(first) - set(second))}, only in the second {sorted(set(second) - set(first))}")
    fields = ("size", "mtime", "mode", "uid", "gid", "uname", "gname", "content sha256")
    for name in sorted(set(first) & set(second)):
        for field, a, b in zip(fields, first[name], second[name], strict=True):
            if a != b:
                found.append(f"{name}: {field} {a} != {b}")
    if left.read_bytes()[4:8] != right.read_bytes()[4:8]:
        found.append("the gzip header carries another modification time")
    return found


def differences(left: Path, right: Path) -> list[str]:
    """Why two archives with the same name have other bytes (member by member); never empty for different bytes."""
    found = _zip_differences(left, right) if left.suffix == ".whl" else _tar_differences(left, right)
    return found or ["no member differs: the compression stream or the container metadata does"]


def compare_builds(first: dict[str, Path], second: dict[str, Path]) -> dict[str, Any]:
    """SHA-256 of every artifact of two builds, and for the ones that differ, why."""
    artifacts: dict[str, Any] = {}
    for name in sorted(set(first) | set(second)):
        if name not in first or name not in second:
            artifacts[name] = {"identical": False, "differences": [f"only built {'first' if name in first else 'second'}"]}
            continue
        one, other = ps.sha256_file(first[name]), ps.sha256_file(second[name])
        entry: dict[str, Any] = {
            "sha256": one, "sha256Second": other, "size": first[name].stat().st_size, "identical": one == other,
        }
        if one != other:
            entry["differences"] = differences(first[name], second[name])
        artifacts[name] = entry
    return artifacts


# --- steps --------------------------------------------------------------------------------------------


def run_split(command: list[str], *, env: dict[str, str] | None, cwd: Path) -> tuple[int, str, str]:
    """Exit status, standard output and standard error apart: a warning on the error stream must not be read as data."""
    result = subprocess.run(command, env=env, cwd=cwd, capture_output=True, text=True, check=False)
    return result.returncode, result.stdout, result.stderr


def run(command: list[str], *, env: dict[str, str] | None, cwd: Path) -> tuple[int, str]:
    code, out, err = run_split(command, env=env, cwd=cwd)
    return code, out + err


def tail(text: str, lines: int = 8) -> str:
    return "\n".join(text.strip().splitlines()[-lines:])


def tool_environment(path: str) -> dict[str, str]:
    return {**{k: v for k, v in os.environ.items() if k != "PYTHONPATH"}, "PYTHONPATH": path}


def installed_digest(python: Path, kind: str, target: Path, work: Path) -> str:
    code, out, err = run_split([str(python), "-I", "-c", DIGEST_CODE, kind, str(target)], env={}, cwd=work)
    if code != 0 or not out.strip():
        raise ps.BuildError(f"could not compute the digest of {target}: {tail(out + err)}")
    return out.strip().splitlines()[-1]


def verify(arguments: argparse.Namespace, work: Path, report: Report, summary: dict[str, Any]) -> None:
    uv = ps.require_uv()
    code, output = run([uv, "--version"], env=None, cwd=work)
    summary["uv"] = output.strip() if code == 0 else "unknown"
    summary["python"] = platform.python_version()
    summary["epoch"] = arguments.epoch

    # 0. the OMG XSDs are not versioned: in place (verified download if they are not) before anything is copied or built
    summary["xsdDownloaded"] = ps.ensure_xsd()

    # 1. two builds, in two different directories
    builds: dict[str, dict[str, Path]] = {}
    for label in ("first", "second"):
        progress(f"building the three distributions ({label} build)")
        tree = ps.copy_source_tree(ROOT, work / label / "source")
        builds[label] = ps.build_distributions(tree, work / label / "dist", epoch=arguments.epoch)
    artifacts = compare_builds(builds["first"], builds["second"])
    expected = 2 * len(ps.PACKAGES)
    reproducible = len(artifacts) == expected and all(item["identical"] for item in artifacts.values())
    summary["artifacts"] = artifacts
    report.add("reproducible-build", reproducible, artifacts=len(artifacts), expected=expected)
    first = builds["first"]
    license_problems = [problem for path in first.values() for problem in ps.license_problems(path)]
    report.add("license-files", not license_problems and len(first) == expected, problems=license_problems)
    wheels = sorted(path for path in first.values() if path.suffix == ".whl")
    core_wheel, core_sdist = ps.wheel_path("bim-core", work / "first" / "dist"), ps.sdist_path("bim-core", work / "first" / "dist")
    if core_wheel is None or core_sdist is None or len(wheels) != len(ps.PACKAGES):
        report.add("artifacts-present", False, wheels=[path.name for path in wheels])
        return
    summary["generator"] = ps.wheel_generator(core_wheel)
    xsd_problems = [*ps.xsd_problems(core_wheel), *ps.xsd_problems(core_sdist)]
    report.add("xsd-in-artifacts", not xsd_problems, problems=xsd_problems)

    # 2. clean venv, installed wheels, isolated smoke test
    progress("installing the wheels in a clean virtual environment")
    python = ps.make_venv(work / "venv", wheels)
    code, out, err = run_split(
        [str(python), "-I", str(TOOLS / "smoke_installed.py"), str(ps.EXAMPLE_PACKAGE)], env={}, cwd=work
    )
    output = out + err
    smoke: dict[str, Any] = {}
    if code == 0 and out.strip():
        smoke = json.loads(out.strip().splitlines()[-1])
    versions = {name: ps.source_version(name) for name in ps.PACKAGES}
    smoke_ok = (
        code == 0
        and smoke.get("ok") is True
        and "site-packages" in smoke.get("installedFrom", "")
        and (smoke.get("bimCore"), smoke.get("bimService"), smoke.get("bimClient"))
        == (versions["bim-core"], versions["bim-service"], versions["bim-client"])
    )
    summary["smoke"] = smoke
    report.add("smoke-installed", smoke_ok, exit=code, detail="" if smoke_ok else tail(output))

    # 3. compilerDigest in every form
    unpacked = ps.extract_sdist(core_sdist, work / "sdist")
    digests = {
        "sourceTree": installed_digest(python, "tree", ROOT / "packages" / "bim-core" / "src" / "bim_core", work),
        "wheel": installed_digest(python, "wheel", core_wheel, work),
        "sdist": installed_digest(python, "tree", unpacked / "src" / "bim_core", work),
        "installed": smoke.get("compilerDigest"),
        "service": smoke.get("serviceCompilerDigest"),
    }
    summary["compilerDigest"] = digests
    report.add("compiler-digest", len(set(digests.values())) == 1 and None not in digests.values(), digests=digests)

    # 4-5. contracts and the baseline against the corpus
    for name, script, path in (
        ("openapi", "dump_service_openapi.py", SOURCE_PATH),
        ("consumer-fixtures", "consumer_fixtures.py", SOURCE_PATH),
    ):
        code, output = run([sys.executable, str(TOOLS / script), "--check"], env=tool_environment(path), cwd=ROOT)
        report.add(name, code == 0, exit=code, detail=tail(output, 3))
    if arguments.skip_corpus:
        report.add("baseline", True, skipped=True, reason="--skip-corpus: this tree has no corpus; nothing was compared")
    else:
        code, output = run([sys.executable, str(TOOLS / "baseline_core.py"), "--check"], env=tool_environment(CORE_ONLY_PATH), cwd=ROOT)
        report.add("baseline", code == 0, exit=code, detail=tail(output, 4))

    # 6. toolchain.json written by the installed wheels
    evidence = work / "evidence" / "toolchain.json"
    code, output = run([str(python), "-I", str(TOOLS / "toolchain_json.py"), "--output", str(evidence)], env={}, cwd=work)
    if code != 0:
        report.add("toolchain-json", False, exit=code, detail=tail(output))
        return
    code, output = run([str(python), "-I", str(TOOLS / "toolchain_json.py"), "--check", str(evidence)], env={}, cwd=work)
    self_check = code == 0
    code, out, err = run_split([sys.executable, str(TOOLS / "toolchain_json.py")], env=tool_environment(SOURCE_PATH), cwd=ROOT)
    tree_document = json.loads(out) if code == 0 else {}
    wheel_document = json.loads(evidence.read_text(encoding="utf-8"))
    differing = sorted(key for key in wheel_document if key != "runtime" and wheel_document[key] != tree_document.get(key))
    summary["toolchainJson"] = {
        "sha256": ps.sha256_file(evidence),
        "wheelRuntime": wheel_document.get("runtime"),
        "treeRuntime": tree_document.get("runtime"),
    }
    report.add("toolchain-json", self_check and code == 0 and not differing, selfCheck=self_check, differsFromTree=differing)

    if arguments.artifacts_out is not None:
        target = arguments.artifacts_out
        target.mkdir(parents=True, exist_ok=True)
        for path in first.values():
            shutil.copy2(path, target / path.name)
        shutil.copy2(evidence, target / "toolchain.json")
        names = sorted([*first, "toolchain.json"])
        (target / "SHA256SUMS").write_text(
            "".join(f"{ps.sha256_file(target / name)}  {name}\n" for name in names), encoding="utf-8"
        )
        summary["artifactsOut"] = str(target)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--epoch", default=ps.SOURCE_DATE_EPOCH, help="SOURCE_DATE_EPOCH of both builds")
    parser.add_argument("--skip-corpus", action="store_true", help="do not run baseline_core.py --check (no corpus in this tree)")
    parser.add_argument("--artifacts-out", type=Path, help="copy the artifacts of the first build, toolchain.json and SHA256SUMS here")
    parser.add_argument("--work", type=Path, help="working directory (default: a temporary one, removed at the end)")
    parser.add_argument("--keep", action="store_true", help="keep the working directory")
    arguments = parser.parse_args(argv)

    work = arguments.work or Path(tempfile.mkdtemp(prefix="verify-release-"))
    work.mkdir(parents=True, exist_ok=True)
    report = Report()
    summary: dict[str, Any] = {}
    try:
        verify(arguments, work, report, summary)
    except ps.BuildError as exc:
        report.add("environment", False, error=str(exc))
    finally:
        if not arguments.keep and arguments.work is None:
            shutil.rmtree(work, ignore_errors=True)
    summary = {"ok": report.ok, **summary, "checks": report.checks}
    if arguments.keep or arguments.work is not None:
        summary["work"] = str(work)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
