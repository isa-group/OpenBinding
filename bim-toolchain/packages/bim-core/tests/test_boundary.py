"""The core is pure: stdlib, jsonschema, lxml and itself; no environment, no repository layout."""

import ast
import os
import subprocess
import sys
import tomllib
from importlib.resources import files
from pathlib import Path

import pytest

import bim_core
from bim_core.toolchain import compiler_bundle_digest

from conftest import TOOLCHAIN_ROOT, corpus_root

SRC = Path(bim_core.__file__).resolve().parent
MODULES = sorted(path for path in SRC.glob("*.py"))
SIBLINGS = frozenset(path.stem for path in MODULES) - {"__init__"}
ALLOWED_ABSOLUTE = frozenset(sys.stdlib_module_names) | {"jsonschema", "lxml"}
PACKAGE = TOOLCHAIN_ROOT / "packages" / "bim-core"


def import_violations(source: str) -> list[str]:
    problems: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            problems.extend(
                f"line {node.lineno}: import {alias.name}"
                for alias in node.names
                if alias.name.split(".")[0] not in ALLOWED_ABSOLUTE
            )
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0:
                if (node.module or "").split(".")[0] not in ALLOWED_ABSOLUTE:
                    problems.append(f"line {node.lineno}: from {node.module} import ...")
            elif node.level == 1 and node.module:
                if node.module.split(".")[0] not in SIBLINGS:
                    problems.append(f"line {node.lineno}: from .{node.module} import ...")
            elif node.level == 1:
                problems.extend(
                    f"line {node.lineno}: from . import {alias.name}"
                    for alias in node.names
                    if alias.name not in SIBLINGS
                )
            else:
                problems.append(f"line {node.lineno}: relative import beyond the package")
        elif isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
            if name in {"__import__", "import_module"}:
                problems.append(f"line {node.lineno}: dynamic import via {name}()")
    return problems


def environment_and_layout_uses(source: str) -> list[str]:
    found: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Attribute) and node.attr in {"environ", "getenv", "parents"}:
            found.append(f"line {node.lineno}: .{node.attr}")
        elif isinstance(node, ast.Name) and node.id in {"__file__", "getenv"}:
            found.append(f"line {node.lineno}: {node.id}")
        elif isinstance(node, ast.ImportFrom) and node.module == "os":
            found.extend(
                f"line {node.lineno}: from os import {alias.name}"
                for alias in node.names
                if alias.name in {"environ", "getenv", "getenvb"}
            )
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            lowered = node.value.lower()
            if "openbinding" in lowered or "schemas_dir" in lowered:
                found.append(f"line {node.lineno}: string {node.value[:40]!r}")
    return found


def test_the_module_list_is_the_expected_one() -> None:
    assert {path.stem for path in MODULES} == {
        "__init__", "_version", "assets", "canonical", "compiler", "errors", "expressions",
        "package", "settings", "toolchain",
    }


@pytest.mark.parametrize("path", MODULES, ids=lambda path: path.name)
def test_module_imports_only_stdlib_jsonschema_lxml_and_siblings(path: Path) -> None:
    assert import_violations(path.read_text(encoding="utf-8")) == []


@pytest.mark.parametrize("path", MODULES, ids=lambda path: path.name)
def test_module_does_not_read_the_environment_or_locate_itself_in_a_repository(path: Path) -> None:
    assert environment_and_layout_uses(path.read_text(encoding="utf-8")) == []


@pytest.mark.parametrize(
    "source",
    [
        "import os\nos.environ['X']",
        "import os\nos.getenv('X')",
        "from os import environ",
        "from pathlib import Path\nPath(__file__).parents[2]",
        "x = 'SCHEMAS_DIR'",
        "x = 'openbinding_gateway.v1'",
    ],
)
def test_the_layout_detector_flags_what_it_should(source: str) -> None:
    assert environment_and_layout_uses(source)


@pytest.mark.parametrize(
    "source",
    ["import sqlalchemy", "import httpx", "from pydantic import BaseModel", "from ..db import session",
     "from .archive import read", "from openbinding_gateway.v1 import compiler",
     "import importlib\nimportlib.import_module('httpx')", "__import__('redis')"],
)
def test_the_import_detector_flags_platform_imports(source: str) -> None:
    assert import_violations(source)


def test_init_exposes_the_documented_public_names() -> None:
    assert "toolchain_identity" in bim_core.__all__
    assert bim_core.__version__ == "0.1.0"


def test_importing_the_core_ignores_the_environment_and_the_working_directory(tmp_path) -> None:
    code = (
        "import sys, bim_core\n"
        "print(bim_core.default_limits() == bim_core.Limits())\n"
        "print('openbinding_gateway' in sys.modules)\n"
        "print(bim_core.compiler_bundle_digest())\n"
    )
    env = {
        **os.environ,
        "PYTHONPATH": str(SRC.parent),
        "BIM_MAX_ENTRIES": "1",
        "BIM_MAX_COMPRESSED_BYTES": "not-a-number",
        "SCHEMAS_DIR": str(tmp_path / "does-not-exist"),
    }
    result = subprocess.run(
        [sys.executable, "-c", code], env=env, cwd=tmp_path, capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.split() == ["True", "False", compiler_bundle_digest()]


def test_resources_are_package_data_reachable_through_importlib_resources() -> None:
    root = files("bim_core").joinpath("resources")
    assert root.joinpath("schemas", "engine-contract.openapi.yaml").is_file()
    assert root.joinpath("vendor", "omg", "bpmn", "2.0.2", "BPMN20.xsd").is_file()
    assert root.joinpath("vendor", "omg", "bpmn", "2.0.2", "README.md").is_file()
    assert not (root.joinpath("schemas", "bim", "v1", "manifests")).is_dir()


def test_pyproject_declares_a_plain_package_without_an_invented_license() -> None:
    data = tomllib.loads((PACKAGE / "pyproject.toml").read_text(encoding="utf-8"))
    project = data["project"]
    assert project["name"] == "bim-core"
    assert project["version"] == bim_core.__version__
    assert project["requires-python"] == ">=3.11"
    assert data["build-system"]["build-backend"] == "hatchling.build"
    assert {item.split(">")[0].split("<")[0].split("=")[0].strip() for item in project["dependencies"]} == {
        "jsonschema", "lxml",
    }
    assert "license" not in project and "license-files" not in project
    assert not any(item.startswith("License ::") for item in project.get("classifiers", []))
    assert (PACKAGE / project["readme"]).is_file()
    assert (PACKAGE / "src" / "bim_core" / "py.typed").is_file()
    assert data["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"] == ["src/bim_core"]


def test_notice_states_the_pending_license_and_keeps_the_copied_files() -> None:
    notice = (TOOLCHAIN_ROOT / "NOTICE.md").read_text(encoding="utf-8")
    assert "pending" in notice and "BPMN 2.0.2" in notice and "No dataset is redistributed" in notice
    assert (TOOLCHAIN_ROOT / "LICENSE").is_file()
    assert (TOOLCHAIN_ROOT / "THIRD_PARTY_NOTICES.md").is_file()


@pytest.mark.parametrize(
    ("original", "copy"),
    [
        ("LICENSE", "LICENSE"),
        ("THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"),
        ("schemas/engine-contract.openapi.yaml", "packages/bim-core/src/bim_core/resources/schemas/engine-contract.openapi.yaml"),
    ],
)
def test_copied_files_are_byte_identical_to_openbinding(original: str, copy: str) -> None:
    source = corpus_root() / original
    if not source.is_file():
        pytest.skip(f"{source} is not available (set BIM_CORPUS_ROOT)")
    assert source.read_bytes() == (TOOLCHAIN_ROOT / copy).read_bytes()


def test_copied_schemas_and_vendor_are_byte_identical_to_openbinding() -> None:
    schemas = corpus_root() / "schemas" / "bim" / "v1"
    vendor = corpus_root() / "openbinding-gateway" / "src" / "openbinding_gateway" / "v1" / "vendor" / "omg" / "bpmn" / "2.0.2"
    if not schemas.is_dir() or not vendor.is_dir():
        pytest.skip("OpenBinding originals are not available (set BIM_CORPUS_ROOT)")
    resources = SRC / "resources"
    originals = sorted(schemas.glob("*.json"))
    assert originals
    for path in originals:
        assert path.read_bytes() == (resources / "schemas" / "bim" / "v1" / path.name).read_bytes(), path.name
    vendored = sorted(path for path in vendor.iterdir() if path.is_file())
    assert vendored
    for path in vendored:
        assert path.read_bytes() == (resources / "vendor" / "omg" / "bpmn" / "2.0.2" / path.name).read_bytes(), path.name
