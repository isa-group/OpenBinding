import pytest
import os
import json
from openbinding_gateway.validation.pipeline import ValidationPipeline

# Setup environment variables for schema paths if not present
if "GENERAL_SCHEMA_PATH" not in os.environ:
    os.environ["GENERAL_SCHEMA_PATH"] = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../schemas/general/schema.json"))

if "SCHEMAS_DIR" not in os.environ:
    os.environ["SCHEMAS_DIR"] = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../schemas"))

@pytest.fixture
def pipeline():
    return ValidationPipeline()

def get_base_instance():
    return {
        "metadata": {"id": "test-1", "name": "test", "version": "1.0", "created_at": "2023-01-01T00:00:00Z"},
        "features": [{"id": "cost", "name": "Cost", "direction": "minimize", "unit": "USD", "scale": "ratio", "valid_range": {"min": 0, "max": 1000}}],
        "providers": [{"id": "p1", "name": "Provider1"}],
        "tasks": [{"id": "t1", "name": "Task1"}, {"id": "t2", "name": "Task2"}],
        "candidates": [
            {"id": "c1", "task_id": "t1", "provider_id": "p1", "features": {"cost": 10}},
            {"id": "c2", "task_id": "t2", "provider_id": "p1", "features": {"cost": 20}}
        ],
        "composition": {
            "type": "structured",
            "root": {
                "kind": "SEQ", 
                "children": [
                    {"kind": "TASK", "id": "n1", "task_id": "t1"},
                    {"kind": "TASK", "id": "n2", "task_id": "t2"}
                ]
            }
        },
        "aggregation_policies": {
            "cost": {"neutral": 0, "compose": {"seq": {"fn": "sum"}, "and": {"fn":"max"}, "xor": {"fn":"sum"}, "loop": {"fn":"sum"}}, "normalize": {"type": "identity"}}
        },
        "objective": {"type": "single", "property": "cost", "goal": "minimize"}, # Standard Single Obj
        "constraints": []
    }

# --- MiniZinc Tests ---

def test_minizinc_single_objective_valid(pipeline):
    instance = get_base_instance()
    # Check general schema first
    assert len(pipeline.validate_general_schema(instance)) == 0
    # Check MiniZinc
    violations = pipeline.specialization_validator.validate("minizinc-csp", instance)
    assert len(violations) == 0

def test_minizinc_multi_objective_invalid(pipeline):
    instance = get_base_instance()
    instance["objective"] = {
        "type": "multi",
        "properties": [
            {"property": "cost", "goal": "minimize"},
            {"property": "time", "goal": "minimize"}
        ]
    }
    # Should be valid for GENERAL schema (if we added 'time' feature, but let's assume loose check or valid struct)
    # Actually need 'time' feature for general schema validity, but specialization might fail specifically on type 'multi'
    # Let's keep it simple: just change type to MULTI
    
    violations = pipeline.specialization_validator.validate("minizinc-csp", instance)
    # Expect failure because MiniZinc specialization restricts to SINGLE
    assert len(violations) > 0
    assert any("SINGLE" in v.message or "objective" in v.path for v in violations)

def test_minizinc_soft_constraint_invalid(pipeline):
    instance = get_base_instance()
    instance["constraints"] = [{
        "id": "c1",
        "kind": "attribute_bound",
        "scope": "global",
        "attribute_id": "cost",
        "op": "<=",
        "value": 100,
        "hard": False # INVALID for MiniZinc
    }]
    
    violations = pipeline.specialization_validator.validate("minizinc-csp", instance)
    assert len(violations) > 0
    assert any("hard" in v.path or "true" in v.message for v in violations)

def test_minizinc_dependency_valid(pipeline):
    instance = get_base_instance()
    instance["constraints"] = [{
        "id": "c1",
        "kind": "dependency",
        "type": "SAME_PROVIDER",
        "tasks": ["t1", "t2"],
        "hard": True
    }]
    violations = pipeline.specialization_validator.validate("minizinc-csp", instance)
    assert len(violations) == 0

# --- Random Search Tests ---

def test_random_search_soft_constraint_valid(pipeline):
    instance = get_base_instance()
    instance["constraints"] = [{
        "id": "c1",
        "kind": "attribute_bound",
        "scope": "global",
        "attribute_id": "cost",
        "op": "<=",
        "value": 100,
        "hard": False # VALID for Random Search
    }]
    
    violations = pipeline.specialization_validator.validate("random-search", instance)
    assert len(violations) == 0

def test_random_search_dependency_valid(pipeline):
    instance = get_base_instance()
    instance["constraints"] = [{
        "id": "c1",
        "kind": "dependency",
        "type": "SAME_PROVIDER",
        "tasks": ["t1", "t2"]
    }]
    violations = pipeline.specialization_validator.validate("random-search", instance)
    assert len(violations) == 0

def test_random_search_multi_objective_invalid(pipeline):
    instance = get_base_instance()
    instance["objective"] = {
        "type": "multi",
        "properties": [{"property": "cost", "goal": "minimize"}]
    }
    violations = pipeline.specialization_validator.validate("random-search", instance)
    assert len(violations) > 0
    assert any("SINGLE" in v.message or "objective" in v.path for v in violations)
