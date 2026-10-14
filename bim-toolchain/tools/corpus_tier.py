"""The corpus tier: which tests read the OpenBinding corpus, found by reading the tests, and the pytest hooks that mark them.

Some tests compile the 82 packages of the OpenBinding corpus (``BIM_CORPUS_ROOT``).  The corpus is not part of this
repository, so a repository exported from OpenBinding must run everything else::

    python -m pytest -m 'not openbinding_corpus' ...

Which tests need the corpus is decided here by static analysis, not by hand: a test belongs to the tier when its body,
its decorators or any fixture it uses can reach one of the names that locate the corpus (``require_corpus_path``,
``corpus_root`` and friends), following module-level helpers, the fixtures of the ``conftest.py`` files above it and
names imported from the support modules of the tests.  Marking by analysis means a new test that touches the corpus is
marked without anyone remembering to; the guard test ``tools/test_corpus_tier.py`` runs the rest of the suite with no
corpus and fails if anything is skipped or fails, which is what catches a miss of the analysis.

A conftest enables it with::

    from corpus_tier import pytest_collection_modifyitems, pytest_configure  # noqa: F401

Tests that start a whole pytest session of their own (the guard, the export check) carry the marker ``spawns_suite`` and
are left out of the sessions they start (``BIM_NESTED_RUN=1``), so that a session never starts itself again.
"""

from __future__ import annotations

import ast
import os
from pathlib import Path
from typing import Any

import pytest

MARKER = "openbinding_corpus"
NESTED_MARKER = "spawns_suite"
NESTED_ENV = "BIM_NESTED_RUN"
TOOLS_DIR = Path(__file__).resolve().parent
ROOT = TOOLS_DIR.parent

#: Names that locate or read the corpus: reaching one of them makes a test belong to the tier.
CORPUS_NAMES = frozenset({
    "require_corpus_path",
    "corpus_root",
    "corpus_available",
    "default_corpus_root",
    "package_directories",
    "CORPUS_MARKER",
})
_FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)


def references(node: ast.AST) -> set[str]:
    """Every name a piece of code can reach: variables, attributes, parameters and ``getfixturevalue("name")`` strings."""
    found: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Name):
            found.add(child.id)
        elif isinstance(child, ast.Attribute):
            found.add(child.attr)
        elif isinstance(child, ast.arg):
            found.add(child.arg)
        elif (
            isinstance(child, ast.Call)
            and isinstance(child.func, ast.Attribute)
            and child.func.attr == "getfixturevalue"
            and child.args
            and isinstance(child.args[0], ast.Constant)
            and isinstance(child.args[0].value, str)
        ):
            found.add(child.args[0].value)
    return found


class Module:
    """One parsed Python file: its functions, its methods, what it imports and what it computes at import time."""

    def __init__(self, path: Path, source: str | None = None) -> None:
        self.path = path
        tree = ast.parse(path.read_text(encoding="utf-8") if source is None else source, filename=str(path))
        self.functions: dict[str, ast.AST] = {}
        self.methods: dict[tuple[str, str], ast.AST] = {}
        #: methods by bare name: a class-level fixture is found by the name a test asks for it with
        self.members: dict[str, ast.AST] = {}
        self.imports: dict[str, tuple[str, str, int]] = {}
        self.assignments: list[tuple[list[str], ast.AST]] = []
        for statement in tree.body:
            if isinstance(statement, _FUNCTIONS):
                self.functions[statement.name] = statement
            elif isinstance(statement, ast.ClassDef):
                for member in statement.body:
                    if isinstance(member, _FUNCTIONS):
                        self.methods[(statement.name, member.name)] = member
                        self.members.setdefault(member.name, member)
            elif isinstance(statement, ast.ImportFrom):
                for alias in statement.names:
                    self.imports[alias.asname or alias.name] = (statement.module or "", alias.name, statement.level)
            elif isinstance(statement, (ast.Assign, ast.AnnAssign)):
                targets = statement.targets if isinstance(statement, ast.Assign) else [statement.target]
                names = [target.id for target in targets if isinstance(target, ast.Name)]
                if names and statement.value is not None:
                    self.assignments.append((names, statement.value))
        self.tainted: set[str] = set()


class Analyzer:
    """Decides, from the source of the tests, which of them can reach the corpus."""

    def __init__(self, root: Path = ROOT) -> None:
        self.root = root
        self._modules: dict[Path, Module] = {}
        self._references: dict[int, set[str]] = {}
        self._verdicts: dict[tuple[Path, str | None, str], bool] = {}

    def _names(self, node: ast.AST) -> set[str]:
        """``references(node)``, computed once (the nodes live as long as their module is held)."""
        key = id(node)
        if key not in self._references:
            self._references[key] = references(node)
        return self._references[key]

    def module(self, path: Path) -> Module:
        path = path.resolve()
        if path not in self._modules:
            info = Module(path)
            self._modules[path] = info
            # Names assigned at import time from something that reaches the corpus are themselves corpus names.
            for names, value in info.assignments:
                if self._reaches_references(info, self._names(value), set()):
                    info.tainted.update(names)
        return self._modules[path]

    def _module_file(self, origin: Path, module: str, level: int) -> Path | None:
        """The file a ``from module import name`` refers to, looked up where the tests find their support modules."""
        if not module:
            return None
        relative = Path(*module.split("."))
        root = self.root.resolve()
        if level:
            directories = [origin.parent]
        else:
            inside = [item for item in origin.parent.parents if item == root or root in item.parents]
            directories = [origin.parent, TOOLS_DIR, *inside]
        for directory in directories:
            for candidate in (directory / f"{relative}.py", directory / relative / "__init__.py"):
                if candidate.is_file():
                    return candidate
        return None

    def _conftests(self, path: Path) -> list[Path]:
        """The ``conftest.py`` files above a test file, the nearest first, up to the root."""
        root = self.root.resolve()
        found = []
        for directory in (path.parent, *path.parent.parents):
            candidate = directory / "conftest.py"
            if candidate.is_file():
                found.append(candidate)
            if directory == root:
                break
        return found

    def _reaches_references(self, info: Module, names: set[str], seen: set[tuple[Path, str]]) -> bool:
        return any(self._reaches(info, name, seen) for name in sorted(names))

    def _reaches(self, info: Module, name: str, seen: set[tuple[Path, str]]) -> bool:
        if name in CORPUS_NAMES or name in info.tainted:
            return True
        key = (info.path, name)
        if key in seen:
            return False
        seen.add(key)
        node = info.functions.get(name)
        if node is None:
            node = info.members.get(name)
        if node is not None:
            return self._reaches_references(info, self._names(node), seen)
        if name in info.imports:
            module, original, level = info.imports[name]
            target = self._module_file(info.path, module, level)
            if target is not None and target.resolve() != info.path:
                return self._reaches(self.module(target), original, seen)
        for conftest in self._conftests(info.path):
            if conftest.resolve() == info.path:
                continue
            other = self.module(conftest)
            if name in other.functions or name in other.members:
                return self._reaches(other, name, seen)
        return False

    def is_corpus_test(self, path: Path, class_name: str | None, name: str) -> bool:
        """Whether the test ``name`` (of ``class_name``, if it is a method) of the file ``path`` can reach the corpus."""
        info = self.module(path)
        key = (info.path, class_name, name)
        if key not in self._verdicts:
            node = info.methods.get((class_name, name)) if class_name else info.functions.get(name)
            self._verdicts[key] = node is not None and self._reaches_references(
                info, self._names(node), {(info.path, name)}
            )
        return self._verdicts[key]

    def corpus_tests(self, path: Path) -> list[str]:
        """The names of the tests of one file that belong to the tier (functions starting with ``test``, and methods)."""
        info = self.module(path)
        found = [name for name in info.functions if name.startswith("test") and self.is_corpus_test(path, None, name)]
        found += [
            f"{owner}::{name}"
            for (owner, name) in info.methods
            if name.startswith("test") and self.is_corpus_test(path, owner, name)
        ]
        return sorted(found)


def pytest_configure(config: Any) -> None:
    config.addinivalue_line(
        "markers", f"{MARKER}: the test reads the OpenBinding corpus (BIM_CORPUS_ROOT); added by tools/corpus_tier.py"
    )
    config.addinivalue_line(
        "markers", f"{NESTED_MARKER}: the test starts a pytest session of its own; left out of such sessions"
    )


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(config: Any, items: list[Any]) -> None:
    analyzer = Analyzer()
    nested = os.environ.get(NESTED_ENV) == "1"
    kept: list[Any] = []
    dropped: list[Any] = []
    for item in items:
        function = getattr(item, "function", None)
        path = getattr(item, "path", None)
        if function is not None and path is not None:
            owner = getattr(item, "cls", None)
            if analyzer.is_corpus_test(Path(str(path)), owner.__name__ if owner is not None else None, function.__name__):
                item.add_marker(getattr(pytest.mark, MARKER))
        if nested and item.get_closest_marker(NESTED_MARKER) is not None:
            dropped.append(item)
        else:
            kept.append(item)
    if dropped:
        config.hook.pytest_deselected(items=dropped)
        items[:] = kept
