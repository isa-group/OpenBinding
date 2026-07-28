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


def test_minizinc_response_recomputes_aggregated_features_in_gateway(minizinc_plugin):
    old_sol = {
        "solution": {
            "feasible": True,
            "selection": {
                "T1": "cand_t1_aws",
                "T2": "cand_t2_radius_iot_network",
                "T3": "cand_t3_here_routing_api",
                "T5": "cand_t5_amazon_braket",
                "T6": "cand_t6_stripe",
            },
            "objective_value": -0.006819703777809102,
            "aggregated_features": {
                "availability": 19.337912048037,
                "reliability": 19.3201518851772,
                "security": 1,
            },
        },
        "provenance": {},
    }

    request = {
        "features": [
            {"id": "availability", "direction": "MAXIMIZE", "scale": "RATIO", "valid_range": {"min": 0, "max": 100}},
            {"id": "reliability", "direction": "MAXIMIZE", "scale": "RATIO", "valid_range": {"min": 0, "max": 100}},
            {"id": "security", "direction": "MAXIMIZE", "scale": "ORDINAL", "valid_range": {"min": 1, "max": 5}},
            {"id": "cost", "direction": "MINIMIZE", "scale": "RATIO", "valid_range": {"min": 0, "max": 10000}},
            {"id": "execution_time", "direction": "MINIMIZE", "scale": "RATIO", "valid_range": {"min": 0, "max": 20000}},
        ],
        "candidates": [
            {"id": "cand_t1_aws", "task_id": "T1", "features": {"availability": 99.95, "reliability": 99.75, "security": 5, "cost": 220, "execution_time": 210}},
            {"id": "cand_t2_radius_iot_network", "task_id": "T2", "features": {"availability": 99.8, "reliability": 99.3, "security": 4, "cost": 500, "execution_time": 420}},
            {"id": "cand_t3_here_routing_api", "task_id": "T3", "features": {"availability": 99.9, "reliability": 99.5, "security": 4, "cost": 300, "execution_time": 380}},
            {"id": "cand_t5_amazon_braket", "task_id": "T5", "features": {"availability": 99.9, "reliability": 99.0, "security": 5, "cost": 1200, "execution_time": 9000}},
            {"id": "cand_t6_stripe", "task_id": "T6", "features": {"availability": 99.99, "reliability": 99.5, "security": 5, "cost": 950, "execution_time": 520}},
        ],
        "aggregation_policies": {
            "availability": {"neutral": 1, "compose": {"seq": {"fn": "PRODUCT"}, "and": {"fn": "PRODUCT"}, "xor": {"fn": "SCALED_SUM"}}},
            "reliability": {"neutral": 1, "compose": {"seq": {"fn": "PRODUCT"}, "and": {"fn": "PRODUCT"}, "xor": {"fn": "SCALED_SUM"}}},
            "security": {"neutral": 5, "compose": {"seq": {"fn": "MIN"}, "and": {"fn": "MIN"}, "xor": {"fn": "SCALED_SUM"}}},
            "cost": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}, "and": {"fn": "SUM"}, "xor": {"fn": "SCALED_SUM"}}},
            "execution_time": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}, "and": {"fn": "MAX"}, "xor": {"fn": "SCALED_SUM"}}},
        },
        "composition": {
            "root": {
                "id": "root_seq",
                "kind": "SEQ",
                "children": [
                    {"id": "node_t1", "kind": "TASK", "task_id": "T1"},
                    {"id": "node_t2", "kind": "TASK", "task_id": "T2"},
                    {"id": "node_t3", "kind": "TASK", "task_id": "T3"},
                    {
                        "id": "node_routing_choice",
                        "kind": "XOR",
                        "branches": [
                            {"p": 0.8, "child": {"id": "node_classic_routing", "kind": "ELEMENT"}},
                            {"p": 0.2, "child": {"id": "node_t5", "kind": "TASK", "task_id": "T5"}},
                        ],
                    },
                    {"id": "node_t6", "kind": "TASK", "task_id": "T6"},
                ],
            }
        },
    }

    new_sol = minizinc_plugin.transform_response(old_sol, request)

    aggregated = new_sol["solutions"][0]["aggregated_features"]
    assert aggregated["security"] == pytest.approx(4.0)
    assert aggregated["cost"] == pytest.approx(2210.0)
    assert aggregated["execution_time"] == pytest.approx(3330.0)
    assert aggregated["availability"] == pytest.approx(99.62045678803702)
    assert aggregated["reliability"] == pytest.approx(97.8675813761625)

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

    # The instance travels verbatim; the engine reads the constraints itself
    # rather than receiving a re-encoded copy of them.
    c = transformed["instance"]["constraints"][0]
    assert c["kind"] == "DEPENDENCY"
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

    c = transformed["instance"]["constraints"][0]
    assert c["kind"] == "ATTRIBUTE_BOUND"
    assert c["attribute_id"] == "cost"
    assert c["op"] == "<="
    assert c["value"] == 100


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


def test_many_heuristic_request_uses_objective_weights(many_heuristic_plugin):
    instance = {
        "objective": {
            "type": "MANY",
            "targets": ["latency", "availability"],
            "weights": {"latency": 0.3, "availability": 0.7},
        },
        "composition": {
            "root": {
                "kind": "TASK", "id": "t1", "task_id": "t1"
            }
        },
        "features": [
            {"id": "latency", "direction": "MINIMIZE", "valid_range": {"min": 0, "max": 10}},
            {"id": "availability", "direction": "MAXIMIZE", "valid_range": {"min": 0, "max": 1}},
            {"id": "cost", "direction": "MINIMIZE", "valid_range": {"min": 0, "max": 100}},
        ],
        "aggregation_policies": {
            "latency": {"compose": {"seq": {"fn": "SUM"}}},
            "availability": {"compose": {"seq": {"fn": "PRODUCT"}}},
            "cost": {"compose": {"seq": {"fn": "SUM"}}},
        },
        "tasks": [{"id": "t1"}],
        "candidates": [
            {"id": "c1", "task_id": "t1", "provider_id": "p1", "features": {"latency": 1, "availability": 0.9, "cost": 5}}
        ],
        "providers": [{"id": "p1"}],
    }

    transformed, _ = many_heuristic_plugin.transform_request(instance)

    assert transformed["features"]["weights"]["latency"] == pytest.approx(0.3)
    assert transformed["features"]["weights"]["availability"] == pytest.approx(0.7)
    assert transformed["features"]["weights"]["cost"] == pytest.approx(0.0)


def test_many_heuristic_response_recomputes_missing_objective_value(many_heuristic_plugin):
    engine_response = {
        "solutions": [
            {
                "selection": {"T1": "cand_t1"},
                "aggregated_features": {"cost": 999.0},
                "objective_value": None,
            }
        ],
        "execution_time": 12,
        "iterations_count": 3,
    }
    request = {
        "features": [
            {"id": "cost", "direction": "MINIMIZE", "scale": "RATIO", "valid_range": {"min": 0, "max": 1000}},
            {"id": "reliability", "direction": "MAXIMIZE", "scale": "RATIO", "valid_range": {"min": 0, "max": 100}},
        ],
        "candidates": [
            {"id": "cand_t1", "task_id": "T1", "features": {"cost": 10, "reliability": 90}},
        ],
        "aggregation_policies": {
            "cost": {"neutral": 0, "compose": {"seq": {"fn": "SUM"}}, "normalize": {"type": "minmax", "bounds": {"min": 0, "max": 1000}}},
            "reliability": {"neutral": 1, "compose": {"seq": {"fn": "SUM"}}, "normalize": {"type": "minmax", "bounds": {"min": 0, "max": 100}}},
        },
        "composition": {
            "root": {"id": "node_t1", "kind": "TASK", "task_id": "T1"}
        },
        "objective": {
            "type": "MANY",
            "targets": ["cost", "reliability"],
            "weights": {"cost": 0.25, "reliability": 0.75},
        },
    }

    transformed = many_heuristic_plugin.transform_response(engine_response, request)

    assert transformed["solutions"][0]["aggregated_features"]["cost"] == pytest.approx(10.0)
    assert transformed["solutions"][0]["aggregated_features"]["reliability"] == pytest.approx(90.0)
    assert transformed["solutions"][0]["objective_value"] == pytest.approx(0.9225)
