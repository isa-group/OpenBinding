import pytest
from openbinding_gateway.validation.engine_plugins.minizinc_csp import MiniZincCSPEnginePlugin
from openbinding_gateway.validation.engine_plugins.random_search import RandomSearchEnginePlugin

@pytest.fixture
def minizinc_plugin():
    return MiniZincCSPEnginePlugin()

@pytest.fixture
def random_search_plugin():
    return RandomSearchEnginePlugin()

# --- MiniZinc Tests ---

def test_minizinc_response_feasible(minizinc_plugin):
    """Test standard feasible response transformation."""
    old_sol = {
        "solution": {
            "feasible": True,
            "selection": {"t1": "c1"},
            "objective_value": 10
        },
        "provenance": {}
    }
    # Pass dummy request
    new_sol = minizinc_plugin.transform_response(old_sol, {"composition": {"root": {}}})
    assert len(new_sol["solutions"]) == 1
    assert new_sol["solutions"][0]["is_feasible"] is True
    assert new_sol["solutions"][0]["binding"] == {"t1": "c1"}

def test_minizinc_response_unfeasible(minizinc_plugin):
    """Test that feasible=False is transformed to empty solution list."""
    old_sol = {
        "solution": {
            "feasible": False,
            "selection": None,
            "objective_value": None
        },
        "provenance": {}
    }
    new_sol = minizinc_plugin.transform_response(old_sol, {"composition": {"root": {}}})
    # Expect empty list for standard "No Solution Found"
    assert new_sol["solutions"] == []

# --- Random Search Tests ---

def test_random_search_request_dependency(random_search_plugin):
    """Test that DEPENDENCY constraints are correctly mapped."""
    instance = {
        "constraints": [
            {
                "id": "c1",
                "kind": "DEPENDENCY",
                "type": "SAME_PROVIDER",
                "tasks": ["t1", "t2"],
                "hard": True
            }
        ],
        "objective": {},
        "composition": {
            "root": {
                "kind": "TASK", "id": "t1", "task_id": "t1"
            }
        },
        "features": [],
        "aggregation_policies": {},
        "tasks": [{"id": "t1"}, {"id": "t2"}],
        "candidates": [],
        "providers": []
    }
    
    transformed, _ = random_search_plugin.transform_request(instance)
    
    # Check constraints
    constraints = transformed["constraints"]
    # We expect 1 constraint
    assert len(constraints) == 1
    c = constraints[0]
    assert c["kind"] == "dependency"
    assert c["type"] == "SAME_PROVIDER"
    assert c["tasks"] == ["t1", "t2"]
    assert c["hard"] is True

def test_random_search_request_attribute_bound(random_search_plugin):
    """Test that ATTRIBUTE_BOUND constraints are correctly mapped."""
    instance = {
        "constraints": [
            {
                "id": "c1",
                "kind": "ATTRIBUTE_BOUND",
                "attribute_id": "cost",
                "op": "<=",
                "value": 100,
                "scope": "GLOBAL",
                "hard": True
            }
        ],
        "objective": {},
        "composition": {
            "root": {
                "kind": "TASK", "id": "t1", "task_id": "t1"
            }
        },
        "features": [],
        "aggregation_policies": {},
        "tasks": [{"id": "t1"}],
        "candidates": [],
        "providers": []
    }
    
    transformed, _ = random_search_plugin.transform_request(instance)
    
    constraints = transformed["constraints"]
    assert len(constraints) == 1
    c = constraints[0]
    assert c["kind"] == "attribute_bound" # Schema uses lowercase
    assert c["attribute_id"] == "cost"
