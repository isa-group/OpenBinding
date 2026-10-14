"""``analysis.bindingSpaceCardinality`` is a decimal string whatever the size of the binding space.

The cardinality is the product of the candidates of every service task, an integer that can have thousands of digits.
CPython refuses ``str(n)`` above ``sys.get_int_max_str_digits()`` (4300 by default) with a ``ValueError``; the in-process
client used to hit it before anything reached the HTTP layer.  The text is produced in blocks that stay under any limit
(``BindingProblem.binding_space_cardinality_decimal``).
"""

from __future__ import annotations

import sys

import pytest

from bim_client.inprocess import _analysis
from bim_core import BindingProblem

TASKS = 15000  # 2 ** 15000 has 4516 digits


def huge_problem(tasks: int = TASKS) -> BindingProblem:
    """A problem with ``tasks`` service tasks of two candidates each; it needs no compilation, only an IR."""
    candidates = [{"resource": "catalog", "id": "a"}, {"resource": "catalog", "id": "b"}]
    document = {
        "apiVersion": "bim/v1",
        "kind": "BindingProblem",
        "metadata": {"name": "huge"},
        "spec": {
            "application": {"tasks": {f"t{index}": {"kind": "service"} for index in range(tasks)}},
            "eligibility": {f"t{index}": list(candidates) for index in range(tasks)},
        },
    }
    return BindingProblem.from_document(document, verify=False)


def decimal_without_limit(value: int) -> str:
    previous = sys.get_int_max_str_digits()
    sys.set_int_max_str_digits(0)
    try:
        return str(value)
    finally:
        sys.set_int_max_str_digits(previous)


def needs_the_default_limit() -> None:
    limit = sys.get_int_max_str_digits()
    if limit == 0 or limit > 4515:
        pytest.skip(f"the interpreter allows {limit or 'any number of'} digits: str() of this size would not fail")


def test_python_refuses_to_print_this_cardinality() -> None:
    """The reproduction: the plain conversion fails in this interpreter."""
    needs_the_default_limit()
    with pytest.raises(ValueError, match="digits"):
        str(huge_problem().binding_space_cardinality)


def test_the_in_process_analysis_gives_the_decimal_string_of_a_huge_space() -> None:
    needs_the_default_limit()
    problem = huge_problem()
    analysis = _analysis(problem)

    assert analysis is not None
    assert analysis["bindingSpaceCardinality"] == decimal_without_limit(2**TASKS)
    assert len(analysis["bindingSpaceCardinality"]) == 4516
    assert analysis["serviceTasks"] == TASKS
    assert analysis["bindingSpaceLog10"] == pytest.approx(TASKS * 0.30102999566398, rel=1e-9)


@pytest.mark.parametrize("tasks", [0, 1, 10, 100])
def test_small_spaces_keep_their_plain_decimal_text(tasks: int) -> None:
    analysis = _analysis(huge_problem(tasks))

    assert analysis is not None
    assert analysis["bindingSpaceCardinality"] == str(2**tasks)
