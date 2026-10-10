"""The pure BIM core stays free of platform code and packageable on its own.

`packages/bim-core` assembles the existing sources under
`openbinding_gateway/v1` into a standalone wheel without moving them. These tests
guard that arrangement: (a) the core modules import only the standard library,
jsonschema, lxml and each other; (b) the packaging metadata is valid and lists
exactly the files of the core; (c) compilation is deterministic.
"""

from __future__ import annotations

import ast
import re
import sys
import tomllib
from pathlib import Path

import pytest

from _repo import REPO_ROOT
from openbinding_gateway import v1 as core_package
from openbinding_gateway.v1.canonical import digest, digest_bytes
from openbinding_gateway.v1.compiler import compile_instance, compiler_bundle_digest
from openbinding_gateway.v1.package import load_package

CORE_DIR = Path(core_package.__file__).resolve().parent
PACKAGING_DIR = REPO_ROOT / "packages" / "bim-core"
DEMO = REPO_ROOT / "examples/demo/01_simple_seq"

CORE_MODULES = ("__init__", "canonical", "package", "expressions", "compiler")
EXCLUDED_MODULES = ("archive", "archive_geometry", "analysis", "remote")
SIBLINGS = frozenset(CORE_MODULES) - {"__init__"}
THIRD_PARTY = frozenset({"jsonschema", "lxml"})
ALLOWED_ABSOLUTE = frozenset(sys.stdlib_module_names) | THIRD_PARTY
# The only place the core names its current host package: importlib.resources in
# package.py. A standalone release must replace it (docs/BIM_CORE.md).
KNOWN_HOST_REFERENCES = {("package.py", "openbinding_gateway.v1")}
BUNDLE_MEMBERS = ("canonical.py", "compiler.py", "expressions.py", "package.py")


def import_violations(source: str) -> list[str]:
    """Return every import that is not stdlib, jsonschema, lxml or a sibling module."""
    problems: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] not in ALLOWED_ABSOLUTE:
                    problems.append(f"line {node.lineno}: import {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            target = "." * node.level + (node.module or "")
            if node.level == 0:
                if (node.module or "").split(".")[0] not in ALLOWED_ABSOLUTE:
                    problems.append(f"line {node.lineno}: from {target} import ...")
            elif node.level == 1 and node.module:
                if node.module.split(".")[0] not in SIBLINGS:
                    problems.append(f"line {node.lineno}: from {target} import ...")
            elif node.level == 1:
                problems.extend(
                    f"line {node.lineno}: from . import {alias.name}"
                    for alias in node.names
                    if alias.name not in SIBLINGS
                )
            else:
                problems.append(f"line {node.lineno}: from {target} import ...")
        elif isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
            if name in {"__import__", "import_module"}:
                problems.append(f"line {node.lineno}: dynamic import via {name}()")
    return problems


def host_references(source: str) -> set[str]:
    return {
        node.value
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and "openbinding_gateway" in node.value
    }


# --- (a) imports ---------------------------------------------------------------


@pytest.mark.parametrize("module", CORE_MODULES)
def test_core_module_imports_only_stdlib_jsonschema_lxml_and_siblings(module: str) -> None:
    source = (CORE_DIR / f"{module}.py").read_text(encoding="utf-8")
    assert import_violations(source) == [], f"{module}.py imports platform code"


@pytest.mark.parametrize("module", CORE_MODULES)
def test_core_module_names_its_host_package_only_where_documented(module: str) -> None:
    source = (CORE_DIR / f"{module}.py").read_text(encoding="utf-8")
    unexpected = {
        value for value in host_references(source) if (f"{module}.py", value) not in KNOWN_HOST_REFERENCES
    }
    assert unexpected == set()


@pytest.mark.parametrize(
    "source",
    [
        "import sqlalchemy",
        "import fastapi.routing",
        "import httpx",
        "import pydantic",
        "import redis",
        "import dramatiq",
        "from pydantic import BaseModel",
        "from ..models import Job",
        "from ..db import session",
        "from ..routes import v1",
        "from . import archive",
        "from .archive import read_archive",
        "from .remote import RemoteEngine",
        "from openbinding_gateway.settings import settings",
        "def f():\n    import sqlalchemy\n",
        "def f():\n    from ..db import session\n",
        "class C:\n    def m(self):\n        from .analysis import run\n",
        "import importlib\nimportlib.import_module('httpx')",
        "__import__('redis')",
    ],
)
def test_import_detector_flags_platform_imports(source: str) -> None:
    assert import_violations(source)


@pytest.mark.parametrize(
    "source",
    [
        "import json, hashlib\nfrom decimal import Decimal",
        "from __future__ import annotations",
        "import jsonschema\nfrom lxml import etree",
        "from .canonical import digest",
        "from . import compiler, package",
        "def f():\n    from base64 import b32encode\n",
    ],
)
def test_import_detector_accepts_core_imports(source: str) -> None:
    assert import_violations(source) == []


def test_core_package_init_imports_only_compiler_and_package() -> None:
    tree = ast.parse((CORE_DIR / "__init__.py").read_text(encoding="utf-8"))
    imported = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
    assert imported == {"compiler", "package"}


# --- (b) packaging ----------------------------------------------------------------


def require_packaging_dir() -> None:
    if not PACKAGING_DIR.is_dir():
        pytest.skip("packages/bim-core is not mounted in this environment")


def packaging() -> dict:
    require_packaging_dir()
    return tomllib.loads((PACKAGING_DIR / "pyproject.toml").read_text(encoding="utf-8"))


def wheel_target() -> dict:
    return packaging()["tool"]["hatch"]["build"]["targets"]["wheel"]


def listed_sources(section: str) -> dict[Path, str]:
    return {(PACKAGING_DIR / source).resolve(): dest for source, dest in wheel_target()[section].items()}


def test_bim_core_pyproject_declares_only_the_two_runtime_dependencies() -> None:
    data = packaging()
    project = data["project"]
    assert project["name"] == "bim-core"
    assert project["version"] == "0.1.0"
    assert project["requires-python"] == ">=3.11"
    assert data["build-system"]["build-backend"] == "hatchling.build"
    assert project["license"] == {"text": "TBD - pending owner decision (repository currently CC BY 4.0)"}
    names = {re.split(r"[\s<>=!~;\[]", requirement, maxsplit=1)[0].lower() for requirement in project["dependencies"]}
    assert names == {"jsonschema", "lxml"}
    assert "optional-dependencies" not in project
    assert (PACKAGING_DIR / project["readme"]).is_file()


def test_bim_core_wheel_lists_exactly_the_core_modules() -> None:
    sources = listed_sources("force-include")
    for source in sources:
        assert source.is_file(), f"listed file does not exist: {source}"

    python = {source.relative_to(CORE_DIR).as_posix(): dest for source, dest in sources.items() if source.suffix == ".py"}
    assert python == {f"{name}.py": f"bim_core/{name}.py" for name in CORE_MODULES}
    for name in EXCLUDED_MODULES:
        assert not any(source.name == f"{name}.py" for source in sources)

    vendor_dir = CORE_DIR / "vendor"
    vendored = {
        source.relative_to(CORE_DIR).as_posix(): dest for source, dest in sources.items() if source.suffix != ".py"
    }
    assert vendored == {
        path.relative_to(CORE_DIR).as_posix(): "bim_core/" + path.relative_to(CORE_DIR).as_posix()
        for path in vendor_dir.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts
    }


def test_bim_core_wheel_ships_every_schema_manifest_and_the_engine_contract() -> None:
    sources = listed_sources("shared-data")
    for source in sources:
        assert source.is_file(), f"listed file does not exist: {source}"

    schemas = REPO_ROOT / "schemas"
    expected = {
        *(schemas / "bim/v1").glob("*.schema.json"),
        *(schemas / "bim/v1/manifests").glob("*.json"),
        schemas / "engine-contract.openapi.yaml",
    }
    assert set(sources) == {path.resolve() for path in expected}
    for source, dest in sources.items():
        assert dest == source.relative_to(schemas.resolve().parent).as_posix()


def test_packaging_skip_is_not_triggered_when_the_directory_exists() -> None:
    if not (REPO_ROOT / "packages" / "bim-core").is_dir():
        pytest.skip("packages/bim-core is not mounted in this environment")
    require_packaging_dir()  # would raise Skipped if the guard misfired
    assert packaging()["project"]["name"] == "bim-core"


def test_bim_core_documentation_exists() -> None:
    require_packaging_dir()
    assert (PACKAGING_DIR / "README.md").is_file()
    assert (REPO_ROOT / "docs" / "BIM_CORE.md").is_file()
    assert "BIM_CORE.md" in (REPO_ROOT / "docs" / "VERSIONED_ARTIFACTS.md").read_text(encoding="utf-8")


# --- (c) determinism ------------------------------------------------------------------


def test_compiling_the_demo_twice_gives_the_same_digest() -> None:
    first = compile_instance(load_package(DEMO))
    second = compile_instance(load_package(DEMO))
    assert first.digest == second.digest
    assert re.fullmatch(r"sha256-[0-9a-f]{64}", first.digest)
    assert first.document == second.document


def test_compiler_bundle_digest_is_stable_and_covers_the_four_core_modules() -> None:
    first = compiler_bundle_digest()
    assert first == compiler_bundle_digest()
    assert re.fullmatch(r"sha256-[0-9a-f]{64}", first)
    members = {name: digest_bytes((CORE_DIR / name).read_bytes()) for name in BUNDLE_MEMBERS}
    assert first == digest(members)
