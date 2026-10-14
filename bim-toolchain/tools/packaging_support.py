"""Shared helpers of the packaging tests and of ``verify_release.py``: where the packages, the built artifacts and the
clean venv are, and how they are built.

Building is done on demand: ``ensure_dist()`` and ``ensure_verify_venv()`` build (and rebuild when the sources changed)
what the tests need, so that no packaging test has to skip for lack of ``dist/`` or ``.verify-venv``.  They need ``uv``
and fail with a clear message when it is missing; nothing here skips.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tarfile
import tomllib
import venv
import zipfile
from email.parser import Parser
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
VERIFY_VENV = ROOT / ".verify-venv"
EXAMPLE_PACKAGE = ROOT / "packages" / "bim-core" / "tests" / "fixtures" / "example-package"
#: distribution name -> (import name, runtime dependencies by name)
PACKAGES: dict[str, tuple[str, frozenset[str]]] = {
    "bim-core": ("bim_core", frozenset({"jsonschema", "lxml", "pyyaml"})),
    "bim-service": ("bim_service", frozenset({"bim-core", "fastapi", "pydantic", "uvicorn"})),
    "bim-client": ("bim_client", frozenset({"bim-core", "httpx"})),
}
#: 2026-01-01T00:00:00Z: the fixed timestamp of reproducible builds (``SOURCE_DATE_EPOCH``).
SOURCE_DATE_EPOCH = "1767225600"
FINGERPRINT_FILE = ".source-fingerprint"
VENV_MARKER = ".wheels-sha256"
#: Files of the repository root that a build may read (hatchling looks for ``.gitignore`` next to the project).
ROOT_BUILD_FILES = ("pyproject.toml", ".gitignore", "NOTICE.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses.json")


class BuildError(RuntimeError):
    """``uv`` is missing, or a build or an installation failed."""


def package_dir(name: str) -> Path:
    return ROOT / "packages" / name


def pyproject(name: str) -> dict[str, Any]:
    return tomllib.loads((package_dir(name) / "pyproject.toml").read_text(encoding="utf-8"))


def source_version(name: str) -> str:
    """``__version__`` read from ``_version.py`` as text (the module is not imported)."""
    text = (package_dir(name) / "src" / PACKAGES[name][0] / "_version.py").read_text(encoding="utf-8")
    match = re.search(r'^__version__\s*=\s*"([^"]+)"\s*$', text, flags=re.MULTILINE)
    assert match, f"no __version__ in {name}/_version.py"
    return match.group(1)


def requirement_name(requirement: str) -> str:
    return re.split(r"[\s;<>=!~(\[@]", requirement, maxsplit=1)[0].lower().replace("_", "-")


def wheel_path(name: str, directory: Path | None = None) -> Path | None:
    found = sorted((directory or DIST).glob(f"{PACKAGES[name][0]}-*.whl"))
    return found[-1] if found else None


def sdist_path(name: str, directory: Path | None = None) -> Path | None:
    found = sorted((directory or DIST).glob(f"{PACKAGES[name][0]}-*.tar.gz"))
    return found[-1] if found else None


def wheel_metadata(path: Path) -> Any:
    with zipfile.ZipFile(path) as archive:
        member = next(item for item in archive.namelist() if item.endswith(".dist-info/METADATA"))
        return Parser().parsestr(archive.read(member).decode("utf-8"))


def wheel_generator(path: Path) -> str:
    """The ``Generator:`` line of the ``WHEEL`` file: which build backend (and version) wrote the wheel."""
    with zipfile.ZipFile(path) as archive:
        member = next(item for item in archive.namelist() if item.endswith(".dist-info/WHEEL"))
        for line in archive.read(member).decode("utf-8").splitlines():
            if line.startswith("Generator:"):
                return line.split(":", 1)[1].strip()
    return ""


def sdist_names(path: Path) -> list[str]:
    """The regular files of the sdist."""
    with tarfile.open(path) as archive:
        return [member.name for member in archive.getmembers() if member.isfile()]


#: Files every wheel (``*.dist-info/licenses/``) and every sdist (top directory) must carry, equal to the root ones.
LICENSE_FILES = ("LICENSE", "NOTICE.md")


def license_problems(path: Path, root: Path = ROOT) -> list[str]:
    """What is wrong with the license files of a wheel or an sdist: missing, duplicated or different from ``root``'s."""
    problems: list[str] = []
    if path.suffix == ".whl":
        with zipfile.ZipFile(path) as archive:
            contents = {name: archive.read(name) for name in archive.namelist()}
        suffix = ".dist-info/licenses/"
    else:
        with tarfile.open(path) as archive:
            contents = {
                member.name: archive.extractfile(member).read()  # type: ignore[union-attr]
                for member in archive.getmembers()
                if member.isfile()
            }
        suffix = ""
    for name in LICENSE_FILES:
        found = [
            member for member in contents
            if (member.endswith(f"{suffix}{name}") if suffix else member.count("/") == 1 and member.endswith(f"/{name}"))
        ]
        if len(found) != 1:
            problems.append(f"{path.name}: {len(found)} copies of {name}, expected 1")
        elif contents[found[0]] != (root / name).read_bytes():
            problems.append(f"{path.name}: {found[0]} differs from the root {name}")
    return problems


def extract_sdist(path: Path, target: Path) -> Path:
    """Extract ``path`` below ``target`` and return the directory the sdist created."""
    with tarfile.open(path) as archive:
        # The "data" extraction filter only exists from Python 3.11.4: check by hand what it would check.
        for member in archive.getmembers():
            parts = Path(member.name).parts
            assert member.isfile() or member.isdir(), f"{member.name}: not a regular file or directory"
            assert not Path(member.name).is_absolute() and ".." not in parts, f"{member.name}: escapes the target"
        archive.extractall(target)
    (directory,) = [item for item in target.iterdir() if item.is_dir()]
    return directory


def files_below(root: Path, prefix: str = "") -> set[str]:
    return {
        f"{prefix}{item.relative_to(root).as_posix()}"
        for item in root.rglob("*")
        if item.is_file() and "__pycache__" not in item.parts and item.suffix != ".pyc"
    }


# --- building ---------------------------------------------------------------------------------------


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require_uv() -> str:
    """The path of ``uv``; a missing ``uv`` is an error, never a reason to skip."""
    uv = shutil.which("uv")
    if uv is None:
        raise BuildError(
            "uv is required to build the wheels and the clean venv and it is not on PATH "
            "(https://docs.astral.sh/uv/getting-started/installation/)"
        )
    return uv


def build_environment(epoch: str = SOURCE_DATE_EPOCH) -> dict[str, str]:
    """The environment of a build: the caller's, without anything that points at a source tree, plus the fixed epoch."""
    environment = {
        key: value for key, value in os.environ.items() if key not in {"PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"}
    }
    environment["SOURCE_DATE_EPOCH"] = epoch
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return environment


def run_uv(uv: str, arguments: list[str], *, cwd: Path, env: dict[str, str]) -> str:
    """Run ``uv`` with its cache only first and, if that fails, with the network; return the output of the one that worked."""
    attempts = []
    for offline in (True, False):
        command = [uv, *(["--offline"] if offline else []), *arguments]
        result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, check=False)
        if result.returncode == 0:
            return result.stdout + result.stderr
        attempts.append(f"$ {' '.join(command)}\nexit {result.returncode}\n{result.stdout}{result.stderr}")
    raise BuildError("uv failed, offline and online:\n" + "\n".join(attempts))


def copy_source_tree(root: Path, target: Path) -> Path:
    """Copy what a build reads (the packages without their tests, and the files of the root) to ``target``."""
    target.mkdir(parents=True, exist_ok=True)
    for name in ROOT_BUILD_FILES:
        if (root / name).is_file():
            shutil.copy2(root / name, target / name)
    shutil.copytree(
        root / "packages",
        target / "packages",
        ignore=shutil.ignore_patterns(
            "__pycache__", "*.pyc", "tests", "dist", ".venv", ".verify-venv", ".pytest_cache", ".ruff_cache", "*.egg-info"
        ),
    )
    return target


def artifacts_in(directory: Path) -> dict[str, Path]:
    """The wheels and sdists of ``directory`` by file name."""
    return {path.name: path for path in sorted([*directory.glob("*.whl"), *directory.glob("*.tar.gz")])}


def build_distributions(
    source_root: Path, out_dir: Path, *, names: tuple[str, ...] = tuple(PACKAGES), epoch: str = SOURCE_DATE_EPOCH
) -> dict[str, Path]:
    """``uv build`` of each package of ``source_root`` into ``out_dir`` (sdist first, the wheel is built from it)."""
    uv = require_uv()
    out_dir.mkdir(parents=True, exist_ok=True)
    environment = build_environment(epoch)
    for name in names:
        run_uv(uv, ["build", "--out-dir", str(out_dir)], cwd=source_root / "packages" / name, env=environment)
    return artifacts_in(out_dir)


def source_fingerprint(root: Path = ROOT) -> str:
    """A digest of everything that goes into the artifacts: the sources, readmes, notices and pyprojects."""
    digest = hashlib.sha256()
    for name in ROOT_BUILD_FILES:
        if (root / name).is_file():
            digest.update(f"{name}\0{sha256_file(root / name)}\n".encode())
    for name in sorted(PACKAGES):
        base = root / "packages" / name
        for path in sorted(item for item in base.rglob("*") if item.is_file()):
            relative = path.relative_to(base)
            if relative.parts[0] == "tests" or "__pycache__" in relative.parts or path.suffix == ".pyc":
                continue
            digest.update(f"{name}/{relative.as_posix()}\0{sha256_file(path)}\n".encode())
    return digest.hexdigest()


def ensure_dist() -> Path:
    """``dist/`` with the wheels and sdists of the current sources, built now unless they are already up to date."""
    fingerprint = source_fingerprint()
    marker = DIST / FINGERPRINT_FILE
    if marker.is_file() and marker.read_text(encoding="utf-8").strip() == fingerprint and len(artifacts_in(DIST)) == 2 * len(PACKAGES):
        return DIST
    if DIST.exists():
        shutil.rmtree(DIST)
    build_distributions(ROOT, DIST)
    marker.write_text(fingerprint + "\n", encoding="utf-8")
    return DIST


def make_venv(location: Path, wheels: list[Path]) -> Path:
    """A clean virtual environment (no system site-packages) with ``wheels`` installed; return its interpreter."""
    uv = require_uv()
    if location.exists():
        shutil.rmtree(location)
    location.parent.mkdir(parents=True, exist_ok=True)
    venv.create(location, with_pip=False, clear=True, symlinks=True)
    python = location / "bin" / "python"
    run_uv(
        uv,
        ["pip", "install", "--python", str(python), *(str(wheel) for wheel in wheels)],
        cwd=location.parent,
        env=build_environment(),
    )
    return python


def ensure_verify_venv() -> Path:
    """The interpreter of ``.verify-venv`` with the wheels of ``dist/`` installed; made now unless it is up to date."""
    wheels = sorted(ensure_dist().glob("*.whl"))
    key = hashlib.sha256("".join(sha256_file(wheel) for wheel in wheels).encode()).hexdigest()
    marker = VERIFY_VENV / VENV_MARKER
    python = VERIFY_VENV / "bin" / "python"
    if python.is_file() and marker.is_file() and marker.read_text(encoding="utf-8").strip() == key:
        return python
    make_venv(VERIFY_VENV, wheels)
    marker.write_text(key + "\n", encoding="utf-8")
    return python
