import os

import pytest

from openbinding_gateway.validation.pipeline import ValidationPipeline




@pytest.fixture
def pipeline() -> ValidationPipeline:
    return ValidationPipeline()


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
            }
        ],
        "providers": [{"id": "p1", "name": "Provider"}],
        "tasks": [{"id": "t1", "name": "Task 1"}],
        "candidates": [
            {
                "id": "c1",
                "task_ids": ["t1"],
                "provider_id": "p1",
                "name": "C1",
                "features": {"cost": 10},
            }
        ],
        "composition": {"type": "STRUCTURED", "root": {"kind": "TASK", "id": "n1", "task_id": "t1"}},
        "aggregation_policies": {"cost": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}}}},
        "objective": {"type": "MONO", "targets": ["cost"], "weights": {"cost": 1.0}},
    }


def test_missing_constraints_defaulted_to_empty(pipeline: ValidationPipeline):
    instance = base_instance()
    assert "constraints" not in instance

    violations, defaults = pipeline.validate_full("random-search", instance)

    assert violations == []
    assert instance["constraints"] == []
    assert any(path == "constraints" for path, _ in defaults)


def test_constraint_hard_default_applied(pipeline: ValidationPipeline):
    instance = base_instance()
    instance["constraints"] = [
        {
            "id": "c1",
            "kind": "ATTRIBUTE_BOUND",
            "scope": "GLOBAL",
            "attribute_id": "cost",
            "op": "<=",
            "value": 5,
        }
    ]

    violations, defaults = pipeline.validate_full("random-search", instance)

    assert violations == []
    assert instance["constraints"][0].get("hard") is True
    assert any(path == "constraints[0].hard" for path, _ in defaults)
