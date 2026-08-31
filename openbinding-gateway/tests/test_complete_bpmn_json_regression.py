"""Regression proof that source notation cannot change an executable problem."""

from itertools import product

from _repo import REPO_ROOT

from openbinding_gateway.v1.compiler import compile_instance
from openbinding_gateway.v1.package import load_package


BPMN_EXAMPLE = REPO_ROOT / "examples/demo/15_bpmn_complete"
JSON_EXAMPLE = REPO_ROOT / "examples/demo/16_json_complete"


def test_complete_bpmn_and_native_json_are_semantically_identical() -> None:
    bpmn = compile_instance(load_package(BPMN_EXAMPLE))
    native = compile_instance(load_package(JSON_EXAMPLE))

    assert bpmn.digest == native.digest
    for key in (
        "profile",
        "application",
        "candidates",
        "eligibility",
        "routing",
        "constraints",
        "placement",
        "optimization",
        "extensions",
    ):
        assert bpmn.document["spec"][key] == native.document["spec"][key]

    bpmn_dialects = {item["id"] for item in bpmn.document["spec"]["dialects"]}
    native_dialects = {item["id"] for item in native.document["spec"]["dialects"]}
    assert "bpmn-workflow/v1" in bpmn_dialects
    assert "bpmn-workflow/v1" not in native_dialects


def test_all_128_bindings_evaluate_identically_in_bpmn_and_json() -> None:
    bpmn = compile_instance(load_package(BPMN_EXAMPLE))
    native = compile_instance(load_package(JSON_EXAMPLE))
    eligibility = bpmn.document["spec"]["eligibility"]
    task_ids = sorted(eligibility)
    choices = [eligibility[task_id] for task_id in task_ids]

    checked = 0
    for selected in product(*choices):
        binding = dict(zip(task_ids, selected, strict=True))
        assert bpmn.evaluate(binding) == native.evaluate(binding)
        checked += 1

    assert checked == 128
