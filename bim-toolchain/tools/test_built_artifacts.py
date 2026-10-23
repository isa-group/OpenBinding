"""The built wheels and sdists (``dist/``, made by ``uv build``) contain what they must and nothing else.

They open the archives and the clean venv.  Nothing here skips for lack of a build: the module builds ``dist/`` on demand
(and rebuilds it when the sources changed), creates ``.verify-venv`` from those wheels and runs the smoke test with that
interpreter in isolated mode, with an empty environment.  A missing ``uv`` is an error (``packaging_support.require_uv``).
"""

from __future__ import annotations

import json
import subprocess
import zipfile
from pathlib import Path

import pytest

import packaging_support as ps
from bim_core.toolchain import bundle_digest, compiler_bundle_digest
from packaging_support import (
    DIST,
    EXAMPLE_PACKAGE,
    PACKAGES,
    ROOT,
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


@pytest.fixture(scope="module", autouse=True)
def built() -> Path:
    """``dist/`` for the current sources, built now if it is not there or is stale."""
    return ps.ensure_dist()


def wheel_of(name: str) -> Path:
    path = wheel_path(name)
    assert path is not None, f"no wheel of {name} in {DIST}"
    return path


def sdist_of(name: str) -> Path:
    path = sdist_path(name)
    assert path is not None, f"no sdist of {name} in {DIST}"
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
    assert not any(item.startswith("License ::") for item in metadata.get_all("Classifier", []))
    assert sorted(metadata.get_all("License-File")) == ["LICENSE", "NOTICE.md"]
    assert "Private :: Do Not Upload" in metadata.get_all("Classifier", [])


@pytest.mark.parametrize("name", NAMES)
def test_wheel_declares_the_spdx_license_expression_of_the_holder(name: str) -> None:
    """``License-Expression`` (PEP 639) is the one declaration; the free-text ``License`` field is not used."""
    metadata = wheel_metadata(wheel_of(name))
    assert metadata["License-Expression"] == "CC-BY-4.0"
    assert metadata["License"] is None


@pytest.mark.parametrize("name", NAMES)
def test_sdist_declares_the_same_license(name: str, tmp_path: Path) -> None:
    unpacked = extract_sdist(sdist_of(name), tmp_path)
    text = (unpacked / "PKG-INFO").read_text(encoding="utf-8")
    assert "License-Expression: CC-BY-4.0" in text
    assert "License-File: LICENSE" in text and "License-File: NOTICE.md" in text
    assert "Private :: Do Not Upload" in text
    assert (unpacked / "LICENSE").read_bytes() == (ROOT / "LICENSE").read_bytes()
    assert (unpacked / "NOTICE.md").read_bytes() == (ROOT / "NOTICE.md").read_bytes()


@pytest.mark.parametrize("name", ["bim-service", "bim-client"])
def test_wheel_requires_bim_core_by_range(name: str) -> None:
    metadata = wheel_metadata(wheel_of(name))
    (requirement,) = [item for item in metadata.get_all("Requires-Dist", []) if requirement_name(item) == "bim-core"]
    assert requirement.replace(" ", "") in {"bim-core<0.3,>=0.2", "bim-core>=0.2,<0.3"}


@pytest.mark.parametrize("name", NAMES)
def test_wheel_ships_the_license_the_notice_py_typed_and_no_tests(name: str) -> None:
    names = wheel_names(wheel_of(name))
    module = PACKAGES[name][0]
    assert f"{module}/py.typed" in names
    assert any(item.endswith(".dist-info/licenses/NOTICE.md") for item in names)
    assert any(item.endswith(".dist-info/licenses/LICENSE") for item in names)
    with zipfile.ZipFile(wheel_of(name)) as archive:
        for member, source in (("LICENSE", ROOT / "LICENSE"), ("NOTICE.md", ROOT / "NOTICE.md")):
            (found,) = [item for item in archive.namelist() if item.endswith(f".dist-info/licenses/{member}")]
            assert archive.read(found) == source.read_bytes(), f"{found} differs from the root {member}"
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
def test_sdist_has_sources_license_notice_readme_and_pyproject_only(name: str) -> None:
    names = sdist_names(sdist_of(name))
    top = f"{PACKAGES[name][0]}-0.2.0"
    members = {item.removeprefix(f"{top}/") for item in names}
    module = PACKAGES[name][0]
    source = package_dir(name) / "src" / module
    expected = {f"src/{module}/{item}" for item in files_below(source)}
    # hatchling adds .gitignore and PKG-INFO to every sdist
    expected |= {".gitignore", "PKG-INFO", "README.md", "LICENSE", "NOTICE.md", "pyproject.toml"}
    if name == "bim-core":
        expected.add("hatch_build.py")  # the build hook that downloads and verifies the OMG XSDs when the wheel is built from it
    assert members == expected
    assert all(item.startswith(f"{top}/") for item in names)


def test_the_core_sdist_has_every_resource() -> None:
    members = set(sdist_names(sdist_of("bim-core")))
    top = "bim_core-0.2.0/src/bim_core"
    for item in files_below(CORE_SRC / "resources"):
        assert f"{top}/resources/{item}" in members, item
    assert f"{top}/py.typed" in members


def test_the_wheel_and_the_sdist_of_bim_core_carry_the_five_omg_xsds_with_the_declared_bytes() -> None:
    """Git does not version the files and the build downloads them; the artifacts must carry them all the same, byte for byte."""
    assert ps.xsd_problems(wheel_of("bim-core")) == []
    assert ps.xsd_problems(sdist_of("bim-core")) == []
    for name in ("bim-service", "bim-client"):
        assert not any(item.endswith(".xsd") for item in wheel_names(wheel_of(name)))


def test_the_sdist_of_bim_core_carries_the_build_hook_and_the_wheel_does_not() -> None:
    members = set(sdist_names(sdist_of("bim-core")))
    assert "bim_core-0.2.0/hatch_build.py" in members
    assert not any(item.endswith("hatch_build.py") for item in wheel_names(wheel_of("bim-core")))


def test_a_wheel_rebuilt_from_the_sdist_carries_the_xsds_too(tmp_path: Path) -> None:
    uv = ps.require_uv()
    unpacked = extract_sdist(sdist_of("bim-core"), tmp_path / "sdist")
    out = tmp_path / "wheel"
    result = subprocess.run(
        [uv, "build", "--wheel", "--out-dir", str(out), str(unpacked)],
        capture_output=True, text=True, check=False, cwd=tmp_path, env=ps.build_environment(),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    (rebuilt,) = out.glob("bim_core-*.whl")
    assert ps.xsd_problems(rebuilt) == []


def test_the_digest_of_the_wheel_equals_the_digest_of_the_source_tree() -> None:
    with zipfile.ZipFile(wheel_of("bim-core")) as archive:
        assert bundle_digest(zipfile.Path(archive, "bim_core/")) == compiler_bundle_digest()


def test_the_digest_of_the_unpacked_sdist_equals_the_digest_of_the_source_tree(tmp_path: Path) -> None:
    unpacked = extract_sdist(sdist_of("bim-core"), tmp_path)
    assert bundle_digest(unpacked / "src" / "bim_core") == compiler_bundle_digest()


def test_the_digest_of_a_wheel_rebuilt_from_the_sdist_equals_the_digest_of_the_source_tree(tmp_path: Path) -> None:
    uv = ps.require_uv()
    unpacked = extract_sdist(sdist_of("bim-core"), tmp_path / "sdist")
    out = tmp_path / "wheel"
    result = subprocess.run(
        [uv, "build", "--wheel", "--out-dir", str(out), str(unpacked)],
        capture_output=True, text=True, check=False, cwd=tmp_path, env=ps.build_environment(),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    (rebuilt,) = out.glob("bim_core-*.whl")
    with zipfile.ZipFile(rebuilt) as archive:
        assert bundle_digest(zipfile.Path(archive, "bim_core/")) == compiler_bundle_digest()


def test_dist_was_built_from_the_current_sources() -> None:
    assert (DIST / ps.FINGERPRINT_FILE).read_text(encoding="utf-8").strip() == ps.source_fingerprint()
    assert len(ps.artifacts_in(DIST)) == 2 * len(PACKAGES)


# --- the clean virtual environment ------------------------------------------------------------------


@pytest.fixture(scope="module")
def venv_python() -> Path:
    """The interpreter of ``.verify-venv`` with the wheels of ``dist/`` installed, made now if it is not there or is stale."""
    return ps.ensure_verify_venv()


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


def test_the_installed_distributions_carry_the_license_metadata(venv_python: Path, tmp_path: Path) -> None:
    code = (
        "from importlib import metadata\n"
        "for name in ('bim-core', 'bim-service', 'bim-client'):\n"
        "    item = metadata.metadata(name)\n"
        "    print(name, item['License-Expression'], sorted(item.get_all('License-File')))\n"
    )
    result = isolated(venv_python, "-c", code, cwd=tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.splitlines() == [f"{name} CC-BY-4.0 ['LICENSE', 'NOTICE.md']" for name in ("bim-core", "bim-service", "bim-client")]


def test_toolchain_json_of_the_clean_venv_agrees_with_the_source_tree(venv_python: Path, tmp_path: Path) -> None:
    result = isolated(venv_python, str(ROOT / "tools" / "toolchain_json.py"), cwd=tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr
    installed = json.loads(result.stdout)
    import toolchain_json

    tree = toolchain_json.build()
    for key in ("schema", "packages", "apiVersion", "compilerDigest", "protocolDigest", "engineContractDigest",
                "profiles", "dialects", "schemas", "vendor"):
        assert installed[key] == tree[key], key
