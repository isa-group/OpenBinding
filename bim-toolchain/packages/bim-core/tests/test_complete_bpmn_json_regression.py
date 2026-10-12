"""Regression proof that source notation cannot change an executable problem.

The two examples belong to the OpenBinding corpus (``BIM_CORPUS_ROOT``); the tests skip when it is absent.
"""

from itertools import product

from core_support import require_corpus_path

from bim_core.compiler import compile_instance
from bim_core.package import load_package


def _examples():
    return (
        require_corpus_path("examples/demo/15_bpmn_complete"),
        require_corpus_path("examples/demo/16_json_complete"),
    )


def test_complete_bpmn_and_native_json_are_semantically_identical() -> None:
    bpmn_example, json_example = _examples()
    bpmn = compile_instance(load_package(bpmn_example))
    native = compile_instance(load_package(json_example))

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
    bpmn_example, json_example = _examples()
    bpmn = compile_instance(load_package(bpmn_example))
    native = compile_instance(load_package(json_example))
    eligibility = bpmn.document["spec"]["eligibility"]
    task_ids = sorted(eligibility)
    choices = [eligibility[task_id] for task_id in task_ids]

    checked = 0
    for selected in product(*choices):
        binding = dict(zip(task_ids, selected, strict=True))
        assert bpmn.evaluate(binding) == native.evaluate(binding)
        checked += 1

    assert checked == 128
