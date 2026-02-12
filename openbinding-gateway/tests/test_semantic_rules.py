import os

import pytest

from openbinding_gateway.validation.semantic_general import GeneralSemanticValidator


if "GENERAL_SCHEMA_PATH" not in os.environ:
    os.environ["GENERAL_SCHEMA_PATH"] = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "../../schemas/general/schema.json")
    )

if "SCHEMAS_DIR" not in os.environ:
    os.environ["SCHEMAS_DIR"] = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "../../schemas")
    )


@pytest.fixture
def validator() -> GeneralSemanticValidator:
    return GeneralSemanticValidator()


def base_instance():
    return {
        "metadata": {"id": "test-1", "name": "test", "version": "1.0", "created_at": "2023-01-01T00:00:00Z"},
        "features": [
            {
                "id": "cost",
                "name": "Cost",
                "direction": "MINIMIZE",
                "unit": "USD",
                "scale": "RATIO",
                "valid_range": {"min": 0, "max": 100},
            },
            {
                "id": "latency",
                "name": "Latency",
                "direction": "MINIMIZE",
                "unit": "ms",
                "scale": "RATIO",
                "valid_range": {"min": 0, "max": 1000},
            },
        ],
        "providers": [{"id": "p1", "name": "Provider"}],
        "tasks": [{"id": "t1", "name": "Task 1"}, {"id": "t2", "name": "Task 2"}],
        "candidates": [
            {
                "id": "c1",
                "task_id": "t1",
                "provider_id": "p1",
                "name": "C1",
                "features": {"cost": 10, "latency": 50},
            },
            {
                "id": "c2",
                "task_id": "t2",
                "provider_id": "p1",
                "name": "C2",
                "features": {"cost": 20, "latency": 80},
            },
        ],
        "composition": {
            "type": "STRUCTURED",
            "root": {
                "kind": "SEQ",
                "id": "n-seq",
                "children": [
                    {"kind": "TASK", "id": "n1", "task_id": "t1"},
                    {"kind": "TASK", "id": "n2", "task_id": "t2"},
                ],
            },
        },
        "aggregation_policies": {
            "cost": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}}},
            "latency": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}}},
        },
        "objective": {"type": "MONO", "targets": ["cost"], "weights": {"cost": 1.0}},
        "constraints": [],
    }


def test_candidate_unknown_feature_key(validator: GeneralSemanticValidator):
    instance = base_instance()
    instance["candidates"][0]["features"]["ghost"] = 1

    violations = validator.validate(instance)

    assert any(v.code == "referential_integrity_error" and "ghost" in (v.path or "") for v in violations)


def test_candidate_feature_out_of_range(validator: GeneralSemanticValidator):
    instance = base_instance()
    instance["candidates"][0]["features"]["cost"] = 1000

    violations = validator.validate(instance)

    assert any(v.code == "value_out_of_range" and "cost" in (v.path or "") for v in violations)


def test_aggregation_policy_unknown_feature(validator: GeneralSemanticValidator):
    instance = base_instance()
    instance["aggregation_policies"]["ghost"] = {"neutral": 0, "compose": {"seq": {"fn": "SUM"}}}

    violations = validator.validate(instance)

    assert any(v.code == "referential_integrity_error" and "aggregation_policies.ghost" == v.path for v in violations)


def test_objective_targets_unknown_feature(validator: GeneralSemanticValidator):
    instance = base_instance()
    instance["objective"]["targets"].append("ghost")

    violations = validator.validate(instance)

    assert any(v.code == "referential_integrity_error" and v.path == "objective.targets" for v in violations)


def test_objective_weights_not_in_targets(validator: GeneralSemanticValidator):
    instance = base_instance()
    instance["objective"]["weights"]["latency"] = 0.0

    violations = validator.validate(instance)

    assert any(v.code == "semantic_invariant_error" and "objective.weights.latency" == v.path for v in violations)


def test_constraint_attribute_unknown_feature(validator: GeneralSemanticValidator):
    instance = base_instance()
    instance["constraints"] = [
        {"id": "c1", "kind": "ATTRIBUTE_BOUND", "scope": "GLOBAL", "attribute_id": "ghost", "op": "<=", "value": 5}
    ]

    violations = validator.validate(instance)

    assert any(v.code == "referential_integrity_error" and v.path == "constraints[0].attribute_id" for v in violations)


def test_constraint_tasks_unknown(validator: GeneralSemanticValidator):
    instance = base_instance()
    instance["constraints"] = [
        {
            "id": "c1",
            "kind": "ATTRIBUTE_BOUND",
            "scope": "LOCAL",
            "tasks": ["t-missing"],
            "attribute_id": "cost",
            "op": "<=",
            "value": 5,
        }
    ]

    violations = validator.validate(instance)

    assert any(v.code == "referential_integrity_error" and v.path == "constraints[0].tasks" for v in violations)


