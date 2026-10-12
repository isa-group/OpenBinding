"""Shared helpers of the packaging tests: where the packages, the built artifacts and the clean venv are."""

from __future__ import annotations

import re
import tarfile
import tomllib
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


def wheel_path(name: str) -> Path | None:
    found = sorted(DIST.glob(f"{PACKAGES[name][0]}-*.whl"))
    return found[-1] if found else None


def sdist_path(name: str) -> Path | None:
    found = sorted(DIST.glob(f"{PACKAGES[name][0]}-*.tar.gz"))
    return found[-1] if found else None


def wheel_metadata(path: Path) -> Any:
    with zipfile.ZipFile(path) as archive:
        member = next(item for item in archive.namelist() if item.endswith(".dist-info/METADATA"))
        return Parser().parsestr(archive.read(member).decode("utf-8"))


def sdist_names(path: Path) -> list[str]:
    """The regular files of the sdist."""
    with tarfile.open(path) as archive:
        return [member.name for member in archive.getmembers() if member.isfile()]


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
