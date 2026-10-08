from _repo import REPO_ROOT

from openbinding_gateway.routes import v1 as routes
from openbinding_gateway.v1.compiler import compile_instance
from openbinding_gateway.v1.package import load_package


EXAMPLE = REPO_ROOT / "examples/demo/15_bpmn_complete"


def test_complete_bpmn_example_lowers_every_showcase_construct() -> None:
    problem = compile_instance(load_package(EXAMPLE))
    spec = problem.document["spec"]
    workflow = spec["application"]["workflow"]

    assert workflow["kind"] == "sequence"
    assert workflow["steps"][0]["task"]["id"] == "authenticate"
    # Unnamed sequences are associative, so the compiler canonicalizes them
    # flat (_flatten_workflow_sequences): authenticate, parallel, publish.
    assert [step["kind"] for step in workflow["steps"]] == ["task", "parallel", "task"]
    assert workflow["steps"][2]["task"]["id"] == "publish"
    parallel = workflow["steps"][1]
    enriched = parallel["branches"][0]
    assert enriched["kind"] == "sequence"
    assert enriched["steps"][0]["task"]["id"] == "enrich"
    exclusive = enriched["steps"][1]
    assert exclusive["kind"] == "exclusive"
    assert [branch["id"] for branch in exclusive["branches"]] == [
        "Flow_Cache",
        "Flow_Fetch",
    ]
    assert enriched["steps"][2] == {
        "kind": "repeat",
        "body": {
            "kind": "task",
            "task": {"resource": "application", "id": "score"},
        },
        "count": 2,
    }
    assert [entry["probability"] for entry in spec["routing"]] == [0.65, 0.35]
    assert len(spec["placement"]) == 1
    assert len(spec["placement"][0]["demands"]) == 14
    assert [item["id"] for item in spec["optimization"]["criteria"]] == [
        "latency",
        "cost",
        "carbon",
        "trust",
    ]


def test_complete_bpmn_example_is_eligible_for_minizinc() -> None:
    problem = compile_instance(load_package(EXAMPLE))
    mode = routes._manifest("minizinc-csp")["spec"]["modes"][0]

    assert routes._mode_compatibility(problem, mode) == []
