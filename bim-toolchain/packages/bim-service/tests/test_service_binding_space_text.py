"""``analysis.bindingSpaceCardinality`` of ``/compile`` and ``/validate`` for a binding space with thousands of digits.

CPython refuses ``str(n)`` above ``sys.get_int_max_str_digits()`` (4300 by default); the service used to answer such a
package with a 500.  The text is produced in blocks (``BindingProblem.binding_space_cardinality_decimal``), so the
limit of the interpreter plays no part.  The same case is tested for the in-process client in
``packages/bim-client/tests/test_binding_space_text.py``.
"""

from __future__ import annotations

import sys

import pytest

from bim_core import BindingProblem
from bim_service.operations import _analysis

TASKS = 15000  # 2 ** 15000 has 4516 digits


def huge_problem(tasks: int = TASKS) -> BindingProblem:
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


def test_the_service_analysis_gives_the_decimal_string_of_a_huge_space() -> None:
    limit = sys.get_int_max_str_digits()
    if limit == 0 or limit > 4515:
        pytest.skip(f"the interpreter allows {limit or 'any number of'} digits: str() of this size would not fail")
    analysis = _analysis(huge_problem())

    assert analysis is not None
    assert analysis["bindingSpaceCardinality"] == decimal_without_limit(2**TASKS)
    assert len(analysis["bindingSpaceCardinality"]) == 4516
    assert analysis["serviceTasks"] == TASKS


@pytest.mark.parametrize("tasks", [0, 1, 10, 100])
def test_small_spaces_keep_their_plain_decimal_text(tasks: int) -> None:
    analysis = _analysis(huge_problem(tasks))

    assert analysis is not None
    assert analysis["bindingSpaceCardinality"] == str(2**tasks)
