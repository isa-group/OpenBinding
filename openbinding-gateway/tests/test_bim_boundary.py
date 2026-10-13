"""The gateway reaches BIM through one door; this keeps the rest of it from reaching around.

``integrations/bim.py`` builds the ``BimPort`` and everything else asks it. The platform may also import
from ``bim_core`` the canonical hashing it shares with the toolchain (``bim_core.canonical``) and the error
classes it translates; two documented helpers about a *single* document that the port has no operation for
live in ``integrations/bim_host.py``. Nothing of the language (compiler, package loader, evaluator,
expressions, compatibility, protocol) may be imported, and ``bim_service`` is never a dependency.
"""

from __future__ import annotations

import ast
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1] / "src" / "openbinding_gateway"

#: Names the platform takes from the top level of ``bim_core``: the errors it translates.
ERRORS = frozenset({
    "BimError",
    "CanonicalizationError",
    "CompileError",
    "ContractError",
    "EvaluationError",
    "ExpressionError",
    "PackageError",
    "ProtocolError",
})

#: What a module may import from ``bim_core`` beyond ``ERRORS`` and ``bim_core.canonical``, by file.
EXTRA = {
    "integrations/bim.py": frozenset({"Limits"}),
    "integrations/bim_host.py": frozenset({
        "InstancePackage",
        "dialect_type_matches",
        "dialect_xml_type_matches",
        "engine_contract_diagnostics",
        "resource_schema_diagnostics",
    }),
}

#: The one module that knows which implementations of the port exist.
CLIENT_USERS = frozenset({"integrations/bim.py"})


def _imports(path: Path) -> list[tuple[int, str, tuple[str, ...]]]:
    """``(line, module, names)`` of every import in ``path``, at any nesting level."""
    found: list[tuple[int, str, tuple[str, ...]]] = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            found.extend((node.lineno, alias.name, ()) for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            found.append((node.lineno, node.module or "", tuple(alias.name for alias in node.names)))
    return found


def violations(relative: str, imports: list[tuple[int, str, tuple[str, ...]]]) -> list[str]:
    problems: list[str] = []
    allowed = ERRORS | EXTRA.get(relative, frozenset())
    for line, module, names in imports:
        root = module.split(".")[0]
        where = f"{relative}:{line}"
        if root == "bim_service":
            problems.append(f"{where} imports {module}: the gateway never depends on the service")
        elif root == "bim_client" and relative not in CLIENT_USERS:
            problems.append(f"{where} imports {module}: only integrations/bim.py builds the port")
        elif root == "bim_core":
            if module == "bim_core":
                for name in names:
                    if name not in allowed:
                        problems.append(f"{where} imports {name} from bim_core")
            elif module != "bim_core.canonical":
                problems.append(f"{where} imports {module}: the language is the toolchain's")
    return problems


def test_the_detector_sees_every_import_form() -> None:
    source = {
        "a.py": [
            (1, "bim_core.compiler", ("compile_instance",)),
            (2, "bim_core.package", ()),
            (3, "bim_core", ("BindingProblem",)),
            (4, "bim_client", ("HttpBim",)),
            (5, "bim_service.app", ("create_app",)),
        ],
    }
    assert len(violations("a.py", source["a.py"])) == 5
    assert violations(
        "b.py",
        [(1, "bim_core.canonical", ("digest",)), (2, "bim_core", ("PackageError", "ContractError"))],
    ) == []
    assert violations("integrations/bim.py", [(1, "bim_client", ("BimPort",)), (2, "bim_core", ("Limits",))]) == []


def test_no_module_of_the_gateway_imports_the_language() -> None:
    problems: list[str] = []
    for path in sorted(PACKAGE.rglob("*.py")):
        relative = path.relative_to(PACKAGE).as_posix()
        problems.extend(violations(relative, _imports(path)))

    assert not problems, "the gateway reaches into BIM:\n" + "\n".join(problems)


def test_the_module_that_builds_the_port_is_the_only_one_that_names_its_implementations() -> None:
    users = {
        path.relative_to(PACKAGE).as_posix()
        for path in PACKAGE.rglob("*.py")
        if any(module.split(".")[0] == "bim_client" for _, module, _ in _imports(path))
    }

    assert users == CLIENT_USERS
