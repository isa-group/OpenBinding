"""Module skeleton: the empty ``app``, ``shared`` and ``modules`` packages and their import contracts.

import-linter lives in the ``lint`` dependency group only, so the static tests read the configuration files;
the teeth test runs ``lint-imports`` on a copy of the source with one planted violation per contract.

[utest->req~gateway-architecture-skeleton~1]
[utest->req~gateway-architecture-module-contracts~1]
"""

from __future__ import annotations

import ast
import configparser
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from _paths import GATEWAY_ROOT

PACKAGE = "openbinding_gateway"
SOURCE = GATEWAY_ROOT / "src" / PACKAGE
NEW_PACKAGES = ("app", "shared", "modules")
MODULES_INI = GATEWAY_ROOT / "importlinter-modules.ini"
LEGACY_INI = GATEWAY_ROOT / ".importlinter"

#: Module order of docs/ARCHITECTURE.md §4.2, top to bottom; each layer is optional.
MODULE_ORDER = [
    "(administration)",
    "(publishing)",
    "(laboratory)",
    "(execution)",
    "(engines) | (repository)",
    "(language)",
    "(collaboration)",
    "(identity)",
    "(plans)",
]
CONTRACTS = {"kernel", "composition-root", "no-legacy-http", "module-layers", "module-inside", "pure-domain"}


def _read(path: Path) -> configparser.ConfigParser:
    parser = configparser.ConfigParser(interpolation=None)
    parser.read_string(path.read_text(encoding="utf-8"))
    return parser


def _lines(value: str) -> list[str]:
    return [line.strip() for line in value.splitlines() if line.strip()]


def _contract(parser: configparser.ConfigParser, name: str) -> configparser.SectionProxy:
    return parser[f"importlinter:contract:{name}"]


def _is_new(name: str) -> bool:
    return any(name == f"{PACKAGE}.{p}" or name.startswith(f"{PACKAGE}.{p}.") for p in NEW_PACKAGES)


def _imported_modules(path: Path) -> list[str]:
    """Every module a file imports, absolute and relative, at any nesting level."""
    parts = list(path.relative_to(SOURCE.parent).with_suffix("").parts)
    package = parts[:-1]
    found: list[str] = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            found.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                if node.level - 1 >= len(package):
                    continue
                base = package[: len(package) - (node.level - 1)]
                if node.module:
                    base = [*base, *node.module.split(".")]
                module = ".".join(base)
            else:
                module = node.module or ""
            found.append(module)
            found.extend(f"{module}.{alias.name}" for alias in node.names)
    return found


def test_new_packages_exist_with_docstring_only_init() -> None:
    for name in NEW_PACKAGES:
        init = SOURCE / name / "__init__.py"
        assert init.is_file(), f"{init} is missing"
        body = ast.parse(init.read_text(encoding="utf-8")).body
        assert len(body) == 1, f"{init} must hold only a docstring"
        node = body[0]
        assert isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
        assert isinstance(node.value.value, str)
        assert "docs/ARCHITECTURE.md" in node.value.value
        assert "§4.2" in node.value.value


def test_composition_root_keeps_its_entry_point() -> None:
    import importlib

    from fastapi import FastAPI

    assert (SOURCE / "app" / "__init__.py").is_file(), "package app is missing"
    main = importlib.import_module(f"{PACKAGE}.main")
    new_app = importlib.import_module(f"{PACKAGE}.app")
    assert isinstance(main.app, FastAPI)
    assert new_app is not main.app
    assert Path(new_app.__file__).parent.name == "app"


def test_nothing_outside_the_new_packages_imports_them() -> None:
    offenders = []
    for path in sorted(SOURCE.rglob("*.py")):
        if path.relative_to(SOURCE).parts[0] in NEW_PACKAGES:
            continue
        offenders.extend(f"{path.relative_to(SOURCE)}: {m}" for m in _imported_modules(path) if _is_new(m))
    assert not offenders, offenders


def test_modules_ini_header_and_contract_set() -> None:
    parser = _read(MODULES_INI)
    assert parser["importlinter"]["root_package"] == PACKAGE
    assert parser["importlinter"]["include_external_packages"] == "True"
    names = {s.removeprefix("importlinter:contract:") for s in parser.sections() if s != "importlinter"}
    assert names == CONTRACTS


def test_forbidden_contracts() -> None:
    parser = _read(MODULES_INI)
    p = PACKAGE
    expected = {
        "kernel": ([f"{p}.shared"], {f"{p}.modules", f"{p}.app", f"{p}.main"}),
        "composition-root": ([f"{p}.modules", f"{p}.shared"], {f"{p}.app"}),
        "no-legacy-http": ([f"{p}.modules"], {f"{p}.routes", f"{p}.main"}),
    }
    for name, (sources, forbidden) in expected.items():
        contract = _contract(parser, name)
        assert contract["type"] == "forbidden"
        assert sorted(_lines(contract["source_modules"])) == sorted(sources)
        assert forbidden <= set(_lines(contract["forbidden_modules"])), name


def test_module_inside_and_pure_domain() -> None:
    parser = _read(MODULES_INI)
    inside = _contract(parser, "module-inside")
    assert inside["type"] == "layers"
    assert _lines(inside["containers"]) == [f"{PACKAGE}.modules.*"]
    assert [x.strip("()") for x in _lines(inside["layers"])] == ["adapters", "application", "domain"]
    pure = _contract(parser, "pure-domain")
    assert pure["type"] == "forbidden"
    assert _lines(pure["source_modules"]) == [f"{PACKAGE}.modules.*.domain"]
    # space_client is the import name of the external SPACE client (space-python-client).
    required = {"fastapi", "starlette", "sqlalchemy", "httpx", "space_client", "bim_client"}
    assert required <= set(_lines(pure["forbidden_modules"]))


def test_module_layers_follow_architecture_order() -> None:
    layers = _contract(_read(MODULES_INI), "module-layers")
    assert layers["type"] == "layers"
    assert _lines(layers["layers"]) == MODULE_ORDER
    assert _lines(layers["containers"]) == [f"{PACKAGE}.modules"]
    assert layers["exhaustive"] == "True"


def test_legacy_importlinter_keeps_its_three_contracts() -> None:
    parser = _read(LEGACY_INI)
    names = {s.removeprefix("importlinter:contract:") for s in parser.sections() if s != "importlinter"}
    assert names == {"layers", "no-routes", "integrations"}


# One planted violation per contract: (path under the copied package, source).
_PLANTED = {
    "kernel": ("shared/leak.py", "import openbinding_gateway.modules.plans\n"),
    "composition-root": ("modules/plans/application/root.py", "import openbinding_gateway.app\n"),
    "no-legacy-http": ("modules/plans/application/http.py", "import openbinding_gateway.routes\n"),
    "module-layers": (
        "modules/plans/application/up.py",
        "import openbinding_gateway.modules.identity.application\n",
    ),
    "module-inside": (
        "modules/plans/domain/up.py",
        "import openbinding_gateway.modules.plans.application\n",
    ),
    "pure-domain": ("modules/plans/domain/rules.py", "import fastapi\n"),
}


def test_every_contract_breaks_on_a_planted_violation(tmp_path: Path) -> None:
    lint_imports = Path(sys.executable).parent / "lint-imports"
    if not lint_imports.is_file():
        pytest.skip("lint-imports is not installed (lint dependency group)")
    assert set(_PLANTED) == CONTRACTS
    copy = tmp_path / PACKAGE
    shutil.copytree(SOURCE, copy, ignore=shutil.ignore_patterns("__pycache__"))
    for module in ("plans", "identity"):
        for layer in ("", "domain", "application", "adapters"):
            package = copy / "modules" / module / layer
            package.mkdir(parents=True, exist_ok=True)
            (package / "__init__.py").write_text("", encoding="utf-8")
    for relative, source in _PLANTED.values():
        (copy / relative).write_text(source, encoding="utf-8")
    env = {**os.environ, "PYTHONPATH": str(tmp_path)}
    result = subprocess.run(
        [str(lint_imports), "--no-cache", "--config", str(MODULES_INI)],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    output = result.stdout + result.stderr
    assert re.search(r"Contracts: 0 kept, 6 broken", output), output
    for title in re.findall(r"^name = (.+)$", MODULES_INI.read_text(encoding="utf-8"), re.MULTILINE):
        assert f"{title} BROKEN" in output, title
    assert result.returncode == 1, output
