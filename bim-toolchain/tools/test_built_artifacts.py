"""The built wheels and sdists (``dist/``, made by ``uv build``) contain what they must and nothing else.

They open the archives; they need no network.  When ``dist/`` has not been built they skip: build first
(``docs/PACKAGING.md``).  When ``.verify-venv`` exists (a clean venv with the wheels installed) they also run the
smoke test with that interpreter in isolated mode, with an empty environment.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

from bim_core.toolchain import bundle_digest, compiler_bundle_digest
from packaging_support import (
    DIST,
    EXAMPLE_PACKAGE,
    PACKAGES,
    ROOT,
    VERIFY_VENV,
    extract_sdist,
    files_below,
    package_dir,
    pyproject,
    requirement_name,
    sdist_names,
    sdist_path,
    source_version,
    wheel_metadata,
    wheel_path,
)

NAMES = sorted(PACKAGES)
CORE_SRC = package_dir("bim-core") / "src" / "bim_core"

pytestmark = pytest.mark.skipif(not DIST.is_dir(), reason=f"{DIST} does not exist: run `uv build` for each package first")


def wheel_of(name: str) -> Path:
    path = wheel_path(name)
    if path is None:
        pytest.skip(f"no wheel of {name} in {DIST}")
    return path


def sdist_of(name: str) -> Path:
    path = sdist_path(name)
    if path is None:
        pytest.skip(f"no sdist of {name} in {DIST}")
    return path


def wheel_names(path: Path) -> list[str]:
    with zipfile.ZipFile(path) as archive:
        return archive.namelist()


def test_there_is_one_wheel_and_one_sdist_per_package() -> None:
    wheels = sorted(path.name for path in DIST.glob("*.whl"))
    sdists = sorted(path.name for path in DIST.glob("*.tar.gz"))
    assert wheels == [f"{PACKAGES[name][0]}-0.2.0-py3-none-any.whl" for name in NAMES]
    assert sdists == [f"{PACKAGES[name][0]}-0.2.0.tar.gz" for name in NAMES]


@pytest.mark.parametrize("name", NAMES)
def test_wheel_metadata(name: str) -> None:
    metadata = wheel_metadata(wheel_of(name))
    assert metadata["Name"] == name
    assert metadata["Version"] == source_version(name) == pyproject(name)["project"]["version"]
    assert metadata["Requires-Python"] == ">=3.11"
    requirements = [item for item in metadata.get_all("Requires-Dist", []) if "extra ==" not in item]
    assert {requirement_name(item) for item in requirements} == PACKAGES[name][1]
    for item in metadata.get_all("Requires-Dist", []):
        assert "@" not in item and "file:" not in item and "/" not in item, f"{item!r} is a path or URL"
    assert metadata["License"] is None and metadata["License-Expression"] is None
    assert not any(item.startswith("License ::") for item in metadata.get_all("Classifier", []))
    assert metadata.get_all("License-File") == ["NOTICE.md"]
    assert "Private :: Do Not Upload" in metadata.get_all("Classifier", [])


@pytest.mark.parametrize("name", ["bim-service", "bim-client"])
def test_wheel_requires_bim_core_by_range(name: str) -> None:
    metadata = wheel_metadata(wheel_of(name))
    (requirement,) = [item for item in metadata.get_all("Requires-Dist", []) if requirement_name(item) == "bim-core"]
    assert requirement.replace(" ", "") in {"bim-core<0.3,>=0.2", "bim-core>=0.2,<0.3"}


@pytest.mark.parametrize("name", NAMES)
def test_wheel_ships_the_notice_py_typed_and_no_tests(name: str) -> None:
    names = wheel_names(wheel_of(name))
    module = PACKAGES[name][0]
    assert f"{module}/py.typed" in names
    assert any(item.endswith(".dist-info/licenses/NOTICE.md") for item in names)
    assert not any("/tests/" in item or "__pycache__" in item or item.endswith(".pyc") for item in names)
    assert {item.split("/")[0] for item in names} == {module, f"{module}-0.2.0.dist-info"}


def test_the_core_wheel_has_every_source_module_and_resource() -> None:
    names = set(wheel_names(wheel_of("bim-core")))
    expected = {f"bim_core/{item}" for item in files_below(CORE_SRC)}
    assert names >= expected, sorted(expected - names)
    assert {item for item in names if item.startswith("bim_core/")} == expected
    resources = {item for item in names if item.startswith("bim_core/resources/")}
    assert len([item for item in resources if item.endswith(".schema.json")]) == 12
    assert "bim_core/resources/schemas/engine-contract.openapi.yaml" in resources
    for xsd in ("BPMN20.xsd", "BPMNDI.xsd", "DC.xsd", "DI.xsd", "Semantic.xsd"):
        assert f"bim_core/resources/vendor/omg/bpmn/2.0.2/{xsd}" in resources


@pytest.mark.parametrize("name", NAMES)
def test_every_python_module_of_a_service_or_client_wheel_is_in_the_source(name: str) -> None:
    source = package_dir(name) / "src" / PACKAGES[name][0]
    expected = {f"{PACKAGES[name][0]}/{item}" for item in files_below(source)}
    in_wheel = {item for item in wheel_names(wheel_of(name)) if item.startswith(f"{PACKAGES[name][0]}/")}
    assert in_wheel == expected


@pytest.mark.parametrize("name", NAMES)
def test_sdist_has_sources_notice_readme_and_pyproject_only(name: str) -> None:
    names = sdist_names(sdist_of(name))
    top = f"{PACKAGES[name][0]}-0.2.0"
    members = {item.removeprefix(f"{top}/") for item in names}
    module = PACKAGES[name][0]
    source = package_dir(name) / "src" / module
    expected = {f"src/{module}/{item}" for item in files_below(source)}
    # hatchling adds .gitignore and PKG-INFO to every sdist
    expected |= {".gitignore", "PKG-INFO", "README.md", "NOTICE.md", "pyproject.toml"}
    assert members == expected
    assert all(item.startswith(f"{top}/") for item in names)


def test_the_core_sdist_has_every_resource() -> None:
    members = set(sdist_names(sdist_of("bim-core")))
    top = "bim_core-0.2.0/src/bim_core"
    for item in files_below(CORE_SRC / "resources"):
        assert f"{top}/resources/{item}" in members, item
    assert f"{top}/py.typed" in members


def test_the_digest_of_the_wheel_equals_the_digest_of_the_source_tree() -> None:
    with zipfile.ZipFile(wheel_of("bim-core")) as archive:
        assert bundle_digest(zipfile.Path(archive, "bim_core/")) == compiler_bundle_digest()


def test_the_digest_of_the_unpacked_sdist_equals_the_digest_of_the_source_tree(tmp_path: Path) -> None:
    unpacked = extract_sdist(sdist_of("bim-core"), tmp_path)
    assert bundle_digest(unpacked / "src" / "bim_core") == compiler_bundle_digest()


def test_the_digest_of_a_wheel_rebuilt_from_the_sdist_equals_the_digest_of_the_source_tree(tmp_path: Path) -> None:
    uv = shutil.which("uv")
    if uv is None:
        pytest.skip("uv is not on PATH")
    unpacked = extract_sdist(sdist_of("bim-core"), tmp_path / "sdist")
    out = tmp_path / "wheel"
    result = subprocess.run(
        [uv, "build", "--wheel", "--out-dir", str(out), str(unpacked)],
        capture_output=True, text=True, check=False, cwd=tmp_path,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    (rebuilt,) = out.glob("bim_core-*.whl")
    with zipfile.ZipFile(rebuilt) as archive:
        assert bundle_digest(zipfile.Path(archive, "bim_core/")) == compiler_bundle_digest()


# --- the clean virtual environment ------------------------------------------------------------------


@pytest.fixture(scope="module")
def venv_python() -> Path:
    python = VERIFY_VENV / "bin" / "python"
    if not python.is_file():
        pytest.skip(f"{VERIFY_VENV} does not exist: create the clean venv and install the wheels first")
    return python


def isolated(python: Path, *arguments: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    """Run ``python -I`` with an empty environment."""
    return subprocess.run(
        [str(python), "-I", *arguments], env={}, cwd=cwd, capture_output=True, text=True, check=False
    )


def test_smoke_test_in_the_clean_venv_and_digest_equality(venv_python: Path, tmp_path: Path) -> None:
    result = isolated(venv_python, str(ROOT / "tools" / "smoke_installed.py"), str(EXAMPLE_PACKAGE), cwd=tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout.strip().splitlines()[-1])
    assert report["ok"] is True
    assert "site-packages" in report["installedFrom"]
    assert (report["bimCore"], report["bimService"], report["bimClient"]) == ("0.2.0", "0.2.0", "0.2.0")
    assert report["compilerDigest"] == report["serviceCompilerDigest"] == compiler_bundle_digest()
    assert report["schemas"] == 12


def test_toolchain_json_of_the_clean_venv_agrees_with_the_source_tree(venv_python: Path, tmp_path: Path) -> None:
    result = isolated(venv_python, str(ROOT / "tools" / "toolchain_json.py"), cwd=tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    installed = json.loads(result.stdout)
    import toolchain_json

    tree = toolchain_json.build()
    for key in ("schema", "packages", "apiVersion", "compilerDigest", "protocolDigest", "engineContractDigest",
                "profiles", "dialects", "schemas", "vendor"):
        assert installed[key] == tree[key], key
