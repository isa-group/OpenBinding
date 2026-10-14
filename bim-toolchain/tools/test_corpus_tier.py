"""The corpus tier: the analysis that finds the tests reading the OpenBinding corpus, the marker it applies, and the guard
that runs everything else with no corpus and fails if anything is skipped or fails."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

import corpus_tier
from corpus_tier import MARKER, NESTED_ENV, NESTED_MARKER, Analyzer
from packaging_support import ROOT

SUITES = ("packages/bim-core/tests", "packages/bim-service/tests", "packages/bim-client/tests", "tools")


def write(directory: Path, name: str, source: str) -> Path:
    path = directory / name
    path.write_text(textwrap.dedent(source), encoding="utf-8")
    return path


def nested_environment(corpus: Path | None = None, **extra: str) -> dict[str, str]:
    """The environment of a session started by a test: no BIM_* variable of the caller, no corpus, and flagged as nested."""
    environment = {key: value for key, value in os.environ.items() if not key.startswith("BIM_")}
    environment[NESTED_ENV] = "1"
    if corpus is not None:
        environment["BIM_CORPUS_ROOT"] = str(corpus)
    environment.update(extra)
    return environment


# --- the analysis -------------------------------------------------------------------------------------


def test_a_test_that_calls_a_corpus_name_is_in_the_tier(tmp_path: Path) -> None:
    path = write(tmp_path, "test_a.py", """
        def test_direct():
            require_corpus_path("examples/demo/01")

        def test_attribute(tool):
            tool.package_directories(root)

        def test_plain():
            assert 1 + 1 == 2
    """)
    assert Analyzer(tmp_path).corpus_tests(path) == ["test_attribute", "test_direct"]


def test_a_fixture_that_reaches_the_corpus_marks_every_test_that_uses_it(tmp_path: Path) -> None:
    path = write(tmp_path, "test_b.py", """
        import pytest

        @pytest.fixture(scope="module")
        def demo():
            return corpus_root() / "x"

        @pytest.fixture
        def derived(demo):
            return demo / "y"

        def test_one(demo):
            pass

        def test_two(derived):
            pass

        def test_three(tmp_path):
            pass
    """)
    assert Analyzer(tmp_path).corpus_tests(path) == ["test_one", "test_two"]


def test_a_helper_of_the_module_and_a_helper_of_a_support_module_are_followed(tmp_path: Path) -> None:
    write(tmp_path, "support.py", """
        def locate():
            return corpus_root()

        def harmless():
            return 1
    """)
    path = write(tmp_path, "test_c.py", """
        from support import harmless, locate

        def local_helper():
            return locate()

        def test_through_the_import():
            locate()

        def test_through_a_local_helper():
            local_helper()

        def test_harmless():
            harmless()
    """)
    assert Analyzer(tmp_path).corpus_tests(path) == ["test_through_a_local_helper", "test_through_the_import"]


def test_a_fixture_of_a_conftest_above_the_test_is_followed(tmp_path: Path) -> None:
    (tmp_path / "sub").mkdir()
    write(tmp_path, "conftest.py", """
        import pytest

        @pytest.fixture
        def corpus():
            return default_corpus_root()

        @pytest.fixture
        def other():
            return 1
    """)
    path = write(tmp_path / "sub", "test_d.py", """
        def test_needs_it(corpus):
            pass

        def test_does_not(other):
            pass
    """)
    assert Analyzer(tmp_path).corpus_tests(path) == ["test_needs_it"]


def test_a_name_computed_at_import_time_from_the_corpus_taints_its_users(tmp_path: Path) -> None:
    path = write(tmp_path, "test_e.py", """
        HERE = corpus_root()
        FIXED = 82

        def test_uses_it():
            print(HERE)

        def test_does_not():
            print(FIXED)
    """)
    assert Analyzer(tmp_path).corpus_tests(path) == ["test_uses_it"]


def test_methods_are_analyzed_as_tests_of_their_class(tmp_path: Path) -> None:
    path = write(tmp_path, "test_f.py", """
        class TestThing:
            def test_reads(self):
                require_corpus_path("x")

            def test_does_not(self):
                pass
    """)
    analyzer = Analyzer(tmp_path)
    assert analyzer.corpus_tests(path) == ["TestThing::test_reads"]
    assert analyzer.is_corpus_test(path, "TestThing", "test_reads") and not analyzer.is_corpus_test(path, "TestThing", "test_does_not")


def test_a_cycle_between_helpers_ends(tmp_path: Path) -> None:
    path = write(tmp_path, "test_g.py", """
        def first():
            return second()

        def second():
            return first()

        def test_loops():
            first()
    """)
    assert Analyzer(tmp_path).corpus_tests(path) == []


def test_the_names_that_locate_the_corpus_are_listed() -> None:
    assert {"require_corpus_path", "corpus_root", "CORPUS_MARKER", "package_directories"} <= corpus_tier.CORPUS_NAMES


# --- the marker, in a session of its own ------------------------------------------------------------------


@pytest.fixture
def small_project(tmp_path: Path) -> Path:
    project = tmp_path / "project"
    project.mkdir()
    write(project, "conftest.py", f"""
        import sys

        sys.path.insert(0, {str(corpus_tier.TOOLS_DIR)!r})
        from corpus_tier import pytest_collection_modifyitems, pytest_configure  # noqa: F401
    """)
    write(project, "test_small.py", """
        import pytest

        def require_corpus_path(relative):
            raise RuntimeError("the corpus is not here")

        def test_needs_the_corpus():
            require_corpus_path("examples")

        def test_does_not():
            assert True

        @pytest.mark.spawns_suite
        def test_starts_a_session():
            assert True
    """)
    return project


def session(project: Path, *arguments: str, **extra: str) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, "-m", "pytest", "--rootdir", str(project), "-p", "no:cacheprovider", "-q", *arguments]
    return subprocess.run(command, cwd=project, env=nested_environment(**extra), capture_output=True, text=True, check=False)


def test_the_marker_is_applied_and_selectable(small_project: Path) -> None:
    environment = {key: value for key, value in os.environ.items() if key != NESTED_ENV}
    base = [sys.executable, "-m", "pytest", "--rootdir", str(small_project), "-p", "no:cacheprovider", "-q"]
    without = subprocess.run([*base, "-m", f"not {MARKER}"], cwd=small_project, env=environment, capture_output=True, text=True, check=False)
    assert without.returncode == 0, without.stdout + without.stderr
    assert "2 passed, 1 deselected" in without.stdout
    only = subprocess.run([*base, "--collect-only", "-m", MARKER], cwd=small_project, env=environment, capture_output=True, text=True, check=False)
    assert "test_small.py::test_needs_the_corpus" in only.stdout
    assert "test_does_not" not in only.stdout


def test_a_test_that_starts_a_session_is_left_out_of_the_sessions_it_starts(small_project: Path) -> None:
    nested = session(small_project, "-m", f"not {MARKER}")
    assert nested.returncode == 0, nested.stdout + nested.stderr
    assert "1 passed, 2 deselected" in nested.stdout
    assert NESTED_MARKER == "spawns_suite"


# --- the real tests ----------------------------------------------------------------------------------------


def collected(*arguments: str) -> list[str]:
    command = [sys.executable, "-m", "pytest", "--rootdir", str(ROOT), "-p", "no:cacheprovider", "-q", "--collect-only", *arguments, *SUITES]
    result = subprocess.run(command, cwd=ROOT, env=nested_environment(), capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    return [line for line in result.stdout.splitlines() if "::" in line]


@pytest.mark.spawns_suite
def test_the_marker_selects_the_corpus_tests_of_this_repository() -> None:
    selected = collected("-m", MARKER)
    files = {line.split("::", 1)[0].rsplit("/", 1)[-1] for line in selected}
    assert {"test_zip_dir_equivalence_corpus.py", "test_b5_corpus.py", "test_baseline_equivalence.py"} <= files
    assert "test_zip_dir_equivalence.py" not in files and "test_limits_near_boundary.py" not in files
    rest = collected("-m", f"not {MARKER}")
    assert len(rest) > 500 and len(selected) > 50
    assert any("test_zip_dir_equivalence.py::" in line for line in rest)


@pytest.mark.spawns_suite
def test_the_set_without_the_corpus_runs_with_no_skip_and_no_failure(tmp_path: Path) -> None:
    """The guard. Everything the analysis did not put in the tier runs against an empty ``BIM_CORPUS_ROOT``: a test that
    still needs the corpus would skip or fail here, which means the analysis missed it. It is what an exported repository
    runs (``-m 'not openbinding_corpus'``)."""
    empty = tmp_path / "no-corpus"
    empty.mkdir()
    command = [
        sys.executable, "-m", "pytest", "--rootdir", str(ROOT), "-p", "no:cacheprovider",
        "-m", f"not {MARKER}", "-rs", "-q", *SUITES,
    ]
    result = subprocess.run(command, cwd=ROOT, env=nested_environment(empty), capture_output=True, text=True, check=False)
    output = result.stdout + result.stderr
    skipped = [line for line in output.splitlines() if line.startswith("SKIPPED")]
    totals = re.search(r"--- totals: passed=(\d+), failed=(\d+), error=(\d+), skipped=(\d+)", output)
    assert result.returncode == 0, "\n".join(output.strip().splitlines()[-40:])
    assert not skipped, "\n".join(skipped)
    assert totals is not None and int(totals.group(1)) > 500, "\n".join(output.strip().splitlines()[-10:])
    assert (int(totals.group(2)), int(totals.group(3)), int(totals.group(4))) == (0, 0, 0)
    assert "deselected" in output
