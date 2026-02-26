import pytest
from openbinding_gateway.validation.engine_plugins.minizinc_csp import MiniZincCSPEnginePlugin
from openbinding_gateway.validation.engine_plugins.random_search import RandomSearchEnginePlugin
from openbinding_gateway.validation.engine_plugins.many_heuristic import ManyHeuristicEnginePlugin

@pytest.fixture
def minizinc_plugin():
    return MiniZincCSPEnginePlugin()

@pytest.fixture
def random_search_plugin():
    return RandomSearchEnginePlugin()

@pytest.fixture
def many_heuristic_plugin():
    return ManyHeuristicEnginePlugin()

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


def test_minizinc_response_feasible_but_empty_selection(minizinc_plugin):
    """A feasible response without binding must be treated as no-solution."""
    old_sol = {
        "solution": {
            "feasible": True,
            "selection": {},
            "objective_value": 10,
        },
        "provenance": {},
    }
    new_sol = minizinc_plugin.transform_response(old_sol, {"composition": {"root": {}}})
    assert new_sol["solutions"] == []

def test_minizinc_response_propagates_engine_violations(minizinc_plugin):
    old_sol = {
        "result": {
            "solution": {
                "feasible": False,
                "selection": None,
                "objective_value": None,
            },
            "violations": [
                {"code": "solver_error", "message": "MiniZinc failed"}
            ],
            "diagnostics": {"reason": "non_zero_exit"},
        }
    }

    new_sol = minizinc_plugin.transform_response(old_sol, {"composition": {"root": {}}})
    assert new_sol["solutions"] == []
    assert new_sol["diagnostics"]["reason"] == "non_zero_exit"
    assert new_sol["diagnostics"]["engine_violations"][0]["code"] == "solver_error"

def test_minizinc_transform_request_allows_debug_and_solver_options(minizinc_plugin):
    req = {
        "composition": {"root": {"kind": "TASK", "task_id": "t1"}},
        "tasks": [{"id": "t1"}],
        "candidates": [],
        "features": [],
        "aggregation_policies": {},
        "objective": {"type": "MONO"},
    }

    _, warnings = minizinc_plugin.transform_request(req, {"debug": True, "solver": "gecode"})
    assert warnings == []

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


def test_many_heuristic_request_dependency(many_heuristic_plugin):
    instance = {
        "constraints": [
            {
                "id": "c1",
                "kind": "DEPENDENCY",
                "type": "DIFFERENT_PROVIDER",
                "tasks": ["t1", "t2"],
                "hard": True
            }
        ],
        "objective": {"type": "MANY"},
        "composition": {
            "root": {
                "kind": "TASK", "id": "t1", "task_id": "t1"
            }
        },
        "features": [
            {"id": "latency", "direction": "MINIMIZE", "valid_range": {"min": 0, "max": 10}}
        ],
        "aggregation_policies": {"latency": {"compose": {"seq": {"fn": "SUM"}}}},
        "tasks": [{"id": "t1"}, {"id": "t2"}],
        "candidates": [
            {"id": "c1", "task_id": "t1", "provider_id": "p1", "features": {"latency": 1}},
            {"id": "c2", "task_id": "t2", "provider_id": "p2", "features": {"latency": 2}}
        ],
        "providers": [{"id": "p1"}, {"id": "p2"}]
    }

    transformed, _ = many_heuristic_plugin.transform_request(instance)

    constraints = transformed["constraints"]
    assert len(constraints) == 1
    c = constraints[0]
    assert c["kind"] == "dependency"
    assert c["type"] == "DIFFERENT_PROVIDER"
    assert c["tasks"] == ["t1", "t2"]
    assert c["hard"] is True
