"""Layering: services, domain and jobs never reach back into the HTTP routes."""

from __future__ import annotations

import ast
from pathlib import Path

PACKAGE = "openbinding_gateway"
SOURCE = Path(__file__).resolve().parents[1] / "src" / PACKAGE
ROUTES = f"{PACKAGE}.routes"

#: Layers that must stay independent of ``routes``.
PROTECTED_LAYERS = ("services", "domain", "jobs")

#: Modules outside ``routes/`` that import ``routes`` at the time of writing,
#: relative to the package (``artifacts`` is ``openbinding_gateway/artifacts.py``).
#: This is frozen debt: shrink it by moving the imported code into a service,
#: never grow it.  ``main`` is the composition root and is exempt.
ALLOWED_LEGACY = frozenset(
    {
        "analysis_jobs",
        "artifacts",
        "reports",
        "study_jobs",
    }
)
COMPOSITION_ROOT = frozenset({"main"})


def _module_name(path: Path) -> str:
    relative = path.relative_to(SOURCE.parent).with_suffix("")
    parts = list(relative.parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def _package_of(path: Path) -> str:
    module = _module_name(path)
    return module if path.name == "__init__.py" else module.rpartition(".")[0]


def _is_routes(name: str) -> bool:
    return name == ROUTES or name.startswith(ROUTES + ".")


def routes_imports(source: str, package: str) -> list[tuple[int, str]]:
    """Every import of ``openbinding_gateway.routes`` in ``source``, at any nesting level."""
    found: list[tuple[int, str]] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found.extend((node.lineno, alias.name) for alias in node.names if _is_routes(alias.name))
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base_parts = package.split(".")
                if node.level - 1 > len(base_parts) - 1:
                    continue
                base_parts = base_parts[: len(base_parts) - (node.level - 1)]
                base = ".".join(base_parts + ([node.module] if node.module else []))
            else:
                base = node.module or ""
            if _is_routes(base):
                found.append((node.lineno, base))
            elif base == PACKAGE:
                found.extend(
                    (node.lineno, f"{base}.{alias.name}")
                    for alias in node.names
                    if _is_routes(f"{base}.{alias.name}")
                )
    return found


def _python_files(root: Path) -> list[Path]:
    return sorted(path for path in root.rglob("*.py") if "__pycache__" not in path.parts)


def test_detector_sees_every_import_form() -> None:
    source = "\n".join(
        [
            "import openbinding_gateway.routes.v1",
            "from openbinding_gateway.routes import v1",
            "from openbinding_gateway import routes",
            "from ..routes import v1",
            "from ..routes.v1 import router",
            "from .. import routes",
            "def late():",
            "    from ..routes.v1 import _problem",
            "    from ...routes import v1",
            "    import json",
            "    from ..db import models",
        ]
    )

    lines = [line for line, _ in routes_imports(source, "openbinding_gateway.services")]

    assert lines == [1, 2, 3, 4, 5, 6, 8]


def test_services_domain_and_jobs_do_not_import_routes() -> None:
    offenders: list[str] = []
    for layer in PROTECTED_LAYERS:
        files = _python_files(SOURCE / layer)
        assert files, f"{layer}/ has no modules to check"
        for path in files:
            for line, name in routes_imports(path.read_text(encoding="utf-8"), _package_of(path)):
                offenders.append(f"{path.relative_to(SOURCE.parent)}:{line} imports {name}")

    assert not offenders, "services/domain/jobs must not import routes:\n" + "\n".join(offenders)


def test_nothing_imports_the_retired_metering_module() -> None:
    offenders: list[str] = []
    for path in _python_files(SOURCE):
        text = path.read_text(encoding="utf-8")
        for node in ast.walk(ast.parse(text)):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [alias.name for alias in node.names] + [node.module or ""]
            else:
                continue
            if any(name == "metering" or name.endswith(".metering") for name in names):
                offenders.append(f"{path.relative_to(SOURCE.parent)}:{node.lineno}")

    assert not offenders, "the metering module was retired; use jobs/:\n" + "\n".join(offenders)


def _modules_importing_routes() -> set[str]:
    importing: set[str] = set()
    for path in _python_files(SOURCE):
        relative = path.relative_to(SOURCE)
        if relative.parts[0] in {"routes", *PROTECTED_LAYERS}:
            continue
        if routes_imports(path.read_text(encoding="utf-8"), _package_of(path)):
            importing.add(_module_name(path).removeprefix(PACKAGE + "."))
    return importing - COMPOSITION_ROOT


def test_no_new_module_imports_routes() -> None:
    new = _modules_importing_routes() - ALLOWED_LEGACY

    assert not new, (
        "These modules import routes; move the shared code into services/ or domain/ "
        f"instead of extending ALLOWED_LEGACY: {sorted(new)}"
    )


def test_allowed_legacy_has_no_stale_entries() -> None:
    stale = ALLOWED_LEGACY - _modules_importing_routes()

    assert not stale, f"These modules no longer import routes; remove them from ALLOWED_LEGACY: {sorted(stale)}"
