"""No test locates a file by counting directories up from its own ``__file__``.

``Path(__file__).parents[2]`` is the repository root only while the tests sit two levels below it. In the
gateway container they sit at ``/app/tests``, ``parents[2]`` is ``/`` and ``/examples``, ``/frontend`` or
``/engines`` do not exist, which failed some sixty tests that passed in a checkout. Repository files are found
through ``_repo.REPO_ROOT`` (it honours ``OPENBINDING_REPO_ROOT``) and the gateway project's own files through
``_paths.GATEWAY_ROOT``; the one place allowed to probe candidate locations is ``_repo.py`` itself.
"""

from __future__ import annotations

import ast
from pathlib import Path

from _paths import TESTS_DIR

#: Files allowed to count parents of ``__file__``: only the module that decides where the repository is.
ALLOWED = frozenset({"_repo.py"})


def _mentions_file(node: ast.AST) -> bool:
    return any(isinstance(child, ast.Name) and child.id == "__file__" for child in ast.walk(node))


def file_relative_parent_lookups(source: str) -> list[int]:
    """Lines that subscript ``.parents`` of an expression built from ``__file__``."""
    return sorted(
        node.lineno
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Subscript)
        and isinstance(node.value, ast.Attribute)
        and node.value.attr == "parents"
        and _mentions_file(node.value.value)
    )


def test_the_scan_sees_the_patterns_that_broke_the_container() -> None:
    assert file_relative_parent_lookups("ROOT = Path(__file__).parents[2]") == [1]
    assert file_relative_parent_lookups("X = Path(__file__).resolve().parents[1] / 'tools'") == [1]
    assert file_relative_parent_lookups("A = 1\nB = Path(__file__).resolve().parents[3]") == [2]
    assert file_relative_parent_lookups("D = Path(__file__).resolve().parent / 'golden'") == []
    assert file_relative_parent_lookups("S = Path(module.__file__).parents[1]") == []
    assert file_relative_parent_lookups("p = path.parents[2]") == []


def test_no_test_counts_parents_of_its_own_file() -> None:
    offenders = []
    for path in sorted(TESTS_DIR.rglob("*.py")):
        if path.name in ALLOWED:
            continue
        for line in file_relative_parent_lookups(path.read_text(encoding="utf-8")):
            offenders.append(f"{path.relative_to(TESTS_DIR)}:{line}")
    assert offenders == [], (
        "Locate repository files with _repo.REPO_ROOT and the gateway project's files with "
        "_paths.GATEWAY_ROOT instead of Path(__file__).parents[n]: " + ", ".join(offenders)
    )


def test_the_allowed_files_exist() -> None:
    assert {name for name in ALLOWED if not Path(TESTS_DIR, name).is_file()} == set()
