"""Modules talk to each other through ``application`` only; ``app`` and ``main`` are the composition root."""

from __future__ import annotations

import ast
from collections.abc import Container
from pathlib import Path, PurePosixPath

from _paths import GATEWAY_ROOT

PACKAGE = "openbinding_gateway"
SOURCE = GATEWAY_ROOT / "src" / PACKAGE
MODULES = f"{PACKAGE}.modules"


def _package_parts(relative: PurePosixPath) -> list[str]:
    """Dotted package that holds ``relative`` (a path under the package), as parts."""
    return [PACKAGE, *relative.parts[:-1]]


def _resolve(node: ast.ImportFrom, package: list[str]) -> str | None:
    """Absolute name of the ``from`` part of an import, or None when a relative import climbs out of the package."""
    if not node.level:
        return node.module or ""
    if node.level - 1 > len(package) - 1:
        return None
    parts = package[: len(package) - (node.level - 1)]
    return ".".join(parts + ([node.module] if node.module else []))


def known_module_paths(root: Path) -> set[str]:
    """Dotted names of every package and module under ``root/modules`` (``root`` is the package directory)."""
    modules_dir = root / "modules"
    if not modules_dir.is_dir():
        return set()
    known: set[str] = set()
    for path in modules_dir.rglob("*"):
        if "__pycache__" in path.parts:
            continue
        if path.is_dir() or path.suffix == ".py":
            relative = path.relative_to(root).with_suffix("") if path.suffix == ".py" else path.relative_to(root)
            parts = [part for part in relative.parts if part != "__init__"]
            known.add(".".join([PACKAGE, *parts]))
    return known


def imported_modules(
    source: str, relative: PurePosixPath, known: Container[str] | None = None
) -> list[tuple[int, str]]:
    """Every ``openbinding_gateway.modules...`` name that ``source`` imports, at any nesting level.

    ``from X import Y`` is reported as ``X.Y`` when ``X.Y`` is a module or package of the tree, else as ``X``. ``known``
    holds those dotted paths; without it, ``Y`` counts as a module when ``X`` is ``modules`` or ``modules.<m>``.
    """
    package = _package_parts(relative)
    found: list[tuple[int, str]] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found.extend((node.lineno, alias.name) for alias in node.names if _in_modules(alias.name))
        elif isinstance(node, ast.ImportFrom):
            base = _resolve(node, package)
            if base is None or not (base == PACKAGE or _in_modules(base)):
                continue
            for alias in node.names:
                candidate = f"{base}.{alias.name}"
                if alias.name == "*":
                    name = base
                elif known is not None:
                    name = candidate if candidate in known else base
                else:
                    name = candidate if len(base.split(".")) <= len(MODULES.split(".")) + 1 else base
                if _in_modules(name):
                    found.append((node.lineno, name))
    return sorted(found)


def _in_modules(name: str) -> bool:
    return name == MODULES or name.startswith(MODULES + ".")


def _exempt_file(relative: PurePosixPath) -> bool:
    return relative.parts[0] == "app" or relative.parts == ("main.py",)


def cross_module_violations(
    source: str, relative: PurePosixPath, known: Container[str] | None = None
) -> list[tuple[int, str]]:
    """``(line, imported module)`` for each import of another module's internals from ``relative``."""
    if _exempt_file(relative):
        return []
    own = relative.parts[1] if relative.parts[0] == "modules" and len(relative.parts) > 2 else None
    violations: list[tuple[int, str]] = []
    for line, name in imported_modules(source, relative, known):
        rest = name.split(".")[len(MODULES.split(".")) :]
        if not rest:
            continue
        module, inside = rest[0], rest[1:]
        if module == own or inside == ["application"]:
            continue
        violations.append((line, name))
    return violations


def violations_in_tree(root: Path) -> list[str]:
    """``<file>:<line> imports <module>`` for each violation in the package directory ``root``."""
    known = known_module_paths(root)
    offenders: list[str] = []
    for path in sorted(root.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        relative = PurePosixPath(path.relative_to(root).as_posix())
        for line, name in cross_module_violations(path.read_text(encoding="utf-8"), relative, known):
            offenders.append(f"{relative}:{line} imports {name}")
    return offenders


def _check(source: str, path: str) -> list[tuple[int, str]]:
    return cross_module_violations(source, PurePosixPath(path))


# [utest->req~gateway-architecture-application-only~1]
def test_another_modules_domain_is_flagged_with_file_line_and_module() -> None:
    source = f"from {MODULES}.execution.domain import run\n"

    assert _check(source, "modules/laboratory/application/runs.py") == [(1, f"{MODULES}.execution.domain")]


# [utest->req~gateway-architecture-application-only~1]
def test_adapters_application_internals_and_package_root_are_flagged() -> None:
    source = "\n".join(
        [
            f"from {MODULES}.engines.adapters.http import router",
            f"from {MODULES}.engines.application.use_cases import submit",
            f"import {MODULES}.engines.domain",
            f"from {MODULES}.engines import domain",
            f"from {MODULES}.engines import Engine",
            f"from {MODULES} import engines",
        ]
    )

    assert [line for line, _ in _check(source, "services/probe.py")] == [1, 2, 3, 4, 5, 6]


# [utest->req~gateway-architecture-application-only~1]
def test_another_modules_application_is_allowed() -> None:
    source = "\n".join(
        [
            f"from {MODULES}.engines.application import submit",
            f"from {MODULES}.engines import application",
            f"import {MODULES}.engines.application",
            "from ..modules.engines import application",
        ]
    )

    assert _check(source, "services/probe.py") == []


# [utest->req~gateway-architecture-application-only~1]
def test_relative_imports_are_resolved_at_any_nesting_level() -> None:
    source = "\n".join(
        [
            "from ..modules.engines.domain import run",
            "def late():",
            "    from ..modules.engines import adapters",
            "    from ...modules.engines.adapters import http",
        ]
    )

    # The last import climbs out of the package, so it is not an import of ``modules``.
    assert _check(source, "services/probe.py") == [
        (1, f"{MODULES}.engines.domain"),
        (3, f"{MODULES}.engines.adapters"),
    ]


# [utest->req~gateway-architecture-application-only~1]
def test_same_module_imports_are_exempt_absolute_and_relative() -> None:
    source = "\n".join(
        [
            f"from {MODULES}.laboratory.domain import run",
            "from ..domain import run",
            "from .. import adapters",
            f"from {MODULES}.laboratory import adapters",
        ]
    )

    assert _check(source, "modules/laboratory/application/runs.py") == []


# [utest->req~gateway-architecture-application-only~1]
def test_a_module_importing_a_sibling_module_is_flagged() -> None:
    source = "from ...execution.domain import run\nfrom ...execution.application import api\n"

    assert _check(source, "modules/laboratory/application/runs.py") == [(1, f"{MODULES}.execution.domain")]


# [utest->req~gateway-architecture-application-only~1]
def test_main_and_the_app_package_are_exempt_but_app_py_and_application_py_are_not() -> None:
    source = f"from {MODULES}.engines.adapters import router\n"
    flagged = [(1, f"{MODULES}.engines.adapters")]

    assert _check(source, "main.py") == []
    assert _check(source, "app/__init__.py") == []
    assert _check(source, "app/wiring/routers.py") == []
    assert _check(source, "app.py") == flagged
    assert _check(source, "application.py") == flagged
    assert _check(source, "main_extra.py") == flagged
    assert _check(source, "routes/main.py") == flagged


# [utest->req~gateway-architecture-application-only~1]
def test_unrelated_imports_and_the_modules_package_itself_are_not_cross_imports() -> None:
    source = f"import json\nfrom ..db import models\nimport {MODULES}\nfrom {PACKAGE} import routes\n"

    assert _check(source, "services/probe.py") == []


def _plant(root: Path, files: dict[str, str]) -> None:
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


# [utest->req~gateway-architecture-application-only~1]
def test_a_submodule_of_another_modules_application_is_flagged_but_an_object_is_not(tmp_path: Path) -> None:
    _plant(
        tmp_path,
        {
            "modules/engines/application/__init__.py": "def submit(): ...\n",
            "modules/engines/application/use_cases.py": "",
            "services/submodule.py": f"from {MODULES}.engines.application import use_cases\n",
            "services/aliased.py": "from ..modules.engines.application import use_cases as cases\n",
            "services/object.py": f"from {MODULES}.engines.application import submit\n",
        },
    )

    assert violations_in_tree(tmp_path) == [
        f"services/aliased.py:1 imports {MODULES}.engines.application.use_cases",
        f"services/submodule.py:1 imports {MODULES}.engines.application.use_cases",
    ]


# [utest->req~gateway-architecture-application-only~1]
def test_violations_in_tree_reports_file_line_and_module(tmp_path: Path) -> None:
    _plant(
        tmp_path,
        {
            "modules/execution/domain/__init__.py": "",
            "modules/laboratory/application/runs.py": f"from {MODULES}.execution.domain import run\n",
        },
    )

    assert violations_in_tree(tmp_path) == [
        f"modules/laboratory/application/runs.py:1 imports {MODULES}.execution.domain"
    ]


# [utest->req~gateway-architecture-application-only~1]
def test_a_tree_without_modules_has_no_violations(tmp_path: Path) -> None:
    _plant(tmp_path, {"routes/health.py": "import json\n"})

    assert violations_in_tree(tmp_path) == []


# [utest->req~gateway-architecture-application-only~1]
def test_aliased_imports_are_reported_by_the_imported_name() -> None:
    source = "\n".join(
        [
            f"import {MODULES}.engines.domain as engine_domain",
            f"from {MODULES}.engines.adapters import http as engine_http",
            f"from {MODULES}.engines import domain as d",
        ]
    )

    assert _check(source, "services/probe.py") == [
        (1, f"{MODULES}.engines.domain"),
        (2, f"{MODULES}.engines.adapters"),
        (3, f"{MODULES}.engines.domain"),
    ]


# [utest->req~gateway-architecture-application-only~1]
def test_conditional_and_class_body_imports_are_flagged() -> None:
    source = "\n".join(
        [
            "if TYPE_CHECKING:",
            f"    from {MODULES}.engines.domain import Run",
            "try:",
            f"    import {MODULES}.engines.adapters",
            "except ImportError:",
            f"    from {MODULES}.execution.domain import run",
            "class Probe:",
            f"    from {MODULES}.engines import domain",
        ]
    )

    assert _check(source, "services/probe.py") == [
        (2, f"{MODULES}.engines.domain"),
        (4, f"{MODULES}.engines.adapters"),
        (6, f"{MODULES}.execution.domain"),
        (8, f"{MODULES}.engines.domain"),
    ]


# [utest->req~gateway-architecture-application-only~1]
def test_the_package_wide_rule_passes_on_the_real_tree() -> None:
    assert any(SOURCE.rglob("*.py")), "the gateway package has no modules to check"
    offenders = violations_in_tree(SOURCE)

    assert not offenders, "Modules are reached through modules.<m>.application only:\n" + "\n".join(offenders)
