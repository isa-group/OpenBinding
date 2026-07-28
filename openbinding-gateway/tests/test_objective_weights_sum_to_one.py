import os

import pytest

from openbinding_gateway.validation.pipeline import ValidationPipeline


# Ensure schema paths are available when running tests locally.


@pytest.fixture
def pipeline() -> ValidationPipeline:
    return ValidationPipeline()


def _minimal_valid_mono_instance(*, weight: float, include_flag: bool, flag_value: bool = True):
    instance = {
        "metadata": {"id": "t-1", "name": "test", "version": "1.0", "created_at": "2023-01-01T00:00:00Z"},
        "features": [
            {
                "id": "cost",
                "name": "Cost",
                "direction": "MINIMIZE",
                "unit": "USD",
                "scale": "RATIO",
                "valid_range": {"min": 0, "max": 1000},
            }
        ],
        "providers": [{"id": "p1", "name": "Provider"}],
        "tasks": [{"id": "t1", "name": "Task"}],
        "candidates": [
            {
                "id": "c1",
                "task_id": "t1",
                "provider_id": "p1",
                "name": "Cand",
                "features": {"cost": 10.0},
            }
        ],
        "composition": {"type": "STRUCTURED", "root": {"kind": "TASK", "id": "n1", "task_id": "t1"}},
        "aggregation_policies": {"cost": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}}}},
        "objective": {"type": "MONO", "targets": ["cost"], "weights": {"cost": weight}},
        "constraints": [],
    }

    if include_flag:
        instance["objective"]["weights_sum_to_one"] = flag_value

    return instance


def test_weights_sum_to_one_missing_defaults_true_and_is_validated(pipeline: ValidationPipeline):
    instance = _minimal_valid_mono_instance(weight=0.7, include_flag=False)

    # General schema is OK (does not enforce sum-to-one).
    assert pipeline.validate_general_schema(instance) == []

    violations, _ = pipeline.validate_full("random-search", instance)
    assert any(v.code == "semantic_invariant_error" and v.path == "objective.weights" for v in violations)

    # Default should be materialized into the instance.
    assert instance["objective"].get("weights_sum_to_one") is True


def test_weights_sum_to_one_false_skips_sum_constraint(pipeline: ValidationPipeline):
    instance = _minimal_valid_mono_instance(weight=0.7, include_flag=True, flag_value=False)

    assert pipeline.validate_general_schema(instance) == []
    violations, _ = pipeline.validate_full("random-search", instance)

    # Should not fail only due to weights not summing to 1.
    assert violations == [], [v.model_dump() for v in violations]
