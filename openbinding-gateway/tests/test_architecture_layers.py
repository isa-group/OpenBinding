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


#: ``integrations/`` is infrastructure boundary code: it may use ``core`` (settings), ``models`` (the problem
#: document) and its own modules, and nothing above them.
INTEGRATION_DEPENDENCIES = frozenset({"core", "models", "integrations"})


def gateway_imports(source: str, package: str) -> list[tuple[int, str]]:
    """Every import of a module of ``openbinding_gateway`` in ``source``, resolved to its absolute name."""
    found: list[tuple[int, str]] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found.extend((node.lineno, alias.name) for alias in node.names if alias.name.startswith(PACKAGE))
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                parts = package.split(".")
                parts = parts[: len(parts) - (node.level - 1)]
                base = ".".join(parts + ([node.module] if node.module else []))
            else:
                base = node.module or ""
            if not (base == PACKAGE or base.startswith(PACKAGE + ".")):
                continue
            # ``from pkg import name`` imports the module ``pkg.name`` when there is one, and the object otherwise.
            reported = {base}
            reported.update(f"{base}.{alias.name}" for alias in node.names if _is_module(f"{base}.{alias.name}"))
            found.extend((node.lineno, name) for name in sorted(reported - {base} or reported))
    return found


def _is_module(name: str) -> bool:
    path = SOURCE.parent.joinpath(*name.split("."))
    return path.with_suffix(".py").is_file() or path.is_dir()


def test_the_integrations_detector_resolves_relative_imports() -> None:
    source = "from ..core.settings import get_settings\nfrom . import bim\nfrom ..services import engines\n"

    assert gateway_imports(source, "openbinding_gateway.integrations") == [
        (1, "openbinding_gateway.core.settings"),
        (2, "openbinding_gateway.integrations.bim"),
        (3, "openbinding_gateway.services.engines"),
    ]


def test_integrations_depend_on_nothing_above_them() -> None:
    offenders: list[str] = []
    files = _python_files(SOURCE / "integrations")
    assert files, "integrations/ has no modules to check"
    for path in files:
        for line, name in gateway_imports(path.read_text(encoding="utf-8"), _package_of(path)):
            layer = name.split(".")[1]
            if layer not in INTEGRATION_DEPENDENCIES:
                offenders.append(f"{path.relative_to(SOURCE.parent)}:{line} imports {name}")

    assert not offenders, "integrations/ must not import upwards:\n" + "\n".join(offenders)


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


#: Plans are read in one place: ``services/entitlements.py``.  ``space_client/`` is the gate itself and ``main``
#: installs it (composition root); nobody else calls ``.caps(...)``.
ENTITLEMENT_READERS = frozenset({"services/entitlements.py", "main.py"})

#: Modules that still reach the gate for something other than capabilities: the contract lifecycle (create,
#: novate, read the subscription, mint the pricing token, remove) and the worker's gate lifetime.  That is
#: SPACE account administration, not plan decisions, so it is not an entitlement read; no module here may call
#: ``.caps(...)`` (the first test below holds for them too).  Frozen debt: it can only shrink, e.g. by moving
#: the contract lifecycle behind a service of its own.
GATE_LIFECYCLE_LEGACY = frozenset(
    {
        "access/contracts.py",  # creates the contract an account was promised
        "job_dispatch.py",  # installs and closes the gate in the Dramatiq worker process
        "routes/admin.py",  # subscription reads and novations on behalf of an administrator
        "routes/auth.py",  # creates the contract at registration
        "routes/cas.py",  # creates the contract and upgrades the default plan on a CAS sign-in
        "routes/users.py",  # pricing token and contract removal on account deletion
    }
)


def _is_gate_package(relative: Path) -> bool:
    return relative.parts[0] == "space_client"


def entitlement_gate_uses(source: str) -> tuple[list[int], list[int]]:
    """Lines that call ``.caps(...)`` and lines that reach ``get_gate`` (import or attribute), in ``source``."""
    caps_calls: list[int] = []
    gate_uses: list[int] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "caps":
            caps_calls.append(node.lineno)
        elif isinstance(node, ast.ImportFrom) and any(alias.name == "get_gate" for alias in node.names):
            gate_uses.append(node.lineno)
        elif isinstance(node, ast.Attribute) and node.attr == "get_gate":
            gate_uses.append(node.lineno)
    return sorted(caps_calls), sorted(gate_uses)


def _gate_uses_by_module() -> tuple[dict[str, list[int]], dict[str, list[int]]]:
    caps: dict[str, list[int]] = {}
    gate: dict[str, list[int]] = {}
    for path in _python_files(SOURCE):
        relative = path.relative_to(SOURCE)
        if _is_gate_package(relative):
            continue
        caps_calls, gate_uses = entitlement_gate_uses(path.read_text(encoding="utf-8"))
        if caps_calls:
            caps[relative.as_posix()] = caps_calls
        if gate_uses:
            gate[relative.as_posix()] = gate_uses
    return caps, gate


def test_the_gate_detector_sees_calls_imports_and_attributes() -> None:
    source = "\n".join(
        [
            "from ..space_client import PricingUnavailable, get_gate",
            "from .. import space_client",
            "async def read(user):",
            "    a = await get_gate().caps(user.id)",
            "    b = await space_client.get_gate().caps(user.id)",
            "    return caps.limit('x')",
        ]
    )

    # The import is the use of a bare ``get_gate()``; ``space_client.get_gate`` is an attribute.
    assert entitlement_gate_uses(source) == ([4, 5], [1, 5])


def test_only_the_entitlement_service_reads_plan_capabilities() -> None:
    caps, _ = _gate_uses_by_module()

    offenders = [f"{module}:{line}" for module, lines in sorted(caps.items()) for line in lines]
    assert set(caps) == {"services/entitlements.py"}, (
        "Only services/entitlements.py may call .caps(...); use EntitlementService:\n" + "\n".join(offenders)
    )


def test_no_new_module_reaches_for_the_gate() -> None:
    _, gate = _gate_uses_by_module()

    new = set(gate) - GATE_LIFECYCLE_LEGACY - ENTITLEMENT_READERS
    assert not new, (
        "get_gate is for the entitlement service and the contract lifecycle only; "
        f"read plans through services.entitlements instead of extending GATE_LIFECYCLE_LEGACY: {sorted(new)}"
    )


def test_gate_lifecycle_legacy_has_no_stale_entries() -> None:
    _, gate = _gate_uses_by_module()

    stale = GATE_LIFECYCLE_LEGACY - set(gate)
    assert not stale, f"These modules no longer use get_gate; remove them from GATE_LIFECYCLE_LEGACY: {sorted(stale)}"


#: The v1 router is being emptied into services (docs/ARCHITECTURE.md, "Known debt").  This is a ratchet: the
#: ceiling is the size of ``routes/v1.py`` rounded up to the hundred, and it can only go down.  Lower it when an
#: extraction brings the file under the previous hundred; never raise it.
V1_ROUTER = SOURCE / "routes" / "v1.py"
MAX_LINES = 1400
RATCHET_STEP = 100


def _v1_router_lines() -> int:
    return len(V1_ROUTER.read_text(encoding="utf-8").splitlines())


def test_v1_router_does_not_grow() -> None:
    lines = _v1_router_lines()

    assert lines <= MAX_LINES, (
        f"routes/v1.py has {lines} lines (ceiling {MAX_LINES}); put the new logic in services/ "
        "instead of raising MAX_LINES"
    )


def test_the_v1_ceiling_follows_the_file_down() -> None:
    lines = _v1_router_lines()

    assert lines > MAX_LINES - RATCHET_STEP, (
        f"routes/v1.py shrank to {lines} lines: lower MAX_LINES to {-(-lines // RATCHET_STEP) * RATCHET_STEP}"
    )


JOB_SUBMISSION = SOURCE / "services" / "job_submission.py"


def fastapi_imports(source: str) -> list[tuple[int, str]]:
    """Every name the module takes from ``fastapi`` (``fastapi.responses.JSONResponse``), at any nesting level."""
    found: list[tuple[int, str]] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found.extend((node.lineno, alias.name) for alias in node.names if alias.name.split(".")[0] == "fastapi")
        elif isinstance(node, ast.ImportFrom) and not node.level and (node.module or "").split(".")[0] == "fastapi":
            found.extend((node.lineno, f"{node.module}.{alias.name}") for alias in node.names)
    return sorted(found)


def module_level_mutables(source: str) -> list[int]:
    """Lines of module-level assignments of a list, dict or set (literal, comprehension or constructor call)."""
    constructors = {"list", "dict", "set", "defaultdict", "OrderedDict", "deque", "Counter"}
    mutable = (ast.List, ast.Dict, ast.Set, ast.ListComp, ast.DictComp, ast.SetComp)
    lines: list[int] = []
    for node in ast.parse(source).body:
        if not isinstance(node, (ast.Assign, ast.AnnAssign)) or node.value is None:
            continue
        value = node.value
        called = value.func if isinstance(value, ast.Call) else None
        name = getattr(called, "id", None) or getattr(called, "attr", None)
        if isinstance(value, mutable) or name in constructors:
            lines.append(node.lineno)
    return lines


def test_the_fastapi_detector_sees_every_form() -> None:
    source = "\n".join(
        [
            "import fastapi",
            "from fastapi import HTTPException, status",
            "from fastapi.responses import JSONResponse",
            "from . import fastapi_like",
            "def late():",
            "    from fastapi import Request",
        ]
    )

    assert [name for _, name in fastapi_imports(source)] == [
        "fastapi",
        "fastapi.HTTPException",
        "fastapi.status",
        "fastapi.responses.JSONResponse",
        "fastapi.Request",
    ]


def test_the_mutable_global_detector_sees_literals_and_constructors() -> None:
    source = "A = []\nB: dict = {}\nC = set()\nD = 'x'\nE = (1, 2)\nF = defaultdict(list)\ndef f():\n    local = []\n"

    assert module_level_mutables(source) == [1, 2, 3, 6]


def test_job_submission_is_independent_of_routes_and_fastapi_responses() -> None:
    source = JOB_SUBMISSION.read_text(encoding="utf-8")

    assert routes_imports(source, "openbinding_gateway.services") == []
    assert {name for _, name in fastapi_imports(source)} <= {"fastapi.HTTPException"}, (
        "services/job_submission.py may use fastapi only for HTTPException; return a JobSubmissionResult"
    )
    assert module_level_mutables(source) == [], "services/job_submission.py must not keep mutable module state"


ENGINE_REGISTRY = SOURCE / "services" / "engine_registry.py"


def test_engine_registry_is_independent_of_routes_and_fastapi_responses() -> None:
    source = ENGINE_REGISTRY.read_text(encoding="utf-8")

    assert routes_imports(source, "openbinding_gateway.services") == []
    assert {name for _, name in fastapi_imports(source)} <= {"fastapi.HTTPException"}, (
        "services/engine_registry.py may use fastapi only for HTTPException; raise a RegistryProblem"
    )
    assert module_level_mutables(source) == [], "services/engine_registry.py must not keep mutable module state"


#: Services extracted from ``routes/v1.py`` after the registry: they raise a problem of their own and never build a
#: response, never import ``routes`` and keep no mutable module state (what they read of the process, such as the
#: resources registered without a database, the route passes in or the snapshot service owns).
V1_SERVICES = {
    "instances": "InstanceProblem",
    "discovery": "DiscoveryProblem",
}


def test_the_v1_services_are_independent_of_routes_and_fastapi_responses() -> None:
    for module, problem in V1_SERVICES.items():
        path = SOURCE / "services" / f"{module}.py"
        source = path.read_text(encoding="utf-8")

        assert routes_imports(source, "openbinding_gateway.services") == [], f"services/{module}.py imports routes"
        assert {name for _, name in fastapi_imports(source)} <= {"fastapi.HTTPException"}, (
            f"services/{module}.py may use fastapi only for HTTPException; raise a {problem}"
        )
        assert module_level_mutables(source) == [], f"services/{module}.py must not keep mutable module state"


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
