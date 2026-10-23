"""The package metadata is coherent with the sources, the notice and the workspace. Reads files only; no build."""

from __future__ import annotations

import json
import tomllib

import pytest

from packaging_support import EXAMPLE_PACKAGE, PACKAGES, ROOT, ensure_xsd, package_dir, pyproject, requirement_name, source_version

NAMES = sorted(PACKAGES)


@pytest.mark.parametrize("name", NAMES)
def test_name_version_and_python_requirement(name: str) -> None:
    project = pyproject(name)["project"]
    assert project["name"] == name
    assert project["version"] == source_version(name) == "0.2.0"
    assert project["requires-python"] == ">=3.11"
    assert (package_dir(name) / project["readme"]).is_file()


def test_the_three_distributions_have_one_version() -> None:
    assert {source_version(name) for name in NAMES} == {"0.2.0"}


@pytest.mark.parametrize("name", NAMES)
def test_runtime_dependencies_are_the_documented_ones_with_ranges(name: str) -> None:
    dependencies = pyproject(name)["project"]["dependencies"]
    assert {requirement_name(item) for item in dependencies} == PACKAGES[name][1]
    for item in dependencies:
        assert ">=" in item and "<" in item, f"{item!r} has no upper bound"
        assert "@" not in item and "file:" not in item and "/" not in item, f"{item!r} is a path or URL"


@pytest.mark.parametrize("name", ["bim-service", "bim-client"])
def test_dependents_declare_bim_core_as_a_plain_range(name: str) -> None:
    dependencies = pyproject(name)["project"]["dependencies"]
    assert "bim-core>=0.2,<0.3" in dependencies


@pytest.mark.parametrize("name", NAMES)
def test_the_license_is_the_spdx_expression_of_licenses_json_and_the_notice_ships(name: str) -> None:
    """``license`` is an SPDX expression (PEP 639), so there is no ``License ::`` classifier (a build backend rejects both);
    ``license-files`` ships the license text and the notice, whose copies in every package are kept equal to the root ones."""
    project = pyproject(name)["project"]
    declared = json.loads((ROOT / "licenses.json").read_text(encoding="utf-8"))["own_material"]["spdx"]
    assert project["license"] == declared == "CC-BY-4.0"
    assert not any(item.startswith("License ::") for item in project["classifiers"])
    assert project["license-files"] == ["LICENSE", "NOTICE.md"]
    assert (package_dir(name) / "NOTICE.md").read_bytes() == (ROOT / "NOTICE.md").read_bytes()
    assert (package_dir(name) / "LICENSE").read_bytes() == (ROOT / "LICENSE").read_bytes()


@pytest.mark.parametrize("name", NAMES)
def test_classifiers_are_neutral_and_keep_the_distribution_off_pypi(name: str) -> None:
    classifiers = pyproject(name)["project"]["classifiers"]
    assert "Private :: Do Not Upload" in classifiers
    assert "Typing :: Typed" in classifiers
    assert "Programming Language :: Python :: 3.11" in classifiers
    assert not any(item.startswith(("License ::", "Development Status ::")) for item in classifiers)


@pytest.mark.parametrize("name", NAMES)
def test_py_typed_is_present(name: str) -> None:
    assert (package_dir(name) / "src" / PACKAGES[name][0] / "py.typed").is_file()


@pytest.mark.parametrize("name", NAMES)
def test_build_configuration(name: str) -> None:
    data = pyproject(name)
    assert data["build-system"]["build-backend"] == "hatchling.build"
    assert data["build-system"]["requires"] == ["hatchling>=1.27"]
    targets = data["tool"]["hatch"]["build"]["targets"]
    assert targets["wheel"]["packages"] == [f"src/{PACKAGES[name][0]}"]
    # bim-core also ships its build hook, the verified download of the OMG XSDs, which its sdist rebuilds the wheel with
    hook = {"/hatch_build.py"} if name == "bim-core" else set()
    assert set(targets["sdist"]["include"]) == {"/src", "/README.md", "/LICENSE", "/NOTICE.md", "/pyproject.toml"} | hook


def test_bim_core_downloads_verifies_and_ships_the_omg_xsds_through_its_build_hook() -> None:
    """Git ignores the five files; the hook puts them in place before every build and ``artifacts`` makes the wheel and the
    sdist carry them anyway.  Nothing excludes them from an artifact."""
    build = pyproject("bim-core")["tool"]["hatch"]["build"]
    assert build["hooks"]["custom"] == {"path": "hatch_build.py"}
    assert build["artifacts"] == ["src/bim_core/resources/vendor/omg/bpmn/2.0.2/*.xsd"]
    for table in (build, build["targets"]["wheel"], build["targets"]["sdist"]):
        assert not any("xsd" in str(item) for key in ("exclude", "force-exclude") for item in table.get(key, []))
    core = package_dir("bim-core")
    assert (core / "hatch_build.py").is_file()
    assert not list((core / "src" / "bim_core").rglob("hatch_build.py")), "the hook lives outside src/bim_core: compilerDigest"
    for name in ("bim-service", "bim-client"):
        assert "hooks" not in pyproject(name)["tool"]["hatch"]["build"] and "artifacts" not in pyproject(name)["tool"]["hatch"]["build"]


def test_the_build_hook_uses_only_the_standard_library_and_hatchling() -> None:
    import ast

    tree = ast.parse((package_dir("bim-core") / "hatch_build.py").read_text(encoding="utf-8"))
    modules = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module.split(".")[0])
    import sys

    assert modules <= set(sys.stdlib_module_names) | {"hatchling"}, modules - set(sys.stdlib_module_names)


def test_the_workspace_ties_the_members_together() -> None:
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert "project" not in data, "the root builds nothing"
    members = data["tool"]["uv"]["workspace"]["members"]
    assert sorted(members) == [f"packages/{name}" for name in NAMES]
    assert data["tool"]["uv"]["sources"]["bim-core"] == {"workspace": True}
    for name in ("bim-service", "bim-client"):
        assert pyproject(name)["tool"]["uv"]["sources"]["bim-core"] == {"workspace": True}


def test_the_root_ignores_build_output_and_environments() -> None:
    lines = {line.strip() for line in (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()}
    assert {"dist/", ".venv/", "__pycache__/", ".verify-venv/"} <= lines


def test_no_dist_info_or_cache_is_tracked_inside_the_sources() -> None:
    for name in NAMES:
        source = package_dir(name) / "src"
        assert not list(source.rglob("*.egg-info")), name
        assert not list(source.rglob("*.dist-info")), name


def test_the_example_package_is_the_demo_package_and_compiles() -> None:
    ensure_xsd()  # compiling validates BPMN against the OMG XSDs, which Git does not version
    import bim_core
    import consumer_fixtures

    files ={path.name: path.read_bytes() for path in sorted(EXAMPLE_PACKAGE.glob("*.json")) if path.name != "binding.json"}
    assert {name: json.loads(data) for name, data in files.items()} == {
        name: json.loads(data) for name, data in consumer_fixtures.demo_files().items()
    }
    binding = json.loads((EXAMPLE_PACKAGE / "binding.json").read_text(encoding="utf-8"))
    assert binding == consumer_fixtures.BINDING
    problem = bim_core.compile_instance(bim_core.InstancePackage(files))
    assert {"features", "violations", "objectives"} <= set(bim_core.evaluate(problem, binding))


def test_the_changelog_names_the_current_version() -> None:
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    assert f"## [{source_version('bim-core')}]" in changelog
